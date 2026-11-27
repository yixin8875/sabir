//! Capture → streaming ASR engine.
//!
//! The WebView never touches audio. A WASAPI loopback stream is opened in
//! shared mode and converted to 16 kHz mono float by the audio engine, decoded
//! by a streaming Zipformer, and only text + level numbers leave this module
//! through a Tauri channel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OnlineRecognizer, OnlineRecognizerConfig,
    VadModelConfig, VoiceActivityDetector,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::asr_models::{AsrService, ModelFiles, StreamingFiles, WhisperFiles};
use crate::general;
use crate::audio::{self, AudioSettings};
use crate::glossary;
use crate::plugins::PluginService;
use crate::store::SessionStore;
use crate::translate::TranslateService;

pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EngineEvent {
    Status {
        state: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sample_rate: Option<u32>,
    },
    Level {
        rms: f32,
        peak: f32,
    },
    Partial {
        id: u64,
        text: String,
        start_ms: u64,
    },
    Final {
        id: u64,
        text: String,
        start_ms: u64,
        end_ms: u64,
    },
    TranslationDelta {
        id: u64,
        text: String,
    },
    TranslationDone {
        id: u64,
        text: String,
        route: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        ms: u64,
        fallback: bool,
    },
    TranslationError {
        id: u64,
        code: String,
        message: String,
    },
    Error {
        message: String,
    },
}

/// Where engine events go. Listening runs use a queue so one writer thread can
/// persist every event before it reaches the WebView; one-off commands (retry a
/// translation) send straight to the channel.
#[derive(Clone)]
pub enum EngineSink {
    Channel(Channel<EngineEvent>),
    Queue(Sender<EngineEvent>),
}

impl EngineSink {
    pub fn send(&self, event: EngineEvent) {
        match self {
            Self::Channel(channel) => {
                let _ = channel.send(event);
            }
            Self::Queue(tx) => {
                let _ = tx.send(event);
            }
        }
    }
}

/* ------------------------------------------------------------------------- */
/* Public engine handle                                                      */
/* ------------------------------------------------------------------------- */

pub struct Engine {
    session: Mutex<Option<Session>>,
    translate: Arc<TranslateService>,
    store: Arc<SessionStore>,
    plugins: Arc<PluginService>,
    last_session: Mutex<Option<i64>>,
}

struct Session {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    capture: Option<JoinHandle<()>>,
    asr: Option<JoinHandle<()>>,
    session_id: i64,
    signal: EngineSink,
}

impl Engine {
    pub fn new(
        translate: Arc<TranslateService>,
        store: Arc<SessionStore>,
        plugins: Arc<PluginService>,
    ) -> Self {
        Self {
            session: Mutex::new(None),
            translate,
            store,
            plugins,
            last_session: Mutex::new(None),
        }
    }

    pub fn start(&self, app: &AppHandle, channel: Channel<EngineEvent>) -> Result<(), String> {
        let (files, threads) = app.state::<AsrService>().engine_model()?;
        let mut guard = self.session.lock().map_err(|_| "engine lock poisoned")?;

        if let Some(session) = guard.as_ref() {
            let asr_done = session.asr.as_ref().is_none_or(JoinHandle::is_finished);
            let capture_done = session.capture.as_ref().is_none_or(JoinHandle::is_finished);
            if !(asr_done && capture_done) {
                return Err("Already listening".to_string());
            }
            if let Some(old) = guard.take() {
                old.stop.store(true, Ordering::SeqCst);
            }
        }

        let audio_settings = load_audio_settings(app);
        let model = app.state::<AsrService>().model_label();
        let route = self.translate.route_id();
        let hotwords = app
            .path()
            .app_data_dir()
            .ok()
            .and_then(|dir| match glossary::write_hotwords(&dir, &self.translate.glossary()) {
                Ok(path) => path,
                Err(err) => {
                    log::warn!("asr: glossary hotwords unavailable: {err}");
                    None
                }
            });
        let session_id =
            self.store
                .create_session(audio_settings.source_label(), &model, &route)?;
        if let Ok(mut last) = self.last_session.lock() {
            *last = Some(session_id);
        }

        if let Some(meta) = self.store.meta(session_id) {
            if let Err(err) = self.plugins.begin_session(&meta) {
                log::warn!("plugin: session stream unavailable: {err}");
            }
        }

        let (event_tx, event_rx) = std::sync::mpsc::channel::<EngineEvent>();
        let sink = EngineSink::Queue(event_tx);
        let store = Arc::clone(&self.store);
        let plugins = Arc::clone(&self.plugins);
        let ui = channel.clone();
        let _ = spawn_thread("sabir-store", move || {
            let mut originals: HashMap<u64, String> = HashMap::new();
            for event in event_rx {
                let event = match event {
                    EngineEvent::Final {
                        id,
                        text,
                        start_ms,
                        end_ms,
                    } => {
                        originals.insert(id, text.clone());
                        EngineEvent::Final {
                            id,
                            text,
                            start_ms,
                            end_ms,
                        }
                    }
                    EngineEvent::TranslationDone {
                        id,
                        text,
                        route,
                        provider,
                        ms,
                        fallback,
                    } if route != "passthrough" && !text.is_empty() => {
                        let original = originals.get(&id).cloned().unwrap_or_default();
                        let rewritten = plugins.rewrite(
                            session_id,
                            id,
                            &original,
                            &text,
                            &route,
                            provider.as_deref(),
                            ms,
                        );
                        EngineEvent::TranslationDone {
                            id,
                            text: rewritten.unwrap_or(text),
                            route,
                            provider,
                            ms,
                            fallback,
                        }
                    }
                    other => other,
                };
                plugins.record(session_id, &event);
                persist_event(&store, session_id, &event);
                let _ = ui.send(event);
            }
        });

        self.translate.reset_session();

        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let (tx, rx) = sync_channel::<Vec<f32>>(96);

        let asr = spawn_thread("sabir-asr", {
            let stop = Arc::clone(&stop);
            let sink = sink.clone();
            let translate = Arc::clone(&self.translate);
            let hotwords = hotwords.clone();
            move || asr_loop(rx, stop, sink, files, threads, translate, hotwords)
        });

        let capture = spawn_capture(
            tx,
            Arc::clone(&stop),
            Arc::clone(&paused),
            sink.clone(),
            audio_settings,
        );

        *guard = Some(Session {
            stop,
            paused,
            capture,
            asr,
            session_id,
            signal: sink,
        });
        Ok(())
    }

