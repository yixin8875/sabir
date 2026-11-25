//! Questions about the transcript.
//!
//! The WebView sends the lines it is showing (text and timestamps only) plus a
//! question. This module builds a numbered transcript, asks the configured
//! local LLM or the user's own provider, and streams the answer back. Answers
//! cite the transcript lines they used, and nothing is stored on disk.
//!
//! Audio never reaches this module.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::general;
use crate::store::{SessionStore, TranscriptHit};
use crate::translate::{llm, TranslateService};

const MAX_CONTEXT_CHARS: usize = 12_000;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
const REMOTE_TIMEOUT: Duration = Duration::from_secs(45);

/// Cross-session retrieval: at most this many search terms are tried, each
/// term contributes up to this many matching lines, one session may contribute
/// at most this many lines, and the whole context stays at this many lines.
const MAX_TERMS: usize = 12;
const PER_TERM_LIMIT: usize = 60;
const PER_SESSION_LINES: usize = 12;
const CROSS_LINES: usize = 40;
const RECENT_LINES: usize = 30;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskLine {
    pub seq: u64,
    pub start_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AskEvent {
    Delta {
        text: String,
    },
    Done {
        route: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        ms: u64,
        citations: Vec<u64>,
    },
    Error {
        code: String,
        message: String,
    },
}

struct Attempt {
    route: &'static str,
    base_url: String,
    model: String,
    key: Option<String>,
    timeout: Duration,
}

fn clock(ms: u64) -> String {
    let total = ms / 1000;
    format!("{:02}:{:02}", total / 60, total % 60)
}

/// Keep the most recent lines that fit the context budget, oldest first.
fn build_context(lines: &[AskLine]) -> (String, Vec<u64>) {
    let mut chosen: Vec<&AskLine> = Vec::new();
    let mut used = 0usize;
    for line in lines.iter().rev() {
        let cost = line.text.chars().count() + 24;
        if used + cost > MAX_CONTEXT_CHARS && !chosen.is_empty() {
            break;
        }
        used += cost;
        chosen.push(line);
    }
    chosen.reverse();
    let mut body = String::new();
    let mut seqs = Vec::with_capacity(chosen.len());
    for line in chosen {
        seqs.push(line.seq);
        body.push_str(&format!(
            "[{}] {} {}\n",
            line.seq,
            clock(line.start_ms),
            line.text.trim()
        ));
    }
    (body, seqs)
}

fn citations(answer: &str, allowed: &[u64]) -> Vec<u64> {
    let mut found = Vec::new();
    let mut current = String::new();
    for ch in answer.chars() {
        if ch == '[' {
            current.clear();
        } else if ch == ']' {
            if let Ok(value) = current.parse::<u64>() {
                if allowed.contains(&value) && !found.contains(&value) {
                    found.push(value);
                }
            }
            current.clear();
        } else if ch.is_ascii_digit() && current.chars().count() < 6 {
            current.push(ch);
        } else {
            current.clear();
        }
    }
    found
}

fn host_of(base_url: &str) -> String {
    base_url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Run the configured answer endpoints in order, streaming deltas and one done
/// callback. Returns the last failure when every endpoint failed.
fn stream_answer<F, G>(
    service: &TranslateService,
    system: &str,
    user: &str,
    mut delta: F,
    mut done: G,
) -> Result<(), (String, String)>
where
    F: FnMut(&str),
    G: FnMut(&str, String, Option<String>, u64),
{
    let targets = service.ask_targets();
    let mut attempts: Vec<Attempt> = Vec::new();
    if targets.remote_consent
        && targets.key.is_some()
        && !targets.remote.base_url.trim().is_empty()
        && !targets.remote.model.trim().is_empty()
    {
        attempts.push(Attempt {
            route: "remoteLlm",
            base_url: targets.remote.base_url.clone(),
            model: targets.remote.model.clone(),
            key: targets.key.clone(),
            timeout: REMOTE_TIMEOUT,
        });
    }
    if !targets.local.base_url.trim().is_empty() && !targets.local.model.trim().is_empty() {
        attempts.push(Attempt {
            route: "localLlm",
            base_url: targets.local.base_url.clone(),
            model: targets.local.model.clone(),
            key: None,
            timeout: LOCAL_TIMEOUT,
        });
    }
    let no_endpoint = || {
        (
            "no_endpoint".to_string(),
            general::pick(
                "问答需要本地 LLM 或第三方接口：打开「翻译与聊天」填写地址、模型与 Key。",
                "Q&A needs a local LLM or a provider: open Translation & chat and fill in the endpoint, model and key.",
            )
            .to_string(),
        )
    };
    if attempts.is_empty() {
        return Err(no_endpoint());
    }

    let mut last_error: Option<(String, String)> = None;
    for attempt in attempts {
        let endpoint = llm::LlmEndpoint {
            base_url: attempt.base_url.clone(),
            model: attempt.model,
        };
        let started = Instant::now();
        let outcome = {
            let mut on_delta = |text: &str| delta(text);
            llm::translate_stream(
                &endpoint,
                attempt.key.as_deref(),
                system,
                user,
                attempt.timeout,
                &mut on_delta,
            )
        };
        match outcome {
            Ok(answer) => {
                let provider = host_of(&attempt.base_url);
                done(
                    &answer,
                    attempt.route.to_string(),
                    (!provider.is_empty()).then_some(provider),
                    started.elapsed().as_millis() as u64,
                );
                return Ok(());
            }
            Err(failure) => {
                log::warn!(
                    "ask: {} failed: {} ({})",
                    attempt.route,
                    failure.message,
                    failure.code
                );
                last_error = Some((failure.code, failure.message));
            }
        }
    }
    Err(last_error.unwrap_or_else(no_endpoint))
}

pub fn ask(
    service: &TranslateService,
    question: &str,
    lines: &[AskLine],
    channel: Channel<AskEvent>,
) {
    let question = question.trim();
    if question.is_empty() {
        let _ = channel.send(AskEvent::Error {
            code: "empty_question".to_string(),
            message: general::pick(
                "先写下要问的问题。",
                "Write the question first.",
            )
            .to_string(),
        });
        return;
    }
    if lines.is_empty() {
        let _ = channel.send(AskEvent::Error {
            code: "no_transcript".to_string(),
            message: general::pick(
                "还没有字幕可以提问；先听一段，或从会话库载入一场。",
                "There is no transcript to ask about yet; listen for a while or open a session in the library.",
            )
            .to_string(),
        });
        return;
    }

    let (transcript, allowed) = build_context(lines);
    let mut system = String::from(general::pick(
        "你是本机实时字幕工具的问答助手。用户会给出带编号的转录，你必须只依据转录回答：\
转录没有提到的内容就直接说「转录里没有提到」，不要补充外部知识。\
用简体中文回答，简洁分点；每个结论后面用方括号标注依据的行号，例如 [12] 或 [12][15]。",
        "You are the Q&A assistant of an on-device live caption app. The user supplies a numbered \
transcript, and you must answer only from it: if the transcript does not mention something, say \
\"the transcript does not mention it\" and do not add outside knowledge. Answer in English, briefly \
and in points; after each conclusion cite the line numbers it relies on in square brackets, e.g. \
[12] or [12][15].",
    ));
    if let Some(block) = service.glossary().prompt_block() {
        system.push_str(general::pick("\n\n本场背景与术语：\n", "\n\nScene and terminology:\n"));
        system.push_str(&block);
        system.push_str(general::pick(
            "\n背景与术语只用于理解，回答仍必须依据转录，并照常用 [行号] 标注依据。",
            "\nUse them only to understand the transcript; answers must still cite transcript line numbers in brackets.",
        ));
    }
    let user = if general::is_chinese() {
        format!("转录（每行格式：行号 时间 原文）：\n{transcript}\n问题：{question}")
    } else {
        format!("Transcript (format: line number time text):\n{transcript}\nQuestion: {question}")
    };

    let stream = channel.clone();
    let finish = channel.clone();
    let result = stream_answer(
        service,
        &system,
        &user,
        |text| {
            let _ = stream.send(AskEvent::Delta {
                text: text.to_string(),
            });
        },
        |answer, route, provider, ms| {
            let _ = finish.send(AskEvent::Done {
                route,
                provider,
                ms,
                citations: citations(answer, &allowed),
            });
        },
    );
    if let Err((code, message)) = result {
        let _ = channel.send(AskEvent::Error { code, message });
    }
}

/* ------------------------------------------------------------------------- */
/* Cross-session retrieval and Q&A                                           */
/* ------------------------------------------------------------------------- */

/// One retrieved line, shown to the user and numbered for citations.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossLine {
    pub index: u64,
    pub session_id: i64,
    pub title: String,
    pub started_at: String,
    pub seq: i64,
    pub start_ms: u64,
    pub original: String,
    pub translated: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CrossAskEvent {
    Retrieved {
        lines: Vec<CrossLine>,
        sessions: u64,
    },
    Delta {
        text: String,
    },
    Done {
        route: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        ms: u64,
        citations: Vec<u64>,
    },
    Error {
        code: String,
        message: String,
    },
}

const ASCII_STOP: &[&str] = &[
    "the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "which", "who",
    "why", "how", "did", "does", "do", "was", "were", "are", "is", "you", "your", "they", "them",
    "their", "about", "say", "said", "tell", "list", "key", "terms", "summarize", "summary",
    "session", "sessions", "last", "recent",
];

const CJK_STOP: &[&str] = &[
    "什么", "怎么", "怎样", "哪些", "哪个", "哪里", "为什么", "是否", "我们", "他们", "她们",
    "这个", "那个", "这些", "那些", "上次", "这次", "之前", "以前", "后来", "一下", "帮我",
    "请问", "告诉", "关于", "有没有", "没有", "可以", "总结", "概括", "讨论", "提到", "说了",
    "讲过", "会议", "内容", "事情", "情况",
];

const CJK_PARTICLES: &str = "的了是在和与就都也个吗呢吧啊哦我你他她它们这那";

fn push_ascii_run(run: &mut String, terms: &mut Vec<String>) {
    let word = run.trim().to_lowercase();
    run.clear();
    if word.chars().count() >= 2 && !ASCII_STOP.contains(&word.as_str()) {
        terms.push(word);
    }
}

fn push_cjk_run(run: &mut Vec<char>, terms: &mut Vec<String>) {
    let text: String = run.iter().collect();
    run.clear();
    let mut stripped = text;
    for stop in CJK_STOP {
        stripped = stripped.replace(stop, "|");
    }
    for segment in stripped.split('|') {
        let chars: Vec<char> = segment.chars().collect();
        for window in chars.windows(2) {
            if window.iter().any(|ch| CJK_PARTICLES.contains(*ch)) {
                continue;
            }
            terms.push(window.iter().collect());
        }
    }
}

/// Search terms for a natural-language question. ASCII words are lowercased;
/// Chinese runs are stripped of question words and split into bigrams. Empty
/// when the question carries no content ("总结一下").
pub fn extract_terms(question: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();
    for ch in question.chars() {
        let is_cjk = ch.is_ascii() == false
            && ('\u{3400}'..='\u{4dbf}').contains(&ch)
            || ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if is_cjk {
            push_ascii_run(&mut ascii, &mut terms);
            cjk.push(ch);
        } else if ch.is_ascii_alphanumeric() || ch == '-' || ch == '\'' {
            push_cjk_run(&mut cjk, &mut terms);
            ascii.push(ch);
        } else {
            push_ascii_run(&mut ascii, &mut terms);
            push_cjk_run(&mut cjk, &mut terms);
        }
    }
    push_ascii_run(&mut ascii, &mut terms);
    push_cjk_run(&mut cjk, &mut terms);

    let mut seen = HashSet::new();
    terms.retain(|term| seen.insert(term.clone()));
    terms.truncate(MAX_TERMS);
    terms
}

fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// Lines from every session that match the question's search terms, ranked by
/// how many terms they hit, then recency, with a per-session cap. A question
/// without searchable terms falls back to the latest lines.
pub fn retrieve(store: &SessionStore, question: &str) -> Vec<TranscriptHit> {
    let terms = extract_terms(question);
    if terms.is_empty() {
        let mut recent = store.recent_segments(RECENT_LINES);
        recent.sort_by(|a, b| {
            b.session_id
                .cmp(&a.session_id)
                .then_with(|| a.start_ms.cmp(&b.start_ms))
        });
        return recent;
    }
    let mut scored: HashMap<(i64, i64), (usize, TranscriptHit)> = HashMap::new();
    for term in &terms {
        for hit in store.segments_matching(&like_pattern(term), PER_TERM_LIMIT) {
            let entry = scored
                .entry((hit.session_id, hit.seq))
                .or_insert_with(|| (0, hit.clone()));
            entry.0 += 1;
            if entry.1.translated.is_none() && hit.translated.is_some() {
                entry.1.translated = hit.translated.clone();
            }
        }
    }
    let mut ranked: Vec<(usize, TranscriptHit)> = scored.into_values().collect();
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.session_id.cmp(&a.1.session_id))
            .then_with(|| b.1.start_ms.cmp(&a.1.start_ms))
    });

    let mut per_session: HashMap<i64, usize> = HashMap::new();
    let mut chosen: Vec<TranscriptHit> = Vec::new();
    for (_, hit) in ranked {
        if chosen.len() >= CROSS_LINES {
            break;
        }
        let count = per_session.entry(hit.session_id).or_insert(0);
        if *count >= PER_SESSION_LINES {
            continue;
        }
        *count += 1;
        chosen.push(hit);
    }
    chosen.sort_by(|a, b| {
        b.session_id
            .cmp(&a.session_id)
            .then_with(|| a.start_ms.cmp(&b.start_ms))
    });
    chosen
}

