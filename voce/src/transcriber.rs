use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{path::Path, process::Command};

#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub text: String,
    pub language: String,
}

#[derive(Deserialize)]
struct WhisperOutput {
    transcription: Vec<WhisperSegment>,
    #[serde(default)]
    result: WhisperResult,
}
#[derive(Deserialize)]
struct WhisperSegment {
    text: String,
}
#[derive(Default, Deserialize)]
struct WhisperResult {
    #[serde(default)]
    language: String,
}

pub fn transcribe(audio: &Path, model: &Path, language: &str) -> Result<Transcript> {
    let output_base = audio.with_extension("transcript");
    let whisper = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(|parent| parent.join("whisper-cli")))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| Path::new("whisper-cli").to_path_buf());
    let mut command = Command::new(whisper);
    command.args([
        "-m",
        model.to_str().context("invalid model path")?,
        "-f",
        audio.to_str().context("invalid audio path")?,
        "-oj",
        "-of",
        output_base.to_str().context("invalid output path")?,
        "-np",
    ]);
    if language != "auto" {
        command.args(["-l", language]);
    }
    let result = command
        .output()
        .context("whisper-cli is unavailable; install the Voce inference runtime")?;
    if !result.status.success() {
        bail!(
            "transcription failed: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        );
    }
    let json_path = output_base.with_extension("transcript.json");
    let raw = std::fs::read_to_string(&json_path)?;
    let _ = std::fs::remove_file(json_path);
    let parsed: WhisperOutput = serde_json::from_str(&raw)?;
    Ok(Transcript {
        text: parsed
            .transcription
            .into_iter()
            .map(|segment| segment.text)
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_owned(),
        language: if parsed.result.language.is_empty() {
            language.to_owned()
        } else {
            parsed.result.language
        },
    })
}