    /// Stop the running session and return the id that was just finished, so
    /// the caller can write its automatic note.
    pub fn stop(&self) -> Option<i64> {
        let session = match self.session.lock() {
            Ok(mut guard) => guard.take(),
            Err(_) => None,
        };
        let Some(mut session) = session else {
            return None;
        };
        session.stop.store(true, Ordering::SeqCst);
        session.paused.store(false, Ordering::SeqCst);
        if let Some(handle) = session.capture.take() {
            let _ = handle.join();
        }
        if let Some(handle) = session.asr.take() {
            let _ = handle.join();
        }
        self.plugins.end_session();
        self.store.finish_session(session.session_id);
        Some(session.session_id)
    }

    /// Keep the session and its transcript, but stop feeding audio to the
    /// recognizer. Useful when the meeting pauses and the user wants the
    /// current captions to stay on screen.
    pub fn pause(&self) {
        let Ok(guard) = self.session.lock() else {
            return;
        };
        let Some(session) = guard.as_ref() else {
            return;
        };
        if session.stop.load(Ordering::SeqCst) {
            return;
        }
        session.paused.store(true, Ordering::SeqCst);
        session.signal.send(EngineEvent::Status {
            state: "paused",
            message: Some(
                general::pick(
                    "已暂停，字幕和会话都还在；继续时接着写",
                    "Paused — subtitles and the session are kept; resume to continue",
                )
                .to_string(),
            ),
            source: None,
            sample_rate: None,
        });
    }

    pub fn resume(&self) {
        let Ok(guard) = self.session.lock() else {
            return;
        };
        let Some(session) = guard.as_ref() else {
            return;
        };
        if session.stop.load(Ordering::SeqCst) {
            return;
        }
        session.paused.store(false, Ordering::SeqCst);
        session.signal.send(EngineEvent::Status {
            state: "listening",
            message: None,
            source: None,
            sample_rate: None,
        });
    }

    pub fn current_session(&self) -> Option<i64> {
        self.last_session.lock().ok().and_then(|guard| *guard)
    }

    pub fn store(&self) -> Arc<SessionStore> {
        Arc::clone(&self.store)
    }
}

fn load_audio_settings(app: &AppHandle) -> AudioSettings {
    app.path()
        .app_config_dir()
        .map(|dir| audio::load(&dir.join("audio.json")))
        .unwrap_or_default()
}

fn persist_event(store: &SessionStore, session_id: i64, event: &EngineEvent) {
    match event {
        EngineEvent::Final {
            id,
            text,
            start_ms,
            end_ms,
        } => {
            let _ = store.insert_segment(
                session_id,
                *id as i64,
                *start_ms as i64,
                *end_ms as i64,
                text,
            );
        }
        EngineEvent::TranslationDone {
            id,
            text,
            route,
            provider,
            ms,
            ..
        } => store.set_translation(
            session_id,
            *id as i64,
            text,
            route,
            provider.as_deref(),
            *ms as i64,
            None,
        ),
        EngineEvent::TranslationError { id, message, .. } => {
            store.set_translation(session_id, *id as i64, "", "", None, 0, Some(message))
        }
        _ => {}
    }
}

