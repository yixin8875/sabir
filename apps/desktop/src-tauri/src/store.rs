//! Local session history.
//!
//! Every listening session is written to SQLite as it happens, so a crash or a
//! closed window does not lose the transcript. Export turns one session into a
//! Markdown note, JSONL or SRT without leaving the machine.
//!
//! The database lives next to the model cache; it never contains audio, API
//! keys or provider credentials.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};

use crate::general;
use serde::Serialize;

pub const EXPORT_FORMATS: [&str; 3] = ["md", "jsonl", "srt"];

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    asr_model TEXT NOT NULL,
    translate_route TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    original TEXT NOT NULL,
    translated TEXT,
    route TEXT,
    provider TEXT,
    translate_ms INTEGER,
    error TEXT
);
CREATE INDEX IF NOT EXISTS segments_session ON segments(session_id, seq);

-- Full-text index (trigram so Chinese substrings and English words both work).
-- External content keeps the table small; triggers keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
    original, translated,
    content='segments', content_rowid='id',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS segments_fts_ai AFTER INSERT ON segments BEGIN
    INSERT INTO segments_fts(rowid, original, translated)
    VALUES (new.id, new.original, new.translated);
END;
CREATE TRIGGER IF NOT EXISTS segments_fts_ad AFTER DELETE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, original, translated)
    VALUES ('delete', old.id, old.original, old.translated);
END;
CREATE TRIGGER IF NOT EXISTS segments_fts_au AFTER UPDATE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, original, translated)
    VALUES ('delete', old.id, old.original, old.translated);
    INSERT INTO segments_fts(rowid, original, translated)
    VALUES (new.id, new.original, new.translated);
END;
";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub title: String,
    pub source: String,
    pub asr_model: String,
    pub translate_route: String,
    pub segments: i64,
}

/// One transcript line found across sessions, with enough session metadata to
/// show where it came from.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHit {
    pub session_id: i64,
    pub title: String,
    pub started_at: String,
    pub seq: i64,
    pub start_ms: i64,
    pub original: String,
    pub translated: Option<String>,
}

/// One full-text search result: the line itself, a short context snippet and
/// its bm25 rank. `score` is 0 for the LIKE fallback used on query terms
/// shorter than the trigram tokenizer can match.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: i64,
    pub title: String,
    pub started_at: String,
    pub seq: i64,
    pub start_ms: i64,
    pub original: String,
    pub translated: Option<String>,
    pub score: f64,
    pub snippet: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSegment {
    pub seq: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub original: String,
    pub translated: Option<String>,
    pub route: Option<String>,
    pub provider: Option<String>,
    pub error: Option<String>,
}

pub struct SessionStore {
    conn: Mutex<Connection>,
}

