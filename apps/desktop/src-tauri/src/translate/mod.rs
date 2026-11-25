//! Sentence-level translation routing.
//!
//! Finals from the ASR thread land in a serial queue. Each sentence is
//! translated by the primary route the user picked, then — if it fails and
//! fallback is on — by the other local route. Remote providers only run when
//! the user stored a key and explicitly consented; the request goes straight
//! from this process to the provider, never through a Livetrans server.
//!
//! Only the finished sentence (plus a few preceding sentences as context for
//! LLM routes) leaves the machine. Audio never does.

pub mod llm;
pub mod models;
pub mod nmt;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::engine::{EngineEvent, EngineSink};
use crate::general;
use crate::glossary::{self, Glossary};
use llm::LlmEndpoint;
use nmt::NmtTranslator;

const KEYRING_SERVICE: &str = "app.livetrans.desktop";
/// Keyring entry used by the pre-profile single-provider format.
const LEGACY_KEYRING_USER: &str = "translate-api-key";
const PROVIDER_KEYRING_PREFIX: &str = "provider:";
const CONSENT_VERSION: &str = "1";
const MAX_PROVIDERS: usize = 10;
const MAX_PROVIDER_NAME: usize = 40;
const MAX_PROVIDER_ID: usize = 64;

const SYSTEM_PROMPT_PREFIX: &str =
    "你是实时字幕翻译器。把用户给出的句子翻译成";
const SYSTEM_PROMPT_SUFFIX: &str =
    "。只输出译文，不要解释，不要重复原文；保留数字、代码、缩写和专有名词。";

fn target_name(lang: &str) -> &'static str {
    match lang {
        "zh-Hant" => "繁体中文",
        "en" => "英文",
        _ => "简体中文",
    }
}

fn system_prompt(lang: &str, glossary: &Glossary) -> String {
    let mut prompt = format!(
        "{SYSTEM_PROMPT_PREFIX}{}{SYSTEM_PROMPT_SUFFIX}",
        target_name(lang)
    );
    if let Some(block) = glossary.prompt_block() {
        prompt.push_str("\n\n本次会话的背景与术语：\n");
        prompt.push_str(&block);
        prompt.push_str("\n翻译时优先采用术语表给出的译法；场景背景只用于理解，不要输出。");
    }
    prompt
}

const REMOTE_TIMEOUT: Duration = Duration::from_secs(15);
const LOCAL_LLM_TIMEOUT: Duration = Duration::from_secs(20);
const CIRCUIT_FAILURES: u32 = 3;
const CIRCUIT_OPEN: Duration = Duration::from_secs(300);