fn spawn_thread<F>(name: &str, f: F) -> Option<JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
{
    thread::Builder::new()
        .name(name.to_string())
        .spawn(f)
        .map_err(|err| log::error!("failed to spawn {name}: {err}"))
        .ok()
}

/* ------------------------------------------------------------------------- */
/* Recognizer config                                                         */
/* ------------------------------------------------------------------------- */

fn build_config(
    files: &StreamingFiles,
    threads: i32,
    hotwords: Option<&Path>,
) -> OnlineRecognizerConfig {
    let mut config = OnlineRecognizerConfig::default();
    config.model_config.transducer.encoder = Some(files.encoder.display().to_string());
    config.model_config.transducer.decoder = Some(files.decoder.display().to_string());
    config.model_config.transducer.joiner = Some(files.joiner.display().to_string());
    config.model_config.tokens = Some(files.tokens.display().to_string());
    config.model_config.num_threads = threads;
    config.decoding_method = Some("greedy_search".to_string());
    config.enable_endpoint = true;
    config.rule1_min_trailing_silence = 2.4;
    config.rule2_min_trailing_silence = 1.2;
    config.rule3_min_utterance_length = 20.0;
    config.feat_config.sample_rate = SAMPLE_RATE as i32;
    if let Some(path) = hotwords {
        // Contextual biasing needs beam search; greedy decoding ignores hotwords.
        config.hotwords_file = Some(path.display().to_string());
        config.hotwords_score = 1.5;
        config.decoding_method = Some("modified_beam_search".to_string());
        config.max_active_paths = 4;
        config.model_config.modeling_unit = Some("cjkchar+bpe".to_string());
        config.model_config.bpe_vocab = Some(files.tokens.display().to_string());
    }
    config
}

/* ------------------------------------------------------------------------- */
/* ASR worker                                                                */
/* ------------------------------------------------------------------------- */

/// The bilingual Zipformer vocabulary is uppercase-only, so raw output looks
/// like shouting. Convert ASCII runs to sentence case while leaving CJK alone.
fn normalize_caption(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut sentence_start = true;

    for ch in text.chars() {
        if ch.is_ascii_alphabetic() {
            if sentence_start {
                out.push(ch.to_ascii_uppercase());
                sentence_start = false;
            } else {
                out.push(ch.to_ascii_lowercase());
            }
            continue;
        }

        out.push(ch);
        match ch {
            '.' | '!' | '?' | '。' | '！' | '？' => sentence_start = true,
            _ if !ch.is_whitespace() => sentence_start = false,
            _ => {}
        }
    }

    out
}

fn asr_loop(
    rx: Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
    sink: EngineSink,
    files: ModelFiles,
    threads: i32,
    translate: Arc<TranslateService>,
    hotwords: Option<PathBuf>,
) {
    match files {
        ModelFiles::Streaming(files) => {
            streaming_loop(rx, stop, sink, files, threads, translate, hotwords)
        }
        // Whisper decoding has no hotword support; the glossary still reaches
        // translation and Q&A.
        ModelFiles::Whisper(files) => whisper_loop(rx, stop, sink, files, threads, translate),
    }
}

fn streaming_loop(
    rx: Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
    sink: EngineSink,
    files: StreamingFiles,
    threads: i32,
    translate: Arc<TranslateService>,
    hotwords: Option<PathBuf>,
) {
    let mut config = build_config(&files, threads, hotwords.as_deref());
    let mut recognizer = OnlineRecognizer::create(&config);
    if recognizer.is_none() && hotwords.is_some() {
        log::warn!("asr: the model rejected glossary hotwords; retrying without bias");
        config = build_config(&files, threads, None);
        recognizer = OnlineRecognizer::create(&config);
    }

    let Some(recognizer) = recognizer else {
        sink.send(EngineEvent::Error {
            message: "Zipformer model failed to load. Check the model files and their int8 variants."
                .to_string(),
        });
        stop.store(true, Ordering::SeqCst);
        return;
    };

    log::info!("asr: streaming zipformer ready ({} threads)", config.model_config.num_threads);

    sink.send(EngineEvent::Status {
        state: "listening",
        message: None,
        source: None,
        sample_rate: Some(SAMPLE_RATE),
    });

    let stream = recognizer.create_stream();
    let mut utterance_id: u64 = 1;
    let mut utterance_start_ms: Option<u64> = None;
    let mut session_ms: u64 = 0;
    let mut last_text = String::new();
    let mut last_partial_at = Instant::now() - Duration::from_secs(1);

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let chunk = match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(chunk) => chunk,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        if chunk.is_empty() {
            continue;
        }

        stream.accept_waveform(SAMPLE_RATE as i32, &chunk);
        session_ms += (chunk.len() as u64 * 1000) / SAMPLE_RATE as u64;

        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }

        let text = recognizer
            .get_result(&stream)
            .map(|result| normalize_caption(result.text.trim()))
            .unwrap_or_default();

        if !text.is_empty() && utterance_start_ms.is_none() {
            // Speech began slightly before the first hypothesis landed.
            utterance_start_ms = Some(session_ms.saturating_sub(600));
        }

        if !text.is_empty()
            && text != last_text
            && last_partial_at.elapsed() >= Duration::from_millis(120)
        {
            sink.send(EngineEvent::Partial {
                id: utterance_id,
                text: text.clone(),
                start_ms: utterance_start_ms.unwrap_or(session_ms),
            });
            last_text = text.clone();
            last_partial_at = Instant::now();
        }

        if recognizer.is_endpoint(&stream) {
            if !text.is_empty() {
                let start_ms = utterance_start_ms.unwrap_or(session_ms);
                log::info!("caption {}–{}ms: {}", start_ms, session_ms, text);
                sink.send(EngineEvent::Final {
                    id: utterance_id,
                    text: text.clone(),
                    start_ms,
                    end_ms: session_ms,
                });
                translate.submit(utterance_id, text.clone(), sink.clone());
                utterance_id += 1;
            }
            recognizer.reset(&stream);
            utterance_start_ms = None;
            last_text.clear();
        }
    }

    // Flush whatever the recognizer still holds when the user stops.
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    let text = recognizer
        .get_result(&stream)
        .map(|result| normalize_caption(result.text.trim()))
        .unwrap_or_default();
    if !text.is_empty() {
        sink.send(EngineEvent::Final {
            id: utterance_id,
            text: text.clone(),
            start_ms: utterance_start_ms.unwrap_or(session_ms),
            end_ms: session_ms,
        });
        translate.submit(utterance_id, text, sink.clone());
    }
}

