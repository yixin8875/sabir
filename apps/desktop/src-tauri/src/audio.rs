//! Which sound the engine listens to.
//!
//! Four modes: the system output (WASAPI loopback of a render endpoint), a
//! microphone (capture endpoint), both mixed together, or a single application
//! captured through WASAPI process loopback. Everything is opened in shared
//! mode with automatic conversion to 16 kHz mono float, so the engine sees one
//! format no matter which source was picked.
//!
//! The choice lives in `audio.json` next to the other settings.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioSource {
    /// WASAPI loopback of an output endpoint.
    System,
    /// A microphone / capture endpoint.
    Microphone,
    /// System output summed with a microphone.
    Both,
    /// WASAPI process loopback of one application (and its children).
    Process,
}

impl AudioSource {
    pub fn parse(value: &str) -> Self {
        match value {
            "microphone" => Self::Microphone,
            "both" => Self::Both,
            "process" => Self::Process,
            _ => Self::System,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Microphone => "microphone",
            Self::Both => "both",
            Self::Process => "process",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    /// `system`, `microphone`, `both` or `process`.
    pub source: String,
    /// Output endpoint id returned by `list_audio_devices`; `None` = default.
    pub device: Option<String>,
    /// Input endpoint id for microphone / both; `None` = default.
    pub mic_device: Option<String>,
    /// Target process for `process` mode.
    pub process_id: Option<u32>,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            source: "system".to_string(),
            device: None,
            mic_device: None,
            process_id: None,
        }
    }
}

impl AudioSettings {
    pub fn normalized(self) -> Self {
        let trim = |value: Option<String>| {
            value
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Self {
            source: AudioSource::parse(&self.source).id().to_string(),
            device: trim(self.device),
            mic_device: trim(self.mic_device),
            process_id: self.process_id.filter(|id| *id > 0),
        }
    }

    pub fn source(&self) -> AudioSource {
        AudioSource::parse(&self.source)
    }

    pub fn source_label(&self) -> &'static str {
        match self.source() {
            AudioSource::System => "系统声音",
            AudioSource::Microphone => "麦克风",
            AudioSource::Both => "系统声音 + 麦克风",
            AudioSource::Process => "单个应用",
        }
    }
}

pub fn load(path: &Path) -> AudioSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<AudioSettings>(&text).ok())
        .map(AudioSettings::normalized)
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &AudioSettings) -> Result<AudioSettings, String> {
    let settings = settings.clone().normalized();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| format!("无法创建设置目录：{err}"))?;
    }
    let body = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("无法序列化音频设置：{err}"))?;
    fs::write(path, body).map_err(|err| format!("无法写入音频设置：{err}"))?;
    Ok(settings)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    pub outputs: Vec<AudioDevice>,
    pub inputs: Vec<AudioDevice>,
}

/// An application currently playing sound, as seen by the Windows mixer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcess {
    pub pid: u32,
    pub name: String,
    pub sessions: u32,
}

#[cfg(windows)]
pub fn list_devices() -> Result<AudioDevices, String> {
    use wasapi::{initialize_mta, DeviceEnumerator, Direction};

    initialize_mta()
        .ok()
        .map_err(|err| format!("COM 初始化失败：{err}"))?;
    let enumerator = DeviceEnumerator::new().map_err(|err| format!("音频设备枚举失败：{err}"))?;

    let collect = |direction: Direction| -> Vec<AudioDevice> {
        let Ok(collection) = enumerator.get_device_collection(direction) else {
            return Vec::new();
        };
        let mut devices = Vec::new();
        for device in &collection {
            let Ok(device) = device else { continue };
            let name = device
                .get_friendlyname()
                .unwrap_or_else(|_| "未命名设备".to_string());
            let Ok(id) = device.get_id() else { continue };
            devices.push(AudioDevice { id, name });
        }
        devices
    };

    Ok(AudioDevices {
        outputs: collect(Direction::Render),
        inputs: collect(Direction::Capture),
    })
}

#[cfg(not(windows))]
pub fn list_devices() -> Result<AudioDevices, String> {
    Err("目前只有 Windows 支持设备枚举。".to_string())
}

#[cfg(windows)]
pub fn list_processes() -> Result<Vec<AudioProcess>, String> {
    use wasapi::{initialize_mta, DeviceEnumerator, Direction};

    initialize_mta()
        .ok()
        .map_err(|err| format!("COM 初始化失败：{err}"))?;
    let enumerator = DeviceEnumerator::new().map_err(|err| format!("音频设备枚举失败：{err}"))?;
    let device = enumerator
        .get_default_device(Direction::Render)
        .map_err(|err| format!("找不到默认输出设备：{err}"))?;
    let manager = device
        .get_iaudiosessionmanager()
        .map_err(|err| format!("读取音频会话失败：{err}"))?;
    let sessions = manager
        .get_audiosessionenumerator()
        .map_err(|err| format!("读取音频会话失败：{err}"))?;

    let mut by_pid: HashMap<u32, u32> = HashMap::new();
    let count = sessions.get_count().unwrap_or(0);
    for index in 0..count {
        let Ok(session) = sessions.get_session(index) else {
            continue;
        };
        let Ok(pid) = session.get_process_id() else {
            continue;
        };
        if pid == 0 || pid == std::process::id() {
            // System sounds / our own playback are not pickable apps.
            continue;
        }
        *by_pid.entry(pid).or_insert(0) += 1;
    }

    let mut processes: Vec<AudioProcess> = by_pid
        .into_iter()
        .map(|(pid, sessions)| AudioProcess {
            pid,
            name: process_name(pid).unwrap_or_else(|| format!("进程 {pid}")),
            sessions,
        })
        .collect();
    processes.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.pid.cmp(&b.pid))
    });
    Ok(processes)
}

#[cfg(not(windows))]
pub fn list_processes() -> Result<Vec<AudioProcess>, String> {
    Err("目前只有 Windows 支持按进程采集。".to_string())
}

#[cfg(windows)]
fn process_name(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = [0u16; 512];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        path.rsplit(['\\', '/'])
            .next()
            .filter(|name| !name.is_empty())
            .map(|name| name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip_and_clamp() {
        let dir = std::env::temp_dir().join("livetrans-audio-settings");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("audio.json");
        assert_eq!(load(&path), AudioSettings::default());

        let saved = save(
            &path,
            &AudioSettings {
                source: "speaker".to_string(),
                device: Some("  ".to_string()),
                mic_device: None,
                process_id: None,
            },
        )
        .unwrap();
        assert_eq!(saved.source, "system");
        assert_eq!(saved.device, None);

        let saved = save(
            &path,
            &AudioSettings {
                source: "both".to_string(),
                device: Some("{0.0.0.00000000}.{out}".to_string()),
                mic_device: Some("{0.0.1.00000000}.{mic}".to_string()),
                process_id: None,
            },
        )
        .unwrap();
        assert_eq!(saved.source(), AudioSource::Both);
        assert_eq!(saved.source_label(), "系统声音 + 麦克风");
        assert_eq!(load(&path), saved);

        let saved = save(
            &path,
            &AudioSettings {
                source: "process".to_string(),
                device: None,
                mic_device: None,
                process_id: Some(4242),
            },
        )
        .unwrap();
        assert_eq!(saved.process_id, Some(4242));
        assert_eq!(load(&path), saved);
        let _ = fs::remove_dir_all(&dir);
    }
}
