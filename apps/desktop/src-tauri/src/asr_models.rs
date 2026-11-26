//! Recognition model catalogue, on-demand download, and ASR settings.
//!
//! Models are no longer shipped inside the installer: the app downloads them
//! into its own data directory when the user asks, and the engine resolves the
//! selected one at start-up. Only model weights travel over the network here;
//! audio and transcript text never leave the machine.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::download::{self, CANCELLED};
use crate::general;

/// Prefix used in the start-up error so the UI can open the recognition page.
pub const NO_MODEL_CODE: &str = "no_asr_model";

/* ------------------------------------------------------------------------- */
/* Catalogue                                                                 */
/* ------------------------------------------------------------------------- */

#[derive(Clone, Copy)]
pub struct ModelFile {
    pub name: &'static str,
    pub bytes: u64,
    /// SHA-256 from the repository's LFS metadata (or hashed from the published
    /// file for small non-LFS entries), used to reject corrupt downloads.
    pub sha256: &'static str,
}

/// Streaming transducers emit words while the speaker is still talking;
/// Whisper models decode a whole VAD-cut sentence at once.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    Streaming,
    Whisper,
}

impl ModelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelKind::Streaming => "streaming",
            ModelKind::Whisper => "whisper",
        }
    }
}

#[derive(Clone, Copy)]
pub struct ModelDef {
    pub id: &'static str,
    pub title: &'static str,
    pub title_en: &'static str,
    pub note: &'static str,
    pub note_en: &'static str,
    pub repo: &'static str,
    pub bytes: u64,
    pub recommended: bool,
    pub kind: ModelKind,
    pub files: &'static [ModelFile],
}

const BILINGUAL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder-epoch-99-avg-1.int8.onnx",
        bytes: 181_895_032,
        sha256: "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b",
    },
    ModelFile {
        name: "decoder-epoch-99-avg-1.onnx",
        bytes: 13_876_452,
        sha256: "2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d",
    },
    ModelFile {
        name: "joiner-epoch-99-avg-1.int8.onnx",
        bytes: 3_228_404,
        sha256: "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0",
    },
    ModelFile {
        name: "tokens.txt",
        bytes: 56_317,
        sha256: "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
    },
];

const EN_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        bytes: 71_082_637,
        sha256: "0d072fd4ef956294ba9db9e9a71a541ac70659095ec4934c8453d8b2fe740187",
    },
    ModelFile {
        name: "decoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        bytes: 1_307_236,
        sha256: "98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02",
    },
    ModelFile {
        name: "joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        bytes: 259_335,
        sha256: "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297",
    },
    ModelFile {
        name: "tokens.txt",
        bytes: 5_048,
        sha256: "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb",
    },
];

const ZH14M_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder-epoch-99-avg-1.int8.onnx",
        bytes: 21_621_684,
        sha256: "1c556ea57cec304e55ec4b72e52c1cc098bb01476ed7d90f3de939fe126487b1",
    },
    ModelFile {
        name: "decoder-epoch-99-avg-1.onnx",
        bytes: 7_509_745,
        sha256: "5ee0f03a2768ff1d5c83ef3a493243c7935d316cd41280037b14783a3467cc78",
    },
    ModelFile {
        name: "joiner-epoch-99-avg-1.int8.onnx",
        bytes: 1_795_562,
        sha256: "a7cf9d82757bdcf786059454495a9ca95e4bd7347f72473fc08d794475c36169",
    },
    ModelFile {
        name: "tokens.txt",
        bytes: 48_697,
        sha256: "8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac",
    },
];

const WHISPER_TURBO_FILES: &[ModelFile] = &[
    ModelFile {
        name: "turbo-encoder.int8.onnx",
        bytes: 674_716_297,
        sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b",
    },
    ModelFile {
        name: "turbo-decoder.int8.onnx",
        bytes: 361_080_764,
        sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547",
    },
    ModelFile {
        name: "turbo-tokens.txt",
        bytes: 816_730,
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
    },
];

