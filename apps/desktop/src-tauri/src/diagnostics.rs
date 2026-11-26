//! One-file diagnostics bundle for bug reports.
//!
//! The zip deliberately excludes transcripts, audio, the SQLite database and
//! every credential: it carries versions, counts, sanitized settings and the
//! tail of the log so a maintainer can reproduce environment problems without
//! receiving what the user was listening to.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;

use crate::general;
use crate::store::StoreHealth;

const LOG_TAIL_BYTES: u64 = 256 * 1024;

/// Settings files copied into the bundle. `glossary.json` and the JSONL event
/// streams are intentionally absent: they contain user content.
const SETTINGS: [(&str, &str); 6] = [
    ("general.json", "general"),
    ("audio.json", "audio"),
    ("asr.json", "asr"),
    ("settings.json", "translate"),
    ("voice.json", "voice"),
    ("plugins.json", "plugins"),
];

const READ_ME: &str = "Livetrans diagnostics\n\
\n\
This archive contains app/system versions, store counts, sanitized settings\n\
and the tail of the log. It does not contain transcripts, audio, the session\n\
database, glossary contents, event streams or API keys.\n";

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "key"
            | "apikey"
            | "api_key"
            | "api-key"
            | "secret"
            | "token"
            | "password"
            | "consent"
            | "consentat"
            | "command"
    ) || key.contains("apikey")
        || key.contains("secret")
}

/// Recursively drop credential-shaped fields while keeping the rest of the
/// settings useful for support.
pub fn sanitize(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| !is_secret_key(key));
            for item in map.values_mut() {
                sanitize(item);
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize(item);
            }
        }
        _ => {}
    }
}

fn read_tail(path: &Path, max: u64) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len > max {
        file.seek(SeekFrom::Start(len - max)).ok()?;
    }
    let mut buf = Vec::new();
    file.take(max).read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn add_bytes(
    zip: &mut zip::ZipWriter<File>,
    name: &str,
    bytes: &[u8],
    options: SimpleFileOptions,
) -> Result<(), String> {
    zip.start_file(name, options)
        .map_err(|err| format!("无法写入诊断包条目 {name}：{err}"))?;
    zip.write_all(bytes)
        .map_err(|err| format!("无法写入诊断包条目 {name}：{err}"))
}

fn add_settings(
    zip: &mut zip::ZipWriter<File>,
    config_dir: &Path,
    options: SimpleFileOptions,
) -> Result<(), String> {
    for (file, name) in SETTINGS {
        let path = config_dir.join(file);
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        sanitize(&mut value);
        let pretty = serde_json::to_vec_pretty(&value)
            .map_err(|err| format!("无法序列化 {file}：{err}"))?;
        add_bytes(zip, &format!("settings/{name}.json"), &pretty, options)?;
    }
    Ok(())
}

fn add_logs(
    zip: &mut zip::ZipWriter<File>,
    log_dir: &Path,
    options: SimpleFileOptions,
) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(log_dir) else {
        return Ok(());
    };
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "log"))
        .collect();
    logs.sort();
    for path in logs {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(bytes) = read_tail(&path, LOG_TAIL_BYTES) else {
            continue;
        };
        add_bytes(zip, &format!("logs/{name}"), &bytes, options)?;
    }
    Ok(())
}

fn installed(data_dir: &Path, relative: &str) -> bool {
    let dir = data_dir.join(relative);
    dir.is_dir()
        && fs::read_dir(&dir)
            .map(|entries| {
                entries.flatten().any(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("onnx"))
                })
            })
            .unwrap_or(false)
}

/// Write the bundle to `dest` and return the path for the UI.
pub fn export(app: &AppHandle, health: StoreHealth, dest: &Path) -> Result<String, String> {
    if dest.as_os_str().is_empty() {
        return Err(general::pick("诊断包路径为空。", "The diagnostics path is empty.").to_string());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("无法创建诊断包目录：{err}"))?;
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let log_dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| PathBuf::from("logs"));
    let info = app.package_info();
    let summary = json!({
        "generatedAt": chrono::Local::now().to_rfc3339(),
        "app": {
            "name": "Livetrans",
            "version": info.version.to_string(),
            "identifier": app.config().identifier,
            "debug": cfg!(debug_assertions),
        },
        "system": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "locale": general::load(&general::settings_path(app)).locale,
        "paths": {
            "config": config_dir.display().to_string(),
            "data": data_dir.display().to_string(),
            "logs": log_dir.display().to_string(),
        },
        "store": health,
        "models": {
            "nmtInstalled": installed(&data_dir, "models/translate/en-zh"),
            "ttsInstalled": installed(&data_dir, "models/tts/kokoro-zh-en-v1.1"),
        },
    });

    let file = File::create(dest)
        .map_err(|err| format!("无法创建诊断包 {}：{err}", dest.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let pretty = serde_json::to_vec_pretty(&summary)
        .map_err(|err| format!("无法序列化诊断摘要：{err}"))?;
    add_bytes(&mut zip, "README.txt", READ_ME.as_bytes(), options)?;
    add_bytes(&mut zip, "summary.json", &pretty, options)?;
    add_settings(&mut zip, &config_dir, options)?;
    add_logs(&mut zip, &log_dir, options)?;
    zip.finish()
        .map_err(|err| format!("无法完成诊断包：{err}"))?;
    Ok(dest.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_credentials_but_keeps_layout() {
        let mut value = serde_json::from_str::<Value>(
            r#"{
                "route": "llm",
                "apiKey": "sk-do-not-export",
                "provider": { "baseUrl": "http://127.0.0.1:11434/v1", "key": "x", "model": "qwen2.5:3b" },
                "enabled": true,
                "command": "python C:\\plugins\\livetrans.py",
                "consentAt": "2026-11-25T13:00:00Z"
            }"#,
        )
        .unwrap();
        sanitize(&mut value);
        assert_eq!(value["route"], "llm");
        assert_eq!(value["provider"]["baseUrl"], "http://127.0.0.1:11434/v1");
        assert_eq!(value["provider"]["model"], "qwen2.5:3b");
        assert_eq!(value["enabled"], true);
        assert!(value.get("apiKey").is_none());
        assert!(value["provider"].get("key").is_none());
        assert!(value.get("command").is_none());
        assert!(value.get("consentAt").is_none());
    }
}
