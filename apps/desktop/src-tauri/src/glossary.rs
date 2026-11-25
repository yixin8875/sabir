//! Scene presets and terminology.
//!
//! Each preset bundles a short scene sentence with source → target terms. The
//! active preset steers the LLM translation routes and the transcript Q&A
//! prompt; streaming transducer models also receive its source terms as ASR
//! hotwords. Nothing here touches audio, and the file never leaves the machine.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::general;

pub const MAX_SCENE_CHARS: usize = 600;
pub const MAX_TERMS: usize = 200;
pub const MAX_PRESETS: usize = 20;
pub const MAX_NAME_CHARS: usize = 40;
pub const GENERAL_ID: &str = "general";
pub const GENERAL_NAME: &str = "通用（不限场景）";
const HOTWORDS_FILE: &str = "glossary-hotwords.txt";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlossaryTerm {
    pub source: String,
    pub target: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlossaryPreset {
    pub id: String,
    pub name: String,
    pub scene: String,
    pub terms: Vec<GlossaryTerm>,
}

impl GlossaryPreset {
    pub fn general() -> Self {
        Self {
            id: GENERAL_ID.to_string(),
            name: GENERAL_NAME.to_string(),
            scene: String::new(),
            terms: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.scene.trim().is_empty() && self.terms.is_empty()
    }

    /// Instructions appended to LLM prompts. `None` when nothing is configured.
    pub fn prompt_block(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut lines = Vec::new();
        if !self.scene.trim().is_empty() {
            lines.push(format!("场景背景：{}", self.scene.trim()));
        }
        if !self.terms.is_empty() {
            let pairs = self
                .terms
                .iter()
                .map(|term| format!("{} => {}", term.source, term.target))
                .collect::<Vec<_>>()
                .join("；");
            lines.push(format!("术语（原文 => 译文）：{pairs}"));
        }
        Some(lines.join("\n"))
    }

    /// One source term per line, as sherpa-onnx expects.
    pub fn hotword_lines(&self) -> Vec<String> {
        self.terms
            .iter()
            .map(|term| term.source.trim().to_string())
            .filter(|source| !source.is_empty() && !source.contains('\n'))
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Glossary {
    pub active_id: String,
    pub presets: Vec<GlossaryPreset>,
}

impl Default for Glossary {
    fn default() -> Self {
        Self {
            active_id: GENERAL_ID.to_string(),
            presets: vec![GlossaryPreset::general()],
        }
    }
}

impl Glossary {
    pub fn normalized(mut self) -> Self {
        let mut presets = Vec::new();
        let mut ids = HashSet::new();
        for (index, mut preset) in self.presets.into_iter().enumerate() {
            preset.name = preset.name.trim().chars().take(MAX_NAME_CHARS).collect();
            preset.scene = preset.scene.trim().chars().take(MAX_SCENE_CHARS).collect();
            preset.terms = normalize_terms(preset.terms);
            preset.id = preset.id.trim().to_string();
            if preset.id.is_empty() {
                preset.id = format!("preset-{}", index + 1);
            }
            if preset.id == GENERAL_ID {
                preset = GlossaryPreset::general();
            }
            let base = preset.id.clone();
            let mut suffix = 1;
            while !ids.insert(preset.id.clone()) {
                suffix += 1;
                preset.id = format!("{base}-{suffix}");
            }
            presets.push(preset);
            if presets.len() >= MAX_PRESETS {
                break;
            }
        }
        if let Some(position) = presets.iter().position(|preset| preset.id == GENERAL_ID) {
            let general = presets.remove(position);
            presets.insert(0, general);
        } else {
            presets.insert(0, GlossaryPreset::general());
        }
        let active_id = if presets.iter().any(|preset| preset.id == self.active_id) {
            self.active_id
        } else {
            GENERAL_ID.to_string()
        };
        self.presets = presets;
        self.active_id = active_id;
        self
    }

    /// The preset currently steering translation, Q&A and hotwords.
    pub fn active(&self) -> Option<&GlossaryPreset> {
        self.presets
            .iter()
            .find(|preset| preset.id == self.active_id)
            .or_else(|| self.presets.first())
    }

    pub fn prompt_block(&self) -> Option<String> {
        self.active().and_then(GlossaryPreset::prompt_block)
    }

    pub fn hotword_lines(&self) -> Vec<String> {
        self.active()
            .map(GlossaryPreset::hotword_lines)
            .unwrap_or_default()
    }

    fn from_legacy(legacy: LegacyGlossary) -> Self {
        let mut glossary = Glossary::default();
        if !legacy.scene.trim().is_empty() || !legacy.terms.is_empty() {
            glossary.presets.push(GlossaryPreset {
                id: "preset-1".to_string(),
                name: "我的场景".to_string(),
                scene: legacy.scene,
                terms: legacy.terms,
            });
            glossary.active_id = "preset-1".to_string();
        }
        glossary
    }
}

fn normalize_terms(terms: Vec<GlossaryTerm>) -> Vec<GlossaryTerm> {
    let mut seen = HashSet::new();
    let mut kept = Vec::new();
    for term in terms {
        let source = term.source.trim().to_string();
        let target = term.target.trim().to_string();
        if source.is_empty() || target.is_empty() {
            continue;
        }
        if !seen.insert(source.to_lowercase()) {
            continue;
        }
        kept.push(GlossaryTerm { source, target });
        if kept.len() >= MAX_TERMS {
            break;
        }
    }
    kept
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LegacyGlossary {
    scene: String,
    terms: Vec<GlossaryTerm>,
}

pub fn load(path: &Path) -> Glossary {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Glossary::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        log::warn!("glossary: cannot parse {} as JSON", path.display());
        return Glossary::default();
    };
    let parsed = if value.get("presets").is_some() {
        serde_json::from_value::<Glossary>(value)
    } else {
        serde_json::from_value::<LegacyGlossary>(value).map(Glossary::from_legacy)
    };
    match parsed {
        Ok(glossary) => glossary.normalized(),
        Err(err) => {
            log::warn!("glossary: cannot parse {}: {err}", path.display());
            Glossary::default()
        }
    }
}

pub fn save(path: &Path, glossary: Glossary) -> Result<Glossary, String> {
    let glossary = glossary.normalized();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建设置目录失败：{err}"))?;
    }
    let json = serde_json::to_string_pretty(&glossary).map_err(|err| err.to_string())?;
    std::fs::write(path, json).map_err(|err| format!("写入术语表失败：{err}"))?;
    Ok(glossary)
}

/* ------------------------------------------------------------------------- */
/* Portable file (settings → glossary import/export)                         */
/* ------------------------------------------------------------------------- */

/// A preset as it appears in a shared file. Ids stay behind so importing into
/// another install can never collide with existing presets.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PortablePreset {
    name: String,
    scene: String,
    terms: Vec<GlossaryTerm>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PortableGlossary {
    #[serde(skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<u32>,
    presets: Vec<PortablePreset>,
}

/// Write every preset that has content (the general preset has none) to a
/// JSON file. The file can be imported on another install.
pub fn export_portable(path: &Path, glossary: &Glossary) -> Result<PathBuf, String> {
    let glossary = glossary.clone().normalized();
    let presets: Vec<PortablePreset> = glossary
        .presets
        .iter()
        .filter(|preset| preset.id != GENERAL_ID && !preset.is_empty())
        .map(|preset| PortablePreset {
            name: preset.name.clone(),
            scene: preset.scene.clone(),
            terms: preset.terms.clone(),
        })
        .collect();
    if presets.is_empty() {
        return Err(general::pick(
            "没有可导出的预设：先填写场景内容或术语。",
            "Nothing to export yet: add a scene or terms to a preset first.",
        )
        .to_string());
    }
    let document = PortableGlossary {
        app: Some("livetrans".to_string()),
        kind: Some("glossary".to_string()),
        version: Some(1),
        presets,
    };
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| {
                if general::is_chinese() {
                    format!("无法创建导出目录：{err}")
                } else {
                    format!("Could not create the export folder: {err}")
                }
            })?;
        }
    }
    let json = serde_json::to_string_pretty(&document).map_err(|err| err.to_string())?;
    std::fs::write(path, json).map_err(|err| {
        if general::is_chinese() {
            format!("写入术语表文件失败：{err}")
        } else {
            format!("Could not write the glossary file: {err}")
        }
    })?;
    Ok(path.to_path_buf())
}

