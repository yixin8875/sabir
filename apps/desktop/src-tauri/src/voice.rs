//! Local voiceover for translated captions.
//!
//! Kokoro v1.1 (Chinese + English) is downloaded on demand like the other
//! models. Rust synthesises one sentence at a time and returns a small WAV as
//! base64; the WebView plays it in order. Text and audio stay on this machine:
//! synthesis runs fully offline once the model is installed.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::download::{self, CANCELLED};
use crate::general;

pub const MODEL_ID: &str = "kokoro-zh-en-v1.1";
const REPO: &str = "csukuangfj/kokoro-multi-lang-v1_1";
/// Sum of every file below; shown in settings.
const TOTAL_BYTES: u64 = 387_430_323;
/// Chinese female voice `zf_001` (sid 3 in Kokoro v1.1).
const ZH_SID: i32 = 3;
/// American female voice `af_maple` (sid 0).
const EN_SID: i32 = 0;
/// A translation is at most a few sentences; this keeps one request bounded.
const MAX_CHARS: usize = 600;

struct VoiceFile {
    name: &'static str,
    bytes: u64,
    /// SHA-256 from the repository's LFS metadata, or hashed from the published
    /// file for the small non-LFS `tokens.txt`.
    sha256: &'static str,
}

const FILES: &[VoiceFile] = &[
    VoiceFile {
        name: "model.onnx",
        bytes: 325_561_476,
        sha256: "99db0bc8fd0c5033d249fe922db16768b71b4a6b26cfd93d206fbf66c76efb5f",
    },
    VoiceFile {
        name: "voices.bin",
        bytes: 53_790_720,
        sha256: "e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c",
    },
    VoiceFile {
        name: "tokens.txt",
        bytes: 1_111,
        sha256: "931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14",
    },
    VoiceFile {
        name: "lexicon-us-en.txt",
        bytes: 5_956_885,
        sha256: "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14",
    },
    VoiceFile {
        name: "lexicon-zh.txt",
        bytes: 2_120_131,
        sha256: "fea060803db3e59193987f1a3436f56917bda09f3b3595b6588e46ae60cebf93",
    },
];

/// Route a formatted message through the interface language without borrowing
/// a temporary, which `general::pick` cannot do.
fn message(zh: String, en: String) -> String {
    if general::is_chinese() {
        zh
    } else {
        en
    }
}

fn installed(dir: &Path) -> bool {
    dir.is_dir()
        && [
            "model.onnx",
            "voices.bin",
            "tokens.txt",
            "lexicon-us-en.txt",
            "lexicon-zh.txt",
        ]
        .iter()
        .all(|name| dir.join(name).is_file())
}

/* ------------------------------------------------------------------------- */
/* Settings                                                                  */
/* ------------------------------------------------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceSettings {
    /// Voiceover is off by default; it only reads translations.
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelInfo {
    pub id: &'static str,
    pub title: String,
    pub note: String,
    pub bytes: u64,
    pub installed: bool,
    pub downloading: bool,
    pub dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettingsView {
    pub settings: VoiceSettings,
    pub model: VoiceModelInfo,
    pub models_root: String,
}

/* ------------------------------------------------------------------------- */
/* Service                                                                   */
/* ------------------------------------------------------------------------- */

pub struct VoiceService {
    settings: RwLock<VoiceSettings>,
    settings_path: PathBuf,
    root: PathBuf,
    /// Loaded lazily on the first sentence; loading a 325 MB graph takes a few
    /// seconds, so it must not happen per sentence.
    engine: Mutex<Option<Arc<OfflineTts>>>,
    download: Mutex<Option<Arc<AtomicBool>>>,
}

