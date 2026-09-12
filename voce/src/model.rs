use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
};

const MODEL_ORIGIN: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const ALLOWED_MODELS: &[&str] = &["base", "small", "medium", "large-v3-turbo-q5_0"];

pub struct ModelManager;

impl ModelManager {
    pub fn directory() -> Result<PathBuf> {
        let mut path = dirs::data_dir().context("XDG data directory is unavailable")?;
        path.push("voce/models");
        Ok(path)
    }

    pub fn path(model: &str) -> Result<PathBuf> {
        validate_model(model)?;
        Ok(Self::directory()?.join(format!("ggml-{model}.bin")))
    }

    pub fn is_installed(model: &str) -> bool {
        Self::path(model)
            .map(|path| {
                path.exists()
                    && path
                        .metadata()
                        .map(|m| m.len() > 1_000_000)
                        .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    pub fn download(model: &str, mut progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
        let destination = Self::path(model)?;
        fs::create_dir_all(Self::directory()?)?;
        let temporary = destination.with_extension("bin.part");
        let url = format!("{MODEL_ORIGIN}/ggml-{model}.bin");
        let response = ureq::get(&url)
            .call()
            .with_context(|| format!("failed to download {url}"))?;
        let total = response
            .header("content-length")
            .and_then(|value| value.parse().ok());
        let mut input = response.into_reader();
        let mut output = fs::File::create(&temporary)?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        let mut received = 0_u64;
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
            received += count as u64;
            progress(received, total);
        }
        output.sync_all()?;
        if received < 1_000_000 {
            let _ = fs::remove_file(&temporary);
            bail!("downloaded model is unexpectedly small");
        }
        let hash = format!("{:x}", digest.finalize());
        fs::write(
            destination.with_extension("bin.sha256"),
            format!("{hash}\n"),
        )?;
        fs::rename(temporary, &destination)?;
        Ok(destination)
    }

    pub fn verify(model: &str) -> Result<bool> {
        let path = Self::path(model)?;
        let expected = fs::read_to_string(path.with_extension("bin.sha256"))?;
        let mut file = fs::File::open(path)?;
        let mut digest = Sha256::new();
        std::io::copy(&mut file, &mut digest)?;
        Ok(format!("{:x}", digest.finalize()) == expected.trim())
    }
}

fn validate_model(model: &str) -> Result<()> {
    if !ALLOWED_MODELS.contains(&model) {
        bail!("unsupported model: {model}");
    }
    Ok(())
}