/// Read a shared glossary file and return its non-empty presets with fresh ids.
/// The general preset is never imported. Callers merge the result into the
/// glossary they are editing.
pub fn import_portable(path: &Path) -> Result<Vec<GlossaryPreset>, String> {
    let text = std::fs::read_to_string(path).map_err(|err| {
        if general::is_chinese() {
            format!("无法读取术语表文件：{err}")
        } else {
            format!("Could not read the glossary file: {err}")
        }
    })?;
    let document: PortableGlossary = serde_json::from_str(&text).map_err(|err| {
        if general::is_chinese() {
            format!("术语表文件不是有效的 JSON：{err}")
        } else {
            format!("The glossary file is not valid JSON: {err}")
        }
    })?;
    let guessed: Vec<GlossaryPreset> = document
        .presets
        .into_iter()
        .enumerate()
        .map(|(index, preset)| GlossaryPreset {
            id: format!("import-{}", index + 1),
            name: preset.name,
            scene: preset.scene,
            terms: preset.terms,
        })
        .collect();
    let normalized = Glossary {
        active_id: GENERAL_ID.to_string(),
        presets: guessed,
    }
    .normalized();
    let presets: Vec<GlossaryPreset> = normalized
        .presets
        .into_iter()
        .filter(|preset| preset.id != GENERAL_ID && !preset.is_empty())
        .collect();
    if presets.is_empty() {
        return Err(general::pick(
            "文件里没有带内容（场景或术语）的预设。",
            "The file has no presets with a scene or terms.",
        )
        .to_string());
    }
    Ok(presets)
}