/* ------------------------------------------------------------------------- */
/* Whisper worker                                                            */
/* ------------------------------------------------------------------------- */

fn whisper_config(files: &WhisperFiles, threads: i32) -> OfflineRecognizerConfig {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.whisper.encoder = Some(files.encoder.display().to_string());
    config.model_config.whisper.decoder = Some(files.decoder.display().to_string());
    config.model_config.whisper.language = files.language.clone();
    config.model_config.whisper.task = Some("transcribe".to_string());
    config.model_config.tokens = Some(files.tokens.display().to_string());
    config.model_config.num_threads = threads;
    config.feat_config.sample_rate = SAMPLE_RATE as i32;
    config
}

/// Offline Whisper has no word-by-word output. A Silero VAD cuts the loopback
/// stream at pauses and every finished span is decoded as one sentence, so the
/// transcript gains a line per spoken sentence instead of per word.
fn whisper_loop(
    rx: Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
    sink: EngineSink,
    files: WhisperFiles,
    threads: i32,
    translate: Arc<TranslateService>,
) {
    let config = whisper_config(&files, threads);
    let Some(recognizer) = OfflineRecognizer::create(&config) else {
        sink.send(EngineEvent::Error {
            message: general::pick(
                "Whisper 模型加载失败。检查模型文件是否完整（encoder、decoder、tokens）。",
                "Could not load the Whisper model. Check that encoder, decoder and tokens are present.",
            )
            .to_string(),
        });
        stop.store(true, Ordering::SeqCst);
        return;
    };

    let Some(vad_path) = files.vad.as_deref() else {
        sink.send(EngineEvent::Error {
            message: general::pick(
                "语音活动检测模型缺失：silero_vad.onnx。请重新安装应用。",
                "The voice activity model silero_vad.onnx is missing. Reinstall the app.",
            )
            .to_string(),
        });
        stop.store(true, Ordering::SeqCst);
        return;
    };

    let mut vad_config = VadModelConfig::default();
    vad_config.silero_vad.model = Some(vad_path.display().to_string());
    vad_config.silero_vad.threshold = 0.5;
    vad_config.silero_vad.min_silence_duration = 0.55;
    vad_config.silero_vad.min_speech_duration = 0.25;
    vad_config.silero_vad.window_size = 512;
    vad_config.silero_vad.max_speech_duration = 20.0;
    vad_config.sample_rate = SAMPLE_RATE as i32;
    vad_config.num_threads = 1;

    let Some(vad) = VoiceActivityDetector::create(&vad_config, 30.0) else {
        sink.send(EngineEvent::Error {
            message: general::pick(
                "语音活动检测模型加载失败：silero_vad.onnx 缺失或损坏。",
                "Could not load the voice activity model: silero_vad.onnx is missing or damaged.",
            )
            .to_string(),
        });
        stop.store(true, Ordering::SeqCst);
        return;
    };

    log::info!(
        "asr: whisper ready ({} threads, language={})",
        threads,
        files.language.as_deref().unwrap_or("auto")
    );

    sink.send(EngineEvent::Status {
        state: "listening",
        message: Some(
            general::pick(
                "Whisper 整段识别：说完一句、停顿后出字",
                "Whisper segment recognition: text appears after a sentence and a pause",
            )
            .to_string(),
        ),
        source: None,
        sample_rate: Some(SAMPLE_RATE),
    });

    let mut utterance_id: u64 = 1;
    let mut session_samples: u64 = 0;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let chunk = match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(chunk) => chunk,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        if chunk.is_empty() {
            continue;
        }

        vad.accept_waveform(&chunk);
        session_samples += chunk.len() as u64;
        drain_whisper_segments(
            &vad,
            &recognizer,
            &sink,
            &translate,
            &mut utterance_id,
            session_samples,
        );
    }

    // Whatever the speaker was in the middle of still deserves a final line.
    vad.flush();
    drain_whisper_segments(
        &vad,
        &recognizer,
        &sink,
        &translate,
        &mut utterance_id,
        session_samples,
    );
}

