// Keeping the session awake, through gnome-session's own inhibitor.
//
//   org.gnome.SessionManager  /org/gnome/SessionManager
//     Inhibit(s app_id, u toplevel_xid, s reason, u flags) -> u cookie
//     Uninhibit(u cookie)
//
// A plain connection.call() rather than a proxy, for the reason filePortal.js
// gives: makeProxyWrapper's synchronous constructor is a problem worth working
// around only when there is a proxy worth having, and two methods is not that.
// Unlike capture.js there is no self-deadlock to avoid either — gnome-session
// is a different process from the one this runs in.
//
// This module imports only GLib and Gio. Nothing from resource:/// and, in
// particular, no Main: notifying the user is the caller's job, handed back
// through onExpire/onError, which is what keeps the pure half loadable by
// linux/tests under plain gjs. pdfRunner.js takes callbacks for the same reason.
//
// == Why the caller owns the state, and this module owns only the cookie ==
//
// There is no way to read our inhibitor back off the bus. GetInhibitors returns
// object paths exposing GetAppId/GetReason/GetFlags and *not* the cookie, so an
// orphaned inhibitor can never be released — and IsInhibited/InhibitedActions
// OR across every client on the session, which on an ordinary desktop is
// already true because a browser is playing a video. Neither can report our
// state.
//
// So: GSettings is the single source of truth, apply() is idempotent, and every
// teardown path must call shutdown(). That is also why the deadline is stored
// as an absolute time rather than a duration — see extension.js.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const BUS_NAME = 'org.gnome.SessionManager';
const OBJECT_PATH = '/org/gnome/SessionManager';
const INTERFACE = 'org.gnome.SessionManager';

// 4 = inhibit suspending, 8 = inhibit the session being marked idle.
//
// Both, not either. Idle alone still lets the machine suspend on the power
// setting; suspend alone still lets the screen blank and lock underneath you.
// "Keep awake" means neither happens.
export const INHIBIT_FLAGS = 4 | 8;

const REASON = 'Keep awake was switched on in Omelette';

// Offered in the command bar and the popup. 0 is first because "until I turn it
// off" is what the toggle means, and the timed variants are the exception.
export const DURATION_CHOICES = [
    { minutes: 0, label: 'Until turned off' },
    { minutes: 15, label: 'For 15 minutes' },
    { minutes: 60, label: 'For 1 hour' },
    { minutes: 120, label: 'For 2 hours' },
];

// --- the pure half --------------------------------------------------------

export function nowSeconds() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

// An absolute unix time, or 0 for indefinite.
//
// Absolute rather than a duration because a duration cannot survive the things
// that routinely interrupt it: locking the screen disables the extension (and
// with it any GLib timer), and GLib timers run on the monotonic clock, which
// does not advance across a suspend. An absolute deadline is still correct
// after any of that, and enable() only has to compare it against the clock.
export function deadlineFor(nowSecs, minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return nowSecs + Math.round(minutes * 60);
}

// Seconds left, or null when there is no deadline at all.
export function remainingSeconds(until, nowSecs) {
    if (!Number.isFinite(until) || until <= 0) return null;
    return Math.max(0, until - nowSecs);
}

export function formatRemaining(seconds) {
    if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

// The subtitle shown wherever the state is displayed.
export function describeAwake({ on, until, now }) {
    if (!on) return 'Off';
    const left = remainingSeconds(until, now);
    if (left === null) return 'On, until you turn it off';
    if (left === 0) return 'Ending now';
    return `On, ${formatRemaining(left)} left`;
}

// --- the D-Bus half -------------------------------------------------------

let _cookie = null;
let _inFlight = false;
let _desired = false;
let _timeoutId = 0;

function clearTimer() {
    if (!_timeoutId) return;
    GLib.source_remove(_timeoutId);
    _timeoutId = 0;
}

function uninhibit() {
    if (_cookie === null) return;
    const cookie = _cookie;
    _cookie = null;
    // Fire and forget, like the Quit path in extension.js: there is nothing
    // useful to do with the reply, and it would land after teardown.
    Gio.DBus.session.call(
        BUS_NAME, OBJECT_PATH, INTERFACE, 'Uninhibit',
        new GLib.Variant('(u)', [cookie]),
        null, Gio.DBusCallFlags.NONE, -1, null, null);
}

function inhibit(appId, onError) {
    if (_inFlight || _cookie !== null) return;
    _inFlight = true;

    Gio.DBus.session.call(
        BUS_NAME, OBJECT_PATH, INTERFACE, 'Inhibit',
        new GLib.Variant('(susu)', [appId, 0, REASON, INHIBIT_FLAGS]),
        new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null,
        (connection, res) => {
            _inFlight = false;
            let cookie;
            try {
                [cookie] = connection.call_finish(res).deepUnpack();
            } catch (e) {
                onError?.(e);
                return;
            }
            _cookie = cookie;
            // The switch may have been turned back off while this call was in
            // flight. Without this the cookie is held forever and, because it
            // cannot be recovered from the bus, there is no way back short of
            // logging out.
            if (!_desired) uninhibit();
        });
}

// Bring the world into line with `{on, until}`. Idempotent: calling it twice
// with the same state does nothing the second time, which is what lets every
// caller — the toggle, the shortcut, a command-bar row, the prefs window —
// simply write GSettings and let one handler reconcile.
//
// `onExpire` fires when a deadline has passed, including a deadline that
// elapsed while the extension was disabled.
export function apply({ on, until = 0, appId }, { onExpire, onError } = {}) {
    clearTimer();

    const now = nowSeconds();
    const left = on ? remainingSeconds(until, now) : null;

    // A deadline in the past: the session was locked, suspended, or the shell
    // was restarted across it.
    if (on && left === 0) {
        _desired = false;
        uninhibit();
        onExpire?.();
        return;
    }

    _desired = !!on;

    if (!_desired) {
        uninhibit();
        return;
    }

    inhibit(appId, onError);

    if (left !== null) {
        _timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, left, () => {
            _timeoutId = 0;
            _desired = false;
            uninhibit();
            onExpire?.();
            return GLib.SOURCE_REMOVE;
        });
    }
}

export function isHeld() {
    return _cookie !== null || (_inFlight && _desired);
}

// Called from the top of both enable() and disable(). Module state outlives an
// extension reload, and an inhibitor that outlives the extension cannot be
// released by anything short of ending the session.
export function shutdown() {
    clearTimer();
    _desired = false;
    _inFlight = false;
    uninhibit();
}
