mod asr_models;
mod ask;
mod audio;
pub mod cli;
mod diagnostics;
mod download;
mod engine;
mod environment;
mod general;
mod glossary;
mod plugins;
mod store;
mod translate;
mod tray;
mod voice;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use asr_models::{
    cancel_asr_download, delete_asr_model, download_asr_model, get_asr_settings, list_asr_models,
    save_asr_settings, AsrService,
};
use audio::{AudioDevices, AudioProcess, AudioSettings};
use engine::{Engine, EngineEvent};
use general::GeneralSettings;
use glossary::{Glossary, GlossaryPreset};
use serde::Serialize;
use plugins::{PluginService, PluginSettings, PluginSettingsView};
use store::{SearchHit, SessionMeta, SessionStore, StoredSegment, EXPORT_FORMATS};
use tauri::ipc::Channel;
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, State};
use translate::{
    cancel_translate_download, clear_provider_api_key, delete_translate_model,
    download_translate_model, get_translate_settings, retranslate_segment, save_translate_settings,
    test_translation, TranslateService,
};
use voice::{
    cancel_voice_download, delete_voice_model, download_voice_model, get_voice_settings,
    save_voice_settings, synthesize_voice, VoiceService,
};

#[tauri::command]
fn start_listening(
    app: AppHandle,
    engine: State<'_, Engine>,
    channel: Channel<EngineEvent>,
) -> Result<(), String> {
    engine.start(&app, channel)
}

#[tauri::command]
fn stop_listening(engine: State<'_, Engine>) {
    engine.stop();
}

#[tauri::command]
fn pause_listening(engine: State<'_, Engine>) {
    engine.pause();
}

#[tauri::command]
fn resume_listening(engine: State<'_, Engine>) {
    engine.resume();
}

#[tauri::command]
fn current_session(engine: State<'_, Engine>) -> Option<i64> {
    engine.current_session()
}

/// Export the current (or a given) session to the configured directory, or
/// `Documents\Sabir` when the user has not picked one.
#[tauri::command]
fn export_session(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: Option<i64>,
    format: String,
) -> Result<String, String> {
    let format = format.trim().to_lowercase();
    if !EXPORT_FORMATS.contains(&format.as_str()) {
        return Err(if general::is_chinese() {
            format!("不支持的导出格式：{format}")
        } else {
            format!("Unsupported export format: {format}")
        });
    }
    let store = engine.store();
    let id = session_id
        .or_else(|| engine.current_session())
        .or_else(|| store.latest_session())
        .ok_or_else(|| {
            general::pick(
                "还没有可导出的会话；先听一段再导出。",
                "Nothing to export yet; listen to something first.",
            )
            .to_string()
        })?;
    let meta = store
        .meta(id)
        .ok_or_else(|| general::pick("找不到这场会话", "Session not found").to_string())?;
    let slug = meta
        .started_at
        .chars()
        .take(16)
        .collect::<String>()
        .replace(' ', "-")
        .replace(':', "");
    let settings = general::load(&general::settings_path(&app));
    let dir = match settings.export_dir {
        Some(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir),
        _ => general::default_export_dir(&app)?,
    };
    let dest = dir.join(format!("sabir-{slug}.{format}"));
    let path = store.export(id, &format, &dest)?;
    Ok(path.display().to_string())
}

/// The folder records land in when the user has not picked one.
#[tauri::command]
fn default_export_dir(app: AppHandle) -> Result<String, String> {
    general::default_export_dir(&app).map(|dir| dir.display().to_string())
}

/// Open the records folder in the system file manager. `dir` is the folder the
/// Records page shows; `None` means the default `Documents\Sabir`.
#[tauri::command]
fn open_export_dir(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    let dir = match dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => PathBuf::from(value),
        None => general::default_export_dir(&app)?,
    };
    std::fs::create_dir_all(&dir).map_err(|err| {
        if general::is_chinese() {
            format!("无法创建记录目录：{err}")
        } else {
            format!("Could not create the records folder: {err}")
        }
    })?;
    open_in_file_manager(&dir)?;
    Ok(dir.display().to_string())
}

