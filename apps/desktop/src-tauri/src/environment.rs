//! Startup environment probe.
//!
//! Zero-config onboarding: report how much memory the machine has, whether a
//! local Ollama is answering, and which recognition model is a sensible first
//! download. Everything here is read-only and stays on the machine.

use std::time::Duration;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub memory_mb: Option<u64>,
    pub cores: u32,
    pub ollama_running: bool,
    pub ollama_models: Vec<String>,
    pub recommended_model: &'static str,
    pub reason: String,
}

pub fn probe(local_base_url: &str) -> Environment {
    let memory_mb = total_memory_mb();
    let cores = std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(0);
    let (ollama_running, ollama_models) = probe_ollama(local_base_url);
    let recommended_model = recommend_model(memory_mb);
    let reason = recommendation_reason(memory_mb, cores, recommended_model);
    Environment {
        memory_mb,
        cores,
        ollama_running,
        ollama_models,
        recommended_model,
        reason,
    }
}

/// Below 8 GB the lightweight Chinese streaming model keeps headroom for the
/// rest of the system; anything larger gets the bilingual streaming model.
pub fn recommend_model(memory_mb: Option<u64>) -> &'static str {
    match memory_mb {
        Some(mb) if mb < 8_192 => "zh-14m",
        _ => "bilingual-zh-en",
    }
}

fn recommendation_reason(memory_mb: Option<u64>, cores: u32, model: &str) -> String {
    use crate::general;
    let memory = memory_mb
        .map(|mb| format!("{:.1} GB", mb as f64 / 1024.0))
        .unwrap_or_else(|| general::pick("内存未知", "unknown memory").to_string());
    let title = match model {
        "zh-14m" => general::pick(
            "中文轻量 Zipformer（约 30MB，内存占用最小）",
            "Lightweight Chinese Zipformer (about 30 MB, lowest memory)",
        ),
        _ => general::pick(
            "中英双语 Zipformer（约 190MB，边说边出字）",
            "Bilingual Chinese–English Zipformer (about 190 MB, streams as you speak)",
        ),
    };
    if general::is_chinese() {
        format!("{memory} 内存、{cores} 核：建议先下 {title}。")
    } else {
        format!("{memory} RAM, {cores} cores: start with {title}.")
    }
}

/// `base_url` is the OpenAI-compatible URL (`…/v1`); Ollama's native API sits
/// at the root.
fn probe_ollama(base_url: &str) -> (bool, Vec<String>) {
    let root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/');
    if root.is_empty() {
        return (false, Vec::new());
    }
    let url = format!("{root}/api/tags");
    let Ok(client) = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(600))
        .timeout(Duration::from_millis(900))
        .no_proxy()
        .build()
    else {
        return (false, Vec::new());
    };
    let Ok(response) = client.get(&url).send() else {
        return (false, Vec::new());
    };
    if !response.status().is_success() {
        return (false, Vec::new());
    }
    let Ok(value) = response.json::<serde_json::Value>() else {
        return (false, Vec::new());
    };
    let models = value
        .get("models")
        .and_then(|models| models.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("name").and_then(|name| name.as_str()))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    (true, models)
}

#[cfg(windows)]
fn total_memory_mb() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::GetPhysicallyInstalledSystemMemory;

    let mut kilobytes: u64 = 0;
    let ok = unsafe { GetPhysicallyInstalledSystemMemory(&mut kilobytes) };
    (ok != 0 && kilobytes > 0).then_some(kilobytes / 1024)
}

#[cfg(not(windows))]
fn total_memory_mb() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_machines_get_the_light_model() {
        assert_eq!(recommend_model(Some(4_096)), "zh-14m");
        assert_eq!(recommend_model(Some(8_192)), "bilingual-zh-en");
        assert_eq!(recommend_model(None), "bilingual-zh-en");
        assert!(recommendation_reason(Some(16_384), 8, "bilingual-zh-en").contains("16.0 GB"));
    }

    #[test]
    fn probe_without_a_server_is_not_fatal() {
        let (running, models) = probe_ollama("http://127.0.0.1:9/v1");
        assert!(!running);
        assert!(models.is_empty());
        assert!(!probe_ollama("").0);
    }
}