/* ------------------------------------------------------------------------- */
/* Settings                                                                  */
/* ------------------------------------------------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranslateRoute {
    /// Embedded opus-mt ONNX model, runs in this process.
    Nmt,
    /// OpenAI-compatible runtime on this machine (Ollama, LM Studio, llama.cpp).
    LocalLlm,
    /// OpenAI-compatible provider on the internet, user's own key.
    RemoteLlm,
}

impl TranslateRoute {
    fn id(self) -> &'static str {
        match self {
            Self::Nmt => "nmt",
            Self::LocalLlm => "localLlm",
            Self::RemoteLlm => "remoteLlm",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        match id {
            "nmt" => Some(Self::Nmt),
            "localLlm" => Some(Self::LocalLlm),
            "remoteLlm" => Some(Self::RemoteLlm),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EndpointSettings {
    /// Display name for the route chip ("Ollama", "DeepSeek", …).
    #[serde(default)]
    pub name: String,
    pub base_url: String,
    pub model: String,
}

impl EndpointSettings {
    fn configured(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }

    fn endpoint(&self) -> LlmEndpoint {
        LlmEndpoint {
            base_url: self.base_url.trim().to_string(),
            model: self.model.trim().to_string(),
        }
    }
}

/// One OpenAI-compatible third-party provider. Every profile owns its own
/// key (in the OS keyring) and its own text-sharing consent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    /// Set when the user accepted sending sentence text to this provider.
    pub consent_at: Option<String>,
}

impl ProviderProfile {
    fn configured(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }

    fn endpoint(&self) -> LlmEndpoint {
        LlmEndpoint {
            base_url: self.base_url.trim().to_string(),
            model: self.model.trim().to_string(),
        }
    }
}

fn default_provider() -> ProviderProfile {
    ProviderProfile {
        id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com/v1".to_string(),
        model: "deepseek-chat".to_string(),
        consent_at: None,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslateSettings {
    pub enabled: bool,
    pub route: TranslateRoute,
    pub context_lines: usize,
    pub fallback_to_local: bool,
    pub local_llm: EndpointSettings,
    /// Third-party OpenAI-compatible profiles (max 10).
    pub providers: Vec<ProviderProfile>,
    /// Which profile the remote route and Q&A use.
    pub active_provider_id: String,
    /// Where downloaded models live; `None` means the app data directory.
    pub models_root: Option<String>,
    /// `zh-Hans` (NMT), `zh-Hant` or `en` (LLM routes).
    pub target_lang: String,
    /// Read-only fields from the pre-profile settings file; never written back.
    #[serde(
        rename = "remoteLlm",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    legacy_remote_llm: Option<EndpointSettings>,
    #[serde(
        rename = "remoteConsentAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    legacy_remote_consent_at: Option<String>,
    /// True when this instance was migrated from the single-provider format.
    #[serde(skip)]
    pub(crate) migrated_legacy: bool,
}

impl Default for TranslateSettings {
    fn default() -> Self {
        let provider = default_provider();
        Self {
            enabled: true,
            route: TranslateRoute::Nmt,
            context_lines: 4,
            fallback_to_local: true,
            local_llm: EndpointSettings {
                name: "Ollama".to_string(),
                base_url: "http://127.0.0.1:11434/v1".to_string(),
                model: "qwen2.5:3b".to_string(),
            },
            active_provider_id: provider.id.clone(),
            providers: vec![provider],
            models_root: None,
            target_lang: "zh-Hans".to_string(),
            legacy_remote_llm: None,
            legacy_remote_consent_at: None,
            migrated_legacy: false,
        }
    }
}

impl TranslateSettings {
    /// The selected provider, falling back to the first one if the saved id
    /// no longer exists.
    pub fn active_provider(&self) -> Option<&ProviderProfile> {
        self.providers
            .iter()
            .find(|provider| provider.id == self.active_provider_id)
            .or_else(|| self.providers.first())
    }

    /// Normalize names/ids, migrate the old single-provider fields, and make
    /// sure the active id points at a real profile.
    fn normalized(mut self) -> (Self, bool) {
        let mut migrated = false;
        // The container-level serde default fills `providers` from
        // TranslateSettings::default() when the old file did not have it, so
        // the legacy field decides whether this is a migration.
        if self.providers.is_empty() || self.legacy_remote_llm.is_some() {
            let legacy = self.legacy_remote_llm.take();
            let consent = self
                .legacy_remote_consent_at
                .take()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            migrated = legacy.is_some() || consent.is_some();
            self.providers.clear();
            let endpoint = legacy.unwrap_or_else(|| EndpointSettings {
                name: "DeepSeek".to_string(),
                base_url: "https://api.deepseek.com/v1".to_string(),
                model: "deepseek-chat".to_string(),
            });
            let name = if endpoint.name.trim().is_empty() {
                "第三方服务".to_string()
            } else {
                endpoint.name.trim().to_string()
            };
            self.providers.push(ProviderProfile {
                id: "provider-1".to_string(),
                name,
                base_url: endpoint.base_url.trim().to_string(),
                model: endpoint.model.trim().to_string(),
                consent_at: consent,
            });
            if self.active_provider_id.trim().is_empty() {
                self.active_provider_id = "provider-1".to_string();
            }
        } else {
            self.legacy_remote_llm = None;
            self.legacy_remote_consent_at = None;
        }

        self.providers.truncate(MAX_PROVIDERS);
        let mut used = std::collections::HashSet::new();
        for (index, provider) in self.providers.iter_mut().enumerate() {
            provider.name = provider
                .name
                .trim()
                .chars()
                .take(MAX_PROVIDER_NAME)
                .collect();
            if provider.name.is_empty() {
                provider.name = format!("服务商 {}", index + 1);
            }
            provider.base_url = provider.base_url.trim().to_string();
            provider.model = provider.model.trim().to_string();
            provider.consent_at = provider
                .consent_at
                .take()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());

            let mut id: String = provider
                .id
                .trim()
                .chars()
                .take(MAX_PROVIDER_ID)
                .collect();
            if id.is_empty() {
                id = format!("provider-{}", index + 1);
            }
            if used.contains(&id) {
                id = format!("{id}-{}", index + 1);
            }
            while used.contains(&id) {
                id.push('_');
            }
            used.insert(id.clone());
            provider.id = id;
        }

        if self.providers.is_empty() {
            self.providers.push(default_provider());
        }
        self.active_provider_id = self.active_provider_id.trim().to_string();
        if !self
            .providers
            .iter()
            .any(|provider| provider.id == self.active_provider_id)
        {
            self.active_provider_id = self.providers[0].id.clone();
        }
        self.migrated_legacy = migrated;
        (self, migrated)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSettingsView {
    settings: TranslateSettings,
    /// Which provider ids currently have a key in the OS keyring.
    provider_keys: HashMap<String, bool>,
    nmt_installed: bool,
    nmt_dir: String,
    nmt_root: String,
    nmt_downloading: bool,
    nmt_bytes: u64,
}

/* ------------------------------------------------------------------------- */
/* Failures                                                                  */
/* ------------------------------------------------------------------------- */

#[derive(Clone, Debug)]
pub struct TranslateFailure {
    pub code: String,
    pub message: String,
    #[allow(dead_code)]
    pub detail: String,
}

impl TranslateFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: String::new(),
        }
    }

    pub fn with_detail(
        code: impl Into<String>,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: detail.into(),
        }
    }
}

/* ------------------------------------------------------------------------- */
/* Service                                                                   */
/* ------------------------------------------------------------------------- */

struct Job {
    id: u64,
    text: String,
    context: Vec<String>,
    channel: Option<EngineSink>,
}

impl Job {
    fn send(&self, event: EngineEvent) {
        if let Some(sink) = &self.channel {
            sink.send(event);
        }
    }
}

#[derive(Default)]
struct SessionHistory {
    order: Vec<u64>,
    texts: HashMap<u64, String>,
}

impl SessionHistory {
    fn push(&mut self, id: u64, text: &str) {
        if self.texts.insert(id, text.to_string()).is_none() {
            self.order.push(id);
        }
    }

    fn context_before(&self, id: u64, limit: usize) -> Vec<String> {
        if limit == 0 {
            return Vec::new();
        }
        let position = self
            .order
            .iter()
            .position(|current| *current == id)
            .unwrap_or(self.order.len());
        self.order[..position]
            .iter()
            .rev()
            .take(limit)
            .filter_map(|current| self.texts.get(current).cloned())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    fn get(&self, id: u64) -> Option<String> {
        self.texts.get(&id).cloned()
    }
}

#[derive(Default)]
struct Circuit {
    failures: u32,
    opened_at: Option<Instant>,
}

impl Circuit {
    fn allows(&mut self) -> bool {
        match self.opened_at {
            Some(at) if at.elapsed() < CIRCUIT_OPEN => false,
            Some(_) => {
                self.opened_at = None;
                self.failures = 0;
                true
            }
            None => true,
        }
    }