#[cfg(target_os = "windows")]
fn open_in_file_manager(path: &Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| {
            if general::is_chinese() {
                format!("无法打开目录：{err}")
            } else {
                format!("Could not open the folder: {err}")
            }
        })
}

#[cfg(not(target_os = "windows"))]
fn open_in_file_manager(path: &Path) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| {
            if general::is_chinese() {
                format!("无法打开目录：{err}")
            } else {
                format!("Could not open the folder: {err}")
            }
        })
}

/// Turn the frosted, translucent window on or off. The window is created with
/// `transparent: true`; the acrylic effect is what the OS paints underneath.
/// Systems with transparency disabled simply keep the opaque background.
#[tauri::command]
fn set_window_translucency(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| general::pick("找不到主窗口", "Main window not found").to_string())?;
    let effects: Option<WindowEffectsConfig> = if enabled {
        Some(
            EffectsBuilder::new()
                .effect(Effect::Acrylic)
                .state(EffectState::Active)
                .build(),
        )
    } else {
        None
    };
    log::info!("window translucency: enabled={enabled}");
    window.set_effects(effects).map_err(|err| {
        log::warn!("window translucency failed: {err}");
        err.to_string()
    })
}

#[tauri::command]
fn rename_session(
    engine: State<'_, Engine>,
    session_id: i64,
    title: String,
) -> Result<SessionMeta, String> {
    engine.store().rename_session(session_id, &title)
}

#[tauri::command]
fn get_general_settings(app: AppHandle) -> GeneralSettings {
    general::load(&general::settings_path(&app))
}

