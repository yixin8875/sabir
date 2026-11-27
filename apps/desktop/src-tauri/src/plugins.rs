//! Local script plugins and the JSONL event stream.
//!
//! A plugin is a command the user writes themselves. It runs on this machine,
//! receives every caption event as JSONL on stdin and may answer a translation
//! with `{"type":"rewrite","id":n,"text":"…"}` on stdout, which replaces the
//! displayed and stored translation. Every event is also appended to
//! `<app_data>/streams/<session id>.jsonl` so Obsidian/Notion scripts and the
//! `sabir stream` CLI can follow a session without a plugin.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::engine::EngineEvent;
use crate::general;
use crate::store::SessionMeta;

/// How long a translation waits for a plugin rewrite before going through
/// unchanged. Keeps a slow script from stalling the caption pipeline.
const REWRITE_TIMEOUT: Duration = Duration::from_millis(400);
/// Rewrites longer than this are almost certainly a runaway script.
const MAX_REWRITE_CHARS: usize = 4_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginSettings {
    pub enabled: bool,
    /// Shell command, e.g. `python C:\plugins\sabir.py`. Empty means none.
    pub command: String,
}

impl PluginSettings {
    pub fn normalized(mut self) -> Self {
        self.command = self.command.trim().to_string();
        if self.command.is_empty() {
            self.enabled = false;
        }
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingsView {
    pub settings: PluginSettings,
    /// Directory holding one `<session id>.jsonl` per listening session.
    pub stream_dir: String,
    pub running: bool,
    pub last_error: Option<String>,
}

struct StreamSession {
    id: i64,
    file: File,
}

pub struct PluginService {
    settings: RwLock<PluginSettings>,
    settings_path: PathBuf,
    stream_dir: PathBuf,
    stream: Mutex<Option<StreamSession>>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, Sender<String>>>>,
    alive: Arc<AtomicBool>,
    last_error: Mutex<Option<String>>,
}

impl PluginService {
    pub fn start(app: &AppHandle) -> Self {
        let settings_path = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("plugins.json"))
            .unwrap_or_else(|_| PathBuf::from("plugins.json"));
        let stream_dir = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("streams"))
            .unwrap_or_else(|_| PathBuf::from("streams"));
        Self::open(settings_path, stream_dir)
    }

    pub fn open(settings_path: PathBuf, stream_dir: PathBuf) -> Self {
        let settings = load_settings(&settings_path);
        let _ = fs::create_dir_all(&stream_dir);
        Self {
            settings: RwLock::new(settings),
            settings_path,
            stream_dir,
            stream: Mutex::new(None),
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            alive: Arc::new(AtomicBool::new(false)),
            last_error: Mutex::new(None),
        }
    }

    pub fn view(&self) -> PluginSettingsView {
        PluginSettingsView {
            settings: self
                .settings
                .read()
                .map(|value| value.clone())
                .unwrap_or_default(),
            stream_dir: self.stream_dir.display().to_string(),
            running: self.alive.load(Ordering::SeqCst),
            last_error: self.last_error.lock().ok().and_then(|value| value.clone()),
        }
    }

    pub fn save(&self, settings: PluginSettings) -> Result<PluginSettingsView, String> {
        if settings.enabled && settings.command.trim().is_empty() {
            return Err(general::pick(
                "先填写插件命令，才能启用。",
                "Enter a plugin command before enabling it.",
            )
            .to_string());
        }
        let settings = settings.normalized();
        write_settings(&self.settings_path, &settings)?;
        *self
            .settings
            .write()
            .map_err(|_| general::pick("插件设置锁已损坏", "Plugin settings lock is poisoned"))? =
            settings;
        Ok(self.view())
    }

    /* --------------------------------------------------------------------- */
    /* Session lifecycle                                                     */
    /* --------------------------------------------------------------------- */

    /// Open the session's stream file and start the plugin (if enabled). Safe to
    /// call when a previous session is still open.
    pub fn begin_session(&self, meta: &SessionMeta) -> Result<(), String> {
        self.end_session();
        if let Ok(mut error) = self.last_error.lock() {
            *error = None;
        }
        let path = self.stream_dir.join(format!("{}.jsonl", meta.id));
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|err| format!("无法创建事件流文件：{err}"))?;
        let header = json!({
            "type": "session",
            "id": meta.id,
            "title": meta.title,
            "startedAt": meta.started_at,
            "endedAt": meta.ended_at,
            "source": meta.source,
            "asrModel": meta.asr_model,
            "translateRoute": meta.translate_route,
        });
        {
            let mut guard = self.stream.lock().map_err(|_| "事件流锁已损坏".to_string())?;
            *guard = Some(StreamSession {
                id: meta.id,
                file,
            });
        }
        self.write_stream_line(&header);

