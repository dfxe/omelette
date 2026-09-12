use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Config {
    pub language: String,
    pub model: String,
    pub input_device: Option<String>,
    pub filler_removal: bool,
    pub history_enabled: bool,
    pub retention_days: u32,
    pub max_recording_seconds: u32,
    pub vocabulary: Vec<VocabularyEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VocabularyEntry {
    pub spoken: String,
    pub written: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            language: "auto".into(),
            model: "small".into(),
            input_device: None,
            filler_removal: true,
            history_enabled: true,
            retention_days: 30,
            max_recording_seconds: 300,
            vocabulary: Vec::new(),
        }
    }
}

impl Config {
    pub fn path() -> Result<PathBuf> {
        let mut path = dirs::config_dir().context("XDG config directory is unavailable")?;
        path.push("voce/config.json");
        Ok(path)
    }

    pub fn load() -> Result<Self> {
        let path = Self::path()?;
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        serde_json::from_str(&raw).context("invalid Voce configuration")
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
        fs::rename(temporary, path)?;
        Ok(())
    }
}