#[tauri::command]
fn save_general_settings(
    app: AppHandle,
    settings: GeneralSettings,
) -> Result<GeneralSettings, String> {
    let settings = settings.normalized();
    if let Some(dir) = settings.export_dir.as_deref() {
        std::fs::create_dir_all(dir)
            .map_err(|err| {
                if general::is_chinese() {
                    format!("无法创建导出目录：{err}")
                } else {
                    format!("Could not create the export folder: {err}")
                }
            })?;
    }
    general::save(&general::settings_path(&app), &settings)?;
    general::set_locale(&settings.locale);
    Ok(settings)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDetail {
    meta: SessionMeta,
    segments: Vec<StoredSegment>,
}

#[tauri::command]
fn list_sessions(
    engine: State<'_, Engine>,
    query: Option<String>,
    limit: Option<u32>,
) -> Vec<SessionMeta> {
    engine
        .store()
        .list_sessions(query.as_deref().unwrap_or(""), limit.unwrap_or(80) as usize)
}

#[tauri::command]
fn session_detail(engine: State<'_, Engine>, session_id: i64) -> Result<SessionDetail, String> {
    let store = engine.store();
    let meta = store
        .meta(session_id)
        .ok_or_else(|| "找不到这场会话".to_string())?;
    Ok(SessionDetail {
        segments: store.segments(session_id),
        meta,
    })
}

#[tauri::command]
fn delete_session(engine: State<'_, Engine>, session_id: i64) -> Result<(), String> {
    engine.store().delete_session(session_id)
}

#[tauri::command]
fn get_audio_settings(app: AppHandle) -> Result<AudioSettings, String> {
    Ok(audio::load(&audio_settings_path(&app)?))
}

#[tauri::command]
fn save_audio_settings(
    app: AppHandle,
    settings: AudioSettings,
) -> Result<AudioSettings, String> {
    audio::save(&audio_settings_path(&app)?, &settings)
}

#[tauri::command]
fn list_audio_devices() -> Result<AudioDevices, String> {
    audio::list_devices()
}

#[tauri::command]
fn list_audio_processes() -> Result<Vec<AudioProcess>, String> {
    audio::list_processes()
}

#[tauri::command]
fn get_glossary(translate: State<'_, Arc<TranslateService>>) -> Glossary {
    translate.glossary()
}

#[tauri::command]
fn save_glossary(
    translate: State<'_, Arc<TranslateService>>,
    glossary: Glossary,
) -> Result<Glossary, String> {
    translate.save_glossary(glossary)
}

/// Write the presets currently shown in settings to a shared JSON file.
#[tauri::command]
fn export_glossary(path: String, glossary: Glossary) -> Result<String, String> {
    glossary::export_portable(Path::new(&path), &glossary)
        .map(|path| path.display().to_string())
}

/// Read a shared glossary file; the result has fresh ids to merge into the
/// glossary being edited.
#[tauri::command]
fn import_glossary(path: String) -> Result<Vec<GlossaryPreset>, String> {
    glossary::import_portable(Path::new(&path))
}

/// Write configured provider profiles without keys, consent or ids.
#[tauri::command]
fn export_provider_profiles(
    path: String,
    profiles: Vec<translate::ProviderProfile>,
) -> Result<String, String> {
    translate::export_provider_profiles(Path::new(&path), &profiles)
        .map(|path| path.display().to_string())
}

/// Read a shared provider-profile file; profiles come back without ids,
/// consent or keys.
#[tauri::command]
fn import_provider_profiles(path: String) -> Result<Vec<translate::ProviderProfile>, String> {
    translate::import_provider_profiles(Path::new(&path))
}

/// Every transcript line across sessions that matches `query`, for cross-
/// session search without a model.
#[tauri::command]
fn search_transcripts(engine: State<'_, Engine>, query: String) -> Vec<ask::CrossLine> {
    ask::search_across(&engine.store(), &query)
}

#[tauri::command]
fn ask_question(
    translate: State<'_, Arc<TranslateService>>,
    question: String,
    lines: Vec<ask::AskLine>,
    channel: Channel<ask::AskEvent>,
) {
    let service = Arc::clone(&translate);
    std::thread::spawn(move || ask::ask(&service, &question, &lines, channel));
}

/// Ask across every session: Rust retrieves the relevant lines, streams them
/// back first, then answers from them.
#[tauri::command]
fn ask_across_sessions(
    engine: State<'_, Engine>,
    translate: State<'_, Arc<TranslateService>>,
    question: String,
    channel: Channel<ask::CrossAskEvent>,
) {
    let store = engine.store();
    let service = Arc::clone(&translate);
    std::thread::spawn(move || ask::ask_across(&store, &service, &question, channel));
}

#[tauri::command]
fn probe_environment(translate: State<'_, Arc<TranslateService>>) -> environment::Environment {
    environment::probe(&translate.local_base_url())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    window
        .set_always_on_top(enabled)
        .map_err(|err| format!("置顶失败：{err}"))?;
    Ok(enabled)
}

/// Show or hide the floating recording pill. While visible it sits at the
/// bottom-right corner of the main window, so it stays near the captions.
#[tauri::command]
fn set_float_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let float = app
        .get_webview_window("float")
        .ok_or_else(|| "找不到浮标窗口".to_string())?;
    if visible {
        if let Some(main) = app.get_webview_window("main") {
            if let (Ok(position), Ok(size), Ok(float_size)) =
                (main.outer_position(), main.outer_size(), float.outer_size())
            {
                let margin = 24i32;
                let x = position.x + size.width as i32 - float_size.width as i32 - margin;
                let y = position.y + size.height as i32 - float_size.height as i32 - margin;
                let _ = float.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
            }
        }
        float.show().map_err(|err| format!("显示浮标失败：{err}"))?;
        let _ = float.set_always_on_top(true);
    } else {
        float.hide().map_err(|err| format!("隐藏浮标失败：{err}"))?;
    }
    Ok(())
}