    fn record_failure(&mut self) {
        self.failures += 1;
        if self.failures >= CIRCUIT_FAILURES {
            self.opened_at = Some(Instant::now());
        }
    }

    fn record_success(&mut self) {
        self.failures = 0;
        self.opened_at = None;
    }
}

pub struct TranslateService {
    settings: RwLock<TranslateSettings>,
    settings_path: PathBuf,
    glossary: RwLock<Glossary>,
    glossary_path: PathBuf,
    queue: Mutex<Option<Sender<Job>>>,
    nmt: Mutex<Option<Arc<NmtTranslator>>>,
    history: Mutex<SessionHistory>,
    circuit: Mutex<Circuit>,
    /// Fallback model root when `settings.modelsRoot` is unset.
    default_root: PathBuf,
    download: Mutex<Option<Arc<AtomicBool>>>,
}

impl TranslateService {
    pub fn start(app: &AppHandle) -> Arc<Self> {
        let settings_path = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("settings.json"))
            .unwrap_or_else(|_| PathBuf::from("settings.json"));
        let settings = load_settings(&settings_path);
        if settings.migrated_legacy {
            if let Some(profile) = settings.active_provider() {
                migrate_legacy_api_key(&profile.id);
            }
        }
        let glossary_path = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("glossary.json"))
            .unwrap_or_else(|_| PathBuf::from("glossary.json"));
        let glossary = glossary::load(&glossary_path);
        let default_root = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("models").join("translate"))
            .unwrap_or_else(|_| PathBuf::from("models").join("translate"));
        let _ = std::fs::create_dir_all(&default_root);
        let service = Arc::new(Self {
            settings: RwLock::new(settings),
            settings_path,
            glossary: RwLock::new(glossary),
            glossary_path,
            queue: Mutex::new(None),
            nmt: Mutex::new(None),
            history: Mutex::new(SessionHistory::default()),
            circuit: Mutex::new(Circuit::default()),
            default_root,
            download: Mutex::new(None),
        });

        let (tx, rx) = mpsc::channel::<Job>();
        if let Ok(mut queue) = service.queue.lock() {
            *queue = Some(tx);
        }
        let worker = Arc::clone(&service);
        let _ = thread::Builder::new()
            .name("livetrans-translate".to_string())
            .spawn(move || worker.worker_loop(rx));

        service
    }

    fn settings(&self) -> TranslateSettings {
        self.settings
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Scene background and terms used by LLM translation, ASR hotwords and Q&A.
    pub fn glossary(&self) -> Glossary {
        self.glossary
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn save_glossary(&self, value: Glossary) -> Result<Glossary, String> {
        let normalized = glossary::save(&self.glossary_path, value)?;
        if let Ok(mut guard) = self.glossary.write() {
            *guard = normalized.clone();
        }
        Ok(normalized)
    }

    /// Called by the engine when a new listening session begins.
    pub fn reset_session(&self) {
        if let Ok(mut history) = self.history.lock() {
            history.order.clear();
            history.texts.clear();
        }
    }

    /// Route id stored with each session ("nmt", "localLlm", …).
    pub fn route_id(&self) -> String {
        self.settings().route.id().to_string()
    }

    /// Base URL of the configured local LLM, probed by the environment card.
    pub fn local_base_url(&self) -> String {
        self.settings().local_llm.base_url
    }

    /// Endpoints and consent used by the transcript Q&A panel.
    pub fn ask_targets(&self) -> AskTargets {
        let settings = self.settings();
        let provider = settings.active_provider();
        AskTargets {
            local: settings.local_llm.clone(),
            remote: provider
                .map(|profile| EndpointSettings {
                    name: profile.name.clone(),
                    base_url: profile.base_url.clone(),
                    model: profile.model.clone(),
                })
                .unwrap_or_default(),
            remote_consent: provider.is_some_and(|profile| profile.consent_at.is_some()),
            key: provider.and_then(|profile| provider_api_key(&profile.id)),
        }
    }

    /// Called from the ASR thread for every finalised sentence.
    pub fn submit(&self, id: u64, text: String, sink: EngineSink) {
        let settings = self.settings();
        if !settings.enabled {
            return;
        }
        let context = {
            let Ok(mut history) = self.history.lock() else {
                return;
            };
            history.push(id, &text);
            history.context_before(id, settings.context_lines.clamp(0, 12))
        };
        self.enqueue(Job {
            id,
            text,
            context,
            channel: Some(sink),
        });
    }

    fn enqueue(&self, job: Job) {
        if let Ok(queue) = self.queue.lock() {
            if let Some(tx) = queue.as_ref() {
                let _ = tx.send(job);
            }
        }
    }

    /* --------------------------------------------------------------------- */
    /* Worker                                                                */
    /* --------------------------------------------------------------------- */

    fn worker_loop(self: Arc<Self>, rx: mpsc::Receiver<Job>) {
        while let Ok(job) = rx.recv() {
            self.run_job(job);
        }
    }

    fn run_job(&self, job: Job) {
        let settings = self.settings();

        if looks_chinese(&job.text) {
            job.send(EngineEvent::TranslationDone {
                id: job.id,
                text: String::new(),
                route: "passthrough".to_string(),
                provider: None,
                ms: 0,
                fallback: false,
            });
            return;
        }

        let chain = self.chain(&settings);
        let mut last_failure: Option<TranslateFailure> = None;

        for (index, route) in chain.iter().copied().enumerate() {
            if route == TranslateRoute::RemoteLlm {
                let profile = settings.active_provider();
                if profile.is_none_or(|profile| profile.consent_at.is_none()) {
                    last_failure = Some(TranslateFailure::new(
                        "consent_required",
                        "第三方翻译尚未获得授权。",
                    ));
                    continue;
                }
                let allowed = match self.circuit.lock() {
                    Ok(mut circuit) => circuit.allows(),
                    Err(_) => false,
                };
                if !allowed {
                    last_failure = Some(TranslateFailure::new(
                        "circuit_open",
                        "第三方连续失败，已暂时回退本地。",
                    ));
                    continue;
                }
            }

            let started = Instant::now();
            match self.attempt(route, &job, &settings) {
                Ok((text, provider)) => {
                    if route == TranslateRoute::RemoteLlm {
                        if let Ok(mut circuit) = self.circuit.lock() {
                            circuit.record_success();
                        }
                    }
                    job.send(EngineEvent::TranslationDone {
                        id: job.id,
                        text,
                        route: route.id().to_string(),
                        provider,
                        ms: started.elapsed().as_millis() as u64,
                        fallback: index > 0,
                    });
                    return;
                }
                Err(failure) => {
                    log::warn!(
                        "translate: {} failed for #{}: {} ({})",
                        route.id(),
                        job.id,
                        failure.message,
                        failure.code
                    );
                    if route == TranslateRoute::RemoteLlm {
                        if let Ok(mut circuit) = self.circuit.lock() {
                            circuit.record_failure();
                        }
                    }
                    last_failure = Some(failure);
                }
            }
        }

        let failure =
            last_failure.unwrap_or_else(|| TranslateFailure::new("no_route", "没有可用的翻译路径。"));
        job.send(EngineEvent::TranslationError {
            id: job.id,
            code: failure.code,
            message: failure.message,
        });
    }

    fn chain(&self, settings: &TranslateSettings) -> Vec<TranslateRoute> {
        let mut chain = vec![settings.route];
        if settings.fallback_to_local {
            let push = |route: TranslateRoute, chain: &mut Vec<TranslateRoute>| {
                if !chain.contains(&route) {
                    chain.push(route);
                }
            };
            if settings.local_llm.configured() {
                push(TranslateRoute::LocalLlm, &mut chain);
            }
            push(TranslateRoute::Nmt, &mut chain);
        }
        chain
    }

    fn attempt(
        &self,
        route: TranslateRoute,
        job: &Job,
        settings: &TranslateSettings,
    ) -> Result<(String, Option<String>), TranslateFailure> {
        let glossary = self.glossary();
        match route {
            TranslateRoute::Nmt => {
                if settings.target_lang != "zh-Hans" {
                    return Err(TranslateFailure::new(
                        "nmt_target",
                        "本地 NMT 只能译为简体中文；换成 LLM 路线，或把「翻译成」改回简体中文。",
                    ));
                }
                let translator = self.nmt()?;
                let started = Instant::now();
                let text = translator
                    .translate(&job.text)
                    .map_err(|message| TranslateFailure::new("nmt_failed", message))?;
                log::info!(
                    "translate: nmt #{} {}ms → {}",
                    job.id,
                    started.elapsed().as_millis(),
                    text
                );
                Ok((text, None))
            }
            TranslateRoute::LocalLlm => {
                if !settings.local_llm.configured() {
                    return Err(TranslateFailure::new(
                        "not_configured",
                        "本地 LLM 未配置地址或模型。",
                    ));
                }
                let endpoint = settings.local_llm.endpoint();
                let provider = host_of(&endpoint.base_url);
                let channel = job.channel.clone();
                let id = job.id;
                let mut delta = move |text: &str| {
                    if let Some(channel) = &channel {
                        let _ = channel.send(EngineEvent::TranslationDelta {
                            id,
                            text: text.to_string(),
                        });
                    }
                };
                let text = llm::translate_stream(
                    &endpoint,
                    None,
                    &system_prompt(&settings.target_lang, &glossary),
                    &user_prompt(&job.text, &job.context),
                    LOCAL_LLM_TIMEOUT,
                    &mut delta,
                )?;
                Ok((sanitize(&text), Some(provider)))
            }
            TranslateRoute::RemoteLlm => {
                let profile = settings.active_provider().ok_or_else(|| {
                    TranslateFailure::new("no_provider", "还没有可用的第三方配置档。")
                })?;
                if !profile.configured() {
                    return Err(TranslateFailure::new(
                        "not_configured",
                        format!("配置档「{}」的地址或模型未填写。", profile.name),
                    ));
                }
                if profile.consent_at.is_none() {
                    return Err(TranslateFailure::new(
                        "missing_consent",
                        format!(
                            "配置档「{}」还没有确认发送句子文本；在设置里勾选同意后再试。",
                            profile.name
                        ),
                    ));
                }
                let key = provider_api_key(&profile.id).ok_or_else(|| {
                    TranslateFailure::new(
                        "missing_key",
                        format!(
                            "配置档「{}」需要 API Key（在设置里填写，仅存系统钥匙串）。",
                            profile.name
                        ),
                    )
                })?;
                let endpoint = profile.endpoint();
                let provider = host_of(&endpoint.base_url);
                let channel = job.channel.clone();
                let id = job.id;
                let mut delta = move |text: &str| {
                    if let Some(channel) = &channel {
                        let _ = channel.send(EngineEvent::TranslationDelta {
                            id,
                            text: text.to_string(),
                        });
                    }
                };
                let text = llm::translate_stream(
                    &endpoint,
                    Some(&key),
                    &system_prompt(&settings.target_lang, &glossary),
                    &user_prompt(&job.text, &job.context),
                    REMOTE_TIMEOUT,
                    &mut delta,
                )?;
                Ok((sanitize(&text), Some(provider)))
            }
        }
    }

    fn nmt(&self) -> Result<Arc<NmtTranslator>, TranslateFailure> {
        if let Ok(guard) = self.nmt.lock() {
            if let Some(translator) = guard.as_ref() {
                return Ok(Arc::clone(translator));
            }
        }
        let dir = self.nmt_dir()?;
        let translator = Arc::new(
            NmtTranslator::load(&dir)
                .map_err(|message| TranslateFailure::new("model_missing", message))?,
        );
        if let Ok(mut guard) = self.nmt.lock() {
            *guard = Some(Arc::clone(&translator));
        }
        Ok(translator)
    }

    /// Model root chosen in settings, else the app data directory.
    fn model_root(&self, settings: &TranslateSettings) -> PathBuf {
        match settings.models_root.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => self.default_root.clone(),
        }
    }

    fn nmt_dir(&self) -> Result<PathBuf, TranslateFailure> {
        let settings = self.settings();
        let mut candidates = Vec::new();
        if let Ok(dir) = std::env::var("LIVETRANS_TRANSLATE_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        candidates.push(self.model_root(&settings).join(models::NMT_DIR_NAME));
        if cfg!(debug_assertions) {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models/translate/en-zh"),
            );
        }
        for candidate in candidates {
            if models::installed(&candidate) {
                return Ok(candidate);
            }
        }
        Err(TranslateFailure::new(
            "model_missing",
            "本地翻译模型未下载：打开设置 → 翻译与聊天，点「下载模型」；也可以指定已有目录。",
        ))
    }

    fn view(&self, settings: TranslateSettings) -> TranslateSettingsView {
        let target = self.model_root(&settings).join(models::NMT_DIR_NAME);
        let installed = self.nmt_dir().ok();
        let provider_keys = settings
            .providers
            .iter()
            .map(|profile| {
                (
                    profile.id.clone(),
                    provider_api_key(&profile.id).is_some(),
                )
            })
            .collect();
        TranslateSettingsView {
            nmt_installed: installed.is_some(),
            nmt_dir: installed
                .unwrap_or(target)
                .display()
                .to_string(),
            nmt_root: self.model_root(&settings).display().to_string(),
            nmt_downloading: self
                .download
                .lock()
                .map(|flag| flag.is_some())
                .unwrap_or(false),
            nmt_bytes: models::NMT_BYTES,
            settings,
            provider_keys,
        }
    }

    /* --------------------------------------------------------------------- */
    /* Model download                                                        */
    /* --------------------------------------------------------------------- */

    fn start_download(
        self: &Arc<Self>,
        channel: Channel<models::TranslateDownloadEvent>,
    ) -> Result<(), String> {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self.download.lock().map_err(|_| "下载锁已损坏".to_string())?;
            if guard.is_some() {
                return Err("本地翻译模型正在下载".to_string());
            }
            *guard = Some(Arc::clone(&flag));
        }

        let settings = self.settings();
        let root = self.model_root(&settings);
        let service = Arc::clone(self);
        thread::Builder::new()
            .name("livetrans-translate-download".to_string())
            .spawn(move || {
                let outcome = models::download(&root, &flag, &mut |event| {
                    let _ = channel.send(event);
                });
                if let Ok(mut guard) = service.download.lock() {
                    *guard = None;
                }
                // A freshly downloaded (or replaced) package must not be masked
                // by a translator loaded from the previous files.
                if let Ok(mut slot) = service.nmt.lock() {
                    *slot = None;
                }
                match outcome {
                    Ok(dir) => {
                        let _ = channel.send(models::TranslateDownloadEvent::Done {
                            dir: dir.display().to_string(),
                        });
                    }
                    Err(err) if err == crate::download::CANCELLED => {
                        let _ = channel.send(models::TranslateDownloadEvent::Cancelled);
                    }
                    Err(err) => {
                        let _ = channel.send(models::TranslateDownloadEvent::Error { message: err });
                    }
                }
            })
            .map_err(|err| format!("下载线程启动失败：{err}"))?;
        Ok(())
    }

    fn cancel_download(&self) {
        if let Ok(guard) = self.download.lock() {
            if let Some(flag) = guard.as_ref() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    fn delete_model(&self) -> Result<(), String> {
        self.cancel_download();
        let target = self.model_root(&self.settings()).join(models::NMT_DIR_NAME);
        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|err| format!("删除模型失败：{err}"))?;
        }
        if let Ok(mut slot) = self.nmt.lock() {
            *slot = None;
        }
        Ok(())
    }

    fn save(
        &self,
        settings: TranslateSettings,
        api_key_value: Option<String>,
        consent: bool,
    ) -> Result<TranslateSettingsView, String> {
        let previous_ids: Vec<String> = self
            .settings()
            .providers
            .iter()
            .map(|profile| profile.id.clone())
            .collect();
        let (mut settings, _) = settings.normalized();
        if consent {
            let active_id = settings.active_provider_id.clone();
            if let Some(profile) = settings
                .providers
                .iter_mut()
                .find(|profile| profile.id == active_id)
            {
                if profile.consent_at.is_none() {
                    profile.consent_at =
                        Some(format!("{CONSENT_VERSION}:{}", unix_secs()));
                }
            }
        }
        if let Some(key) = api_key_value {
            store_provider_key(&settings.active_provider_id, &key)?;
        }
        // Keys of deleted profiles should not linger in the credential store.
        for old_id in previous_ids {
            if !settings
                .providers
                .iter()
                .any(|profile| profile.id == old_id)
            {
                let _ = store_provider_key(&old_id, "");
            }
        }
        settings.context_lines = settings.context_lines.clamp(0, 12);
        settings.target_lang = match settings.target_lang.as_str() {
            "zh-Hant" | "en" => settings.target_lang,
            _ => "zh-Hans".to_string(),
        };
        settings.models_root = settings
            .models_root
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Ok(mut guard) = self.settings.write() {
            *guard = settings.clone();
        }
        // The model directory may have changed; reload on the next sentence.
        if let Ok(mut slot) = self.nmt.lock() {
            *slot = None;
        }
        if let Some(parent) = self.settings_path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let json = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
        std::fs::write(&self.settings_path, json).map_err(|err| err.to_string())?;
        log::info!(
            "translate: settings saved to {}",
            self.settings_path.display()
        );
        Ok(self.view(settings))
    }

    pub fn retranslate(&self, id: u64, sink: EngineSink) -> Result<(), String> {
        let (text, context) = {
            let history = self.history.lock().map_err(|_| "history lock")?;
            let text = history.get(id).ok_or("找不到这句原文")?;
            let settings = self.settings();
            let context = history.context_before(id, settings.context_lines.clamp(0, 12));
            (text, context)
        };
        // Retrying is an explicit user action, so it runs even while the
        // automatic toggle is off.
        self.enqueue(Job {
            id,
            text,
            context,
            channel: Some(sink),
        });
        Ok(())
    }

    fn test(&self, route: TranslateRoute) -> Result<TestTranslation, String> {
        let settings = self.settings();
        if route == TranslateRoute::RemoteLlm {
            let profile = settings
                .active_provider()
                .ok_or("还没有可用的第三方配置档。")?;
            if profile.consent_at.is_none() {
                return Err(format!(
                    "先在设置里确认：句子会发送到「{}」。",
                    profile.name
                ));
            }
        }
        let job = Job {
            id: 0,
            text: "Good morning, everyone. Let's begin today's class.".to_string(),
            context: Vec::new(),
            channel: None,
        };
        let started = Instant::now();
        let (text, provider) = self
            .attempt(route, &job, &settings)
            .map_err(|failure| failure.message)?;
        Ok(TestTranslation {
            text,
            route: route.id().to_string(),
            provider,
            ms: started.elapsed().as_millis() as u64,
        })
    }
}