/// Write the hotword file for the active preset. Returns the path when there
/// is at least one term; removes a stale file otherwise.
pub fn write_hotwords(dir: &Path, glossary: &Glossary) -> Result<Option<PathBuf>, String> {
    let path = dir.join(HOTWORDS_FILE);
    let lines = glossary.hotword_lines();
    if lines.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(None);
    }
    std::fs::create_dir_all(dir).map_err(|err| format!("创建热词目录失败：{err}"))?;
    let mut body = lines.join("\n");
    body.push('\n');
    std::fs::write(&path, body).map_err(|err| format!("写入热词文件失败：{err}"))?;
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(source: &str, target: &str) -> GlossaryTerm {
        GlossaryTerm {
            source: source.to_string(),
            target: target.to_string(),
        }
    }

    fn preset(id: &str, name: &str, scene: &str, terms: Vec<GlossaryTerm>) -> GlossaryPreset {
        GlossaryPreset {
            id: id.to_string(),
            name: name.to_string(),
            scene: scene.to_string(),
            terms,
        }
    }

    #[test]
    fn normalization_keeps_general_first_and_falls_back() {
        let glossary = Glossary {
            active_id: "missing".to_string(),
            presets: vec![
                preset("p1", "  季度评审  ", "  讨论 Kubernetes  ", vec![
                    term(" Kubernetes ", "Kubernetes 集群"),
                    term("kubernetes", "重复项"),
                    term("", "空原文"),
                    term("空译文", ""),
                ]),
                preset("p1", "重复 id", "", vec![]),
            ],
        }
        .normalized();
        assert_eq!(glossary.active_id, GENERAL_ID);
        assert_eq!(glossary.presets.len(), 3);
        assert_eq!(glossary.presets[0].id, GENERAL_ID);
        assert_eq!(glossary.presets[0].name, GENERAL_NAME);
        assert_eq!(glossary.presets[1].name, "季度评审");
        assert_eq!(glossary.presets[1].scene, "讨论 Kubernetes");
        assert_eq!(glossary.presets[1].terms.len(), 1);
        assert_eq!(glossary.presets[2].id, "p1-2");
    }

    #[test]
    fn general_preset_cannot_carry_content() {
        let glossary = Glossary {
            active_id: GENERAL_ID.to_string(),
            presets: vec![preset(GENERAL_ID, "自定义", "不应保留", vec![term("a", "b")])],
        }
        .normalized();
        assert_eq!(glossary.presets.len(), 1);
        assert!(glossary.presets[0].is_empty());
        assert_eq!(glossary.presets[0].name, GENERAL_NAME);
        assert!(glossary.prompt_block().is_none());
    }

    #[test]
    fn prompt_block_and_hotwords_follow_the_active_preset() {
        let glossary = Glossary {
            active_id: "p2".to_string(),
            presets: vec![
                GlossaryPreset::general(),
                preset("p1", "旧场景", "不该出现", vec![term("old", "旧译法")]),
                preset("p2", "产品评审", "产品评审", vec![term("supply chain", "供应链")]),
            ],
        }
        .normalized();
        let block = glossary.prompt_block().unwrap();
        assert!(block.contains("场景背景：产品评审"));
        assert!(block.contains("supply chain => 供应链"));
        assert!(!block.contains("不该出现"));
        assert_eq!(glossary.hotword_lines(), vec!["supply chain"]);
    }

    #[test]
    fn hotwords_file_round_trips_and_clears() {
        let dir = std::env::temp_dir().join(format!("livetrans-glossary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let glossary = Glossary {
            active_id: "p1".to_string(),
            presets: vec![
                GlossaryPreset::general(),
                preset("p1", "产品评审", "", vec![term("Kubernetes", "Kubernetes 集群")]),
            ],
        };
        let path = write_hotwords(&dir, &glossary).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Kubernetes\n");
        assert!(write_hotwords(&dir, &Glossary::default()).unwrap().is_none());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn portable_file_round_trips_without_ids_or_the_general_preset() {
        let dir = std::env::temp_dir().join(format!("livetrans-glossary-portable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let glossary = Glossary {
            active_id: "p1".to_string(),
            presets: vec![
                GlossaryPreset::general(),
                preset("p1", "产品评审", "讨论云原生", vec![term("canary", "金丝雀发布")]),
                preset("p2", "空预设", "", vec![]),
            ],
        };
        let path = export_portable(&dir.join("glossary.json"), &glossary).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["kind"], "glossary");
        assert_eq!(value["presets"].as_array().unwrap().len(), 1);
        assert!(value["presets"][0].get("id").is_none());

        let imported = import_portable(&path).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "产品评审");
        assert_eq!(imported[0].scene, "讨论云原生");
        assert_eq!(imported[0].terms.len(), 1);
        assert!(imported[0].id.starts_with("import-"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn importing_the_in_app_file_shape_works() {
        let dir = std::env::temp_dir().join(format!("livetrans-glossary-import-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("glossary.json");
        std::fs::write(
            &path,
            r#"{"activeId":"p1","presets":[{"id":"general","name":"通用","scene":"","terms":[]},
                {"id":"p1","name":"高数课","scene":"微积分","terms":[{"source":"limit","target":"极限"}]}]}"#,
        )
        .unwrap();
        let imported = import_portable(&path).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "高数课");
        assert_eq!(imported[0].terms[0].target, "极限");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn portable_files_reject_empty_or_broken_content() {
        let dir = std::env::temp_dir().join(format!("livetrans-glossary-import-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(export_portable(&dir.join("empty.json"), &Glossary::default()).is_err());

        let broken = dir.join("broken.json");
        std::fs::write(&broken, "{not json").unwrap();
        assert!(import_portable(&broken).is_err());

        let blank = dir.join("blank.json");
        std::fs::write(&blank, r#"{"presets":[{"name":"只有名字"}]}"#).unwrap();
        assert!(import_portable(&blank).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_file_is_migrated_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("livetrans-glossary-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("glossary.json");
        std::fs::write(
            &path,
            r#"{"scene":"产品评审","terms":[{"source":"canary","target":"金丝雀发布"}]}"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.presets.len(), 2);
        assert_eq!(loaded.active_id, "preset-1");
        assert_eq!(loaded.active().unwrap().name, "我的场景");
        assert_eq!(loaded.hotword_lines(), vec!["canary"]);

        let saved = save(&path, loaded).unwrap();
        let reloaded = load(&path);
        assert_eq!(saved, reloaded);
        assert_eq!(reloaded.presets[0].id, GENERAL_ID);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