const WHISPER_SMALL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "small-encoder.int8.onnx",
        bytes: 112_442_483,
        sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9",
    },
    ModelFile {
        name: "small-decoder.int8.onnx",
        bytes: 262_226_114,
        sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee",
    },
    ModelFile {
        name: "small-tokens.txt",
        bytes: 816_730,
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
    },
];

pub const CATALOG: &[ModelDef] = &[
    ModelDef {
        id: "bilingual-zh-en",
        title: "中英双语 Zipformer",
        title_en: "Bilingual Chinese–English Zipformer",
        note: "边说边出字，中英文自动混识，通用场景首选。",
        note_en: "Text appears as you speak; detects Chinese and English automatically. The default for general use.",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        bytes: 199_056_205,
        recommended: true,
        kind: ModelKind::Streaming,
        files: BILINGUAL_FILES,
    },
    ModelDef {
        id: "en-streaming",
        title: "英文 Zipformer",
        title_en: "English Zipformer",
        note: "只识别英文，体积更小、延迟更低，适合纯英文课程。",
        note_en: "English only; smaller and faster, good for English-only courses.",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
        bytes: 72_654_256,
        recommended: false,
        kind: ModelKind::Streaming,
        files: EN_FILES,
    },
    ModelDef {
        id: "zh-14m",
        title: "中文轻量 Zipformer",
        title_en: "Lightweight Chinese Zipformer",
        note: "低配电脑或只看中文会议时用，占内存最少。",
        note_en: "For low-end machines or Chinese-only meetings; uses the least memory.",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
        bytes: 30_975_688,
        recommended: false,
        kind: ModelKind::Streaming,
        files: ZH14M_FILES,
    },
    ModelDef {
        id: "whisper-turbo",
        title: "Whisper Large v3 Turbo",
        title_en: "Whisper Large v3 Turbo",
        note: "整段识别：说完整句、停顿片刻后出字，中英混说和多语种准确率最高。体积约 1 GB，CPU 解码每句再花约一秒。",
        note_en: "Segment recognition: text appears after a full sentence and a short pause; best accuracy for mixed Chinese–English and many languages. About 1 GB; CPU decoding adds about a second per sentence.",
        repo: "csukuangfj/sherpa-onnx-whisper-turbo",
        bytes: 1_036_613_791,
        recommended: false,
        kind: ModelKind::Whisper,
        files: WHISPER_TURBO_FILES,
    },
    ModelDef {
        id: "whisper-small",
        title: "Whisper Small",
        title_en: "Whisper Small",
        note: "整段识别，轻量多语种模型，下载和内存占用都小，准确率低于 Turbo。",
        note_en: "Segment recognition; a small multilingual model with a light download and memory footprint, less accurate than Turbo.",
        repo: "csukuangfj/sherpa-onnx-whisper-small",
        bytes: 375_485_327,
        recommended: false,
        kind: ModelKind::Whisper,
        files: WHISPER_SMALL_FILES,
    },
];

/* ------------------------------------------------------------------------- */
/* Settings                                                                  */
/* ------------------------------------------------------------------------- */

fn default_language() -> String {
    "auto".to_string()
}

