//! OpenAI-compatible chat completions, used for both local runtimes
//! (Ollama / LM Studio / llama.cpp on 127.0.0.1) and third-party providers the
//! user configures with their own key.
//!
//! Requests are made from Rust; the WebView never sees the key. Tokens are
//! streamed back through the caller's delta callback so a sentence can appear
//! while it is being translated.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};

use super::TranslateFailure;

const MAX_ERROR_BODY: usize = 400;

#[derive(Clone, Debug)]
pub struct LlmEndpoint {
    pub base_url: String,
    pub model: String,
}

pub fn chat_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

pub fn translate_stream(
    endpoint: &LlmEndpoint,
    api_key: Option<&str>,
    system: &str,
    user: &str,
    timeout: Duration,
    mut on_delta: impl FnMut(&str),
) -> Result<String, TranslateFailure> {
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|err| TranslateFailure::new("client_error", format!("HTTP 客户端创建失败：{err}")))?;

    let body = json!({
        "model": endpoint.model,
        "stream": true,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });

    let mut request = client.post(chat_url(&endpoint.base_url)).json(&body);
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        request = request.bearer_auth(key.trim());
    }

    let response = request.send().map_err(|err| {
        let code = if err.is_timeout() {
            "timeout"
        } else if err.is_connect() {
            "unreachable"
        } else {
            "network"
        };
        TranslateFailure::new(code, format!("无法连接 {}：{err}", endpoint.base_url))
    })?;

    let status = response.status();
    if !status.is_success() {
        return Err(status_failure(response, status.as_u16()));
    }

    let reader = BufReader::new(response);
    let mut text = String::new();

    for line in reader.lines() {
        let line = line.map_err(|err| {
            TranslateFailure::new("stream_read", format!("读取流式响应失败：{err}"))
        })?;
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(content) = value
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("content"))
            .and_then(|content| content.as_str())
        {
            if !content.is_empty() {
                text.push_str(content);
                on_delta(&text);
            }
        }
    }

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(TranslateFailure::new(
            "empty_response",
            "服务返回了空译文（检查模型名与响应格式）。".to_string(),
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn parses_openai_sse_stream() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let body = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"早上\"}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
                    "data: [DONE]\n\n"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let mut deltas = Vec::new();
        let text = translate_stream(
            &LlmEndpoint {
                base_url: format!("http://{address}"),
                model: "mock".to_string(),
            },
            None,
            "system",
            "user",
            Duration::from_secs(5),
            |delta| deltas.push(delta.to_string()),
        )
        .expect("stream");

        assert_eq!(text, "早上好");
        assert_eq!(deltas.last().map(String::as_str), Some("早上好"));
    }
}

fn status_failure(response: Response, status: u16) -> TranslateFailure {
    let mut body = String::new();
    if let Ok(text) = response.text() {
        body = text.chars().take(MAX_ERROR_BODY).collect();
    }
    let code = match status {
        401 | 403 => "invalid_key",
        404 => "bad_endpoint",
        429 => "rate_limited",
        500..=599 => "upstream",
        _ => "http",
    };
    let message = match code {
        "invalid_key" => "API Key 无效或没有权限（HTTP 401/403）。".to_string(),
        "bad_endpoint" => "接口地址或模型名不存在（HTTP 404）。".to_string(),
        "rate_limited" => "服务商限流（HTTP 429）。".to_string(),
        _ => format!("服务返回 HTTP {status}。"),
    };
    TranslateFailure::with_detail(code, message, body)
}