/// Show or hide the subtitle overlay. The overlay remembers its own position in
/// the webview's localStorage, so it is only shown and hidden here.
#[tauri::command]
fn set_caption_visible(
    app: AppHandle,
    visible: bool,
    spot: Option<CaptionSpot>,
) -> Result<(), String> {
    let caption = app.get_webview_window("caption").ok_or_else(|| {
        general::pick("找不到字幕浮窗", "Caption overlay window not found").to_string()
    })?;
    if visible {
        // Never take focus away from the video or lecture underneath; clicks on
        // the overlay's own buttons still arrive.
        let _ = caption.set_focusable(false);
        let _ = caption.set_always_on_top(true);
        // Position before showing, so the window does not flash at a stale spot.
        place_caption(&app, spot)?;
        caption.show().map_err(|err| {
            if general::is_chinese() {
                format!("显示字幕浮窗失败：{err}")
            } else {
                format!("Could not show the caption overlay: {err}")
            }
        })?;
    } else {
        caption.hide().map_err(|err| {
            if general::is_chinese() {
                format!("隐藏字幕浮窗失败：{err}")
            } else {
                format!("Could not hide the caption overlay: {err}")
            }
        })?;
    }
    Ok(())
}

/// Where the user left the overlay (physical pixels), stored by its webview.
#[derive(Clone, Copy, serde::Deserialize)]
struct CaptionSpot {
    x: i32,
    y: i32,
}

/// Put the overlay back where the user dragged it, or at the bottom centre of
/// the screen on first use. Done here rather than in the webview so it works
/// even before the overlay document has loaded.
fn place_caption(app: &AppHandle, spot: Option<CaptionSpot>) -> Result<(), String> {
    let caption = app
        .get_webview_window("caption")
        .ok_or_else(|| general::pick("找不到字幕浮窗", "Caption overlay window not found").to_string())?;
    let size = caption.outer_size().map_err(|err| err.to_string())?;
    // Prefer the monitor the saved spot is on: the user may have dragged the
    // overlay to a second screen. Otherwise follow the main window.
    let monitor = spot
        .and_then(|spot| {
            app.monitor_from_point(spot.x as f64, spot.y as f64)
                .ok()
                .flatten()
        })
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|main| main.current_monitor().ok().flatten())
        })
        .or_else(|| caption.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let origin = monitor.position();
    let area = monitor.size();
    let room_x = (area.width as i32 - size.width as i32).max(0);
    let room_y = (area.height as i32 - size.height as i32).max(0);
    let (x, y) = match spot {
        Some(spot) => (spot.x, spot.y),
        None => (origin.x + room_x / 2, origin.y + room_y - 96),
    };
    caption
        .set_position(tauri::PhysicalPosition::new(
            x.clamp(origin.x, origin.x + room_x),
            y.clamp(origin.y, origin.y + room_y),
        ))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let _ = main.unminimize();
    main.show().map_err(|err| format!("显示主窗口失败：{err}"))?;
    main.set_focus()
        .map_err(|err| format!("聚焦主窗口失败：{err}"))?;
    Ok(())
}

#[tauri::command]
fn get_plugin_settings(plugins: State<'_, Arc<PluginService>>) -> PluginSettingsView {
    plugins.view()
}

#[tauri::command]
fn save_plugin_settings(
    plugins: State<'_, Arc<PluginService>>,
    settings: PluginSettings,
) -> Result<PluginSettingsView, String> {
    plugins.save(settings)
}

/// Run a plugin once with a sample sentence and report what came back.
#[tauri::command]
async fn test_plugin(command: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || plugins::probe(&command))
        .await
        .map_err(|err| err.to_string())?
}

/// Full-text search across local sessions (the library's search panel).
#[tauri::command]
fn search_library(
    engine: State<'_, Engine>,
    query: String,
    limit: Option<u32>,
    session_id: Option<i64>,
) -> Vec<SearchHit> {
    engine
        .store()
        .search_fulltext(&query, limit.unwrap_or(40) as usize, session_id)
}

/// Write a support bundle the user can attach to a bug report.
#[tauri::command]
fn export_diagnostics(
    app: AppHandle,
    engine: State<'_, Engine>,
    path: String,
) -> Result<String, String> {
    diagnostics::export(&app, engine.store().health(), Path::new(&path))
}

fn audio_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("audio.json"))
        .map_err(|err| format!("找不到设置目录：{err}"))
}

