//! System tray icon and its small menu.
//!
//! Closing the main window hides it here when `minimizeToTray` is on; the tray
//! is the only way back and also carries the explicit quit action.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::general;

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(
        app,
        "show",
        general::pick("显示主窗口", "Show window"),
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        "settings",
        general::pick("设置…", "Settings…"),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        general::pick("退出 Sabir", "Quit Sabir"),
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("the app icon is bundled"),
        )
        .tooltip("Sabir")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "settings" => {
                show_main(app);
                if let Err(err) = app.emit("sabir:command", "settings") {
                    log::warn!("tray: could not send settings command: {err}");
                }
            }
            "quit" => {
                // Quitting while recording still ends the session properly and
                // writes its note.
                crate::stop_and_note(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
