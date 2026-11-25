//! On-demand package for the local NMT route.
//!
//! The opus-mt en→zh ONNX graphs used to ship inside the installer. They are a
//! model like any other now: settings downloads them, the engine loads them
//! from the configured model directory, and deleting them simply disables the
//! local route until they are downloaded again.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::download::{self, CANCELLED};

pub const NMT_REPO: &str = "Xenova/opus-mt-en-zh";
pub const NMT_BYTES: u64 = 441_177_157;
pub const NMT_DIR_NAME: &str = "en-zh";

struct PackageFile {
    remote: &'static str,
    local: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const PACKAGE: &[PackageFile] = &[
    PackageFile {
        remote: "onnx/encoder_model_int8.onnx",
        local: "encoder_model_int8.onnx",
        bytes: 52_726_553,
        sha256: "262c0319bd0d8a6570f287211bf962035788954f20697e022cd60aaf62209b9c",
    },
    PackageFile {
        remote: "onnx/decoder_model_int8.onnx",
        local: "decoder_model_int8.onnx",
        bytes: 192_658_471,
        sha256: "8eb245366039256e29a21c73d6438f7a0878866d570b4e2b8fff5d88ec9bac5e",
    },
    PackageFile {
        remote: "onnx/decoder_with_past_model_int8.onnx",
        local: "decoder_with_past_model_int8.onnx",
        bytes: 189_409_678,
        sha256: "004b2112aeffd2027e8b4846feaad0842973d8a94514a254d79295434df998d5",
    },
    PackageFile {
        remote: "tokenizer.json",
        local: "tokenizer.json",
        bytes: 6_380_952,
        sha256: "d0c7da27056e8f42adce9e76d8e792e5daa64e15f5acd2e7aabf0121877dd4c1",
    },
    PackageFile {
        remote: "config.json",
        local: "config.json",
        bytes: 1_503,
        sha256: "4727d1229a04f95bf6f39abf949d8080615433d99d6ebd85f81c09edd247d5fa",
    },
];

pub fn installed(dir: &Path) -> bool {
    [
        "encoder_model_int8.onnx",
        "decoder_model_int8.onnx",
        "decoder_with_past_model_int8.onnx",
        "tokenizer.json",
    ]
    .iter()
    .all(|file| dir.join(file).is_file())
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TranslateDownloadEvent {
    Progress {
        file: String,
        file_index: usize,
        file_total: usize,
        downloaded: u64,
        total: u64,
    },
    Done {
        dir: String,
    },
    Error {
        message: String,
    },
    Cancelled,
}

/// Download the package into `root/en-zh`. Returns the model directory.
pub fn download(
    root: &Path,
    flag: &AtomicBool,
    on_event: &mut dyn FnMut(TranslateDownloadEvent),
) -> Result<PathBuf, String> {
    let dir = root.join(NMT_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建模型目录：{err}"))?;

    let client = download::client()?;
    let base = download::pick_base(&client, NMT_REPO, "tokenizer.json")?;
    let mut done_bytes: u64 = 0;

    for (index, file) in PACKAGE.iter().enumerate() {
        if flag.load(Ordering::SeqCst) {
            return Err(CANCELLED.to_string());
        }
        // `fetch_file` skips a file that is already present *and* matches its
        // checksum, so a re-download also repairs a corrupt copy.
        let remote = download::RemoteFile {
            remote: file.remote,
            local: file.local,
            bytes: file.bytes,
            sha256: file.sha256,
        };
        download::fetch_file(&client, &base, NMT_REPO, &remote, &dir, flag, &mut |written| {
            on_event(TranslateDownloadEvent::Progress {
                file: file.local.to_string(),
                file_index: index,
                file_total: PACKAGE.len(),
                downloaded: done_bytes + written,
                total: NMT_BYTES,
            });
        })?;
        done_bytes += file.bytes;
        on_event(TranslateDownloadEvent::Progress {
            file: file.local.to_string(),
            file_index: index,
            file_total: PACKAGE.len(),
            downloaded: done_bytes,
            total: NMT_BYTES,
        });
    }

    if !installed(&dir) {
        return Err("下载完成，但模型文件不完整，请重试。".to_string());
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_directory_is_not_installed() {
        let dir = std::env::temp_dir().join("livetrans-nmt-empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!installed(&dir));
        for file in [
            "encoder_model_int8.onnx",
            "decoder_model_int8.onnx",
            "decoder_with_past_model_int8.onnx",
            "tokenizer.json",
        ] {
            fs::write(dir.join(file), b"x").unwrap();
        }
        assert!(installed(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "downloads ~421MB from the network; run with --ignored"]
    fn downloads_the_nmt_package() {
        let root = std::env::temp_dir().join("livetrans-nmt-download-test");
        let _ = fs::remove_dir_all(&root);
        let flag = AtomicBool::new(false);
        let mut last: Option<TranslateDownloadEvent> = None;
        let dir = download(&root, &flag, &mut |event| last = Some(event))
            .expect("download should succeed");
        assert!(installed(&dir));
        assert!(matches!(last, Some(TranslateDownloadEvent::Progress { .. })));
        eprintln!("nmt dir: {}", dir.display());
    }
}