/* ------------------------------------------------------------------------- */
/* Tauri commands                                                            */
/* ------------------------------------------------------------------------- */

#[tauri::command]
pub fn get_translate_settings(
    service: State<'_, Arc<TranslateService>>,
) -> Result<TranslateSettingsView, String> {
    let settings = service.settings();
    Ok(service.view(settings))
}

#[tauri::command]
pub fn save_translate_settings(
    service: State<'_, Arc<TranslateService>>,
    settings: TranslateSettings,
    api_key: Option<String>,
    consent: bool,
) -> Result<TranslateSettingsView, String> {
    service.save(settings, api_key, consent)
}

#[tauri::command]
pub fn clear_provider_api_key(
    service: State<'_, Arc<TranslateService>>,
    provider_id: String,
) -> Result<TranslateSettingsView, String> {
    if provider_id.trim().is_empty() {
        return Err("缺少配置档 id".to_string());
    }
    store_provider_key(provider_id.trim(), "").map_err(|err| err.to_string())?;
    let settings = service.settings();
    Ok(service.view(settings))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTranslation {
    pub text: String,
    pub route: String,
    pub provider: Option<String>,
    pub ms: u64,
}

#[tauri::command]
pub fn test_translation(
    service: State<'_, Arc<TranslateService>>,
    route: Option<String>,
) -> Result<TestTranslation, String> {
    let settings = service.settings();
    let route = route
        .as_deref()
        .and_then(TranslateRoute::from_id)
        .unwrap_or(settings.route);
    service.test(route)
}

#[tauri::command]
pub fn download_translate_model(
    service: State<'_, Arc<TranslateService>>,
    channel: Channel<models::TranslateDownloadEvent>,
) -> Result<(), String> {
    service.inner().start_download(channel)
}

#[tauri::command]
pub fn cancel_translate_download(service: State<'_, Arc<TranslateService>>) {
    service.cancel_download();
}

#[tauri::command]
pub fn delete_translate_model(
    service: State<'_, Arc<TranslateService>>,
) -> Result<TranslateSettingsView, String> {
    service.delete_model()?;
    Ok(service.view(service.settings()))
}

#[tauri::command]
pub fn retranslate_segment(
    service: State<'_, Arc<TranslateService>>,
    id: u64,
    channel: Channel<EngineEvent>,
) -> Result<(), String> {
    service.retranslate(id, EngineSink::Channel(channel))
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

fn load_settings(path: &Path) -> TranslateSettings {
    let parsed = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<TranslateSettings>(&text).ok())
        .unwrap_or_default();
    parsed.normalized().0
}

fn looks_chinese(text: &str) -> bool {
    let mut cjk = 0usize;
    let mut latin = 0usize;
    for ch in text.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            cjk += 1;
        } else if ch.is_ascii_alphabetic() {
            latin += 1;
        }
    }
    cjk > 0 && latin <= cjk * 2 / 3
}