impl VoiceService {
    pub fn start(app: &AppHandle) -> Self {
        let settings_path = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("voice.json"))
            .unwrap_or_else(|_| PathBuf::from("voice.json"));
        let settings = load_settings(&settings_path);
        let root = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("models").join("tts"))
            .unwrap_or_else(|_| PathBuf::from("models").join("tts"));
        let _ = fs::create_dir_all(&root);
        Self {
            settings: RwLock::new(settings),
            settings_path,
            root,
            engine: Mutex::new(None),
            download: Mutex::new(None),
        }
    }

    fn model_dir(&self) -> PathBuf {
        self.root.join(MODEL_ID)
    }

    pub fn view(&self) -> VoiceSettingsView {
        let settings = self
            .settings
            .read()
            .map(|value| value.clone())
            .unwrap_or_default();
        let dir = self.model_dir();
        VoiceSettingsView {
            settings,
            model: VoiceModelInfo {
                id: MODEL_ID,
                title: general::pick(
                    "Kokoro v1.1 · 中英双语",
                    "Kokoro v1.1 · Chinese–English",
                )
                .to_string(),
                note: general::pick(
                    "在本机运行，不上传任何内容。支持中文和英文；RSI 这类短缩写会拆成字母朗读，词典里没有的其他英文单词会被跳过。",
                    "Runs on this machine and uploads nothing. Speaks Chinese and English; short acronyms such as RSI are spelled out, and English words missing from the lexicon are skipped.",
                )
                .to_string(),
                bytes: TOTAL_BYTES,
                installed: installed(&dir),
                downloading: self.is_downloading(),
                dir: dir.display().to_string(),
            },
            models_root: self.root.display().to_string(),
        }
    }

    pub fn save(&self, settings: VoiceSettings) -> Result<VoiceSettingsView, String> {
        if settings.enabled && !installed(&self.model_dir()) {
            return Err(general::pick(
                "先下载上面的语音模型，才能打开朗读。",
                "Download the voice model above before turning voiceover on.",
            )
            .to_string());
        }
        write_settings(&self.settings_path, &settings)?;
        *self.settings.write().map_err(|_| {
            general::pick("配音设置锁已损坏", "Voice settings lock is poisoned").to_string()
        })? = settings;
        Ok(self.view())
    }

    pub fn download(
        &self,
        app: &AppHandle,
        channel: Channel<VoiceDownloadEvent>,
    ) -> Result<(), String> {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut slot = self.download.lock().map_err(|_| {
                general::pick("下载锁已损坏", "Download lock is poisoned").to_string()
            })?;
            if slot.is_some() {
                return Err(general::pick(
                    "语音模型正在下载",
                    "The voice model is already downloading",
                )
                .to_string());
            }
            *slot = Some(Arc::clone(&flag));
        }

        let root = self.root.clone();
        let app_handle = app.clone();
        thread::Builder::new()
            .name("sabir-voice-download".to_string())
            .spawn(move || {
                let outcome = download_model(&root, &flag, &mut |event| {
                    let _ = channel.send(event);
                });
                if let Some(service) = app_handle.try_state::<Arc<VoiceService>>() {
                    if let Ok(mut slot) = service.download.lock() {
                        *slot = None;
                    }
                    if outcome.is_ok() {
                        if let Ok(mut cache) = service.engine.lock() {
                            *cache = None;
                        }
                    }
                }
                match outcome {
                    Ok(dir) => {
                        let _ = channel.send(VoiceDownloadEvent::Done {
                            dir: dir.display().to_string(),
                        });
                    }
                    Err(err) if err == CANCELLED => {
                        let _ = channel.send(VoiceDownloadEvent::Cancelled);
                    }
                    Err(err) => {
                        let _ = channel.send(VoiceDownloadEvent::Error { message: err });
                    }
                }
            })
            .map_err(|err| format!("voice download thread failed: {err}"))?;

        Ok(())
    }

    pub fn cancel(&self) {
        if let Ok(slot) = self.download.lock() {
            if let Some(flag) = slot.as_ref() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    fn is_downloading(&self) -> bool {
        self.download
            .lock()
            .map(|slot| slot.is_some())
            .unwrap_or(false)
    }

    pub fn delete(&self) -> Result<VoiceSettingsView, String> {
        self.cancel();
        let dir = self.model_dir();
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|err| {
                message(
                    format!("删除语音模型失败：{err}"),
                    format!("Could not delete the voice model: {err}"),
                )
            })?;
        }
        if let Ok(mut cache) = self.engine.lock() {
            *cache = None;
        }
        let current = self
            .settings
            .read()
            .map(|value| value.clone())
            .unwrap_or_default();
        if current.enabled {
            let next = VoiceSettings { enabled: false };
            let _ = write_settings(&self.settings_path, &next);
            if let Ok(mut guard) = self.settings.write() {
                *guard = next;
            }
        }
        Ok(self.view())
    }

    /// Synthesise one sentence and return a base64 WAV (mono, 16-bit PCM).
    pub fn synthesize(&self, text: &str, lang: &str) -> Result<String, String> {
        let clean = text.replace('\0', "");
        let clean = clean.trim();
        if clean.is_empty() {
            return Ok(String::new());
        }
        let clean: String = clean.chars().take(MAX_CHARS).collect();
        let engine = self.engine()?;
        let sid = if lang.trim().to_ascii_lowercase().starts_with("en") {
            EN_SID
        } else {
            ZH_SID
        };
        let config = GenerationConfig {
            sid,
            speed: 1.0,
            ..Default::default()
        };
        let audio = engine
            .generate_with_config(&clean, &config, None::<fn(&[f32], f32) -> bool>)
            .ok_or_else(|| {
                general::pick(
                    "语音合成失败，请换一句试试。",
                    "Speech synthesis failed; try another sentence.",
                )
                .to_string()
            })?;
        Ok(base64(&wav_bytes(audio.samples(), audio.sample_rate())))
    }

    fn engine(&self) -> Result<Arc<OfflineTts>, String> {
        let mut cache = self.engine.lock().map_err(|_| {
            general::pick("语音引擎锁已损坏", "Voice engine lock is poisoned").to_string()
        })?;
        if let Some(engine) = cache.as_ref() {
            return Ok(Arc::clone(engine));
        }
        let dir = self.model_dir();
        if !installed(&dir) {
            return Err(general::pick(
                "还没有下载语音模型，打开设置 → 配音下载一个。",
                "No voice model yet; download one in Settings → Voiceover.",
            )
            .to_string());
        }
        let path = |name: &str| dir.join(name).display().to_string();
        let config = OfflineTtsConfig {
            model: OfflineTtsModelConfig {
                kokoro: OfflineTtsKokoroModelConfig {
                    model: Some(path("model.onnx")),
                    voices: Some(path("voices.bin")),
                    tokens: Some(path("tokens.txt")),
                    lexicon: Some(format!(
                        "{},{}",
                        path("lexicon-us-en.txt"),
                        path("lexicon-zh.txt")
                    )),
                    length_scale: 1.0,
                    ..Default::default()
                },
                num_threads: 2,
                ..Default::default()
            },
            ..Default::default()
        };
        let engine = OfflineTts::create(&config).ok_or_else(|| {
            general::pick(
                "无法加载语音模型，请重新下载。",
                "Could not load the voice model; download it again.",
            )
            .to_string()
        })?;
        let engine = Arc::new(engine);
        *cache = Some(Arc::clone(&engine));
        Ok(engine)
    }
}