fn drain_whisper_segments(
    vad: &VoiceActivityDetector,
    recognizer: &OfflineRecognizer,
    sink: &EngineSink,
    translate: &TranslateService,
    utterance_id: &mut u64,
    session_samples: u64,
) {
    while let Some(segment) = vad.front() {
        let samples = segment.samples();
        if !samples.is_empty() {
            let stream = recognizer.create_stream();
            stream.accept_waveform(SAMPLE_RATE as i32, samples);
            recognizer.decode(&stream);
            let text = stream
                .get_result()
                .map(|result| result.text.trim().to_string())
                .unwrap_or_default();
            if !text.is_empty() {
                let end_ms = session_samples * 1000 / SAMPLE_RATE as u64;
                let duration_ms = samples.len() as u64 * 1000 / SAMPLE_RATE as u64;
                let start_ms = end_ms.saturating_sub(duration_ms);
                log::info!("whisper {}–{}ms: {}", start_ms, end_ms, text);
                sink.send(EngineEvent::Final {
                    id: *utterance_id,
                    text: text.clone(),
                    start_ms,
                    end_ms,
                });
                translate.submit(*utterance_id, text, sink.clone());
                *utterance_id += 1;
            }
        }
        vad.pop();
    }
}

/* ------------------------------------------------------------------------- */
/* Capture worker                                                            */
/* ------------------------------------------------------------------------- */

#[cfg(windows)]
fn spawn_capture(
    tx: SyncSender<Vec<f32>>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    sink: EngineSink,
    settings: AudioSettings,
) -> Option<JoinHandle<()>> {
    use crate::audio::AudioSource;

    let specs: Vec<CaptureSpec> = match settings.source() {
        AudioSource::System => vec![CaptureSpec::Output(settings.device.clone())],
        AudioSource::Microphone => vec![CaptureSpec::Input(settings.mic_device.clone())],
        AudioSource::Both => vec![
            CaptureSpec::Output(settings.device.clone()),
            CaptureSpec::Input(settings.mic_device.clone()),
        ],
        AudioSource::Process => match settings.process_id {
            Some(pid) => vec![CaptureSpec::Process(pid)],
            None => {
                sink.send(EngineEvent::Error {
                    message: general::pick(
                        "还没有选择要采集的应用。打开设置 → 识别，选一个正在播放的应用。",
                        "No app selected. Open Settings → Recognition and pick an app that is playing audio.",
                    )
                    .to_string(),
                });
                return None;
            }
        },
    };

    spawn_thread("sabir-capture", move || {
        if specs.len() == 1 {
            let spec = specs.into_iter().next().expect("one spec");
            if let Err(message) = capture_loop(tx, stop, paused, Some(sink.clone()), spec, true) {
                sink.send(EngineEvent::Error { message });
            }
            return;
        }

        // System + microphone: one reader thread per device, then a mixer that
        // sums both 16 kHz streams before the recognizer sees them.
        let (system_tx, system_rx) = sync_channel::<Vec<f32>>(32);
        let (mic_tx, mic_rx) = sync_channel::<Vec<f32>>(32);
        let mut handles = Vec::new();
        for (spec, device_tx, name) in [
            (specs[0].clone(), system_tx, "sabir-capture-system"),
            (specs[1].clone(), mic_tx, "sabir-capture-mic"),
        ] {
            let stop = Arc::clone(&stop);
            let paused = Arc::clone(&paused);
            let errors = sink.clone();
            if let Some(handle) = spawn_thread(name, move || {
                if let Err(message) = capture_loop(device_tx, stop, paused, None, spec, false) {
                    // One half of the mix can fail (no microphone on a desktop,
                    // for example). Keep the other half flowing and say so.
                    errors.send(EngineEvent::Status {
                        state: "listening",
                        message: Some(if general::is_chinese() {
                            format!("{message}；另一路继续采集中")
                        } else {
                            format!("{message}; the other input keeps recording")
                        }),
                        source: None,
                        sample_rate: None,
                    });
                }
            }) {
                handles.push(handle);
            }
        }

        sink.send(EngineEvent::Status {
            state: "starting",
            message: Some(
                general::pick(
                    "系统声音 + 麦克风混音（16 kHz 单声道）",
                    "System audio + microphone mix (16 kHz mono)",
                )
                .to_string(),
            ),
            source: Some(
                general::pick("系统声音 + 麦克风", "System audio + microphone").to_string(),
            ),
            sample_rate: Some(SAMPLE_RATE),
        });
        if let Err(message) = mix_loop(system_rx, mic_rx, tx, Arc::clone(&stop), sink.clone()) {
            sink.send(EngineEvent::Error { message });
        }
        for handle in handles {
            let _ = handle.join();
        }
    })
}

