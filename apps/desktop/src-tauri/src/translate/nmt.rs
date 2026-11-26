//! Local neural machine translation: opus-mt (Marian) exported to ONNX.
//!
//! Encoder, first decoder step and cached decoder step are three separate ONNX
//! graphs (the same split Hugging Face's ONNX export uses), so the greedy
//! decode loop is explicit here: encoder → start token → repeat until EOS while
//! carrying the key/value cache. Fully on-device, no network, no tokenizer
//! service.

use std::path::Path;
use std::sync::Mutex;

use ort::session::{Session, SessionOutputs};
use ort::value::Tensor;
use tokenizers::Tokenizer;

const ENCODER: &str = "encoder_model_int8.onnx";
const DECODER: &str = "decoder_model_int8.onnx";
const DECODER_PAST: &str = "decoder_with_past_model_int8.onnx";
const TOKENIZER: &str = "tokenizer.json";
const CONFIG: &str = "config.json";

const MAX_SOURCE_TOKENS: usize = 500;
const MAX_TARGET_TOKENS: usize = 96;

/// One cached tensor: destination input name plus owned shape and data.
type CacheEntry = (String, Vec<i64>, Vec<f32>);

pub struct NmtTranslator {
    // Keeps the ONNX Runtime environment alive for the sessions below.
    _env: ort::environment::Environment,
    encoder: Mutex<Session>,
    decoder: Mutex<Session>,
    decoder_past: Mutex<Session>,
    tokenizer: Tokenizer,
    start_id: i64,
    eos_id: i64,
    layers: usize,
}

impl NmtTranslator {
    pub fn load(dir: &Path) -> Result<Self, String> {
        for file in [ENCODER, DECODER, DECODER_PAST, TOKENIZER] {
            let path = dir.join(file);
            if !path.is_file() {
                return Err(format!(
                    "本地翻译模型缺少 {}（目录 {}）。",
                    file,
                    dir.display()
                ));
            }
        }

        // The exported Marian tokenizer.json carries a Precompiled normalizer
        // with a null SentencePiece charsmap, which the Rust tokenizers crate
        // rejects. NFKC is the closest behaviour for English source text.
        let raw = std::fs::read_to_string(dir.join(TOKENIZER))
            .map_err(|err| format!("tokenizer.json 无法读取：{err}"))?;
        let mut config: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|err| format!("tokenizer.json 解析失败：{err}"))?;
        if config
            .pointer("/normalizer/precompiled_charsmap")
            .is_some_and(serde_json::Value::is_null)
        {
            config["normalizer"] = serde_json::json!({ "type": "NFKC" });
        }
        let tokenizer = Tokenizer::from_bytes(config.to_string())
            .map_err(|err| format!("tokenizer.json 无法读取：{err}"))?;

        let config: serde_json::Value = std::fs::read_to_string(dir.join(CONFIG))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        let start_id = config
            .get("decoder_start_token_id")
            .and_then(|value| value.as_i64())
            .unwrap_or(65_000);
        let eos_id = config
            .get("eos_token_id")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        let layers = config
            .get("decoder_layers")
            .and_then(|value| value.as_u64())
            .map(|value| value as usize)
            .unwrap_or(6);

        let builder = match find_dylib() {
            Some(path) => ort::init_from(&path).map_err(|err| {
                format!("加载 onnxruntime.dll 失败（{}）：{err}", path.display())
            })?,
            None => ort::init(),
        };
        let env = builder
            .with_name("sabir-nmt")
            .build()
            .map_err(|err| format!("ONNX Runtime 初始化失败：{err}"))?;

        let encoder = open_session(&env, dir, ENCODER)?;
        let decoder = open_session(&env, dir, DECODER)?;
        let decoder_past = open_session(&env, dir, DECODER_PAST)?;