        let settings = self
            .settings
            .read()
            .map(|value| value.clone())
            .unwrap_or_default();
        if settings.enabled && !settings.command.is_empty() {
            match self.spawn(&settings.command) {
                Ok(()) => {
                    // Later events reach the plugin through `record`.
                    self.write_stdin_line(&header);
                }
                Err(err) => {
                    if let Ok(mut error) = self.last_error.lock() {
                        *error = Some(err.clone());
                    }
                    log::warn!("plugin: {err}");
                }
            }
        }
        Ok(())
    }

    fn spawn(&self, command: &str) -> Result<(), String> {
        let mut process = shell_command(command);
        process
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: scripts must not flash a console over captions.
            process.creation_flags(0x0800_0000);
        }
        let mut child = process
            .spawn()
            .map_err(|err| format!("插件启动失败：{err}"))?;
        let stdin = child.stdin.take().ok_or("插件 stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("插件 stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("插件 stderr 不可用")?;

        let pending = Arc::clone(&self.pending);
        let alive = Arc::clone(&self.alive);
        thread::Builder::new()
            .name("sabir-plugin-out".to_string())
            .spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        log::warn!("plugin: non-JSON stdout line: {}", line.trim());
                        continue;
                    };
                    match value.get("type").and_then(Value::as_str) {
                        Some("rewrite") => {
                            let id = value.get("id").and_then(Value::as_u64);
                            let text = value
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            if let Some(id) = id {
                                if let Ok(mut map) = pending.lock() {
                                    if let Some(tx) = map.remove(&id) {
                                        let _ = tx.send(text);
                                    }
                                }
                            }
                        }
                        Some("log") => log::info!(
                            "plugin: {}",
                            value.get("message").and_then(Value::as_str).unwrap_or("")
                        ),
                        _ => {}
                    }
                }
                alive.store(false, Ordering::SeqCst);
            })
            .map_err(|err| format!("插件读取线程启动失败：{err}"))?;

        thread::Builder::new()
            .name("sabir-plugin-err".to_string())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        log::warn!("plugin stderr: {}", line.trim());
                    }
                }
            })
            .ok();

        if let Ok(mut slot) = self.stdin.lock() {
            *slot = Some(stdin);
        }
        if let Ok(mut slot) = self.child.lock() {
            *slot = Some(child);
        }
        self.alive.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Send the end marker, close stdin and stop the child process.
    pub fn end_session(&self) {
        let session_id = self
            .stream
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|session| session.id));
        if let Some(id) = session_id {
            self.write_line(&json!({ "type": "sessionEnd", "sessionId": id }));
        }
        let mut stdin = self.stdin.lock().ok().and_then(|mut slot| slot.take());
        if let Some(pipe) = stdin.as_mut() {
            let _ = pipe.flush();
        }
        drop(stdin);
        if let Some(mut child) = self.child.lock().ok().and_then(|mut slot| slot.take()) {
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(40)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        if let Ok(mut guard) = self.stream.lock() {
            if let Some(session) = guard.take() {
                let _ = session.file.sync_all();
            }
        }
    }

    /* --------------------------------------------------------------------- */
    /* Events and rewrites                                                   */
    /* --------------------------------------------------------------------- */

    /// Append one engine event to the JSONL stream and the plugin's stdin.
    /// Level events are omitted: they arrive many times a second and carry no
    /// transcript text.
    pub fn record(&self, session_id: i64, event: &EngineEvent) {
        // Levels are too chatty for a transcript stream, and the empty partial
        // that clears Whisper's grey preview is for the UI only.
        if matches!(event, EngineEvent::Level { .. }) {
            return;
        }
        if let EngineEvent::Partial { text, .. } = event {
            if text.is_empty() {
                return;
            }
        }
        let Ok(mut value) = serde_json::to_value(event) else {
            return;
        };
        if let Value::Object(ref mut map) = value {
            map.insert("sessionId".to_string(), json!(session_id));
        }
        self.write_line(&value);
    }

    /// Ask the plugin to rewrite one translation. Returns `None` when no plugin
    /// is running, the answer misses the deadline, or the rewritten text is
    /// empty/unchanged.
    #[allow(clippy::too_many_arguments)]
    pub fn rewrite(
        &self,
        session_id: i64,
        id: u64,
        original: &str,
        translated: &str,
        route: &str,
        provider: Option<&str>,
        ms: u64,
    ) -> Option<String> {
        if !self.alive.load(Ordering::SeqCst) || translated.trim().is_empty() {
            return None;
        }
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = self.pending.lock().ok()?;
            pending.insert(id, tx);
        }
        let request = json!({
            "type": "translate",
            "sessionId": session_id,
            "id": id,
            "original": original,
            "text": translated,
            "route": route,
            "provider": provider,
            "ms": ms,
        });
        // The rewrite request is part of the plugin protocol, not a transcript
        // event; keep it out of the JSONL stream that external tools read.
        if !self.write_stdin_line(&request) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return None;
        }
        let answer = rx.recv_timeout(REWRITE_TIMEOUT).ok();
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
        let answer = answer?;
        let clean = answer.replace('\0', "");
        let clean = clean.trim();
        if clean.is_empty() || clean == translated.trim() {
            return None;
        }
        Some(clean.chars().take(MAX_REWRITE_CHARS).collect())
    }

    fn write_line(&self, value: &Value) -> bool {
        self.write_stream_line(value);
        self.write_stdin_line(value)
    }

    fn write_stream_line(&self, value: &Value) -> bool {
        let line = value.to_string();
        if let Ok(mut guard) = self.stream.lock() {
            if let Some(session) = guard.as_mut() {
                if writeln!(session.file, "{line}").is_ok() {
                    let _ = session.file.flush();
                    return true;
                }
            }
        }
        false
    }

    fn write_stdin_line(&self, value: &Value) -> bool {
        let line = value.to_string();
        if let Ok(mut guard) = self.stdin.lock() {
            if let Some(pipe) = guard.as_mut() {
                if writeln!(pipe, "{line}").is_ok() {
                    let _ = pipe.flush();
                    return true;
                }
            }
        }
        false
    }
}