#[cfg(windows)]
#[derive(Clone)]
enum CaptureSpec {
    /// Loopback of an output endpoint.
    Output(Option<String>),
    /// A microphone / capture endpoint.
    Input(Option<String>),
    /// Process loopback of one application, including its children.
    Process(u32),
}

#[cfg(windows)]
fn open_endpoint(
    direction: wasapi::Direction,
    id: Option<&str>,
    kind: &str,
) -> Result<(wasapi::AudioClient, String), String> {
    use wasapi::DeviceEnumerator;

    let enumerator = DeviceEnumerator::new().map_err(|err| format!("audio enumerator: {err}"))?;
    let device = match id {
        Some(id) => enumerator
            .get_device(id)
            .or_else(|_| enumerator.get_default_device(direction)),
        None => enumerator.get_default_device(direction),
    }
    .map_err(|err| {
        if general::is_chinese() {
            format!("找不到{kind}设备：{err}")
        } else {
            format!("Could not find the {kind} device: {err}")
        }
    })?;
    let label = device
        .get_friendlyname()
        .unwrap_or_else(|_| "Audio device".to_string());
    let client = device
        .get_iaudioclient()
        .map_err(|err| {
            if general::is_chinese() {
                format!("打开设备失败：{err}")
            } else {
                format!("Could not open the device: {err}")
            }
        })?;
    Ok((client, label))
}

#[cfg(windows)]
fn capture_loop(
    tx: SyncSender<Vec<f32>>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    levels: Option<EngineSink>,
    spec: CaptureSpec,
    announce: bool,
) -> Result<(), String> {
    use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

    initialize_mta()
        .ok()
        .map_err(|err| format!("COM initialization failed: {err}"))?;

    let format = WaveFormat::new(32, 32, SampleType::Float, SAMPLE_RATE as usize, 1, None);

    let (mut client, display, keepalive, announcement) = match &spec {
        CaptureSpec::Output(device) => {
            let (client, label) = open_endpoint(
                Direction::Render,
                device.as_deref(),
                general::pick("输出", "output"),
            )?;
            let announcement = if general::is_chinese() {
                format!("正在采集 \"{label}\"（16 kHz 单声道）")
            } else {
                format!("Capturing \"{label}\" (16 kHz mono)")
            };
            (client, label, true, announcement)
        }
        CaptureSpec::Input(device) => {
            let (client, label) = open_endpoint(
                Direction::Capture,
                device.as_deref(),
                general::pick("麦克风", "microphone"),
            )?;
            let announcement = if general::is_chinese() {
                format!("正在采集麦克风 \"{label}\"（16 kHz 单声道）")
            } else {
                format!("Capturing microphone \"{label}\" (16 kHz mono)")
            };
            (
                client,
                format!("{} · {label}", general::pick("麦克风", "Microphone")),
                false,
                announcement,
            )
        }
        CaptureSpec::Process(pid) => {
            let client = AudioClient::new_application_loopback_client(*pid, true)
                .map_err(|err| {
                    if general::is_chinese() {
                        format!("打开应用音频失败：{err}")
                    } else {
                        format!("Could not open app audio: {err}")
                    }
                })?;
            (
                client,
                general::pick("单个应用", "Single app").to_string(),
                true,
                general::pick(
                    "正在采集所选应用的音频（16 kHz 单声道）",
                    "Capturing the selected app (16 kHz mono)",
                )
                .to_string(),
            )
        }
    };

    // Process loopback has no device period; any buffer duration is accepted.
    let period = match client.get_device_period() {
        Ok((_, period)) => period,
        Err(_) => 200_000,
    };

    client
        .initialize_client(
            &format,
            Direction::Capture,
            StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: period,
            },
            None,
        )
        .map_err(|err| {
            if general::is_chinese() {
                format!("{display} 初始化失败：{err}")
            } else {
                format!("Could not initialize {display}: {err}")
            }
        })?;

    let event = client
        .set_get_eventhandle()
        .map_err(|err| format!("capture event: {err}"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|err| format!("capture client: {err}"))?;

    client
        .start_stream()
        .map_err(|err| format!("start capture: {err}"))?;

    log::info!("capture: {display} @ {SAMPLE_RATE} Hz mono");
    if announce {
        if let Some(sink) = levels.as_ref() {
            sink.send(EngineEvent::Status {
                state: "starting",
                message: Some(announcement),
                source: Some(display),
                sample_rate: Some(SAMPLE_RATE),
            });
        }
    }

    let mut buffer = vec![0u8; (SAMPLE_RATE as usize / 10) * 4];
    let mut last_level = Instant::now();
    let mut last_audio = Instant::now();
    // In shared loopback mode WASAPI stops delivering packets when nothing is
    // playing. Without this, an utterance never reaches its trailing-silence
    // endpoint and the last sentence would wait for the next sound to appear.
    // Microphones deliver silence as packets, so this only applies to loopback.
    let silence = vec![0f32; SAMPLE_RATE as usize / 10];

    while !stop.load(Ordering::SeqCst) {
        let is_paused = paused.load(Ordering::SeqCst);
        if event.wait_for_event(100).is_err() {
            if keepalive
                && !is_paused
                && last_audio.elapsed() < Duration::from_secs(6)
                && tx.send(silence.clone()).is_err()
            {
                let _ = client.stop_stream();
                return Ok(());
            }
            if let (Some(sink), true) = (
                levels.as_ref(),
                last_level.elapsed() >= Duration::from_millis(150),
            ) {
                sink.send(EngineEvent::Level { rms: 0.0, peak: 0.0 });
                last_level = Instant::now();
            }
            continue;
        }

        last_audio = Instant::now();

        loop {
            match capture.get_next_packet_size() {
                Ok(Some(0)) | Ok(None) => break,
                Ok(Some(_)) => {}
                Err(_) => break,
            }

            let (frames, _info) = match capture.read_from_device(&mut buffer) {
                Ok(read) => read,
                Err(_) => break,
            };
            if frames == 0 {
                break;
            }

            // While paused, drain the device so the stream never backs up, but
            // send nothing to the recognizer: the session and transcript stay.
            if paused.load(Ordering::SeqCst) {
                continue;
            }

            let byte_len = frames as usize * 4;
            let samples: Vec<f32> = buffer[..byte_len]
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                .collect();

            if let Some(sink) = levels.as_ref() {
                if last_level.elapsed() >= Duration::from_millis(90) {
                    let (rms, peak) = level_of(&samples);
                    sink.send(EngineEvent::Level { rms, peak });
                    last_level = Instant::now();
                }
            }

            if tx.send(samples).is_err() {
                let _ = client.stop_stream();
                return Ok(());
            }
        }
    }

    let _ = client.stop_stream();
    Ok(())
}

