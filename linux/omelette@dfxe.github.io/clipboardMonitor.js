import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { fingerprintFor, collapseText } from './vaultStore.js';

// The compositor's Meta.Selection emits 'owner-changed' whenever clipboard
// ownership flips, so we listen for that (debounced) and read the content on
// demand instead of polling on a timer.
const DEBOUNCE_MS = 150;
const IGNORE_CAP = 256;

// Cross-desktop hints that a password manager / secret tooling put a transient
// secret on the clipboard; we must never persist those. The KDE hint
// ("x-kde-passwordManagerHint") already matches via the substring below.
const SENSITIVE_HINTS = [
    'passwordmanagerhint',
    'x-kde-passwordmanagerhint',
    'org.freedesktop.secrets',
    'concealed',
];

function isSensitive(mimetypes) {
    return mimetypes.some(m => {
        const l = m.toLowerCase();
        return SENSITIVE_HINTS.some(h => l.includes(h));
    });
}

export const ClipboardMonitor = GObject.registerClass({
    Signals: { 'captured': { param_types: [GObject.TYPE_JSOBJECT] } },
}, class ClipboardMonitor extends GObject.Object {
    _init(settings) {
        super._init();
        // super._init() takes no props, so `settings` stays our own param.
        this._settings = settings ?? null;
        this._selection = null;
        this._ownerChangedId = 0;
        this._debounceId = 0;
        // Fingerprints of content this extension itself just placed on the
        // clipboard (re-copy / capture), so our own writes don't bounce back in
        // as new history.
        this._ignored = new Set();
    }

    start() {
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_sel, type, _source) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._scheduleRead();
            });
    }

    stop() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._selection && this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        this._selection = null;
        this._ignored.clear();
    }

    ignore(fingerprint) {
        if (!fingerprint) return;
        this._ignored.add(fingerprint);
        // Bound the set; drop the oldest insertions if it grows too large.
        if (this._ignored.size > IGNORE_CAP) {
            const excess = this._ignored.size - IGNORE_CAP;
            const it = this._ignored.values();
            for (let i = 0; i < excess; i++) this._ignored.delete(it.next().value);
        }
    }

    _paused() {
        return this._settings ? this._settings.get_boolean('paused') : false;
    }

    _scheduleRead() {
        if (this._debounceId) GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._read();
            return GLib.SOURCE_REMOVE;
        });
    }

    _read() {
        // Incognito: don't even look at the clipboard while paused.
        if (this._paused()) return;

        const clipboard = St.Clipboard.get_default();
        // Cheap bail before we bother reading anything.
        if (isSensitive(clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [])) return;

        const storeImages = this._settings ? this._settings.get_boolean('store-images') : true;

        // Prefer text, fall back to a PNG image.
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clip, text) => {
            // Ownership can flip between the check above and this callback: the
            // content we were handed may belong to a *different* owner than the
            // one we vetted. Re-read the types and judge them against the
            // content we actually got, or a password manager that grabs the
            // clipboard mid-read gets its secret persisted.
            const mimetypes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
            if (isSensitive(mimetypes)) return;

            if (text && text.trim().length > 0) {
                this._ingestText(text);
            } else if (storeImages && mimetypes.includes('image/png')) {
                clipboard.get_content(St.ClipboardType.CLIPBOARD, 'image/png',
                    (_c, glibBytes) => {
                        if (isSensitive(clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? []))
                            return;
                        const data = glibBytes?.get_data();
                        if (data && data.length > 0) this._ingestImage(data);
                    });
            }
        });
    }

    _ingestText(text) {
        const bytes = new TextEncoder().encode(text);
        const fp = fingerprintFor('text', bytes);
        // Consuming, not a peek: the entry exists to swallow exactly one bounce
        // of our own write. Leaving it in the set means the user copying that
        // same text by hand later is silently dropped from history.
        if (this._ignored.delete(fp)) return;
        this.emit('captured', {
            kind: 'text',
            text,
            contentType: 'text/plain',
            byteCount: bytes.length,
            fingerprint: fp,
            title: collapseText(text),
        });
    }

    _ingestImage(data) {
        // Passive clipboard images respect the size cap; explicit Area/Screen
        // captures go through a different path and are never dropped here.
        const cap = this._settings ? this._settings.get_int('max-image-bytes') : 0;
        if (cap > 0 && data.length > cap) return;

        const fp = fingerprintFor('image', data);
        if (this._ignored.delete(fp)) return;
        this.emit('captured', {
            kind: 'image',
            bytes: data,
            contentType: 'image/png',
            byteCount: data.length,
            fingerprint: fp,
            title: 'Image',
        });
    }
});