fn user_prompt(text: &str, context: &[String]) -> String {
    if context.is_empty() {
        format!("待翻译句子：{text}")
    } else {
        format!(
            "上文（仅供理解，不要翻译）：{}\n待翻译句子：{text}",
            context.join(" ")
        )
    }
}

fn sanitize(text: &str) -> String {
    let trimmed = text.trim();
    let without_prefix = trimmed
        .strip_prefix("译文：")
        .or_else(|| trimmed.strip_prefix("译文:"))
        .unwrap_or(trimmed);
    without_prefix.trim().trim_matches('"').trim().to_string()
}

fn host_of(base_url: &str) -> String {
    base_url
        .split("://")
        .nth(1)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or(base_url)
        .to_string()
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn legacy_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, LEGACY_KEYRING_USER).map_err(|err| err.to_string())
}

fn provider_keyring_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        KEYRING_SERVICE,
        &format!("{PROVIDER_KEYRING_PREFIX}{}", provider_id.trim()),
    )
    .map_err(|err| err.to_string())
}

pub struct AskTargets {
    pub local: EndpointSettings,
    pub remote: EndpointSettings,
    pub remote_consent: bool,
    pub key: Option<String>,
}

pub(crate) fn provider_api_key(provider_id: &str) -> Option<String> {
    if provider_id.trim().is_empty() {
        return None;
    }
    provider_keyring_entry(provider_id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|key| !key.trim().is_empty())
}