#[cfg(windows)]
fn level_of(samples: &[f32]) -> (f32, f32) {
    let mut sum = 0.0f64;
    let mut peak = 0.0f32;
    for sample in samples {
        let value = sample.abs();
        sum += (value * value) as f64;
        if value > peak {
            peak = value;
        }
    }
    let rms = if samples.is_empty() {
        0.0
    } else {
        ((sum / samples.len() as f64).sqrt() as f32 * 4.0).clamp(0.0, 1.0)
    };
    (rms, peak.clamp(0.0, 1.0))
}

/// Sums the system loopback and microphone streams sample by sample and emits
/// steady 100 ms chunks, so the recognizer sees one continuous 16 kHz stream.
#[cfg(windows)]
fn mix_loop(
    system: Receiver<Vec<f32>>,
    microphone: Receiver<Vec<f32>>,
    tx: SyncSender<Vec<f32>>,
    stop: Arc<AtomicBool>,
    sink: EngineSink,
) -> Result<(), String> {
    use std::collections::VecDeque;
    use std::sync::mpsc::{RecvTimeoutError, TryRecvError};

    const CHUNK: usize = SAMPLE_RATE as usize / 10;
    const MAX_BUFFER: usize = SAMPLE_RATE as usize * 5;

    let mut system_buffer: VecDeque<f32> = VecDeque::new();
    let mut mic_buffer: VecDeque<f32> = VecDeque::new();
    let mut system_open = true;
    let mut mic_open = true;
    let mut last_level = Instant::now();

    while !stop.load(Ordering::SeqCst) {
        if system_open {
            match system.recv_timeout(Duration::from_millis(12)) {
                Ok(chunk) => system_buffer.extend(chunk),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => system_open = false,
            }
        } else {
            thread::sleep(Duration::from_millis(12));
        }

        if mic_open {
            loop {
                match microphone.try_recv() {
                    Ok(chunk) => mic_buffer.extend(chunk),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        mic_open = false;
                        break;
                    }
                }
            }
        }

        if !system_open && !mic_open {
            break;
        }

        while system_buffer.len() >= CHUNK && mic_buffer.len() >= CHUNK {
            let mut mixed = Vec::with_capacity(CHUNK);
            for _ in 0..CHUNK {
                let left = system_buffer.pop_front().unwrap_or(0.0);
                let right = mic_buffer.pop_front().unwrap_or(0.0);
                mixed.push((left + right).clamp(-1.0, 1.0));
            }
            deliver_mixed(&tx, mixed, &sink, &mut last_level);
        }

        // One side can fall quiet while the other still carries speech; keep
        // that side flowing on its own instead of stalling the recognizer.
        if mic_buffer.is_empty() && system_buffer.len() >= CHUNK * 3 {
            let mixed: Vec<f32> = system_buffer.drain(..CHUNK).collect();
            deliver_mixed(&tx, mixed, &sink, &mut last_level);
        }
        if system_buffer.is_empty() && mic_buffer.len() >= CHUNK * 3 {
            let mixed: Vec<f32> = mic_buffer.drain(..CHUNK).collect();
            deliver_mixed(&tx, mixed, &sink, &mut last_level);
        }

        if system_buffer.len() > MAX_BUFFER {
            system_buffer.drain(..system_buffer.len() - MAX_BUFFER);
        }
        if mic_buffer.len() > MAX_BUFFER {
            mic_buffer.drain(..mic_buffer.len() - MAX_BUFFER);
        }
    }

    Ok(())
}

