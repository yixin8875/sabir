//! Resumable model downloads shared by the recognition and translation
//! managers.
//!
//! Files come from Hugging Face repositories; `hf-mirror.com` is tried before
//! `huggingface.co`, and `LIVETRANS_MODEL_BASE` overrides both. Every file
//! downloads to `<name>.part` with an HTTP Range resume and is renamed only
//! after its byte count and SHA-256 match the catalogue; a mismatch deletes
//! the partial file so the next attempt starts clean. Only model weights
//! travel over the network here.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// Sentinel error meaning the user pressed cancel.
pub const CANCELLED: &str = "__cancelled__";

/// Hugging Face mirrors, tried in order.
const MIRRORS: [&str; 2] = ["https://hf-mirror.com", "https://huggingface.co"];

pub struct RemoteFile<'a> {
    /// Path inside the repository (`onnx/encoder_model_int8.onnx`).
    pub remote: &'a str,
    /// Name on disk (`encoder_model_int8.onnx`).
    pub local: &'a str,
    pub bytes: u64,
    /// SHA-256 of the finished file as lowercase hex. Empty disables the check.
    pub sha256: &'a str,
}

/// Hash a file with SHA-256 in 64KB chunks; models reach ~675MB, so the whole
/// file never sits in memory.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|err| format!("无法读取 {}：{err}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("无法读取 {}：{err}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Compare a finished file with the catalogue's checksum. An empty `expected`
/// keeps the old size-only behaviour.
pub fn verify_file(path: &Path, name: &str, expected: &str) -> Result<(), String> {
    if expected.is_empty() {
        return Ok(());
    }
    let actual = sha256_file(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "{name} 校验失败：SHA-256 不符（文件可能下载损坏或被篡改），请重试。"
        ))
    }
}

/// Downloads can be as large as ~675MB, so the total timeout is generous;
/// `connect_timeout` still fails fast when the network is down.
pub fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(3 * 60 * 60))
        .build()
        .map_err(|err| format!("HTTP 客户端初始化失败：{err}"))
}

pub fn pick_base(
    client: &reqwest::blocking::Client,
    repo: &str,
    probe: &str,
) -> Result<String, String> {
    if let Ok(base) = std::env::var("LIVETRANS_MODEL_BASE") {
        let base = base.trim_end_matches('/').to_string();
        if !base.is_empty() {
            return Ok(base);
        }
    }
    let mut last_error = String::new();
    for base in MIRRORS {
        let url = format!("{base}/{repo}/resolve/main/{probe}");
        match client.get(&url).timeout(Duration::from_secs(12)).send() {
            Ok(response) if response.status().is_success() => return Ok(base.to_string()),
            Ok(response) => last_error = format!("{base} 返回 HTTP {}", response.status().as_u16()),
            Err(err) => last_error = format!("{base}：{err}"),
        }
    }
    Err(format!(
        "模型站点都连不上（{last_error}）。检查网络，或用 LIVETRANS_MODEL_BASE 指定镜像。"
    ))
}

/// Download one file into `dir`, resuming a previous `.part` when possible.
/// `on_progress` is called at most every 250ms with the new byte count.
pub fn fetch_file(
    client: &reqwest::blocking::Client,
    base: &str,
    repo: &str,
    file: &RemoteFile<'_>,
    dir: &Path,
    flag: &AtomicBool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let part = dir.join(format!("{}.part", file.local));
    let final_path: PathBuf = dir.join(file.local);

    // A finished file only counts when both its size and checksum agree with
    // the catalogue; a corrupt copy is removed and fetched again.
    if final_path.is_file() {
        let right_size = final_path
            .metadata()
            .map(|meta| meta.len() == file.bytes)
            .unwrap_or(false);
        if right_size && verify_file(&final_path, file.local, file.sha256).is_ok() {
            return Ok(());
        }
        let _ = fs::remove_file(&final_path);
    }

    let mut offset = part.metadata().map(|meta| meta.len()).unwrap_or(0);
    if offset > file.bytes {
        offset = 0;
        let _ = fs::remove_file(&part);
    }

    let url = format!("{base}/{repo}/resolve/main/{}", file.remote);
    let mut request = client.get(&url);
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let mut response = request
        .send()
        .map_err(|err| format!("下载 {} 失败：{err}", file.local))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载 {} 失败：HTTP {}",
            file.local,
            response.status().as_u16()
        ));
    }
    if offset > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        offset = 0;
    }

    let mut out = if offset > 0 {
        OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|err| format!("无法续写 {}：{err}", file.local))?
    } else {
        File::create(&part).map_err(|err| format!("无法创建 {}：{err}", file.local))?
    };

    let mut buffer = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut last_report = Instant::now();
    loop {
        if flag.load(Ordering::SeqCst) {
            let _ = out.flush();
            return Err(CANCELLED.to_string());
        }
        let read = response
            .read(&mut buffer)
            .map_err(|err| format!("读取 {} 失败：{err}", file.local))?;
        if read == 0 {
            break;
        }
        out.write_all(&buffer[..read])
            .map_err(|err| format!("写入 {} 失败：{err}", file.local))?;
        written += read as u64;
        if last_report.elapsed() >= Duration::from_millis(250) {
            on_progress(offset + written);
            last_report = Instant::now();
        }
    }
    out.flush()
        .map_err(|err| format!("写入 {} 失败：{err}", file.local))?;
    drop(out);

    let actual = part.metadata().map(|meta| meta.len()).unwrap_or(0);
    if actual != file.bytes {
        return Err(format!(
            "{} 大小不符（{actual} / {} 字节），再试一次会续传。",
            file.local, file.bytes
        ));
    }
    if let Err(err) = verify_file(&part, file.local, file.sha256) {
        // A checksum failure never resumes: drop the partial file so the next
        // attempt starts from byte zero.
        let _ = fs::remove_file(&part);
        return Err(err);
    }
    fs::rename(&part, &final_path).map_err(|err| format!("重命名 {} 失败：{err}", file.local))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_a_known_vector() {
        let dir = std::env::temp_dir().join("livetrans-sha256-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.txt");
        fs::write(&path, b"abc").unwrap();
        let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_file(&path).unwrap(), digest);
        assert!(verify_file(&path, "abc.txt", digest).is_ok());
        assert!(verify_file(&path, "abc.txt", "").is_ok());
        let err = verify_file(&path, "abc.txt", "00").unwrap_err();
        assert!(err.contains("SHA-256"));
        let _ = fs::remove_dir_all(&dir);
    }
}
