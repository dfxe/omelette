// Optional Voce dictation backend. The recorder/transcriber remains a separate
// process; Omelette owns the Shell-facing UI, shortcuts, clipboard and paste.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUS_NAME = 'org.voce.Voce1';
const OBJECT_PATH = '/org/voce/Voce1';
const INTERFACE = `<node><interface name="org.voce.Voce1">
  <method name="Start"/><method name="Stop"><arg type="s" direction="in"/></method>
  <method name="Toggle"><arg type="s" direction="in"/></method><method name="Cancel"/>
  <method name="MarkInserted"><arg type="x" direction="in"/><arg type="b" direction="in"/></method>
  <signal name="StatusChanged"><arg type="s"/></signal>
  <signal name="TranscriptReady"><arg type="x"/><arg type="s"/><arg type="s"/></signal>
  <signal name="Error"><arg type="s"/></signal><property name="State" type="s" access="read"/>
</interface></node>`;

const VoceProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE);

let _proxy = null;
let _overlay = null;
let _label = null;
let _visualizer = null;
let _bars = [];
let _animationTimer = 0;
let _animationFrame = 0;
let _holding = false;
let _capturedId = 0;
let _monitorsId = 0;
let _signalIds = [];
let _errorTimer = 0;
let _targetClass = null;
let _callbacks = null;

function focusedClass() {
    return global.display.get_focus_window()?.get_wm_class()?.toLowerCase() ?? '';
}

function positionOverlay() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || !_overlay) return;
    const [, width] = _overlay.get_preferred_width(-1);
    _overlay.set_position(Math.round(monitor.x + (monitor.width - width) / 2),
        monitor.y + monitor.height - 96);
}

function stopAnimation() {
    if (_animationTimer) GLib.source_remove(_animationTimer);
    _animationTimer = 0;
    _animationFrame = 0;
}

function animate(state) {
    stopAnimation();
    if (!_visualizer) return;
    _visualizer.visible = state === 'recording' || state === 'transcribing';
    if (!_visualizer.visible) return;

    const recordingFrames = [
        [5, 11, 17, 9, 6],
        [8, 17, 10, 15, 7],
        [14, 8, 18, 11, 16],
        [7, 14, 9, 18, 10],
        [11, 18, 13, 7, 14],
        [16, 10, 7, 14, 9],
    ];
    _animationTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 110, () => {
        if (!_visualizer) {
            _animationTimer = 0;
            return GLib.SOURCE_REMOVE;
        }
        const heights = state === 'recording'
            ? recordingFrames[_animationFrame % recordingFrames.length]
            : [0, 1, 2, 1, 0].map(offset =>
                6 + 3 * ((_animationFrame + offset) % 4));
        for (let i = 0; i < _bars.length; i++)
            _bars[i].set_height(heights[i]);
        _animationFrame++;
        return GLib.SOURCE_CONTINUE;
    });
}

function setState(state) {
    const active = state === 'recording' || state === 'transcribing';
    if (_overlay) _overlay.visible = active;
    if (_label) _label.text = state === 'recording' ? 'Listening…' : 'Transcribing…';
    if (_overlay) {
        if (state === 'recording') _overlay.add_style_class_name('cb-recording');
        else _overlay.remove_style_class_name('cb-recording');
    }
    animate(state);
    _callbacks?.onState?.(state);
    if (active) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        positionOverlay();
        return GLib.SOURCE_REMOVE;
    });
}

function showError(message) {
    Main.notifyError('Omelette dictation', message);
    if (!_overlay || !_label) return;
    _overlay.visible = true;
    _label.text = message;
    positionOverlay();
    if (_errorTimer) GLib.source_remove(_errorTimer);
    _errorTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
        _errorTimer = 0;
        if (_overlay) _overlay.visible = false;
        return GLib.SOURCE_REMOVE;
    });
}

function call(method, ...args) {
    if (!_proxy) {
        showError('Voce is unavailable. Install and start the Voce service first.');
        return;
    }
    _proxy[method](...args, (_result, error) => {
        if (error) showError(error.message ?? String(error));
    });
}

export function start() {
    _targetClass = focusedClass();
    call('StartRemote');
}

export function stop() {
    call('StopRemote', _targetClass ?? focusedClass());
}

export function toggle() {
    _targetClass = focusedClass();
    call('ToggleRemote', _targetClass);
}

export function beginHold() {
    if (_holding) return;
    _holding = true;
    start();
}

function capturedEvent(_actor, event) {
    if (!_holding || event.type() !== Clutter.EventType.KEY_RELEASE)
        return Clutter.EVENT_PROPAGATE;
    if (event.get_key_symbol() === Clutter.KEY_space) {
        _holding = false;
        stop();
    }
    return Clutter.EVENT_PROPAGATE;
}

export function enable(callbacks = {}) {
    shutdown();
    _callbacks = callbacks;
    _overlay = new St.BoxLayout({
        style_class: 'cb-voce-overlay', visible: false, reactive: false,
    });
    _overlay.add_child(new St.Icon({
        icon_name: 'audio-input-microphone-symbolic',
        style_class: 'cb-voce-overlay-icon',
    }));
    _visualizer = new St.BoxLayout({
        style_class: 'cb-voce-visualizer',
        y_align: Clutter.ActorAlign.CENTER,
    });
    _bars = Array.from({ length: 5 }, () => {
        const bar = new St.Widget({ style_class: 'cb-voce-bar', height: 6 });
        _visualizer.add_child(bar);
        return bar;
    });
    _overlay.add_child(_visualizer);
    _label = new St.Label({ text: 'Listening…', y_align: Clutter.ActorAlign.CENTER });
    _overlay.add_child(_label);
    Main.layoutManager.addTopChrome(_overlay);
    positionOverlay();
    _monitorsId = Main.layoutManager.connect('monitors-changed', positionOverlay);
    _capturedId = global.stage.connect('captured-event', capturedEvent);

    _proxy = new VoceProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, proxy => {
        _signalIds = [
            proxy.connectSignal('StatusChanged', (_p, _s, [state]) => setState(state)),
            proxy.connectSignal('TranscriptReady', (_p, _s, [id, text, language]) => {
                _callbacks?.onTranscript?.({ id, text, language, wmClass: _targetClass });
            }),
            proxy.connectSignal('Error', (_p, _s, [message]) => showError(message)),
        ];
        setState(proxy.State ?? 'idle');
    }, error => {
        // Keep the proxy: GDBusProxy tracks the well-known name and becomes
        // usable when a service started after Omelette eventually owns it.
        log(`omelette: Voce service unavailable: ${error.message}`);
    });
}

export function markInserted(id, inserted) {
    if (id > 0) call('MarkInsertedRemote', id, inserted);
}

export function shutdown() {
    if (_holding && _proxy) call('CancelRemote');
    _holding = false;
    if (_capturedId) global.stage.disconnect(_capturedId);
    if (_monitorsId) Main.layoutManager.disconnect(_monitorsId);
    if (_errorTimer) GLib.source_remove(_errorTimer);
    stopAnimation();
    if (_proxy) for (const id of _signalIds) _proxy.disconnectSignal(id);
    _overlay?.destroy();
    _proxy = null;
    _overlay = null;
    _label = null;
    _visualizer = null;
    _bars = [];
    _capturedId = 0;
    _monitorsId = 0;
    _errorTimer = 0;
    _signalIds = [];
    _targetClass = null;
    _callbacks = null;
}
