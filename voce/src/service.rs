use crate::{
    cleanup, config::Config, history::HistoryStore, model::ModelManager, recorder::Recorder,
    transcriber,
};
use std::sync::Mutex;
use zbus::{interface, SignalContext};

pub const BUS_NAME: &str = "org.voce.Voce1";
pub const OBJECT_PATH: &str = "/org/voce/Voce1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Recording,
    Transcribing,
    Error,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Recording => "recording",
            Self::Transcribing => "transcribing",
            Self::Error => "error",
        }
    }
}

struct Runtime {
    state: State,
    recorder: Option<Recorder>,
    last_error: String,
    cancelled: bool,
}

pub struct VoceService {
    runtime: Mutex<Runtime>,
}

impl Default for VoceService {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(Runtime {
                state: State::Idle,
                recorder: None,
                cancelled: false,
                last_error: String::new(),
            }),
        }
    }
}

#[interface(name = "org.voce.Voce1")]
impl VoceService {
    async fn start(
        &self,
        #[zbus(signal_context)] context: SignalContext<'_>,
    ) -> zbus::fdo::Result<()> {
        let config = Config::load().map_err(failed)?;
        {
            let runtime = self.runtime.lock().unwrap();
            if matches!(runtime.state, State::Recording | State::Transcribing) {
                return Ok(());
            }
        }
        let recorder = Recorder::start(config.input_device.as_deref()).map_err(failed)?;
        {
            let mut runtime = self.runtime.lock().unwrap();
            runtime.recorder = Some(recorder);
            runtime.cancelled = false;
            runtime.state = State::Recording;
            runtime.last_error.clear();
        }
        Self::status_changed(&context, "recording").await?;
        Ok(())
    }

    async fn stop(
        &self,
        application: &str,
        #[zbus(signal_context)] context: SignalContext<'_>,
    ) -> zbus::fdo::Result<()> {
        let recorder = {
            let mut runtime = self.runtime.lock().unwrap();
            if runtime.state != State::Recording {
                return Ok(());
            }
            runtime.state = State::Transcribing;
            runtime.recorder.take()
        };
        Self::status_changed(&context, "transcribing").await?;
        let result = (|| -> anyhow::Result<(i64, String, String)> {
            let recording = recorder
                .expect("recording state must own a recorder")
                .stop()?;
            let config = Config::load()?;
            let model = ModelManager::path(&config.model)?;
            if !ModelManager::is_installed(&config.model) {
                anyhow::bail!(
                    "model '{}' is not installed; open Voce to download it",
                    config.model
                );
            }
            let transcript = transcriber::transcribe(&recording.path, &model, &config.language)?;
            let text = cleanup::clean(
                &transcript.text,
                &transcript.language,
                config.filler_removal,
                &config.vocabulary,
            );
            if text.is_empty() {
                anyhow::bail!("no speech was detected");
            }
            let id = if config.history_enabled {
                let store = HistoryStore::open_default()?;
                store.prune(config.retention_days)?;
                store.insert(
                    &text,
                    &transcript.language,
                    recording.duration_ms,
                    non_empty(application),
                )?
            } else {
                0
            };
            Ok((id, text, transcript.language))
        })();
        if self.runtime.lock().unwrap().cancelled {
            self.set_state(State::Idle, "");
            Self::status_changed(&context, "idle").await?;
            return Ok(());
        }
        match result {
            Ok((id, text, language)) => {
                self.set_state(State::Idle, "");
                Self::transcript_ready(&context, id, &text, &language).await?;
                Self::status_changed(&context, "idle").await?;
                Ok(())
            }
            Err(error) => {
                let message = format!("{error:#}");
                self.set_state(State::Error, &message);
                Self::error(&context, &message).await?;
                Self::status_changed(&context, "error").await?;
                Err(failed(message))
            }
        }
    }

    async fn toggle(
        &self,
        application: &str,
        #[zbus(signal_context)] context: SignalContext<'_>,
    ) -> zbus::fdo::Result<()> {
        let state = self.runtime.lock().unwrap().state;
        if state == State::Recording {
            self.stop(application, context).await
        } else {
            self.start(context).await
        }
    }

    async fn cancel(
        &self,
        #[zbus(signal_context)] context: SignalContext<'_>,
    ) -> zbus::fdo::Result<()> {
        self.runtime.lock().unwrap().cancelled = true;
        if let Some(recorder) = self.runtime.lock().unwrap().recorder.take() {
            recorder.cancel();
        }
        self.set_state(State::Idle, "");
        Self::status_changed(&context, "idle").await?;
        Ok(())
    }

    async fn mark_inserted(&self, id: i64, inserted: bool) -> zbus::fdo::Result<()> {
        if id > 0 {
            HistoryStore::open_default()
                .and_then(|store| store.mark_inserted(id, inserted))
                .map_err(failed)?;
        }
        Ok(())
    }

    #[zbus(property)]
    fn state(&self) -> String {
        self.runtime.lock().unwrap().state.as_str().into()
    }

    #[zbus(property)]
    fn last_error(&self) -> String {
        self.runtime.lock().unwrap().last_error.clone()
    }

    #[zbus(signal)]
    async fn status_changed(context: &SignalContext<'_>, state: &str) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn transcript_ready(
        context: &SignalContext<'_>,
        id: i64,
        text: &str,
        language: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn error(context: &SignalContext<'_>, message: &str) -> zbus::Result<()>;
}

impl VoceService {
    fn set_state(&self, state: State, error: &str) {
        let mut runtime = self.runtime.lock().unwrap();
        runtime.state = state;
        runtime.last_error = error.into();
    }
}

fn failed(error: impl std::fmt::Display) -> zbus::fdo::Error {
    zbus::fdo::Error::Failed(error.to_string())
}
fn non_empty(value: &str) -> Option<&str> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub fn run() -> anyhow::Result<()> {
    let _connection = zbus::blocking::ConnectionBuilder::session()?
        .name(BUS_NAME)?
        .serve_at(OBJECT_PATH, VoceService::default())?
        .build()?;
    loop {
        std::thread::park();
    }
}