/// Move the pre-rename app folders (`app.livetrans.desktop`) once, so local
/// sessions, downloaded models and settings survive the rename. It only acts
/// when the new folder does not exist yet; failures are logged, not fatal.
fn migrate_legacy_app_dirs(app: &AppHandle) {
    for dir in [app.path().app_data_dir(), app.path().app_config_dir()]
        .into_iter()
        .flatten()
    {
        if dir.exists() {
            continue;
        }
        let Some(parent) = dir.parent() else {
            continue;
        };
        let old = parent.join("app.livetrans.desktop");
        if old == dir || !old.is_dir() {
            continue;
        }
        match std::fs::rename(&old, &dir) {
            Ok(()) => log::info!("migrated legacy app folder to {}", dir.display()),
            Err(err) => log::warn!("could not migrate {}: {err}", old.display()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            start_listening,
            stop_listening,
            pause_listening,
            resume_listening,
            current_session,
            export_session,
            list_sessions,
            session_detail,
            delete_session,
            rename_session,
            get_general_settings,
            save_general_settings,
            default_export_dir,
            open_export_dir,
            get_audio_settings,
            save_audio_settings,
            list_audio_devices,
            list_audio_processes,
            get_glossary,
            save_glossary,
            export_glossary,
            import_glossary,
            export_provider_profiles,
            import_provider_profiles,
            search_transcripts,
            search_library,
            export_diagnostics,
            get_plugin_settings,
            save_plugin_settings,
            test_plugin,
            ask_question,
            ask_across_sessions,
            probe_environment,
            set_always_on_top,
            set_window_translucency,
            set_float_visible,
            set_caption_visible,
            focus_main_window,
            get_translate_settings,
            save_translate_settings,
            clear_provider_api_key,
            test_translation,
            retranslate_segment,
            download_translate_model,
            cancel_translate_download,
            delete_translate_model,
            get_asr_settings,
            save_asr_settings,
            list_asr_models,
            download_asr_model,
            cancel_asr_download,
            delete_asr_model,
            get_voice_settings,
            save_voice_settings,
            download_voice_model,
            cancel_voice_download,
            delete_voice_model,
            synthesize_voice
        ])
        .setup(|app| {
            // Release builds keep a small rotating log too: the diagnostics
            // bundle attaches its tail without asking the user to reproduce.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                    .max_file_size(4 * 1024 * 1024)
                    .build(),
            )?;

            migrate_legacy_app_dirs(app.handle());

            // Load the interface language before any service can emit text or
            // write session rows, so labels are consistent from the first run.
            let _ = general::load(&general::settings_path(app.handle()));
            tray::build(app.handle())?;

            let asr = AsrService::start(app.handle());
            app.manage(asr);

            let database = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("sabir.db"))
                .unwrap_or_else(|_| PathBuf::from("sabir.db"));
            let store = match SessionStore::open(&database) {
                Ok(store) => store,
                Err(err) => {
                    log::error!("session store unavailable at {}: {err}", database.display());
                    let fallback = std::env::temp_dir().join("sabir.db");
                    SessionStore::open(&fallback)?
                }
            };
            let store = Arc::new(store);

            let translate = TranslateService::start(app.handle());
            let plugins = Arc::new(PluginService::start(app.handle()));
            app.manage(Engine::new(
                Arc::clone(&translate),
                Arc::clone(&store),
                Arc::clone(&plugins),
            ));
            app.manage(translate);
            app.manage(store);
            app.manage(plugins);
            app.manage(Arc::new(VoiceService::start(app.handle())));
            Ok(())
        })
        // The floating pill is a second window; closing the main window either
        // hides it in the tray or quits the whole app.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Stop the pipeline first so the open session gets its
                    // `ended_at` instead of staying "in progress" forever.
                    if let Some(engine) = window.app_handle().try_state::<Engine>() {
                        engine.stop();
                    }
                    let settings =
                        general::load(&general::settings_path(window.app_handle()));
                    if settings.minimize_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                    window.app_handle().exit(0);
                }
            } else if window.label() == "caption" {
                // The overlay has no title bar; Alt+F4 hides it and tells the
                // main window to switch the preference off.
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.app_handle().emit("sabir:caption-hidden", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