/* ------------------------------------------------------------------------- */
/* Download                                                                  */
/* ------------------------------------------------------------------------- */

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum VoiceDownloadEvent {
    Progress {
        file: String,
        file_index: usize,
        file_total: usize,
        downloaded: u64,
        total: u64,
    },
    Done {
        dir: String,
    },
    Error {
        message: String,
    },
    Cancelled,
}

fn download_model(
    root: &Path,
    flag: &AtomicBool,
    on_event: &mut dyn FnMut(VoiceDownloadEvent),
) -> Result<PathBuf, String> {
    let dir = root.join(MODEL_ID);
    fs::create_dir_all(&dir).map_err(|err| {
        message(
            format!("无法创建模型目录：{err}"),
            format!("Could not create the model folder: {err}"),
        )
    })?;

    let client = download::client()?;
    let base = download::pick_base(&client, REPO, "tokens.txt")?;
    let mut done_bytes: u64 = 0;

    for (index, file) in FILES.iter().enumerate() {
        if flag.load(Ordering::SeqCst) {
            return Err(CANCELLED.to_string());
        }
        let remote = download::RemoteFile {
            remote: file.name,
            local: file.name,
            bytes: file.bytes,
            sha256: file.sha256,
        };
        download::fetch_file(&client, &base, REPO, &remote, &dir, flag, &mut |written| {
            on_event(VoiceDownloadEvent::Progress {
                file: file.name.to_string(),
                file_index: index,
                file_total: FILES.len(),
                downloaded: done_bytes + written,
                total: TOTAL_BYTES,
            });
        })?;
        done_bytes += file.bytes;
        on_event(VoiceDownloadEvent::Progress {
            file: file.name.to_string(),
            file_index: index,
            file_total: FILES.len(),
            downloaded: done_bytes,
            total: TOTAL_BYTES,
        });
    }

    if !installed(&dir) {
        return Err(general::pick(
            "下载完成，但模型文件不完整，请重试。",
            "The download finished but the model is incomplete; try again.",
        )
        .to_string());
    }
    Ok(dir)
}

