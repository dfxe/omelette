.PHONY: check test build runtime package install-user

check:
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	glib-compile-schemas --strict --dry-run extension/schemas
	glib-compile-schemas --strict --dry-run data

test:
	cargo test

build:
	cargo build --release

runtime:
	bash scripts/build-whisper.sh

package: build runtime
	cargo deb

install-user: build
	install -Dm755 target/release/voce "$(HOME)/.local/bin/voce"
	install -Dm644 data/org.voce.Voce.desktop "$(HOME)/.local/share/applications/org.voce.Voce.desktop"
	install -Dm644 data/org.voce.Voce.metainfo.xml "$(HOME)/.local/share/metainfo/org.voce.Voce.metainfo.xml"
	install -Dm644 data/voce.service "$(HOME)/.config/systemd/user/voce.service"
	sed -i 's|/usr/bin/voce|%h/.local/bin/voce|' "$(HOME)/.config/systemd/user/voce.service"
	systemctl --user daemon-reload