        log::info!("translate: loading opus-mt en→zh from {}", dir.display());
        Ok(Self {
            _env: env,
            encoder: Mutex::new(encoder),
            decoder: Mutex::new(decoder),
            decoder_past: Mutex::new(decoder_past),
            tokenizer,
            start_id,
            eos_id,
            layers,
        })
    }

    pub fn translate(&self, source: &str) -> Result<String, String> {
        let encoding = self
            .tokenizer
            .encode(source, true)
            .map_err(|err| format!("分词失败：{err}"))?;
        let ids: Vec<i64> = encoding
            .get_ids()
            .iter()
            .take(MAX_SOURCE_TOKENS)
            .map(|id| *id as i64)
            .collect();
        if ids.is_empty() {
            return Ok(String::new());
        }
        let len = ids.len() as i64;
        let mask = vec![1i64; ids.len()];

        // 1. Encoder pass.
        let (hidden_shape, hidden) = {
            let mut session = lock(&self.encoder)?;
            let outputs = session
                .run(ort::inputs![
                    "input_ids" => Tensor::from_array((vec![1i64, len], ids))
                        .map_err(|err| format!("input_ids: {err}"))?,
                    "attention_mask" => Tensor::from_array((vec![1i64, len], mask))
                        .map_err(|err| format!("attention_mask: {err}"))?,
                ])
                .map_err(|err| format!("编码器推理失败：{err}"))?;
            extract(&outputs, "last_hidden_state")?
        };

        // 2. First decoder step: no cache yet, encoder states feed cross-attention.
        let mut next;
        let mut cache: Vec<CacheEntry>;
        {
            let mut session = lock(&self.decoder)?;
            let outputs = session
                .run(ort::inputs![
                    "input_ids" => Tensor::from_array((vec![1i64, 1], vec![self.start_id]))
                        .map_err(|err| format!("input_ids: {err}"))?,
                    "encoder_attention_mask" => Tensor::from_array((
                        vec![1i64, len],
                        vec![1i64; len as usize],
                    ))
                    .map_err(|err| format!("encoder_attention_mask: {err}"))?,
                    "encoder_hidden_states" => Tensor::from_array((hidden_shape, hidden))
                        .map_err(|err| format!("encoder_hidden_states: {err}"))?,
                ])
                .map_err(|err| format!("解码器首步失败：{err}"))?;
            next = pick_token(&outputs)?;
            cache = collect_cache(&outputs, self.layers, None)?;
        }

        let mut generated: Vec<u32> = Vec::with_capacity(32);
        let mut steps = 0usize;
        while next != self.eos_id && next != self.start_id && steps < MAX_TARGET_TOKENS {
            generated.push(next as u32);
            steps += 1;

            let mut inputs = ort::inputs![
                "input_ids" => Tensor::from_array((vec![1i64, 1], vec![next]))
                    .map_err(|err| format!("input_ids: {err}"))?,
                "encoder_attention_mask" => Tensor::from_array((
                    vec![1i64, len],
                    vec![1i64; len as usize],
                ))
                .map_err(|err| format!("encoder_attention_mask: {err}"))?,
            ];
            for (name, shape, data) in &cache {
                inputs.push((
                    name.clone().into(),
                    Tensor::from_array((shape.clone(), data.clone()))
                        .map_err(|err| format!("cache {name}: {err}"))?
                        .into(),
                ));
            }

            let mut session = lock(&self.decoder_past)?;
            let outputs = session
                .run(inputs)
                .map_err(|err| format!("解码器推理失败：{err}"))?;
            next = pick_token(&outputs)?;
            // The cached-step graph only re-emits decoder key/values; the
            // encoder cross-attention cache is constant and carried forward.
            cache = collect_cache(&outputs, self.layers, Some(&cache))?;
        }

        if generated.is_empty() {
            return Ok(String::new());
        }
        let text = self
            .tokenizer
            .decode(&generated, true)
            .map_err(|err| format!("译文拼接失败：{err}"))?;
        Ok(text.trim().to_string())
    }
}