/* ------------------------------------------------------------------------- */
/* Settings file                                                             */
/* ------------------------------------------------------------------------- */

fn load_settings(path: &Path) -> PluginSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<PluginSettings>(&text).ok())
        .unwrap_or_default()
        .normalized()
}

fn write_settings(path: &Path, settings: &PluginSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|err| format!("无法保存插件设置：{err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("无法保存插件设置：{err}"))
}

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("cmd");
    process.arg("/C").arg(command);
    // Python scripts are the common case; without this their stdin/stdout use
    // the console code page and Chinese captions corrupt the JSONL stream.
    process
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    process
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("sh");
    process.arg("-c").arg(command);
    process
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    process
}

/* ------------------------------------------------------------------------- */
/* Test button                                                               */
/* ------------------------------------------------------------------------- */

/// Run a one-off plugin probe: feed one sample translation and report whether a
/// rewrite came back. Used by the settings "测试" button.
pub fn probe(command: &str) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(general::pick(
            "先填写插件命令。",
            "Enter a plugin command first.",
        )
        .to_string());
    }
    let mut process = shell_command(command);
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000);
    }
    let mut child = process
        .spawn()
        .map_err(|err| format!("插件启动失败：{err}"))?;
    let mut stdin = child.stdin.take().ok_or("插件 stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("插件 stdout 不可用")?;
    let _ = writeln!(
        stdin,
        "{}",
        json!({ "type": "session", "id": 0, "title": "Plugin test" })
    );
    let _ = writeln!(
        stdin,
        "{}",
        json!({
            "type": "translate",
            "sessionId": 0,
            "id": 1,
            "original": "Hello.",
            "text": "你好。",
            "route": "nmt",
            "ms": 0,
        })
    );
    let _ = stdin.flush();

    let (tx, rx) = mpsc::channel::<String>();
    let reader = thread::Builder::new()
        .name("sabir-plugin-probe".to_string())
        .spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
        .map_err(|err| format!("插件读取线程启动失败：{err}"))?;

    let deadline = Instant::now() + Duration::from_millis(2_500);
    let mut result = general::pick(
        "插件运行了，但没有返回改写（只输出事件流也可以）。",
        "The plugin ran but did not return a rewrite (streaming events only is fine).",
    )
    .to_string();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if value.get("type").and_then(Value::as_str) != Some("rewrite") {
                    continue;
                }
                let text = value
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                result = if text.is_empty() {
                    general::pick("插件返回了空的改写。", "The plugin returned an empty rewrite.")
                        .to_string()
                } else {
                    format!(
                        "{}：{}",
                        general::pick("插件返回了改写", "Plugin returned a rewrite"),
                        text.chars().take(80).collect::<String>()
                    )
                };
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                result = general::pick(
                    "插件已退出，没有返回改写。",
                    "The plugin exited without returning a rewrite.",
                )
                .to_string();
                break;
            }
        }
    }
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SessionMeta;

    fn meta(id: i64) -> SessionMeta {
        SessionMeta {
            id,
            started_at: "2026-11-25 10:00:00".to_string(),
            ended_at: None,
            title: "测试会话".to_string(),
            source: "系统声音".to_string(),
            asr_model: "zipformer".to_string(),
            translate_route: "nmt".to_string(),
            segments: 0,
        }
    }

    fn fixture(label: &str) -> (PluginService, PathBuf) {
        let dir = std::env::temp_dir().join(format!("sabir-plugin-test-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let service = PluginService::open(dir.join("plugins.json"), dir.join("streams"));
        (service, dir)
    }

    #[test]
    fn empty_commands_are_normalized_and_round_trip() {
        let settings = PluginSettings {
            enabled: true,
            command: "  python script.py  ".to_string(),
        }
        .normalized();
        assert!(settings.enabled);
        assert_eq!(settings.command, "python script.py");

        let (service, dir) = fixture("settings");
        let saved = service
            .save(PluginSettings {
                enabled: false,
                command: "  ".to_string(),
            })
            .unwrap();
        assert!(!saved.settings.enabled);
        assert!(saved.settings.command.is_empty());
        assert_eq!(load_settings(&dir.join("plugins.json")).command, "");
        assert!(service
            .save(PluginSettings {
                enabled: true,
                command: "".to_string(),
            })
            .is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_a_session_stream_and_skips_levels() {
        let (service, dir) = fixture("stream");
        service.begin_session(&meta(7)).unwrap();
        service.record(
            7,
            &EngineEvent::Level {
                rms: 0.2,
                peak: 0.4,
            },
        );
        service.record(
            7,
            &EngineEvent::Final {
                id: 1,
                text: "Hello there.".to_string(),
                start_ms: 0,
                end_ms: 1200,
            },
        );
        service.record(
            7,
            &EngineEvent::TranslationDone {
                id: 1,
                text: "你好。".to_string(),
                route: "nmt".to_string(),
                provider: None,
                ms: 90,
                fallback: false,
            },
        );
        service.end_session();

        let text = fs::read_to_string(dir.join("streams").join("7.jsonl")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4); // session, final, translationDone, sessionEnd
        assert!(lines[0].contains("\"type\":\"session\""));
        assert!(lines[1].contains("\"type\":\"final\""));
        assert!(lines[1].contains("\"sessionId\":7"));
        assert!(lines[2].contains("\"type\":\"translationDone\""));
        assert!(lines[3].contains("\"type\":\"sessionEnd\""));
        assert!(!text.contains("\"level\""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewrite_is_a_no_op_without_a_plugin() {
        let (service, dir) = fixture("rewrite");
        assert_eq!(
            service.rewrite(1, 1, "Hello.", "你好。", "nmt", None, 10),
            None
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn probe_accepts_an_echoing_plugin() {
        let dir = std::env::temp_dir().join("sabir-plugin-test-probe");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let bat = dir.join("reply.bat");
        fs::write(
            &bat,
            "@echo off\r\necho {\"type\":\"rewrite\",\"id\":1,\"text\":\"rewritten\"}\r\n",
        )
        .unwrap();
        let result = probe(&bat.display().to_string()).unwrap();
        assert!(result.contains("rewritten"), "{result}");
        let _ = fs::remove_dir_all(&dir);
    }
}
