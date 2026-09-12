import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BUS_NAME = 'org.voce.Voce1';
const OBJECT_PATH = '/org/voce/Voce1';
const INTERFACE = `
<node>
  <interface name="org.voce.Voce1">
    <method name="Start"/>
    <method name="Stop"><arg type="s" direction="in"/></method>
    <method name="Toggle"><arg type="s" direction="in"/></method>
    <method name="Cancel"/>
    <method name="MarkInserted"><arg type="x" direction="in"/><arg type="b" direction="in"/></method>
    <signal name="StatusChanged"><arg type="s"/></signal>
    <signal name="TranscriptReady"><arg type="x"/><arg type="s"/><arg type="s"/></signal>
    <signal name="Error"><arg type="s"/></signal>
    <property name="State" type="s" access="read"/>
  </interface>
</node>`;

const VoceProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE);

export default class VoceExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._holding = false;
        this._createIndicator();
        this._createOverlay();
        this._registerShortcuts();
        this._capturedEventId = global.stage.connect('captured-event', (_actor, event) => this._capturedEvent(event));
        this._proxy = new VoceProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, proxy => {
            this._signalId = proxy.connectSignal('StatusChanged', (_proxy, _sender, [state]) => this._setState(state));
            this._transcriptId = proxy.connectSignal('TranscriptReady', (_proxy, _sender, [id, text]) => this._insertText(id, text));
            this._errorId = proxy.connectSignal('Error', (_proxy, _sender, [message]) => this._showError(message));
        }, error => this._showError(`Voce service unavailable: ${error.message}`));
    }

    disable() {
        if (this._holding)
            this._call('CancelRemote');
        Main.wm.removeKeybinding('hold-shortcut');
        Main.wm.removeKeybinding('toggle-shortcut');
        if (this._capturedEventId)
            global.stage.disconnect(this._capturedEventId);
        this._disconnectProxy();
        this._overlay?.destroy();
        this._indicator?.destroy();
        this._settings = null;
        this._proxy = null;
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'Voce');
        this._icon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', style_class: 'system-status-icon'});
        this._indicator.add_child(this._icon);
        this._toggleItem = new PopupMenu.PopupMenuItem('Start dictation');
        this._toggleItem.connect('activate', () => this._call('ToggleRemote', this._focusedApplication()));
        this._indicator.menu.addMenuItem(this._toggleItem);
        const cancel = new PopupMenu.PopupMenuItem('Cancel');
        cancel.connect('activate', () => this._call('CancelRemote'));
        this._indicator.menu.addMenuItem(cancel);
        const settings = new PopupMenu.PopupMenuItem('Voce settings');
        settings.connect('activate', () => Gio.Subprocess.new(['voce'], Gio.SubprocessFlags.NONE));
        this._indicator.menu.addMenuItem(settings);
        Main.panel.addToStatusArea('voce', this._indicator);
    }

    _createOverlay() {
        this._overlay = new St.BoxLayout({style_class: 'voce-overlay', visible: false, reactive: false});
        this._overlayIcon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', style_class: 'voce-overlay-icon'});
        this._overlayLabel = new St.Label({text: 'Listening…', y_align: Clutter.ActorAlign.CENTER});
        this._overlay.add_child(this._overlayIcon);
        this._overlay.add_child(this._overlayLabel);
        Main.layoutManager.addTopChrome(this._overlay);
        this._positionOverlay();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._positionOverlay());
    }

    _positionOverlay() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._overlay)
            return;
        this._overlay.set_position(Math.round(monitor.x + monitor.width / 2 - 90), monitor.y + monitor.height - 96);
    }

    _registerShortcuts() {
        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        Main.wm.addKeybinding('hold-shortcut', this._settings, flags, ShellActionMode(), () => {
            if (!this._holding) {
                this._holding = true;
                this._call('StartRemote');
            }
        });
        Main.wm.addKeybinding('toggle-shortcut', this._settings, flags, ShellActionMode(), () => {
            this._call('ToggleRemote', this._focusedApplication());
        });
    }

    _capturedEvent(event) {
        if (!this._holding || event.type() !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        const [, key] = event.get_key_symbol ? [true, event.get_key_symbol()] : [false, 0];
        if (key === Clutter.KEY_space) {
            this._holding = false;
            this._call('StopRemote', this._focusedApplication());
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _call(method, ...arguments_) {
        if (!this._proxy) {
            this._showError('Voce is still starting');
            return;
        }
        const callback = (_result, error) => error && this._showError(error.message);
        this._proxy[method](...arguments_, callback);
    }

    _setState(state) {
        const active = state === 'recording' || state === 'transcribing';
        this._icon.icon_name = state === 'recording' ? 'media-record-symbolic' : 'audio-input-microphone-symbolic';
        this._toggleItem.label.text = state === 'recording' ? 'Stop dictation' : 'Start dictation';
        this._overlay.visible = active;
        this._overlayLabel.text = state === 'recording' ? 'Listening…' : 'Transcribing…';
        if (state === 'recording')
            this._indicator.add_style_class_name('voce-recording');
        else
            this._indicator.remove_style_class_name('voce-recording');
    }

    _insertText(id, text) {
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            let inserted = false;
            try {
                const terminal = this._isTerminal(this._focusedApplication());
                const seat = Clutter.get_default_backend().get_default_seat();
                const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                const time = Clutter.get_current_event_time();
                keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
                if (terminal)
                    keyboard.notify_keyval(time, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
                keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.PRESSED);
                keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.RELEASED);
                if (terminal)
                    keyboard.notify_keyval(time, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
                keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
                inserted = true;
            } catch (error) {
                this._showError(`Text copied; automatic paste failed: ${error.message}`);
            }
            this._call('MarkInsertedRemote', id, inserted);
            return GLib.SOURCE_REMOVE;
        });
    }

    _focusedApplication() {
        return global.display.focus_window?.get_wm_class()?.toLowerCase() ?? '';
    }

    _isTerminal(application) {
        const configured = this._settings.get_strv('terminal-apps').map(value => value.toLowerCase());
        return configured.some(value => application.includes(value));
    }

    _showError(message) {
        Main.notifyError('Voce', message);
        if (this._overlayLabel) {
            this._overlay.visible = true;
            this._overlayLabel.text = message;
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                if (this._overlay) this._overlay.visible = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _disconnectProxy() {
        if (this._proxy && this._signalId) this._proxy.disconnectSignal(this._signalId);
        if (this._proxy && this._transcriptId) this._proxy.disconnectSignal(this._transcriptId);
        if (this._proxy && this._errorId) this._proxy.disconnectSignal(this._errorId);
        if (this._monitorsChangedId) Main.layoutManager.disconnect(this._monitorsChangedId);
    }
}

function ShellActionMode() {
    // Importing Shell solely for this enum breaks older extension linters; the numeric
    // combination is NORMAL | OVERVIEW and deliberately excludes the lock screen.
    return 1 | 2;
}