/* ------------------------------------------------------------------------- */
/* Portable provider profiles (settings → import/export)                     */
/* ------------------------------------------------------------------------- */

/// A profile as shared in a file: no id (so an import cannot collide with an
/// existing profile's keyring entry), no consent and no API key. The key never
/// enters `settings.json` either.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PortableProviderProfile {
    #[serde(default)]
    name: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PortableProviderProfiles {
    #[serde(skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<u32>,
    profiles: Vec<PortableProviderProfile>,
}

/// Write every configured profile to a JSON file without keys, consent or ids.
pub fn export_provider_profiles(
    path: &Path,
    profiles: &[ProviderProfile],
) -> Result<PathBuf, String> {
    let profiles: Vec<PortableProviderProfile> = profiles
        .iter()
        .filter(|profile| profile.configured())
        .map(|profile| PortableProviderProfile {
            name: profile.name.trim().to_string(),
            base_url: profile.base_url.trim().to_string(),
            model: profile.model.trim().to_string(),
        })
        .collect();
    if profiles.is_empty() {
        return Err(general::pick(
            "没有可导出的配置档：先填写接口地址与模型。",
            "Nothing to export yet: fill in an endpoint and model first.",
        )
        .to_string());
    }
    let document = PortableProviderProfiles {
        app: Some("livetrans".to_string()),
        kind: Some("provider-profiles".to_string()),
        version: Some(1),
        profiles,
    };
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| {
                if general::is_chinese() {
                    format!("无法创建导出目录：{err}")
                } else {
                    format!("Could not create the export folder: {err}")
                }
            })?;
        }
    }
    let json = serde_json::to_string_pretty(&document).map_err(|err| err.to_string())?;
    std::fs::write(path, json).map_err(|err| {
        if general::is_chinese() {
            format!("写入配置档文件失败：{err}")
        } else {
            format!("Could not write the provider file: {err}")
        }
    })?;
    Ok(path.to_path_buf())
}

