//! `livetrans` command-line companion.
//!
//! Reads the same SQLite database the app writes, so scripts can list, search,
//! render or export sessions without opening the window. `stream --follow`
//! tails a session's JSONL event stream for editor integrations.
//!
//! Build it with `cargo build --features cli --bin livetrans`; set
//! `LIVETRANS_DB` to point at another database.

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::exit;
use std::thread;
use std::time::Duration;

use crate::store::{SessionStore, EXPORT_FORMATS};

const USAGE: &str = "\
livetrans — local session companion

Usage:
  livetrans list [--query TEXT] [--limit N] [--json]
  livetrans search QUERY... [--limit N] [--session ID]
  livetrans show ID [--format md|jsonl|srt]
  livetrans export ID [--format md|jsonl|srt] [--out PATH]
  livetrans stream [--session ID] [--follow]

Environment:
  LIVETRANS_DB   path to livetrans.db (defaults to the app's data folder)
";

struct Argv {
    items: Vec<String>,
}

impl Argv {
    fn new(items: Vec<String>) -> Self {
        Self { items }
    }

    fn flag(&mut self, name: &str) -> bool {
        if let Some(index) = self.items.iter().position(|item| item == name) {
            self.items.remove(index);
            true
        } else {
            false
        }
    }

    fn value(&mut self, name: &str) -> Option<String> {
        let index = self.items.iter().position(|item| item == name)?;
        self.items.remove(index);
        if index < self.items.len() {
            Some(self.items.remove(index))
        } else {
            None
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("livetrans: {message}");
    exit(1);
}

fn parse_limit(value: Option<String>, fallback: usize) -> usize {
    value
        .and_then(|text| text.parse::<usize>().ok())
        .filter(|limit| *limit > 0)
        .unwrap_or(fallback)
}

fn parse_id(value: Option<String>) -> Option<i64> {
    value.and_then(|text| text.trim().parse::<i64>().ok())
}

/// `%APPDATA%\app.livetrans.desktop` (or the platform equivalent) unless
/// `LIVETRANS_DB` overrides the database path.
fn db_path() -> PathBuf {
    if let Ok(value) = std::env::var("LIVETRANS_DB") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    data_dir().join("livetrans.db")
}

fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("app.livetrans.desktop");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("app.livetrans.desktop");
        }
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        if let Ok(data) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(data).join("app.livetrans.desktop");
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("app.livetrans.desktop");
        }
    }
    PathBuf::from(".livetrans")
}

fn streams_dir() -> PathBuf {
    db_path()
        .parent()
        .map(|dir| dir.join("streams"))
        .unwrap_or_else(|| PathBuf::from("streams"))
}

fn open_store() -> SessionStore {
    let path = db_path();
    if !path.is_file() {
        fail(&format!(
            "no session database at {} (listen once in the app first)",
            path.display()
        ));
    }
    SessionStore::open(&path).unwrap_or_else(|err| fail(&err))
}

fn print_jsonl<T: serde::Serialize>(value: &T) {
    match serde_json::to_string(value) {
        Ok(line) => println!("{line}"),
        Err(err) => fail(&format!("could not serialise a line: {err}")),
    }
}

pub fn run(args: Vec<String>) {
    let mut argv = Argv::new(args);
    if argv.items.is_empty() {
        print!("{USAGE}");
        return;
    }
    let command = argv.items.remove(0);
    match command.as_str() {
        "help" | "--help" | "-h" => print!("{USAGE}"),
        "list" => list(&mut argv),
        "search" => search(&mut argv),
        "show" => show(&mut argv),
        "export" => export(&mut argv),
        "stream" => stream(&mut argv),
        other => fail(&format!("unknown command `{other}`; try `livetrans help`")),
    }
}

fn list(argv: &mut Argv) {
    let query = argv.value("--query").unwrap_or_default();
    let limit = parse_limit(argv.value("--limit"), 80);
    let json = argv.flag("--json");
    let store = open_store();
    let rows = store.list_sessions(&query, limit);
    if json {
        println!(
            "{}",
            serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string())
        );
        return;
    }
    for row in rows {
        println!(
            "{}\t{}\t{}\t{}",
            row.id, row.started_at, row.segments, row.title
        );
    }
}

fn search(argv: &mut Argv) {
    let limit = parse_limit(argv.value("--limit"), 40);
    let session_id = parse_id(argv.value("--session"));
    let query = argv.items.join(" ").trim().to_string();
    if query.is_empty() {
        fail("give a word or sentence to search for; try `livetrans search rollout`");
    }
    let store = open_store();
    for hit in store.search_fulltext(&query, limit, session_id) {
        print_jsonl(&hit);
    }
}

fn show(argv: &mut Argv) {
    let format = argv.value("--format").unwrap_or_else(|| "md".to_string());
    let id = parse_id(argv.items.first().cloned());
    let Some(id) = id else {
        fail("give a session id; run `livetrans list` to find one");
    };
    if !EXPORT_FORMATS.contains(&format.as_str()) {
        fail("format must be md, jsonl or srt");
    }
    let store = open_store();
    match store.render(id, &format) {
        Ok(body) => print!("{body}"),
        Err(err) => fail(&err),
    }
}

fn export(argv: &mut Argv) {
    let format = argv.value("--format").unwrap_or_else(|| "md".to_string());
    let out = argv.value("--out");
    let id = parse_id(argv.items.first().cloned());
    let Some(id) = id else {
        fail("give a session id; run `livetrans list` to find one");
    };
    if !EXPORT_FORMATS.contains(&format.as_str()) {
        fail("format must be md, jsonl or srt");
    }
    let dest = out
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("livetrans-{id}.{format}")));
    let store = open_store();
    match store.export(id, &format, &dest) {
        Ok(path) => println!("{}", path.display()),
        Err(err) => fail(&err),
    }
}

fn stream(argv: &mut Argv) {
    let follow = argv.flag("--follow");
    let requested = parse_id(argv.value("--session"));
    let stream_dir = streams_dir();
    let id = match requested {
        Some(id) => id,
        None => {
            let store = open_store();
            store
                .latest_session()
                .unwrap_or_else(|| fail("no sessions yet; listen once in the app first"))
        }
    };
    let path = stream_dir.join(format!("{id}.jsonl"));
    if !path.is_file() && !follow {
        fail(&format!(
            "no event stream for session {id} at {}",
            path.display()
        ));
    }
    if !follow {
        match fs::read_to_string(&path) {
            Ok(text) => print!("{text}"),
            Err(err) => fail(&format!("could not read {}: {err}", path.display())),
        }
        return;
    }

    let mut offset: u64 = 0;
    loop {
        if let Ok(mut file) = fs::File::open(&path) {
            let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
            if len < offset {
                // The stream was truncated by a new session with this id.
                offset = 0;
            }
            if file.seek(SeekFrom::Start(offset)).is_ok() {
                let mut text = String::new();
                if file.read_to_string(&mut text).is_ok() {
                    offset += text.len() as u64;
                    print!("{text}");
                    let _ = std::io::stdout().flush();
                }
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
}