/// Locate `onnxruntime.dll` for dynamic loading: env override, next to the
/// executable, then the vendored copy in a development checkout.
fn find_dylib() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    };

    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("ORT_DYLIB_PATH") {
        candidates.push(std::path::PathBuf::from(path));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            candidates.push(dir.join("vendor/onnxruntime").join(name));
        }
    }
    candidates.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor/onnxruntime")
            .join(name),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn open_session(
    env: &ort::environment::Environment,
    dir: &Path,
    file: &str,
) -> Result<Session, String> {
    Session::builder(env)
        .map_err(|err| format!("ONNX session 创建失败：{err}"))?
        .with_intra_threads(2)
        .map_err(|err| format!("ONNX 线程配置失败：{err}"))?
        .commit_from_file(dir.join(file))
        .map_err(|err| format!("{file} 加载失败：{err}"))
}

fn lock(session: &Mutex<Session>) -> Result<std::sync::MutexGuard<'_, Session>, String> {
    session.lock().map_err(|_| "翻译模型锁已损坏".to_string())
}

fn extract(outputs: &SessionOutputs<'_>, name: &str) -> Result<(Vec<i64>, Vec<f32>), String> {
    let value = outputs
        .get(name)
        .ok_or_else(|| format!("模型没有输出 {name}"))?;
    let (shape, data) = value
        .try_extract_tensor::<f32>()
        .map_err(|err| format!("{name} 读取失败：{err}"))?;
    Ok((shape.iter().copied().collect(), data.to_vec()))
}

fn pick_token(outputs: &SessionOutputs<'_>) -> Result<i64, String> {
    let (dims, logits) = extract(outputs, "logits")?;
    let vocab = *dims.last().ok_or("logits 形状为空")? as usize;
    let seq = dims
        .get(dims.len().saturating_sub(2))
        .copied()
        .unwrap_or(1)
        .max(1) as usize;
    if vocab == 0 || logits.len() < seq * vocab {
        return Err("logits 形状与数据不一致".to_string());
    }
    let offset = (seq - 1) * vocab;
    let mut best = 0usize;
    let mut best_value = f32::NEG_INFINITY;
    for (index, value) in logits[offset..offset + vocab].iter().enumerate() {
        if *value > best_value {
            best_value = *value;
            best = index;
        }
    }
    Ok(best as i64)
}

fn collect_cache(
    outputs: &SessionOutputs<'_>,
    layers: usize,
    previous: Option<&[CacheEntry]>,
) -> Result<Vec<CacheEntry>, String> {
    let mut cache = Vec::with_capacity(layers * 4);
    for layer in 0..layers {
        for part in ["decoder.key", "decoder.value", "encoder.key", "encoder.value"] {
            let name = format!("present.{layer}.{part}");
            if outputs.get(&name).is_none() && part.starts_with("encoder") {
                let past_name = format!("past_key_values.{layer}.{part}");
                let carried = previous
                    .and_then(|entries| entries.iter().find(|entry| entry.0 == past_name))
                    .ok_or_else(|| format!("缓存里缺少 {past_name}"))?;
                cache.push((carried.0.clone(), carried.1.clone(), carried.2.clone()));
            } else {
                let (shape, data) = extract(outputs, &name)?;
                cache.push((format!("past_key_values.{layer}.{part}"), shape, data));
            }
        }
    }
    Ok(cache)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/translate/en-zh")
    }

    #[test]
    fn translates_english_to_chinese() {
        let dir = model_dir();
        if !dir.join(ENCODER).is_file() {
            eprintln!("skipping: opus-mt model not installed in {}", dir.display());
            return;
        }
        let translator = NmtTranslator::load(&dir).expect("load model");
        let out = translator
            .translate("Good morning, everyone. Let's begin today's class.")
            .expect("translate");
        eprintln!("translation: {out}");
        assert!(
            out.chars().any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch)),
            "expected Chinese output, got: {out}"
        );
    }
}