impl SessionStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|err| format!("无法创建数据目录：{err}"))?;
        }
        let conn = Connection::open(path).map_err(|err| format!("无法打开会话数据库：{err}"))?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or(0);
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("初始化会话数据库失败：{err}"))?;
        if version < 1 {
            // Index rows written before the FTS table existed (and fill the
            // fresh table on first run).
            let _ = conn.execute("INSERT INTO segments_fts(segments_fts) VALUES('rebuild')", []);
            let _ = conn.pragma_update(None, "user_version", 1);
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn.lock().map_err(|_| "会话数据库锁失效".to_string())
    }

    /// Start a session row and return its id.
    pub fn create_session(
        &self,
        source: &str,
        asr_model: &str,
        translate_route: &str,
    ) -> Result<i64, String> {
        let now = Local::now();
        let started_at = now.format("%Y-%m-%d %H:%M:%S").to_string();
        let title = now.format("%Y-%m-%d %H:%M").to_string();
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO sessions (started_at, title, source, asr_model, translate_route)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![started_at, title, source, asr_model, translate_route],
        )
        .map_err(|err| format!("无法创建会话记录：{err}"))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn finish_session(&self, id: i64) {
        let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        if let Ok(conn) = self.lock() {
            let _ = conn.execute(
                "UPDATE sessions SET ended_at = ?2 WHERE id = ?1",
                params![id, now],
            );
        }
    }

    /// Rename a session. The title is trimmed and capped at 80 characters;
    /// an empty title is rejected so the library never shows a blank row.
    pub fn rename_session(&self, id: i64, title: &str) -> Result<SessionMeta, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err(general::pick("标题不能为空", "Title cannot be empty").to_string());
        }
        let title: String = title.chars().take(80).collect();
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE sessions SET title = ?2 WHERE id = ?1",
                params![id, title],
            )
            .map_err(|err| format!("无法重命名会话：{err}"))?;
        if changed == 0 {
            return Err(general::pick("找不到这场会话", "Session not found").to_string());
        }
        drop(conn);
        self.meta(id)
            .ok_or_else(|| general::pick("找不到这场会话", "Session not found").to_string())
    }

    pub fn insert_segment(
        &self,
        session_id: i64,
        seq: i64,
        start_ms: i64,
        end_ms: i64,
        text: &str,
    ) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO segments (session_id, seq, start_ms, end_ms, original)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, seq, start_ms, end_ms, text],
        )
        .map_err(|err| format!("无法写入字幕：{err}"))?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_translation(
        &self,
        session_id: i64,
        seq: i64,
        translated: &str,
        route: &str,
        provider: Option<&str>,
        translate_ms: i64,
        error: Option<&str>,
    ) {
        if let Ok(conn) = self.lock() {
            let _ = conn.execute(
                "UPDATE segments SET translated = ?3, route = ?4, provider = ?5,
                        translate_ms = ?6, error = ?7
                 WHERE session_id = ?1 AND seq = ?2",
                params![
                    session_id,
                    seq,
                    translated,
                    route,
                    provider,
                    translate_ms,
                    error
                ],
            );
        }
    }

    /// Sessions newest first. `query` matches the title, the audio source, or
    /// any original/translated line in the session.
    pub fn list_sessions(&self, query: &str, limit: usize) -> Vec<SessionMeta> {
        let Ok(conn) = self.lock() else {
            return Vec::new();
        };
        let columns = "SELECT s.id, s.started_at, s.ended_at, s.title, s.source, s.asr_model,
                              s.translate_route,
                              (SELECT COUNT(*) FROM segments WHERE session_id = s.id)";
        let row = |row: &rusqlite::Row<'_>| {
            Ok(SessionMeta {
                id: row.get(0)?,
                started_at: row.get(1)?,
                ended_at: row.get(2)?,
                title: row.get(3)?,
                source: row.get(4)?,
                asr_model: row.get(5)?,
                translate_route: row.get(6)?,
                segments: row.get(7)?,
            })
        };

        let trimmed = query.trim();
        let mut sessions: Vec<SessionMeta> = if trimmed.is_empty() {
            let Ok(mut statement) = conn.prepare(&format!(
                "{columns} FROM sessions s ORDER BY s.id DESC LIMIT ?1"
            )) else {
                return Vec::new();
            };
            let rows = statement.query_map(params![limit as i64], row);
            match rows {
                Ok(rows) => rows.filter_map(Result::ok).collect(),
                Err(_) => Vec::new(),
            }
        } else {
            let like = format!("%{trimmed}%");
            let Ok(mut statement) = conn.prepare(&format!(
                "{columns} FROM sessions s
                 WHERE s.title LIKE ?1 OR s.source LIKE ?1
                    OR EXISTS (
                        SELECT 1 FROM segments x
                        WHERE x.session_id = s.id
                          AND (x.original LIKE ?1 OR x.translated LIKE ?1)
                    )
                 ORDER BY s.id DESC LIMIT ?2"
            )) else {
                return Vec::new();
            };
            let rows = statement.query_map(params![like, limit as i64], row);
            match rows {
                Ok(rows) => rows.filter_map(Result::ok).collect(),
                Err(_) => Vec::new(),
            }
        };
        sessions.truncate(limit);
        sessions
    }

    /// Lines whose original or translation matches an escaped LIKE pattern,
    /// newest sessions first. Used by cross-session retrieval, one pattern per
    /// search term.
    pub fn segments_matching(&self, pattern: &str, limit: usize) -> Vec<TranscriptHit> {
        let Ok(conn) = self.lock() else {
            return Vec::new();
        };
        let Ok(mut statement) = conn.prepare(
            "SELECT s.id, s.title, s.started_at, x.seq, x.start_ms, x.original, x.translated
             FROM segments x JOIN sessions s ON s.id = x.session_id
             WHERE x.original LIKE ?1 ESCAPE '\\' OR x.translated LIKE ?1 ESCAPE '\\'
             ORDER BY s.id DESC, x.seq DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        let rows = statement.query_map(params![pattern, limit as i64], transcript_hit);
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// The latest lines across the newest sessions. Fallback context for a
    /// question that carries no searchable terms ("总结一下").
    pub fn recent_segments(&self, limit: usize) -> Vec<TranscriptHit> {
        let Ok(conn) = self.lock() else {
            return Vec::new();
        };
        let Ok(mut statement) = conn.prepare(
            "SELECT s.id, s.title, s.started_at, x.seq, x.start_ms, x.original, x.translated
             FROM segments x JOIN sessions s ON s.id = x.session_id
             ORDER BY s.id DESC, x.seq DESC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        let rows = statement.query_map(params![limit as i64], transcript_hit);
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Full-text search across every session (or one session). English words
    /// and Chinese strings of three or more characters use the FTS5 trigram
    /// index; shorter terms fall back to LIKE because trigram cannot match
    /// them. Returns at most `limit` hits, best rank first.
    pub fn search_fulltext(
        &self,
        query: &str,
        limit: usize,
        session_id: Option<i64>,
    ) -> Vec<SearchHit> {
        let trimmed = query.trim();
        if trimmed.is_empty() || limit == 0 {
            return Vec::new();
        }
        let terms: Vec<&str> = trimmed.split_whitespace().collect();
        let usable: Vec<&str> = terms
            .iter()
            .copied()
            .filter(|term| term.chars().count() >= 3)
            .collect();
        if usable.is_empty() {
            return self.search_like(trimmed, &terms, limit, session_id);
        }

        let match_query = usable
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let Ok(conn) = self.lock() else {
            return Vec::new();
        };
        let sql = if session_id.is_some() {
            "SELECT s.id, s.title, s.started_at, x.seq, x.start_ms, x.original, x.translated,
                    bm25(segments_fts) AS rank
             FROM segments_fts
             JOIN segments x ON x.id = segments_fts.rowid
             JOIN sessions s ON s.id = x.session_id
             WHERE segments_fts MATCH ?1 AND x.session_id = ?2
             ORDER BY rank LIMIT ?3"
        } else {
            "SELECT s.id, s.title, s.started_at, x.seq, x.start_ms, x.original, x.translated,
                    bm25(segments_fts) AS rank
             FROM segments_fts
             JOIN segments x ON x.id = segments_fts.rowid
             JOIN sessions s ON s.id = x.session_id
             WHERE segments_fts MATCH ?1
             ORDER BY rank LIMIT ?2"
        };
        let Ok(mut statement) = conn.prepare(sql) else {
            return Vec::new();
        };
        let row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<(SearchHit, f64)> {
            let original: String = row.get(5)?;
            let translated: Option<String> = row.get(6)?;
            let snippet = snippet_for(translated.as_deref().unwrap_or(&original), &terms);
            Ok((
                SearchHit {
                    session_id: row.get(0)?,
                    title: row.get(1)?,
                    started_at: row.get(2)?,
                    seq: row.get(3)?,
                    start_ms: row.get(4)?,
                    original,
                    translated,
                    score: 0.0,
                    snippet,
                },
                row.get(7)?,
            ))
        };
        let rows = if let Some(id) = session_id {
            statement.query_map(params![match_query, id, limit as i64], row)
        } else {
            statement.query_map(params![match_query, limit as i64], row)
        };
        match rows {
            Ok(rows) => rows
                .filter_map(Result::ok)
                .map(|(mut hit, rank)| {
                    hit.score = rank;
                    hit
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    fn search_like(
        &self,
        needle: &str,
        terms: &[&str],
        limit: usize,
        session_id: Option<i64>,
    ) -> Vec<SearchHit> {
        let hits = self.segments_matching(&like_pattern(needle), limit.saturating_mul(4).max(limit));
        hits.into_iter()
            .filter(|hit| session_id.is_none_or(|id| hit.session_id == id))
            .take(limit)
            .map(|hit| {
                let snippet =
                    snippet_for(hit.translated.as_deref().unwrap_or(&hit.original), terms);
                SearchHit {
                    session_id: hit.session_id,
                    title: hit.title,
                    started_at: hit.started_at,
                    seq: hit.seq,
                    start_ms: hit.start_ms,
                    original: hit.original,
                    translated: hit.translated,
                    score: 0.0,
                    snippet,
                }
            })
            .collect()
    }

    pub fn delete_session(&self, session_id: i64) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "DELETE FROM segments WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|err| format!("删除字幕失败：{err}"))?;
        let removed = conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|err| format!("删除会话失败：{err}"))?;
        if removed == 0 {
            return Err("找不到这场会话".to_string());
        }
        Ok(())
    }

    pub fn latest_session(&self) -> Option<i64> {
        let conn = self.lock().ok()?;
        conn.query_row(
            "SELECT id FROM sessions ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn meta(&self, session_id: i64) -> Option<SessionMeta> {
        let conn = self.lock().ok()?;
        conn.query_row(
            "SELECT s.id, s.started_at, s.ended_at, s.title, s.source, s.asr_model,
                    s.translate_route,
                    (SELECT COUNT(*) FROM segments WHERE session_id = s.id)
             FROM sessions s WHERE s.id = ?1",
            params![session_id],
            |row| {
                Ok(SessionMeta {
                    id: row.get(0)?,
                    started_at: row.get(1)?,
                    ended_at: row.get(2)?,
                    title: row.get(3)?,
                    source: row.get(4)?,
                    asr_model: row.get(5)?,
                    translate_route: row.get(6)?,
                    segments: row.get(7)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn segments(&self, session_id: i64) -> Vec<StoredSegment> {
        let Ok(conn) = self.lock() else {
            return Vec::new();
        };
        let Ok(mut statement) = conn.prepare(
            "SELECT seq, start_ms, end_ms, original, translated, route, provider, error
             FROM segments WHERE session_id = ?1 ORDER BY seq",
        ) else {
            return Vec::new();
        };
        let rows = statement.query_map(params![session_id], |row| {
            Ok(StoredSegment {
                seq: row.get(0)?,
                start_ms: row.get(1)?,
                end_ms: row.get(2)?,
                original: row.get(3)?,
                translated: row.get(4)?,
                route: row.get(5)?,
                provider: row.get(6)?,
                error: row.get(7)?,
            })
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Render one session in the requested format without writing a file.
    /// Used by export and by the CLI's `show` command.
    pub fn render(&self, session_id: i64, format: &str) -> Result<String, String> {
        let meta = self.meta(session_id).ok_or_else(|| "找不到这场会话".to_string())?;
        let segments = self.segments(session_id);
        match format {
            "md" => Ok(render_markdown(&meta, &segments)),
            "jsonl" => Ok(render_jsonl(&meta, &segments)),
            "srt" => Ok(render_srt(&segments)),
            other => Err(format!("不支持的导出格式：{other}")),
        }
    }

    /// Write a session to `dest` in the requested format. The parent directory
    /// is created when missing. Returns the written path.
    pub fn export(&self, session_id: i64, format: &str, dest: &Path) -> Result<PathBuf, String> {
        let body = self.render(session_id, format)?;
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(|err| format!("无法创建导出目录：{err}"))?;
        }
        fs::write(dest, body).map_err(|err| format!("写入导出文件失败：{err}"))?;
        Ok(dest.to_path_buf())
    }
}

/* ------------------------------------------------------------------------- */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------- */

fn clock(ms: i64) -> String {
    let total = ms.max(0) as u64 / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

fn srt_clock(ms: i64) -> String {
    let value = ms.max(0) as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        value / 3_600_000,
        (value % 3_600_000) / 60_000,
        (value % 60_000) / 1000,
        value % 1000
    )
}

fn duration(segments: &[StoredSegment]) -> String {
    clock(segments.last().map(|segment| segment.end_ms).unwrap_or(0))
}

fn render_markdown(meta: &SessionMeta, segments: &[StoredSegment]) -> String {
    let labels = if general::is_chinese() {
        ("日期", "时长", "音源", "识别", "翻译")
    } else {
        ("Date", "Duration", "Audio", "Recognition", "Translation")
    };
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", meta.title));
    out.push_str(&format!(
        "- {}：{}\n",
        labels.0,
        meta.started_at.split(' ').next().unwrap_or("")
    ));
    out.push_str(&format!("- {}：{}\n", labels.1, duration(segments)));
    out.push_str(&format!("- {}：{}\n", labels.2, meta.source));
    out.push_str(&format!("- {}：{}\n", labels.3, meta.asr_model));
    out.push_str(&format!("- {}：{}\n\n---\n\n", labels.4, meta.translate_route));
    for segment in segments {
        out.push_str(&format!("**{}**\n", clock(segment.start_ms)));
        out.push_str(segment.original.trim());
        out.push('\n');
        match (&segment.translated, &segment.error) {
            (Some(text), _) if !text.trim().is_empty() => {
                out.push_str(text.trim());
                out.push('\n');
            }
            (_, Some(error)) => {
                out.push_str(&format!(
                    "<!-- {}：{error} -->\n",
                    general::pick("翻译失败", "translation failed")
                ));
            }
            _ => {}
        }
        out.push('\n');
    }
    out
}

fn render_jsonl(meta: &SessionMeta, segments: &[StoredSegment]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{}\n",
        serde_json::json!({
            "type": "session",
            "id": meta.id,
            "title": meta.title,
            "startedAt": meta.started_at,
            "endedAt": meta.ended_at,
            "source": meta.source,
            "asrModel": meta.asr_model,
            "translateRoute": meta.translate_route,
        })
    ));
    for segment in segments {
        out.push_str(&format!(
            "{}\n",
            serde_json::json!({
                "type": "segment",
                "seq": segment.seq,
                "startMs": segment.start_ms,
                "endMs": segment.end_ms,
                "original": segment.original,
                "translated": segment.translated,
                "route": segment.route,
                "provider": segment.provider,
                "error": segment.error,
            })
        ));
    }
    out
}

fn render_srt(segments: &[StoredSegment]) -> String {
    let mut out = String::new();
    for (index, segment) in segments.iter().enumerate() {
        out.push_str(&format!("{}\n", index + 1));
        out.push_str(&format!(
            "{} --> {}\n",
            srt_clock(segment.start_ms),
            srt_clock(segment.end_ms.max(segment.start_ms + 1))
        ));
        out.push_str(segment.original.trim());
        out.push('\n');
        if let Some(text) = &segment.translated {
            if !text.trim().is_empty() {
                out.push_str(text.trim());
                out.push('\n');
            }
        }
        out.push('\n');
    }
    out
}

/// Escape a user string for a contained LIKE pattern.
fn like_pattern(needle: &str) -> String {
    let escaped = needle
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// A short window around the first query term, so the library can show why a
/// line matched without shipping whole paragraphs.
fn snippet_for(text: &str, terms: &[&str]) -> String {
    let lower = text.to_lowercase();
    let byte_pos = terms
        .iter()
        .filter_map(|term| lower.find(&term.to_lowercase()))
        .min();
    let total = text.chars().count();
    if total <= 100 {
        return text.trim().to_string();
    }
    let start_char = byte_pos
        .map(|pos| lower[..pos].chars().count())
        .unwrap_or(0);
    let begin = start_char.saturating_sub(24);
    let end = (begin + 90).min(total);
    let mut out: String = text.chars().skip(begin).take(end - begin).collect();
    if begin > 0 {
        out.insert(0, '…');
    }
    if end < total {
        out.push('…');
    }
    out.trim().to_string()
}

fn transcript_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptHit> {
    Ok(TranscriptHit {
        session_id: row.get(0)?,
        title: row.get(1)?,
        started_at: row.get(2)?,
        seq: row.get(3)?,
        start_ms: row.get(4)?,
        original: row.get(5)?,
        translated: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(label: &str) -> (SessionStore, i64) {
        let dir = std::env::temp_dir().join(format!("livetrans-store-test-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let store = SessionStore::open(&dir.join("test.db")).unwrap();
        let id = store
            .create_session("系统声音", "whisper-small", "nmt")
            .unwrap();
        store.insert_segment(id, 1, 0, 2400, "Hello there.").unwrap();
        store.set_translation(id, 1, "你好。", "nmt", None, 120, None);
        store.insert_segment(id, 2, 2400, 5200, "Second line.").unwrap();
        store.finish_session(id);
        (store, id)
    }

    #[test]
    fn round_trips_sessions_and_segments() {
        let (store, id) = fixture("roundtrip");
        let meta = store.meta(id).expect("meta");
        assert_eq!(meta.segments, 2);
        assert_eq!(meta.asr_model, "whisper-small");
        assert!(meta.ended_at.is_some());
        assert_eq!(store.latest_session(), Some(id));
        let segments = store.segments(id);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].translated.as_deref(), Some("你好。"));
        let _ = fs::remove_dir_all(std::env::temp_dir().join("livetrans-store-test-roundtrip"));
    }

    #[test]
    fn renames_a_session_and_rejects_blank_titles() {
        let (store, id) = fixture("rename");
        let renamed = store.rename_session(id, "  产品评审  ").unwrap();
        assert_eq!(renamed.title, "产品评审");
        assert!(store.rename_session(id, "   ").is_err());
        assert!(store.rename_session(9999, "x").is_err());
        let listed = store.list_sessions("产品评审", 5);
        assert!(listed.iter().any(|row| row.id == id));
        let _ = fs::remove_dir_all(std::env::temp_dir().join("livetrans-store-test-rename"));
    }

    #[test]
    fn searches_and_deletes_sessions() {
        let (store, id) = fixture("library");
        let all = store.list_sessions("", 10);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, id);
        assert_eq!(all[0].segments, 2);
        assert_eq!(store.list_sessions("你好", 10).len(), 1);
        assert!(store.list_sessions("zzz-not-there", 10).is_empty());
        store.delete_session(id).unwrap();
        assert!(store.list_sessions("", 10).is_empty());
        assert!(store.meta(id).is_none());
        assert!(store.delete_session(id).is_err());
        let _ = fs::remove_dir_all(std::env::temp_dir().join("livetrans-store-test-library"));
    }

    #[test]
    fn searches_lines_across_sessions_and_returns_recent_lines() {
        let (store, first) = fixture("retrieval");
        store
            .insert_segment(first, 3, 5300, 7000, "Kubernetes rollout plan")
            .unwrap();
        let second = store
            .create_session("系统声音", "whisper-small", "nmt")
            .unwrap();
        store
            .insert_segment(second, 1, 1000, 3000, "the rollout starts Monday")
            .unwrap();
        store.set_translation(second, 1, "灰度发布周一上线", "nmt", None, 100, None);
        store.finish_session(second);

        let hits = store.segments_matching("%rollout%", 20);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].session_id, second);
        assert_eq!(hits[0].seq, 1);

        let translated = store.segments_matching("%灰度发布%", 20);
        assert_eq!(translated.len(), 1);
        assert_eq!(
            translated[0].translated.as_deref(),
            Some("灰度发布周一上线")
        );

        let recent = store.recent_segments(3);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].session_id, second);
        assert!(store.segments_matching("%zzz%", 20).is_empty());

        let _ = fs::remove_dir_all(std::env::temp_dir().join("livetrans-store-test-retrieval"));
    }

    #[test]
    fn searches_full_text_in_both_languages() {
        let (store, id) = fixture("fts");
        store
            .insert_segment(id, 3, 5300, 7000, "Kubernetes rollout plan")
            .unwrap();
        store.set_translation(
            id,
            3,
            "Kubernetes 灰度发布计划已经确定",
            "nmt",
            None,
            120,
            None,
        );
        store
            .insert_segment(id, 4, 7100, 9000, "AI rollout starts Monday")
            .unwrap();

        let english = store.search_fulltext("rollout", 10, None);
        assert_eq!(english.len(), 2);
        assert!(english[0].snippet.contains("rollout"));
        assert!(english[0].score < 0.0);

        let chinese = store.search_fulltext("灰度发布", 10, None);
        assert_eq!(chinese.len(), 1);
        assert_eq!(chinese[0].seq, 3);
        assert!(chinese[0].snippet.contains("灰度发布"));

        let scoped = store.search_fulltext("rollout", 1, Some(id));
        assert_eq!(scoped.len(), 1);

        let fallback = store.search_fulltext("AI", 10, None);
        assert!(fallback.iter().any(|hit| hit.seq == 4));
        assert_eq!(fallback[0].score, 0.0);

        assert!(store.search_fulltext("zzz-not-there", 10, None).is_empty());

        store.delete_session(id).unwrap();
        assert!(store.search_fulltext("rollout", 10, None).is_empty());

        let _ = fs::remove_dir_all(std::env::temp_dir().join("livetrans-store-test-fts"));
    }

    #[test]
    fn rebuilds_the_full_text_index_for_existing_databases() {
        let dir = std::env::temp_dir().join("livetrans-store-test-fts-reopen");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        {
            let store = SessionStore::open(&path).unwrap();
            let id = store.create_session("系统声音", "zipformer", "nmt").unwrap();
            store
                .insert_segment(id, 1, 0, 2000, "existing transcript about budgets")
                .unwrap();
            store.finish_session(id);
        }
        // Drop the index to simulate a database written before FTS existed.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("DROP TABLE segments_fts", []).unwrap();
            conn.pragma_update(None, "user_version", 0).unwrap();
        }
        let store = SessionStore::open(&path).unwrap();
        let hits = store.search_fulltext("budgets", 5, None);
        assert_eq!(hits.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exports_markdown_jsonl_and_srt() {
        let (store, id) = fixture("export");
        let dir = std::env::temp_dir().join("livetrans-store-export");
        let md = store.export(id, "md", &dir.join("note.md")).unwrap();
        let text = fs::read_to_string(&md).unwrap();
        assert!(text.contains("Hello there."));
        assert!(text.contains("你好。"));
        assert!(text.contains("00:00:00"));

        let jsonl = store.export(id, "jsonl", &dir.join("note.jsonl")).unwrap();
        let text = fs::read_to_string(&jsonl).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.lines().next().unwrap().contains("\"type\":\"session\""));

        let srt = store.export(id, "srt", &dir.join("note.srt")).unwrap();
        let text = fs::read_to_string(&srt).unwrap();
        assert!(text.contains("00:00:00,000 --> 00:00:02,400"));
        assert!(text.contains("Second line."));
        assert!(store.export(id, "docx", &dir.join("x")).is_err());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(std::env::temp_dir().join("livetrans-store-test-export"));
    }
}
