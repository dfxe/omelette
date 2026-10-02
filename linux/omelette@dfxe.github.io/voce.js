// Optional Voce dictation backend. The recorder/transcriber remains a separate
// process; Omelette owns the Shell-facing UI, shortcuts, clipboard and paste.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
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

// Stop does the whole transcription before it replies, which on a CPU model
// can take far longer than GDBus's 25 s default. A timeout there is not a
// failure: the transcript still arrives through TranscriptReady.
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

// How often a hold checks whether its shortcut is still held down.
const HOLD_POLL_MS = 40;

// The modifiers a hold shortcut can be built from. Lock and NumLock are left
// out on purpose: they are latched, not held.
const HOLD_MODS = Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SUPER_MASK |
    Clutter.ModifierType.HYPER_MASK |
    Clutter.ModifierType.META_MASK |
    Clutter.ModifierType.MOD4_MASK;

// The same failure arrives twice from Stop — once as the Error signal and once
// as the method's error reply — so an identical message this soon is dropped.
const ERROR_DEDUPE_MS = 2000;

let _proxy = null;
let _overlay = null;
let _label = null;
let _visualizer = null;
let _bars = [];
let _animationTimer = 0;
let _animationFrame = 0;
let _holding = false;
let _holdMods = 0;
let _holdPollId = 0;
let _holdGrab = null;
// A Start still waiting for its reply, and whether a Stop has been asked for
// meanwhile. See stop().
let _startPending = false;
let _stopQueued = false;
let _lastError = null;
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
    const now = GLib.get_monotonic_time() / 1000;
    if (_lastError && _lastError.message === message && now - _lastError.at < ERROR_DEDUPE_MS)
        return;
    _lastError = { message, at: now };
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

const NOT_RUNNING = 'Voce is not running. Start it with: systemctl --user start voce.service';

function describeError(error) {
    if (error instanceof GLib.Error &&
        (error.matches(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN) ||
         error.matches(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER)))
        return NOT_RUNNING;
    if (error instanceof GLib.Error && Gio.DBusError.is_remote_error(error))
        Gio.DBusError.strip_remote_error(error);
    return error.message ?? String(error);
}

function call(method, args = [], onDone = null) {
    if (!_proxy) {
        showError(NOT_RUNNING);
        onDone?.(false);
        return;
    }
    _proxy[method](...args, (_result, error) => {
        if (error) showError(describeError(error));
        onDone?.(!error);
    });
}

export function start() {
    _targetClass = focusedClass();
    _startPending = true;
    _stopQueued = false;
    call('StartRemote', [], ok => {
        _startPending = false;
        if (_stopQueued && ok) {
            _stopQueued = false;
            stop();
        }
        _stopQueued = false;
    });
}

export function stop() {
    // A quick tap can release the shortcut before Start has replied. Stopping
    // then would reach the service while it is still idle and be ignored,
    // leaving the microphone open once Start lands — so wait for it.
    if (_startPending) {
        _stopQueued = true;
        return;
    }
    call('StopRemote', [_targetClass ?? focusedClass()]);
}

export function toggle() {
    _targetClass = focusedClass();
    call('ToggleRemote', [_targetClass]);
}

function heldMods() {
    const [, , mods] = global.get_pointer();
    return mods & HOLD_MODS;
}

// Hold-to-talk ends when the shortcut is let go. While an application window
// has focus its key releases go to that window and never reach the stage, so
// listening for the release alone left the microphone open indefinitely.
// Instead, note which modifiers the shortcut was pressed with and poll for any
// of them coming up — the pointer's modifier state is global on both X11 and
// Wayland. A shortcut with no modifiers has nothing to poll, so for that one
// the keyboard is grabbed and the release is caught on the stage.
export function beginHold() {
    if (_holding) return;
    _holding = true;
    start();

    _holdMods = heldMods();
    if (_holdMods === 0) {
        grabKeyboard();
        return;
    }
    _holdPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_POLL_MS, () => {
        if ((heldMods() & _holdMods) === _holdMods) return GLib.SOURCE_CONTINUE;
        _holdPollId = 0;
        endHold();
        return GLib.SOURCE_REMOVE;
    });
}

function grabKeyboard() {
    try {
        _holdGrab = Main.pushModal(_overlay, { actionMode: Shell.ActionMode.POPUP });
    } catch (e) {
        logError(e, 'omelette: could not grab the keyboard for hold-to-talk');
        _holdGrab = null;
    }
    // Another grab already owns the keyboard: the release will never reach
    // us, and a hold that cannot end is worse than one that ends at once.
    if (_holdGrab && (_holdGrab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
        Main.popModal(_holdGrab);
        _holdGrab = null;
    }
    if (!_holdGrab) endHold();
}

function endHold() {
    if (!_holding) return;
    _holding = false;
    clearHold();
    stop();
}

function clearHold() {
    if (_holdPollId) GLib.source_remove(_holdPollId);
    _holdPollId = 0;
    _holdMods = 0;
    if (_holdGrab) Main.popModal(_holdGrab);
    _holdGrab = null;
}

// Only reached while the shell itself has keyboard focus: the modifier-less
// hold above, or a hold started with the popup open.
function capturedEvent(_actor, event) {
    if (!_holding || event.type() !== Clutter.EventType.KEY_RELEASE)
        return Clutter.EVENT_PROPAGATE;
    if (_holdMods === 0) endHold();
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

    // The proxy tracks the well-known name, so it keeps working across the
    // service restarting — or starting for the first time after Omelette did,
    // which D-Bus activation does on the first call.
    _proxy = new VoceProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, proxy => {
        setState(proxy.State || 'idle');
    }, error => {
        log(`omelette: Voce service unavailable: ${error.message}`);
    });
    _proxy.set_default_timeout(CALL_TIMEOUT_MS);
    // Connected here rather than in the ready callback: that one is skipped
    // when the first connection attempt fails, and the transcript of every
    // later dictation would then go nowhere.
    _signalIds = [
        _proxy.connectSignal('StatusChanged', (_p, _s, [state]) => setState(state)),
        _proxy.connectSignal('TranscriptReady', (_p, _s, [id, text, language]) => {
            _callbacks?.onTranscript?.({ id, text, language, wmClass: _targetClass });
        }),
        _proxy.connectSignal('Error', (_p, _s, [message]) => showError(message)),
    ];
}

export function markInserted(id, inserted) {
    if (id > 0) call('MarkInsertedRemote', [id, inserted]);
}

export function shutdown() {
    if (_holding && _proxy) call('CancelRemote');
    _holding = false;
    clearHold();
    _startPending = false;
    _stopQueued = false;
    _lastError = null;
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