/// Read a shared provider file. Profiles without an endpoint or model are
/// skipped; the result has empty ids and no consent, so the caller must assign
/// ids and ask the user to confirm text sharing again.
pub fn import_provider_profiles(path: &Path) -> Result<Vec<ProviderProfile>, String> {
    let text = std::fs::read_to_string(path).map_err(|err| {
        if general::is_chinese() {
            format!("无法读取配置档文件：{err}")
        } else {
            format!("Could not read the provider file: {err}")
        }
    })?;
    let document: PortableProviderProfiles = serde_json::from_str(&text).map_err(|err| {
        if general::is_chinese() {
            format!("配置档文件不是有效的 JSON：{err}")
        } else {
            format!("The provider file is not valid JSON: {err}")
        }
    })?;
    let mut profiles = Vec::new();
    for (index, portable) in document.profiles.into_iter().enumerate() {
        let base_url = portable.base_url.trim().to_string();
        let model = portable.model.trim().to_string();
        if base_url.is_empty() || model.is_empty() {
            continue;
        }
        let name: String = portable
            .name
            .trim()
            .chars()
            .take(MAX_PROVIDER_NAME)
            .collect();
        let name = if name.trim().is_empty() {
            format!("服务商 {}", index + 1)
        } else {
            name
        };
        profiles.push(ProviderProfile {
            id: String::new(),
            name,
            base_url,
            model,
            consent_at: None,
        });
        if profiles.len() >= MAX_PROVIDERS {
            break;
        }
    }
    if profiles.is_empty() {
        return Err(general::pick(
            "文件里没有完整的配置档（需要接口地址与模型）。",
            "The file has no complete profiles (an endpoint and model are required).",
        )
        .to_string());
    }
    Ok(profiles)
}

fn store_provider_key(provider_id: &str, key: &str) -> Result<(), String> {
    let entry = provider_keyring_entry(provider_id)?;
    if key.trim().is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry
            .set_password(key.trim())
            .map_err(|err| err.to_string())
    }
}

fn legacy_api_key() -> Option<String> {
    legacy_keyring_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|key| !key.trim().is_empty())
}