fn default_threads() -> i32 {
    2
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSettings {
    /// Catalogue id, or an absolute directory chosen by the user.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_threads")]
    pub threads: i32,
    /// Where downloads land; `None` means the app data directory.
    #[serde(default)]
    pub models_root: Option<String>,
}

impl Default for AsrSettings {
    fn default() -> Self {
        Self {
            model: None,
            language: default_language(),
            threads: default_threads(),
            models_root: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrModelInfo {
    pub id: &'static str,
    pub title: String,
    pub note: String,
    pub bytes: u64,
    pub recommended: bool,
    pub kind: &'static str,
    pub installed: bool,
    pub downloading: bool,
    pub dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSettingsView {
    pub settings: AsrSettings,
    pub models: Vec<AsrModelInfo>,
    pub selected_dir: Option<String>,
    pub models_root: String,
    pub ready: bool,
}

/* ------------------------------------------------------------------------- */
/* Model files                                                               */
/* ------------------------------------------------------------------------- */

pub struct StreamingFiles {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

pub struct WhisperFiles {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub tokens: PathBuf,
    /// The VAD graph ships with the app; a model directory may also carry its
    /// own copy, which then wins.
    pub vad: Option<PathBuf>,
    /// `None` lets Whisper detect the language from each segment.
    pub language: Option<String>,
}

pub enum ModelFiles {
    Streaming(StreamingFiles),
    Whisper(WhisperFiles),
}

/// Pick the encoder / decoder / joiner / tokens files out of a directory.
///
/// The int8 encoder and joiner are preferred (they are what the exported
/// models ship for CPU); the decoder prefers the float graph when both exist.
/// A directory with a joiner is a streaming Zipformer; without one but with a
/// VAD graph or a `*-tokens.txt` file it is treated as Whisper.
pub fn discover(dir: &Path) -> Option<ModelFiles> {
    if !dir.is_dir() {
        return None;
    }

    let pick = |prefix: &str, prefer_int8: bool| -> Option<PathBuf> {
        let mut best: Option<(bool, PathBuf)> = None;
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            // Whisper files carry a family prefix ("turbo-encoder.int8.onnx"),
            // streaming ones start with the role name directly.
            if !name.contains(prefix) || !name.ends_with(".onnx") {
                continue;
            }
            let int8 = name.contains(".int8.");
            let better = match &best {
                None => true,
                Some((best_int8, _)) => int8 != *best_int8 && int8 == prefer_int8,
            };
            if better {
                best = Some((int8, entry.path()));
            }
        }
        best.map(|(_, path)| path)
    };

    let encoder = pick("encoder", true)?;
    let decoder = pick("decoder", false)?;

    if let Some(joiner) = pick("joiner", true) {
        let tokens = dir.join("tokens.txt");
        if !tokens.is_file() {
            return None;
        }
        return Some(ModelFiles::Streaming(StreamingFiles {
            encoder,
            decoder,
            joiner,
            tokens,
        }));
    }

    let tokens = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .find(|name| name == "tokens.txt" || name.ends_with("-tokens.txt"))?;
    let tokens = dir.join(tokens);
    if !tokens.is_file() {
        return None;
    }
    let vad = dir.join("silero_vad.onnx");
    Some(ModelFiles::Whisper(WhisperFiles {
        encoder,
        decoder,
        tokens,
        vad: vad.is_file().then_some(vad),
        language: None,
    }))
}

/* ------------------------------------------------------------------------- */
/* Service                                                                   */
/* ------------------------------------------------------------------------- */

pub struct AsrService {
    settings: RwLock<AsrSettings>,
    settings_path: PathBuf,
    /// Fallback download root when `settings.modelsRoot` is unset.
    default_root: PathBuf,
    /// Bundled Silero VAD graph, needed only by Whisper models.
    vad: Option<PathBuf>,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AsrService {
    pub fn start(app: &AppHandle) -> Self {
        let settings_path = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("asr.json"))
            .unwrap_or_else(|_| PathBuf::from("asr.json"));
        let settings = load_settings(&settings_path);
        let root = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("models").join("asr"))
            .unwrap_or_else(|_| PathBuf::from("models").join("asr"));
        let _ = fs::create_dir_all(&root);
        Self {
            settings: RwLock::new(settings),
            settings_path,
            default_root: root,
            vad: resolve_vad(app),
            downloads: Mutex::new(HashMap::new()),
        }
    }

    /// Download root chosen in settings, else the app data directory.
    fn root(&self, settings: &AsrSettings) -> PathBuf {
        match settings.models_root.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => self.default_root.clone(),
        }
    }

    fn current_root(&self) -> PathBuf {
        self.settings
            .read()
            .map(|settings| self.root(&settings))
            .unwrap_or_else(|_| self.default_root.clone())
    }

    fn selected_dir(&self) -> Option<PathBuf> {
        let settings = self.settings.read().ok()?;
        let value = settings.model.clone()?;
        let candidate =
            if Path::new(&value).is_absolute() || value.contains('\\') || value.contains('/') {
                PathBuf::from(value)
            } else {
                self.root(&settings).join(value)
            };
        discover(&candidate).map(|_| candidate)
    }

    /// Resolve the directory the engine should load. Besides the selection in
    /// `asr.json`, a development checkout and `SABIR_MODEL_DIR` are honoured
    /// so `cargo run` keeps working without downloading anything.
    pub fn resolve_dir(&self) -> Option<PathBuf> {
        if let Some(dir) = self.selected_dir() {
            return Some(dir);
        }

        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = std::env::var("SABIR_MODEL_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        // `cargo run` should keep working against the checkout's sample model;
        // a release build must never reach for the build machine's source tree.
        if cfg!(debug_assertions) {
            candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models"));
        }
        candidates.into_iter().find(|dir| discover(dir).is_some())
    }

    pub fn engine_model(&self) -> Result<(ModelFiles, i32), String> {
        let dir = self.resolve_dir().ok_or_else(no_model_error)?;
        let files = discover(&dir).ok_or_else(no_model_error)?;
        let (language, threads) = self
            .settings
            .read()
            .map(|settings| (settings.language.clone(), settings.threads.clamp(1, 8)))
            .unwrap_or_else(|_| (default_language(), default_threads()));
        let files = match files {
            ModelFiles::Streaming(files) => ModelFiles::Streaming(files),
            ModelFiles::Whisper(mut files) => {
                files.vad = Some(files.vad.or_else(|| self.vad.clone()).ok_or_else(|| {
                    "没有找到语音活动检测模型 silero_vad.onnx，请重新安装应用。".to_string()
                })?);
                files.language = match language.as_str() {
                    "" | "auto" => None,
                    other => Some(other.to_string()),
                };
                ModelFiles::Whisper(files)
            }
        };
        Ok((files, threads))
    }

    /// Human-readable model name for the session history ("whisper-small",
    /// "bilingual-zh-en", or the custom directory's last path segment).
    pub fn model_label(&self) -> String {
        self.resolve_dir()
            .and_then(|dir| {
                dir.file_name()
                    .map(|name| name.to_string_lossy().to_string())
            })
            .or_else(|| {
                self.settings
                    .read()
                    .ok()
                    .and_then(|settings| settings.model.clone())
            })
            .unwrap_or_else(|| "asr".to_string())
    }

    pub fn view(&self) -> AsrSettingsView {
        let settings = self
            .settings
            .read()
            .map(|value| value.clone())
            .unwrap_or_default();
        let selected_dir = self.resolve_dir().map(|path| path.display().to_string());
        let root = self.root(&settings);
        let models = CATALOG
            .iter()
            .map(|def| {
                let dir = root.join(def.id);
                AsrModelInfo {
                    id: def.id,
                    title: general::pick(def.title, def.title_en).to_string(),
                    note: general::pick(def.note, def.note_en).to_string(),
                    bytes: def.bytes,
                    recommended: def.recommended,
                    kind: def.kind.as_str(),
                    installed: discover(&dir).is_some(),
                    downloading: self.is_downloading(def.id),
                    dir: dir.display().to_string(),
                }
            })
            .collect();
        AsrSettingsView {
            ready: selected_dir.is_some(),
            settings,
            models,
            selected_dir,
            models_root: root.display().to_string(),
        }
    }

    pub fn save(&self, mut settings: AsrSettings) -> Result<AsrSettingsView, String> {
        settings.threads = settings.threads.clamp(1, 8);
        if settings.language.is_empty() {
            settings.language = default_language();
        }
        settings.models_root = settings
            .models_root
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(root) = settings.models_root.as_deref() {
            let _ = fs::create_dir_all(root);
        }
        write_settings(&self.settings_path, &settings)?;
        *self
            .settings
            .write()
            .map_err(|_| "识别设置锁已损坏".to_string())? = settings;
        Ok(self.view())
    }

    pub fn download(
        &self,
        app: &AppHandle,
        model_id: &str,
        channel: Channel<AsrDownloadEvent>,
    ) -> Result<(), String> {
        let def = CATALOG
            .iter()
            .find(|def| def.id == model_id)
            .ok_or_else(|| format!("未知模型：{model_id}"))?;

        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut downloads = self
                .downloads
                .lock()
                .map_err(|_| "下载锁已损坏".to_string())?;
            if downloads.contains_key(model_id) {
                return Err("这个模型正在下载".to_string());
            }
            downloads.insert(model_id.to_string(), Arc::clone(&flag));
        }

        let id = model_id.to_string();
        let app_handle = app.clone();
        let root = self.current_root();
        thread::Builder::new()
            .name(format!("sabir-download-{id}"))
            .spawn(move || {
                let outcome = download_model(def, &root, &flag, &mut |event| {
                    let _ = channel.send(event);
                });
                if let Some(service) = app_handle.try_state::<AsrService>() {
                    if let Ok(mut downloads) = service.downloads.lock() {
                        downloads.remove(&id);
                    }
                }
                match outcome {
                    Ok(dir) => {
                        let _ = channel.send(AsrDownloadEvent::Done {
                            model_id: id,
                            dir: dir.display().to_string(),
                        });
                    }
                    Err(err) if err == CANCELLED => {
                        let _ = channel.send(AsrDownloadEvent::Cancelled { model_id: id });
                    }
                    Err(err) => {
                        let _ = channel.send(AsrDownloadEvent::Error {
                            model_id: id,
                            message: err,
                        });
                    }
                }
            })
            .map_err(|err| format!("下载线程启动失败：{err}"))?;

        Ok(())
    }

    pub fn cancel(&self, model_id: &str) {
        if let Ok(downloads) = self.downloads.lock() {
            if let Some(flag) = downloads.get(model_id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn is_downloading(&self, model_id: &str) -> bool {
        self.downloads
            .lock()
            .map(|downloads| downloads.contains_key(model_id))
            .unwrap_or(false)
    }

    pub fn delete(&self, model_id: &str) -> Result<AsrSettingsView, String> {
        if !CATALOG.iter().any(|def| def.id == model_id) {
            return Err(format!("未知模型：{model_id}"));
        }
        self.cancel(model_id);
        let dir = self.current_root().join(model_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|err| format!("删除模型失败：{err}"))?;
        }
        let selected = self
            .settings
            .read()
            .ok()
            .and_then(|settings| settings.model.clone());
        if selected.as_deref() == Some(model_id) {
            let mut next = self
                .settings
                .read()
                .map(|settings| settings.clone())
                .unwrap_or_default();
            next.model = None;
            let _ = write_settings(&self.settings_path, &next);
            if let Ok(mut guard) = self.settings.write() {
                *guard = next;
            }
        }
        Ok(self.view())
    }
}

fn no_model_error() -> String {
    format!("{NO_MODEL_CODE}: 还没有可用的识别模型，打开设置 → 识别下载一个。")
}

/// Locate the bundled Silero VAD graph: next to the installed executable, or
/// in the source tree while running `cargo run`.
fn resolve_vad(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("silero_vad.onnx"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("silero_vad.onnx"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/vad/silero_vad.onnx"));
    candidates.into_iter().find(|path| path.is_file())
}

/* ------------------------------------------------------------------------- */
/* Download                                                                  */
/* ------------------------------------------------------------------------- */

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AsrDownloadEvent {
    Progress {
        model_id: String,
        file: String,
        file_index: usize,
        file_total: usize,
        downloaded: u64,
        total: u64,
    },
    Done {
        model_id: String,
        dir: String,
    },
    Error {
        model_id: String,
        message: String,
    },
    Cancelled {
        model_id: String,
    },
}

fn download_model(
    def: &ModelDef,
    root: &Path,
    flag: &AtomicBool,
    on_event: &mut dyn FnMut(AsrDownloadEvent),
) -> Result<PathBuf, String> {
    let dir = root.join(def.id);
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建模型目录：{err}"))?;

    let client = download::client()?;
    // Probe with the small vocabulary file rather than a weight blob.
    let probe = def
        .files
        .iter()
        .find(|file| file.name.ends_with("tokens.txt"))
        .map(|file| file.name)
        .unwrap_or("tokens.txt");
    let base = download::pick_base(&client, def.repo, probe)?;
    let mut done_bytes: u64 = 0;

    for (index, file) in def.files.iter().enumerate() {
        if flag.load(Ordering::SeqCst) {
            return Err(CANCELLED.to_string());
        }
        // `fetch_file` skips a file that is already present *and* matches its
        // checksum, so a re-download also repairs a corrupt copy.
        let remote = download::RemoteFile {
            remote: file.name,
            local: file.name,
            bytes: file.bytes,
            sha256: file.sha256,
        };
        download::fetch_file(&client, &base, def.repo, &remote, &dir, flag, &mut |written| {
            on_event(AsrDownloadEvent::Progress {
                model_id: def.id.to_string(),
                file: file.name.to_string(),
                file_index: index,
                file_total: def.files.len(),
                downloaded: done_bytes + written,
                total: def.bytes,
            });
        })?;
        done_bytes += file.bytes;
        on_event(AsrDownloadEvent::Progress {
            model_id: def.id.to_string(),
            file: file.name.to_string(),
            file_index: index,
            file_total: def.files.len(),
            downloaded: done_bytes,
            total: def.bytes,
        });
    }

    if discover(&dir).is_none() {
        return Err("下载完成，但模型文件不完整，请重试。".to_string());
    }
    Ok(dir)
}

/* ------------------------------------------------------------------------- */
/* Settings file                                                             */
/* ------------------------------------------------------------------------- */

fn load_settings(path: &Path) -> AsrSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_settings(path: &Path, settings: &AsrSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|err| format!("写设置失败：{err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("写设置失败：{err}"))
}

/* ------------------------------------------------------------------------- */
/* Commands                                                                  */
/* ------------------------------------------------------------------------- */

#[tauri::command]
pub fn get_asr_settings(state: State<'_, AsrService>) -> AsrSettingsView {
    state.view()
}

#[tauri::command]
pub fn save_asr_settings(
    state: State<'_, AsrService>,
    settings: AsrSettings,
) -> Result<AsrSettingsView, String> {
    state.save(settings)
}

#[tauri::command]
pub fn list_asr_models(state: State<'_, AsrService>) -> AsrSettingsView {
    state.view()
}

#[tauri::command]
pub fn download_asr_model(
    app: AppHandle,
    state: State<'_, AsrService>,
    model_id: String,
    channel: Channel<AsrDownloadEvent>,
) -> Result<(), String> {
    state.download(&app, &model_id, channel)
}

#[tauri::command]
pub fn cancel_asr_download(state: State<'_, AsrService>, model_id: String) {
    state.cancel(&model_id);
}

#[tauri::command]
pub fn delete_asr_model(
    state: State<'_, AsrService>,
    model_id: String,
) -> Result<AsrSettingsView, String> {
    state.delete(&model_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_int8_encoder_decoder_joiner() {
        let dir = std::env::temp_dir().join("sabir-discover-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "encoder-x.onnx",
            "encoder-x.int8.onnx",
            "decoder-x.onnx",
            "decoder-x.int8.onnx",
            "joiner-x.int8.onnx",
            "tokens.txt",
        ] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        let files = discover(&dir).expect("discover should find a complete set");
        let ModelFiles::Streaming(files) = files else {
            panic!("joiner directory must be streaming");
        };
        assert!(files.encoder.to_string_lossy().contains(".int8."));
        assert!(!files.decoder.to_string_lossy().contains(".int8."));
        assert!(files.joiner.to_string_lossy().contains(".int8."));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovers_whisper_without_joiner() {
        let dir = std::env::temp_dir().join("sabir-discover-whisper");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "turbo-encoder.int8.onnx",
            "turbo-decoder.int8.onnx",
            "turbo-tokens.txt",
        ] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        let files = discover(&dir).expect("whisper files should be discovered");
        let ModelFiles::Whisper(files) = files else {
            panic!("no joiner means whisper");
        };
        assert!(files.tokens.to_string_lossy().ends_with("turbo-tokens.txt"));
        assert!(files.vad.is_none());
        fs::write(dir.join("silero_vad.onnx"), b"x").unwrap();
        let ModelFiles::Whisper(files) = discover(&dir).unwrap() else {
            panic!("no joiner means whisper");
        };
        assert!(files.vad.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_tokens_means_not_installed() {
        let dir = std::env::temp_dir().join("sabir-discover-incomplete");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for name in ["encoder-x.int8.onnx", "decoder-x.onnx", "joiner-x.int8.onnx"] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        assert!(discover(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_roundtrip() {
        let path = std::env::temp_dir().join("sabir-asr-settings.json");
        let _ = fs::remove_file(&path);
        assert!(load_settings(&path).model.is_none());

        let settings = AsrSettings {
            model: Some("zh-14m".to_string()),
            language: "auto".to_string(),
            threads: 4,
            models_root: None,
        };
        write_settings(&path, &settings).unwrap();
        let loaded = load_settings(&path);
        assert_eq!(loaded.model.as_deref(), Some("zh-14m"));
        assert_eq!(loaded.threads, 4);
        let _ = fs::remove_file(&path);
    }

    #[test]
    #[ignore = "downloads ~358MB from the network; run with --ignored"]
    fn downloads_whisper_small_from_mirror() {
        let root = std::env::temp_dir().join("sabir-whisper-download-test");
        let _ = fs::remove_dir_all(&root);
        let def = CATALOG
            .iter()
            .find(|def| def.id == "whisper-small")
            .unwrap();
        let flag = AtomicBool::new(false);
        let mut last: Option<AsrDownloadEvent> = None;
        let dir = download_model(def, &root, &flag, &mut |event| last = Some(event))
            .expect("download should succeed");
        let files = discover(&dir).expect("downloaded whisper set should be complete");
        assert!(matches!(files, ModelFiles::Whisper(_)));
        assert!(matches!(last, Some(AsrDownloadEvent::Progress { .. })));
        // Keep the directory: engine tests read it through this env var.
        eprintln!("whisper-small dir: {}", dir.display());
    }

    #[test]
    #[ignore = "downloads ~31MB from the network; run with --ignored"]
    fn downloads_zh_14m_from_mirror() {
        let root = std::env::temp_dir().join("sabir-download-test");
        let _ = fs::remove_dir_all(&root);
        let def = CATALOG.iter().find(|def| def.id == "zh-14m").unwrap();
        let flag = AtomicBool::new(false);
        let mut last: Option<AsrDownloadEvent> = None;
        let dir = download_model(def, &root, &flag, &mut |event| last = Some(event))
            .expect("download should succeed");
        assert!(discover(&dir).is_some());
        assert!(matches!(last, Some(AsrDownloadEvent::Progress { .. })));
        let _ = fs::remove_dir_all(&root);
    }
}