fn cross_lines(hits: &[TranscriptHit]) -> Vec<CrossLine> {
    hits.iter()
        .enumerate()
        .map(|(index, hit)| CrossLine {
            index: index as u64 + 1,
            session_id: hit.session_id,
            title: hit.title.clone(),
            started_at: hit.started_at.clone(),
            seq: hit.seq,
            start_ms: hit.start_ms.max(0) as u64,
            original: hit.original.clone(),
            translated: hit.translated.clone(),
        })
        .collect()
}

fn distinct_sessions(lines: &[CrossLine]) -> u64 {
    lines
        .iter()
        .map(|line| line.session_id)
        .collect::<HashSet<_>>()
        .len() as u64
}

/// Search every session's transcript without calling a model.
pub fn search_across(store: &SessionStore, query: &str) -> Vec<CrossLine> {
    cross_lines(&retrieve(store, query.trim()))
}

/// Ask a question grounded on lines retrieved from every session, streaming
/// the retrieved lines first, then the answer.
pub fn ask_across(
    store: &SessionStore,
    service: &TranslateService,
    question: &str,
    channel: Channel<CrossAskEvent>,
) {
    let question = question.trim();
    if question.is_empty() {
        let _ = channel.send(CrossAskEvent::Error {
            code: "empty_question".to_string(),
            message: general::pick("先写下要问的问题。", "Write the question first.").to_string(),
        });
        return;
    }

    let lines = cross_lines(&retrieve(store, question));
    if lines.is_empty() {
        let _ = channel.send(CrossAskEvent::Error {
            code: "no_results".to_string(),
            message: general::pick(
                "没有在历史会话里检索到与问题相关的字幕。换个关键词，或打开某场会话直接提问。",
                "No transcript lines in your sessions match this question. Try different keywords, or open one session and ask there.",
            )
            .to_string(),
        });
        return;
    }
    let sessions = distinct_sessions(&lines);
    let _ = channel.send(CrossAskEvent::Retrieved {
        lines: lines.clone(),
        sessions,
    });

    let mut body = String::new();
    for line in &lines {
        body.push_str(&format!(
            "[{}] 「{}」 {} {}\n",
            line.index,
            line.title,
            clock(line.start_ms),
            line.original.trim()
        ));
    }
    let mut system = String::from(general::pick(
        "你是本机实时字幕工具的跨会话检索助手。用户会给出从多场历史会话里检索到的、带编号的\
字幕行（每行注明所属会话与时间）。你必须只依据这些字幕回答：没有提到的内容直接说\
「检索到的字幕里没有提到」，不要补充外部知识。用简体中文回答，简洁分点；每个结论后面用\
方括号标注依据的行号，例如 [3]；提到会话时用它的标题。",
        "You are the cross-session search assistant of an on-device live caption app. The user \
supplies numbered transcript lines retrieved from several past sessions, each labeled with its \
session title and time. Answer only from those lines: if they do not mention something, say \
\"the retrieved lines do not mention it\" and do not add outside knowledge. Answer in English, \
briefly and in points; cite the line numbers after each conclusion in square brackets, e.g. [3]; \
refer to sessions by their title.",
    ));
    if let Some(block) = service.glossary().prompt_block() {
        system.push_str(general::pick("\n\n场景背景与术语：\n", "\n\nScene and terminology:\n"));
        system.push_str(&block);
        system.push_str(general::pick(
            "\n背景与术语只用于理解，回答仍必须依据检索到的字幕，并照常用 [行号] 标注依据。",
            "\nUse them only to understand the lines; answers must still cite retrieved line numbers in brackets.",
        ));
    }
    let user = if general::is_chinese() {
        format!("检索到的字幕（每行格式：行号 「会话标题」 时间 原文）：\n{body}\n问题：{question}")
    } else {
        format!(
            "Retrieved transcript lines (format: index \"session title\" time text):\n{body}\nQuestion: {question}"
        )
    };

    let allowed: Vec<u64> = lines.iter().map(|line| line.index).collect();
    let stream = channel.clone();
    let finish = channel.clone();
    let result = stream_answer(
        service,
        &system,
        &user,
        |text| {
            let _ = stream.send(CrossAskEvent::Delta {
                text: text.to_string(),
            });
        },
        |answer, route, provider, ms| {
            let _ = finish.send(CrossAskEvent::Done {
                route,
                provider,
                ms,
                citations: citations(answer, &allowed),
            });
        },
    );
    if let Err((code, message)) = result {
        let _ = channel.send(CrossAskEvent::Error { code, message });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(seq: u64, start_ms: u64, text: &str) -> AskLine {
        AskLine {
            seq,
            start_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn context_is_numbered_and_keeps_the_tail() {
        let lines = vec![
            line(1, 5_000, "hello there"),
            line(2, 65_000, "second line"),
        ];
        let (body, allowed) = build_context(&lines);
        assert!(body.contains("[1] 00:05 hello there"));
        assert!(body.contains("[2] 01:05 second line"));
        assert_eq!(allowed, vec![1, 2]);
    }

    #[test]
    fn citations_only_keep_lines_that_were_sent() {
        let allowed = vec![1, 2];
        assert_eq!(citations("见 [2] 与 [9]，再 [2]", &allowed), vec![2]);
        assert!(citations("没有引用", &allowed).is_empty());
        assert!(citations("[] [abc] [1x]", &allowed).is_empty());
    }

    #[test]
    fn terms_skip_question_words_and_split_cjk_bigrams() {
        let terms = extract_terms("What did they say about the Kubernetes rollout?");
        assert!(terms.contains(&"kubernetes".to_string()));
        assert!(terms.contains(&"rollout".to_string()));
        assert!(!terms.contains(&"what".to_string()));
        assert!(!terms.contains(&"did".to_string()));

        let terms = extract_terms("产品评审的结论");
        assert!(terms.contains(&"产品".to_string()));
        assert!(terms.contains(&"评审".to_string()));
        assert!(terms.contains(&"结论".to_string()));
        assert!(!terms.contains(&"审的".to_string()));
        assert!(!terms.contains(&"的结".to_string()));

        assert!(extract_terms("上次会议讨论了什么").is_empty());
    }

    #[test]
    fn retrieval_prefers_lines_hitting_more_terms() {
        let dir = std::env::temp_dir().join(format!("livetrans-retrieve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = SessionStore::open(&dir.join("test.db")).unwrap();
        let first = store
            .create_session("系统声音", "whisper-small", "nmt")
            .unwrap();
        store.insert_segment(first, 1, 0, 1000, "we talked about lunch").unwrap();
        store
            .insert_segment(first, 2, 2000, 3000, "the kubernetes deployment shipped")
            .unwrap();
        let second = store
            .create_session("系统声音", "whisper-small", "nmt")
            .unwrap();
        store
            .insert_segment(second, 1, 500, 2500, "kubernetes canary deployment plan")
            .unwrap();
        store.finish_session(second);

        let hits = retrieve(&store, "kubernetes deployment");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].session_id, second);
        assert!(hits[0].original.contains("canary"));

        let lines = search_across(&store, "kubernetes");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].session_id, second);
        assert_eq!(lines[0].index, 1);
        assert_eq!(lines[1].index, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