/// Copy the pre-profile single key to the migrated profile, then remove the
/// old entry. Best effort: failures only mean the user re-enters the key.
fn migrate_legacy_api_key(provider_id: &str) {
    if provider_api_key(provider_id).is_some() {
        return;
    }
    let Some(old) = legacy_api_key() else {
        return;
    };
    match store_provider_key(provider_id, &old) {
        Ok(()) => {
            if let Ok(entry) = legacy_keyring_entry() {
                let _ = entry.delete_credential();
            }
            log::info!("translate: migrated legacy API key to provider {provider_id}");
        }
        Err(err) => log::warn!("translate: legacy API key migration failed: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_single_provider_migrates_to_profile() {
        let legacy = json!({
            "enabled": true,
            "route": "remoteLlm",
            "contextLines": 4,
            "fallbackToLocal": true,
            "localLlm": {
                "name": "Ollama",
                "baseUrl": "http://127.0.0.1:11434/v1",
                "model": "qwen2.5:3b"
            },
            "remoteLlm": {
                "name": "DeepSeek",
                "baseUrl": "https://api.deepseek.com/v1",
                "model": "deepseek-chat"
            },
            "remoteConsentAt": "1:1700000000",
            "modelsRoot": null,
            "targetLang": "zh-Hans"
        });
        let parsed: TranslateSettings = serde_json::from_value(legacy).expect("legacy parse");
        let (settings, migrated) = parsed.normalized();

        assert!(migrated);
        assert_eq!(settings.providers.len(), 1);
        assert_eq!(settings.providers[0].id, "provider-1");
        assert_eq!(settings.providers[0].name, "DeepSeek");
        assert_eq!(settings.providers[0].base_url, "https://api.deepseek.com/v1");
        assert_eq!(settings.providers[0].model, "deepseek-chat");
        assert_eq!(
            settings.providers[0].consent_at.as_deref(),
            Some("1:1700000000")
        );
        assert_eq!(settings.active_provider_id, "provider-1");
        assert_eq!(
            settings.active_provider().map(|profile| profile.name.as_str()),
            Some("DeepSeek")
        );

        let saved = serde_json::to_value(&settings).expect("serialize");
        assert!(saved.get("remoteLlm").is_none());
        assert!(saved.get("remoteConsentAt").is_none());
        assert_eq!(saved["providers"][0]["baseUrl"], "https://api.deepseek.com/v1");
        assert_eq!(saved["activeProviderId"], "provider-1");
    }

    #[test]
    fn profiles_are_trimmed_deduped_and_active_falls_back() {
        let mut settings = TranslateSettings::default();
        settings.providers = vec![
            ProviderProfile {
                id: "same".to_string(),
                name: "  A  ".to_string(),
                base_url: " https://a.example/v1 ".to_string(),
                model: " m1 ".to_string(),
                consent_at: Some("   ".to_string()),
            },
            ProviderProfile {
                id: "same".to_string(),
                name: String::new(),
                base_url: String::new(),
                model: String::new(),
                consent_at: None,
            },
        ];
        settings.active_provider_id = "missing".to_string();

        let (settings, migrated) = settings.normalized();

        assert!(!migrated);
        assert_eq!(settings.providers.len(), 2);
        assert_eq!(settings.providers[0].id, "same");
        assert_eq!(settings.providers[0].name, "A");
        assert_eq!(settings.providers[0].base_url, "https://a.example/v1");
        assert_eq!(settings.providers[0].model, "m1");
        assert_eq!(settings.providers[0].consent_at, None);
        assert_eq!(settings.providers[1].name, "服务商 2");
        assert_ne!(settings.providers[1].id, "same");
        assert_eq!(settings.active_provider_id, "same");
        assert_eq!(
            settings.active_provider().map(|profile| profile.name.as_str()),
            Some("A")
        );
    }

    #[test]
    fn provider_profiles_export_without_keys_consent_or_ids() {
        let dir = std::env::temp_dir().join(format!(
            "livetrans-provider-portable-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let profiles = vec![
            ProviderProfile {
                id: "p1".to_string(),
                name: "  评审用  ".to_string(),
                base_url: " https://api.example/v1 ".to_string(),
                model: "example-chat".to_string(),
                consent_at: Some("1:1700000000".to_string()),
            },
            ProviderProfile {
                id: "p2".to_string(),
                name: "未配置".to_string(),
                base_url: String::new(),
                model: String::new(),
                consent_at: None,
            },
        ];
        let path = export_provider_profiles(&dir.join("providers.json"), &profiles).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["kind"], "provider-profiles");
        assert_eq!(value["profiles"].as_array().unwrap().len(), 1);
        assert_eq!(value["profiles"][0]["name"], "评审用");
        assert_eq!(value["profiles"][0]["baseUrl"], "https://api.example/v1");
        assert!(value["profiles"][0].get("id").is_none());
        assert!(value["profiles"][0].get("consentAt").is_none());
        assert!(export_provider_profiles(&dir.join("empty.json"), &profiles[1..]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn importing_provider_profiles_skips_incomplete_entries() {
        let dir = std::env::temp_dir().join(format!(
            "livetrans-provider-import-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");
        std::fs::write(
            &path,
            r#"{"profiles":[
                {"name":"完整","baseUrl":"https://a.example/v1","model":"m1"},
                {"name":"缺模型","baseUrl":"https://b.example/v1"},
                {"name":"","baseUrl":"https://c.example/v1","model":"m3"}
            ]}"#,
        )
        .unwrap();
        let imported = import_provider_profiles(&path).unwrap();
        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|profile| profile.id.is_empty()));
        assert!(imported.iter().all(|profile| profile.consent_at.is_none()));
        assert_eq!(imported[0].name, "完整");
        assert_eq!(imported[1].name, "服务商 3");

        let broken = dir.join("broken.json");
        std::fs::write(&broken, "not json").unwrap();
        assert!(import_provider_profiles(&broken).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "touches the OS credential store"]
    fn provider_keys_are_stored_per_profile() {
        let a = "livetrans-selftest-a";
        let b = "livetrans-selftest-b";
        let _ = store_provider_key(a, "");
        let _ = store_provider_key(b, "");

        store_provider_key(a, "sk-a").expect("store a");
        store_provider_key(b, "sk-b").expect("store b");
        assert_eq!(provider_api_key(a).as_deref(), Some("sk-a"));
        assert_eq!(provider_api_key(b).as_deref(), Some("sk-b"));

        store_provider_key(a, "").expect("clear a");
        assert!(provider_api_key(a).is_none());
        assert_eq!(provider_api_key(b).as_deref(), Some("sk-b"));
        store_provider_key(b, "").expect("clear b");
    }

    #[test]
    fn provider_count_is_capped_and_default_exists() {
        let mut settings = TranslateSettings::default();
        settings.providers = (0..12)
            .map(|index| ProviderProfile {
                id: format!("p{index}"),
                name: format!("P{index}"),
                base_url: "https://example/v1".to_string(),
                model: "m".to_string(),
                consent_at: None,
            })
            .collect();
        settings.active_provider_id = "p11".to_string();

        let (settings, _) = settings.normalized();

        assert_eq!(settings.providers.len(), MAX_PROVIDERS);
        assert_eq!(settings.active_provider_id, "p0");

        let empty = TranslateSettings {
            providers: Vec::new(),
            active_provider_id: String::new(),
            ..TranslateSettings::default()
        }
        .normalized()
        .0;
        assert_eq!(empty.providers.len(), 1);
        assert_eq!(empty.active_provider_id, empty.providers[0].id);
    }
}