#[cfg(windows)]
fn deliver_mixed(
    tx: &SyncSender<Vec<f32>>,
    mixed: Vec<f32>,
    sink: &EngineSink,
    last_level: &mut Instant,
) {
    if last_level.elapsed() >= Duration::from_millis(90) {
        let (rms, peak) = level_of(&mixed);
        sink.send(EngineEvent::Level { rms, peak });
        *last_level = Instant::now();
    }
    let _ = tx.send(mixed);
}

#[cfg(not(windows))]
fn spawn_capture(
    _tx: SyncSender<Vec<f32>>,
    _stop: Arc<AtomicBool>,
    _paused: Arc<AtomicBool>,
    sink: EngineSink,
    _settings: AudioSettings,
) -> Option<JoinHandle<()>> {
    sink.send(EngineEvent::Error {
        message: "This spike only implements Windows loopback capture. macOS (ScreenCaptureKit) and Linux (PipeWire) capture are next.".to_string(),
    });
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr_models::{discover, ModelFiles};
    use std::path::{Path, PathBuf};

    /// Minimal 16 kHz mono PCM16 reader for the repository's sample clips.
    fn read_wav(path: &Path) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("read wav");
        let mut position = 12; // skip "RIFF" size "WAVE"
        while position + 8 <= bytes.len() {
            let id = &bytes[position..position + 4];
            let size = u32::from_le_bytes([
                bytes[position + 4],
                bytes[position + 5],
                bytes[position + 6],
                bytes[position + 7],
            ]) as usize;
            let body = position + 8;
            if id == b"data" {
                return bytes[body..(body + size).min(bytes.len())]
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
                    .collect();
            }
            position = body + size + (size & 1);
        }
        panic!("no data chunk in {}", path.display());
    }

    fn whisper_test_dir() -> Option<PathBuf> {
        if let Ok(dir) = std::env::var("SABIR_WHISPER_TEST_DIR") {
            return Some(PathBuf::from(dir));
        }
        let dir = std::env::temp_dir()
            .join("sabir-whisper-download-test")
            .join("whisper-small");
        discover(&dir).is_some().then_some(dir)
    }

    #[test]
    #[ignore = "needs the whisper-small download test to have run; use --ignored"]
    fn whisper_decodes_the_sample_clip() {
        let Some(dir) = whisper_test_dir() else {
            panic!("download whisper-small first (cargo test -- --ignored downloads_whisper_small_from_mirror)");
        };
        let Some(ModelFiles::Whisper(mut files)) = discover(&dir) else {
            panic!("{} is not a whisper model directory", dir.display());
        };
        files.vad = Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("vendor/vad/silero_vad.onnx"),
        );

        let samples = read_wav(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/0.wav"));
        let recognizer = OfflineRecognizer::create(&whisper_config(&files, 2))
            .expect("whisper recognizer should load");
        let stream = recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE as i32, &samples);
        recognizer.decode(&stream);
        let text = stream.get_result().map(|result| result.text).unwrap_or_default();
        eprintln!("whisper heard: {text}");
        assert!(!text.trim().is_empty(), "expected a transcript");

        let mut vad_config = VadModelConfig::default();
        vad_config.silero_vad.model = Some(files.vad.unwrap().display().to_string());
        vad_config.silero_vad.threshold = 0.5;
        vad_config.silero_vad.min_silence_duration = 0.55;
        vad_config.silero_vad.min_speech_duration = 0.25;
        vad_config.silero_vad.window_size = 512;
        vad_config.sample_rate = SAMPLE_RATE as i32;
        let vad = VoiceActivityDetector::create(&vad_config, 30.0)
            .expect("bundled silero VAD should load");
        vad.accept_waveform(&samples);
        vad.flush();
        assert!(!vad.is_empty(), "VAD should cut at least one speech segment");
    }
}
