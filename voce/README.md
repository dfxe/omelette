# Voce

Voce is Omelette's private, local-first voice-dictation backend for Ubuntu
GNOME on Wayland. Omelette owns the shortcuts and desktop UI; Voce records and
transcribes locally with `whisper.cpp`.

## Features

- Global hold-to-talk (`Super+Alt+Space`) and toggle (`Super+Alt+D`) shortcuts.
- Integrated Omelette menu and non-focus-stealing recording/transcribing pill.
- Local multilingual Whisper transcription with no cloud account.
- English and Romanian spoken punctuation, filler cleanup, and custom vocabulary.
- Automatic `Ctrl+V` or terminal-aware `Ctrl+Shift+V` insertion.
- Local transcript history; microphone audio is never retained.
- Native GTK 4/libadwaita window and systemd user service.

## Build on Ubuntu 24.04

```sh
sudo apt install build-essential cargo cmake git libgtk-4-dev libadwaita-1-dev \
  libsqlite3-dev libssl-dev libvulkan-dev pipewire-bin
cargo install cargo-deb
make check test build
make runtime
make package
```

Set `VOCE_VULKAN=ON make runtime` for Vulkan acceleration. The CPU build remains the portable default.

For development, install the Omelette Shell extension first, then
`make install-user` installs the Voce app and user service:

```sh
systemctl --user enable --now voce.service
```

Open Voce and download the small multilingual model before first use. Models live in `$XDG_DATA_HOME/voce/models`; settings and history use standard XDG user directories.

## Privacy

Audio exists only as a uniquely named temporary WAV during transcription and is removed on success, error, or cancellation. It is never added to history. The downloader uses HTTPS and records a SHA-256 digest for later integrity checks. Once a model is installed, dictation makes no network requests.

## Architecture

- `src/service.rs`: D-Bus service and dictation state machine.
- `src/recorder.rs`: PipeWire capture through `pw-record`.
- `src/transcriber.rs`: pinned `whisper.cpp` adapter.
- `src/cleanup.rs`: deterministic transcript cleanup.
- `src/history.rs`: SQLite text history.
- `../linux/omelette@dfxe.github.io/voce.js`: GNOME shortcuts, status UI,
  clipboard history, and Wayland paste integration.
- `extension/`: legacy standalone extension, retained as migration reference
  and no longer packaged.

Voce targets GNOME Shell 46–50 and is tested first on Ubuntu 24.04 / GNOME 46. Other desktops, X11, cloud rewriting, wake words, and retained audio are out of scope.
