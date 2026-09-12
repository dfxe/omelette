use adw::prelude::*;
use gtk::glib;
use std::time::Duration;
use voce::{config::Config, history::HistoryStore, model::ModelManager, service};

const APP_ID: &str = "org.voce.Voce";

fn main() -> glib::ExitCode {
    if std::env::args().any(|argument| argument == "--service") {
        if let Err(error) = service::run() {
            eprintln!("Voce service failed: {error:#}");
            return glib::ExitCode::FAILURE;
        }
        return glib::ExitCode::SUCCESS;
    }

    std::thread::Builder::new()
        .name("voce-dbus".into())
        .spawn(|| {
            if let Err(error) = service::run() {
                eprintln!("Voce service failed: {error:#}");
            }
        })
        .expect("failed to start service thread");

    let application = adw::Application::builder().application_id(APP_ID).build();
    application.connect_activate(build_ui);
    application.run()
}

fn build_ui(application: &adw::Application) {
    if let Some(window) = application.active_window() {
        window.present();
        return;
    }
    let page = adw::PreferencesPage::new();

    let status_group = adw::PreferencesGroup::builder()
        .title("Dictation")
        .description("Private speech-to-text for your GNOME desktop")
        .build();
    let status = adw::ActionRow::builder()
        .title("Ready")
        .subtitle("Use Super+Alt+Space to hold, or Super+Alt+D to toggle")
        .build();
    status.add_prefix(&gtk::Image::from_icon_name(
        "audio-input-microphone-symbolic",
    ));
    let dictate = gtk::Button::builder()
        .label("Start dictation")
        .valign(gtk::Align::Center)
        .build();
    status.add_suffix(&dictate);
    status_group.add(&status);
    page.add(&status_group);

    let speech_group = adw::PreferencesGroup::builder()
        .title("Speech model")
        .build();
    let model_row = adw::ComboRow::builder()
        .title("Model")
        .subtitle("Downloaded models run entirely on this computer")
        .build();
    model_row.set_model(Some(&gtk::StringList::new(&[
        "Base multilingual",
        "Small multilingual",
        "Medium multilingual",
        "Large v3 Turbo (Q5)",
    ])));
    model_row.set_selected(match Config::load().unwrap_or_default().model.as_str() {
        "base" => 0,
        "medium" => 2,
        "large-v3-turbo-q5_0" => 3,
        _ => 1,
    });
    speech_group.add(&model_row);
    let model_status = adw::ActionRow::builder()
        .title("Small multilingual")
        .build();
    let download = gtk::Button::builder()
        .label("Download")
        .valign(gtk::Align::Center)
        .build();
    model_status.add_suffix(&download);
    speech_group.add(&model_status);
    page.add(&speech_group);

    let privacy_group = adw::PreferencesGroup::builder().title("Privacy").build();
    let history_toggle = adw::SwitchRow::builder()
        .title("Save transcript history")
        .subtitle("Audio is never saved")
        .active(Config::load().unwrap_or_default().history_enabled)
        .build();
    privacy_group.add(&history_toggle);
    let filler_toggle = adw::SwitchRow::builder()
        .title("Remove filler words")
        .subtitle("Remove common hesitations in English and Romanian")
        .active(Config::load().unwrap_or_default().filler_removal)
        .build();
    privacy_group.add(&filler_toggle);
    page.add(&privacy_group);

    let history_group = adw::PreferencesGroup::builder()
        .title("Recent dictations")
        .build();
    match HistoryStore::open_default().and_then(|store| store.list("", 20)) {
        Ok(entries) if entries.is_empty() => history_group.add(
            &adw::ActionRow::builder()
                .title("No dictations yet")
                .subtitle("Your recent text will appear here")
                .build(),
        ),
        Ok(entries) => {
            for entry in entries {
                let row = adw::ActionRow::builder()
                    .title(&entry.text)
                    .subtitle(entry.created_at.format("%Y-%m-%d %H:%M").to_string())
                    .build();
                row.set_activatable(true);
                let text = entry.text;
                row.connect_activated(move |_| {
                    if let Some(display) = gtk::gdk::Display::default() {
                        display.clipboard().set_text(&text);
                    }
                });
                history_group.add(&row);
            }
        }
        Err(error) => history_group.add(
            &adw::ActionRow::builder()
                .title("History unavailable")
                .subtitle(error.to_string())
                .build(),
        ),
    }
    page.add(&history_group);

    let toolbar = adw::ToolbarView::new();
    toolbar.add_top_bar(&adw::HeaderBar::new());
    toolbar.set_content(Some(&page));
    let window = adw::ApplicationWindow::builder()
        .application(application)
        .title("Voce")
        .default_width(680)
        .default_height(720)
        .content(&toolbar)
        .build();

    let status_for_button = status.clone();
    let dictate_for_button = dictate.clone();
    dictate.connect_clicked(move |_| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(call_service("Toggle", "").map_err(|error| error.to_string()));
        });
        let status = status_for_button.clone();
        let button = dictate_for_button.clone();
        glib::timeout_add_local(Duration::from_millis(50), move || {
            match receiver.try_recv() {
                Ok(Ok(())) => {
                    status.set_title("Dictation toggled");
                    button.set_label("Toggle dictation");
                    glib::ControlFlow::Break
                }
                Ok(Err(error)) => {
                    status.set_title(&format!("Could not start: {error}"));
                    glib::ControlFlow::Break
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => glib::ControlFlow::Continue,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => glib::ControlFlow::Break,
            }
        });
    });

    let model_status_for_download = model_status.clone();
    download.connect_clicked(move |button| {
        button.set_sensitive(false);
        model_status_for_download.set_subtitle("Downloading…");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let model = Config::load().unwrap_or_default().model;
            let _ = sender.send(
                ModelManager::download(&model, |_, _| {})
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
            );
        });
        let row = model_status_for_download.clone();
        let button = button.clone();
        glib::timeout_add_local(Duration::from_millis(100), move || {
            match receiver.try_recv() {
                Ok(result) => {
                    button.set_sensitive(true);
                    row.set_subtitle(if result.is_ok() {
                        "Installed and verified"
                    } else {
                        "Download failed; try again"
                    });
                    glib::ControlFlow::Break
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => glib::ControlFlow::Continue,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => glib::ControlFlow::Break,
            }
        });
    });

    history_toggle.connect_active_notify(|row| {
        save_config(|config| config.history_enabled = row.is_active())
    });
    filler_toggle
        .connect_active_notify(|row| save_config(|config| config.filler_removal = row.is_active()));
    model_row.connect_selected_notify(|row| {
        let model = match row.selected() {
            0 => "base",
            2 => "medium",
            3 => "large-v3-turbo-q5_0",
            _ => "small",
        };
        save_config(|config| config.model = model.into());
    });

    let model_status_tick = model_status.clone();
    glib::timeout_add_local(Duration::from_millis(500), move || {
        model_status_tick.set_subtitle(if ModelManager::is_installed("small") {
            "Installed and verified"
        } else {
            "Not installed (about 466 MB)"
        });
        glib::ControlFlow::Continue
    });
    window.present();
}

fn save_config(update: impl FnOnce(&mut Config)) {
    let mut config = Config::load().unwrap_or_default();
    update(&mut config);
    if let Err(error) = config.save() {
        eprintln!("Failed to save settings: {error:#}");
    }
}
fn call_service(method: &str, application: &str) -> anyhow::Result<()> {
    let connection = zbus::blocking::Connection::session()?;
    let proxy = zbus::blocking::Proxy::new(
        &connection,
        service::BUS_NAME,
        service::OBJECT_PATH,
        service::BUS_NAME,
    )?;
    let _: () = proxy.call(method, &(application))?;
    Ok(())
}
