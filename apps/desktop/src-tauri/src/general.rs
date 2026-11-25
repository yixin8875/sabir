//! Application-wide preferences that Rust needs: where exports land and which
//! interface language the user picked. The rest of the small UI preferences
//! (always-on-top, float, zoom) stay in the webview's localStorage.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// True while the interface is Simplified Chinese (the default).
static CHINESE: AtomicBool = AtomicBool::new(true);

pub fn is_chinese() -> bool {
    CHINESE.load(Ordering::Relaxed)
}

/// Pick the Chinese or English variant of a user-visible string.
pub fn pick<'a>(zh: &'a str, en: &'a str) -> &'a str {
    if is_chinese() {
        zh
    } else {
        en
    }
}

pub fn set_locale(locale: &str) {
    let chinese = locale.trim().to_lowercase() != "en";
    CHINESE.store(chinese, Ordering::Relaxed);
}

pub fn normalize_locale(locale: &str) -> String {
    if locale.trim().to_lowercase() == "en" {
        "en".to_string()
    } else {
        "zh-Hans".to_string()
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    /// Absolute directory for exported notes; `None` means `Documents\Livetrans`.
    #[serde(default)]
    pub export_dir: Option<String>,
    /// `zh-Hans` or `en`.
    #[serde(default = "default_locale")]
    pub locale: String,
}

fn default_locale() -> String {
    "zh-Hans".to_string()
}

impl GeneralSettings {
    pub fn normalized(mut self) -> Self {
        self.locale = normalize_locale(&self.locale);
        self.export_dir = self
            .export_dir
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self
    }
}

pub fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("general.json"))
        .unwrap_or_else(|_| PathBuf::from("general.json"))
}

pub fn load(path: &Path) -> GeneralSettings {
    let settings = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<GeneralSettings>(&text).ok())
        .unwrap_or_default()
        .normalized();
    set_locale(&settings.locale);
    settings
}

pub fn save(path: &Path, settings: &GeneralSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|err| format!("无法保存设置：{err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("无法保存设置：{err}"))
}

/// The directory exports default to when the user has not picked one.
pub fn default_export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .map(|dir| dir.join("Livetrans"))
        .map_err(|err| {
            if is_chinese() {
                format!("找不到文档目录：{err}")
            } else {
                format!("Could not find the Documents folder: {err}")
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_is_normalized_and_unknown_values_fall_back() {
        assert_eq!(normalize_locale("en"), "en");
        assert_eq!(normalize_locale("EN"), "en");
        assert_eq!(normalize_locale("zh-Hans"), "zh-Hans");
        assert_eq!(normalize_locale("fr"), "zh-Hans");
        set_locale("en");
        assert!(!is_chinese());
        set_locale("zh-Hans");
        assert!(is_chinese());
    }

    #[test]
    fn settings_round_trip() {
        let dir = std::env::temp_dir().join("livetrans-general-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("general.json");
        let settings = GeneralSettings {
            export_dir: Some("  D:\\notes  ".to_string()),
            locale: "en".to_string(),
        }
        .normalized();
        assert_eq!(settings.export_dir.as_deref(), Some("D:\\notes"));
        save(&path, &settings).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.export_dir.as_deref(), Some("D:\\notes"));
        assert_eq!(loaded.locale, "en");
        let empty = GeneralSettings {
            export_dir: Some("   ".to_string()),
            locale: "zh-Hans".to_string(),
        }
        .normalized();
        assert!(empty.export_dir.is_none());
        set_locale("zh-Hans");
        let _ = fs::remove_dir_all(&dir);
    }
}