/* ------------------------------------------------------------------------- */
/* Settings file                                                             */
/* ------------------------------------------------------------------------- */

fn load_settings(path: &Path) -> VoiceSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_settings(path: &Path, settings: &VoiceSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|err| {
        message(
            format!("写设置失败：{err}"),
            format!("Could not write settings: {err}"),
        )
    })?;
    fs::rename(&tmp, path).map_err(|err| {
        message(
            format!("写设置失败：{err}"),
            format!("Could not write settings: {err}"),
        )
    })
}

/* ------------------------------------------------------------------------- */
/* Audio encoding                                                            */
/* ------------------------------------------------------------------------- */

fn wav_bytes(samples: &[f32], sample_rate: i32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let rate = sample_rate.max(1) as u32;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        out.push(TABLE[(first >> 2) as usize] as char);
        out.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(third & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/* ------------------------------------------------------------------------- */
/* Commands                                                                  */
/* ------------------------------------------------------------------------- */

#[tauri::command]
pub fn get_voice_settings(state: State<'_, Arc<VoiceService>>) -> VoiceSettingsView {
    state.view()
}

#[tauri::command]
pub fn save_voice_settings(
    state: State<'_, Arc<VoiceService>>,
    settings: VoiceSettings,
) -> Result<VoiceSettingsView, String> {
    state.save(settings)
}

#[tauri::command]
pub fn download_voice_model(
    app: AppHandle,
    state: State<'_, Arc<VoiceService>>,
    channel: Channel<VoiceDownloadEvent>,
) -> Result<(), String> {
    state.download(&app, channel)
}

#[tauri::command]
pub fn cancel_voice_download(state: State<'_, Arc<VoiceService>>) {
    state.cancel();
}

#[tauri::command]
pub fn delete_voice_model(state: State<'_, Arc<VoiceService>>) -> Result<VoiceSettingsView, String> {
    state.delete()
}

/// Synthesise one translated sentence; returns a base64 WAV. Runs off the main
/// thread because the first call also loads the model.
#[tauri::command]
pub async fn synthesize_voice(
    state: State<'_, Arc<VoiceService>>,
    text: String,
    lang: String,
) -> Result<String, String> {
    let service = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || service.synthesize(&text, &lang))
        .await
        .map_err(|err| {
            message(
                format!("语音合成线程失败：{err}"),
                format!("Speech synthesis thread failed: {err}"),
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_has_a_riff_header_and_pcm_samples() {
        let wav = wav_bytes(&[0.0, 1.0, -1.0], 24_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(wav.len(), 44 + 6);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24_000);
        assert_eq!(i16::from_le_bytes(wav[46..48].try_into().unwrap()), 32767);
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn empty_directory_is_not_installed() {
        let dir = std::env::temp_dir().join("sabir-voice-empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!installed(&dir));
        for file in FILES {
            fs::write(dir.join(file.name), b"x").unwrap();
        }
        assert!(installed(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_default_to_off_and_round_trip() {
        let path = std::env::temp_dir().join("sabir-voice-settings.json");
        let _ = fs::remove_file(&path);
        assert!(!load_settings(&path).enabled);
        write_settings(&path, &VoiceSettings { enabled: true }).unwrap();
        assert!(load_settings(&path).enabled);
        let _ = fs::remove_file(&path);
    }

    #[test]
    #[ignore = "downloads ~370MB from the network; run with --ignored"]
    fn downloads_and_synthesises_a_sentence() {
        let root = std::env::temp_dir().join("sabir-voice-download-test");
        let _ = fs::remove_dir_all(&root);
        let flag = AtomicBool::new(false);
        let mut last: Option<VoiceDownloadEvent> = None;
        let dir = download_model(&root, &flag, &mut |event| last = Some(event))
            .expect("download should succeed");
        assert!(installed(&dir));
        assert!(matches!(last, Some(VoiceDownloadEvent::Progress { .. })));

        let service = VoiceService {
            settings: RwLock::new(VoiceSettings::default()),
            settings_path: root.join("voice.json"),
            root: root.clone(),
            engine: Mutex::new(None),
            download: Mutex::new(None),
        };
        let audio = service
            .synthesize("你好，世界。This is a test.", "zh")
            .expect("synthesis should succeed");
        assert!(audio.starts_with("UklGR"), "expected a base64 RIFF header");
        assert!(audio.len() > 10_000, "audio looks too short");
        let _ = fs::remove_dir_all(&root);
    }
}
