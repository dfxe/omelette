use anyhow::{bail, Context, Result};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Instant,
};

pub struct Recorder {
    child: Child,
    path: PathBuf,
    started: Instant,
}

pub struct Recording {
    pub path: PathBuf,
    pub duration_ms: u64,
}

impl Recorder {
    pub fn start(input_device: Option<&str>) -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "voce-{}-{}.wav",
            std::process::id(),
            chrono::Utc::now().timestamp_millis()
        ));
        let mut command = Command::new("pw-record");
        command.args(["--rate", "16000", "--channels", "1", "--format", "s16"]);
        if let Some(device) = input_device {
            command.args(["--target", device]);
        }
        command
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let child = command
            .spawn()
            .context("pw-record is unavailable; install PipeWire tools")?;
        Ok(Self {
            child,
            path,
            started: Instant::now(),
        })
    }

    pub fn stop(mut self) -> Result<Recording> {
        // `Child::kill` sends SIGKILL on Unix, which prevents pw-record from
        // finalizing the WAV header. Ask it to stop gracefully so whisper.cpp
        // can read the completed recording.
        let signal_status = Command::new("kill")
            .args(["-INT", &self.child.id().to_string()])
            .status()
            .context("failed to signal microphone capture")?;
        if !signal_status.success() {
            bail!("failed to stop microphone capture ({signal_status})");
        }
        let status = self.child.wait()?;
        if !self.path.exists() || self.path.metadata()?.len() < 44 {
            bail!("microphone produced no audio ({status})");
        }
        Ok(Recording {
            path: self.path,
            duration_ms: self.started.elapsed().as_millis() as u64,
        })
    }

    pub fn cancel(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(self.path);
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
