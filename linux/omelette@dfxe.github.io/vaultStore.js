import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { dataDir } from './dataDir.js';

// Bounded ring buffer of copied items, deduplicated by a content fingerprint,
// persisted as plaintext JSON. Image payloads live as PNG files alongside the
// JSON rather than inline base64: a file reference is lighter and lets St.Icon
// thumbnail straight off disk.
//
// Limits (history size, entry lifetime) come from GSettings so they can be tuned
// in prefs; a null settings object falls back to these defaults.
const DEFAULT_MAX_ITEMS = 200;
const TITLE_MAX = 84;

// How long to sit on changes before writing. Long enough to coalesce a burst of
// copies into one write, short enough that a crash costs almost nothing.
const PERSIST_DEBOUNCE_MS = 400;

const WRITE_FLAGS =
    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;

// SHA-256 over "<kind>\0<bytes>".
// `bytes` must be a Uint8Array.
export function fingerprintFor(kind, bytes) {
    const prefix = new TextEncoder().encode(`${kind}\0`);
    const buf = new Uint8Array(prefix.length + bytes.length);
    buf.set(prefix, 0);
    buf.set(bytes, prefix.length);
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, buf);
}

function nowIso() {
    return GLib.DateTime.new_now_local().format_iso8601();
}

export function collapseText(text) {
    const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
    if (oneLine.length <= TITLE_MAX) return oneLine;
    return `${oneLine.slice(0, TITLE_MAX - 1)}…`;
}

export const VaultStore = GObject.registerClass({
    Signals: { 'changed': {} },
}, class VaultStore extends GObject.Object {
    _init(settings) {
        super._init();
        // We call super._init() with no props, so `settings` is our own param and
        // is never interpreted as a GObject property dictionary.
        this._settings = settings ?? null;
        this._items = [];
        // Non-null after a load that could not parse the vault; see load().
        this.loadFailure = null;
        // Coalesced-write state; see _persist()/flush().
        this._persistId = 0;
        this._dirty = false;
        this._dataDir = dataDir();
        this._imagesDir = GLib.build_filenamev([this._dataDir, 'images']);
        this._vaultPath = GLib.build_filenamev([this._dataDir, 'vault.json']);
    }

    // Pinned items sort ahead of the rest (each group keeps its newest-first
    // order). The UI iterates this directly.
    get items() {
        const pinned = this._items.filter(it => it.pinned);
        const rest = this._items.filter(it => !it.pinned);
        return [...pinned, ...rest];
    }

    get _maxItems() {
        const n = this._settings ? this._settings.get_int('max-items') : DEFAULT_MAX_ITEMS;
        return n > 0 ? n : DEFAULT_MAX_ITEMS;
    }

    _ensureDirs() {
        GLib.mkdir_with_parents(this._imagesDir, 0o700);
    }

    // Move an unreadable vault aside instead of writing over it. The name is
    // timestamped so a second failure can't clobber the first rescue.
    _quarantine() {
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        let dest = GLib.build_filenamev([this._dataDir, `vault.corrupt-${stamp}.json`]);
        for (let n = 1; GLib.file_test(dest, GLib.FileTest.EXISTS); n++)
            dest = GLib.build_filenamev([this._dataDir, `vault.corrupt-${stamp}-${n}.json`]);
        if (GLib.rename(this._vaultPath, dest) !== 0) return null;
        return dest;
    }

    load() {
        this._ensureDirs();
        // Set when the on-disk vault could not be read. While true we refuse to
        // persist, so a parse failure can never overwrite recoverable history.
        this.loadFailure = null;

        if (!GLib.file_test(this._vaultPath, GLib.FileTest.EXISTS)) {
            this._items = [];
            // Still sweep: with no vault at all, every PNG under images/ is by
            // definition unreferenced. Skipping this was leaking the whole
            // directory whenever vault.json went missing on its own.
            this._gcImages();
            this.emit('changed');
            return;
        }
        try {
            const [ok, contents] = GLib.file_get_contents(this._vaultPath);
            if (!ok) throw new Error('vault.json could not be read');
            const parsed = JSON.parse(new TextDecoder().decode(contents));
            if (!Array.isArray(parsed)) throw new Error('vault.json is not an array');
            // Drop image items whose backing file has vanished.
            this._items = parsed.filter(it =>
                it && (it.kind !== 'image' ||
                    (it.imagePath && GLib.file_test(it.imagePath, GLib.FileTest.EXISTS))));
        } catch (e) {
            logError(e, 'omelette: failed to load vault.json');
            this._items = [];
            // Rescue the bytes before anything can persist over them. If even
            // the rename fails, loadFailure still blocks _persist(), so the
            // original file survives untouched.
            this.loadFailure = { archivedTo: this._quarantine() };
            this.emit('changed');
            return;
        }

        // Apply time- and size-based limits that may have changed while we were
        // not running, then write the cleaned list back.
        this._expire();
        this._trim();
        this._gcImages();
        this._persist();
        this.emit('changed');
    }

    // Nothing reconciles images/ against vault.json during normal operation: a
    // crash between the PNG write in add() and the JSON write that follows it
    // strands the file forever. Sweep once per load, when the item list is
    // known-good — never after a failed load, where every image would look
    // orphaned and the quarantined vault still references them.
    _gcImages() {
        if (this.loadFailure) return;
        let dir;
        try {
            dir = GLib.Dir.open(this._imagesDir, 0);
        } catch (_) {
            return; // No images directory yet — nothing to collect.
        }
        const live = new Set(this._items
            .filter(it => it.kind === 'image' && it.imagePath)
            .map(it => it.imagePath));
        let name;
        while ((name = dir.read_name()) !== null) {
            if (!name.endsWith('.png')) continue;
            const path = GLib.build_filenamev([this._imagesDir, name]);
            if (!live.has(path)) GLib.unlink(path);
        }
        dir.close();
    }

    // payload: { kind: 'text'|'image', text?, bytes?(Uint8Array), contentType?, title?, fingerprint? }
    add(payload) {
        const dataBytes = payload.kind === 'text'
            ? new TextEncoder().encode(payload.text ?? '')
            : payload.bytes;
        if (!dataBytes || dataBytes.length === 0) return null;

        const fp = payload.fingerprint ?? fingerprintFor(payload.kind, dataBytes);
        const existingIdx = this._items.findIndex(it => it.fingerprint === fp);

        if (existingIdx >= 0) {
            // Already present — promote to the top instead of duplicating. Keep
            // its pinned flag so re-copying a pin doesn't unpin it.
            const [existing] = this._items.splice(existingIdx, 1);
            existing.createdAt = nowIso();
            this._items.unshift(existing);
            this._persist();
            this.emit('changed');
            return existing;
        }

        let imagePath;
        if (payload.kind === 'image') {
            this._ensureDirs();
            imagePath = GLib.build_filenamev([this._imagesDir, `${fp}.png`]);
            if (!GLib.file_test(imagePath, GLib.FileTest.EXISTS)) {
                try {
                    this._writePrivate(imagePath, dataBytes);
                } catch (e) {
                    logError(e, 'omelette: failed to write image payload');
                    return null;
                }
            }
        }

        const item = {
            id: GLib.uuid_string_random(),
            kind: payload.kind,
            title: payload.title ?? (payload.kind === 'text' ? collapseText(payload.text) : 'Image'),
            createdAt: nowIso(),
            contentType: payload.contentType ?? (payload.kind === 'text' ? 'text/plain' : 'image/png'),
            byteCount: dataBytes.length,
            fingerprint: fp,
            pinned: false,
        };
        if (payload.kind === 'text') item.text = payload.text ?? '';
        else item.imagePath = imagePath;

        this._items.unshift(item);
        this._expire();
        this._trim();
        this._persist();
        this.emit('changed');
        return item;
    }

    togglePin(id) {
        const it = this._items.find(x => x.id === id);
        if (!it) return;
        it.pinned = !it.pinned;
        this._persist();
        this.emit('changed');
    }

    remove(id) {
        const idx = this._items.findIndex(it => it.id === id);
        if (idx < 0) return;
        const [removed] = this._items.splice(idx, 1);
        this._forgetImage(removed);
        this._persist();
        this.emit('changed');
    }

    clear() {
        // Detach the list first, then delete backing files unconditionally —
        // there's nothing left to reference them.
        const doomed = this._items;
        this._items = [];
        for (const it of doomed) {
            if (it.kind === 'image' && it.imagePath &&
                GLib.file_test(it.imagePath, GLib.FileTest.EXISTS))
                GLib.unlink(it.imagePath);
        }
        this._persist();
        this.emit('changed');
    }

    // Re-apply expiry + size limits after a settings change (max-items lowered,
    // entry-ttl-days set). Only emits/persists when something actually changed.
    applyLimits() {
        const expired = this._expire();
        const trimmed = this._trim();
        if (expired || trimmed) {
            this._persist();
            this.emit('changed');
        }
    }

    // Drop unpinned items older than entry-ttl-days. Returns true if any went.
    _expire() {
        const days = this._settings ? this._settings.get_int('entry-ttl-days') : 0;
        if (!days || days <= 0) return false;
        const cutoff = GLib.DateTime.new_now_local().add_days(-days);
        let changed = false;
        for (let i = this._items.length - 1; i >= 0; i--) {
            const it = this._items[i];
            if (it.pinned) continue;
            const created = GLib.DateTime.new_from_iso8601(it.createdAt, null);
            if (created && cutoff.compare(created) > 0) {
                const [dropped] = this._items.splice(i, 1);
                this._forgetImage(dropped);
                changed = true;
            }
        }
        return changed;
    }

    // Enforce the max-items cap, dropping the oldest *unpinned* entries first so
    // pins survive even a shrunk history. Returns true if any went.
    _trim() {
        const max = this._maxItems;
        let changed = false;
        for (let i = this._items.length - 1; i >= 0 && this._items.length > max; i--) {
            if (!this._items[i].pinned) {
                const [dropped] = this._items.splice(i, 1);
                this._forgetImage(dropped);
                changed = true;
            }
        }
        return changed;
    }

    // Delete an item's backing PNG when no surviving item references it.
    _forgetImage(item) {
        if (!item || item.kind !== 'image' || !item.imagePath) return;
        const stillUsed = this._items.some(it => it.imagePath === item.imagePath);
        if (!stillUsed && GLib.file_test(item.imagePath, GLib.FileTest.EXISTS))
            GLib.unlink(item.imagePath);
    }

    // Atomic write that is owner-only from the moment it has content.
    //
    // g_file_set_contents creates its temp file at 0666 & ~umask and does not
    // inherit the target's mode, so a chmod *after* the write means the payload
    // exists at 0644 for the length of the write. G_FILE_CREATE_PRIVATE creates
    // it 0600 up front, and replace_contents still does the temp-file + rename
    // dance, so atomicity is unchanged.
    _writePrivate(path, bytes) {
        Gio.File.new_for_path(path).replace_contents(
            bytes, null, false, WRITE_FLAGS, null);
    }

    // Mark the vault dirty and schedule a write.
    //
    // This used to serialize the whole array and block on file_set_contents,
    // from seven call sites — toggling one pin rewrote the entire history with
    // an fsync, on the compositor thread. Now it coalesces (a burst of copies
    // costs one write) and the write itself is async. disable() calls flush()
    // so nothing queued is lost at shutdown.
    _persist() {
        // The load failed and we could not move the unreadable file aside, so
        // the user's real history is still sitting at _vaultPath. Writing our
        // empty salvage over it is exactly the data loss we're avoiding.
        if (this.loadFailure && !this.loadFailure.archivedTo) return;
        this._dirty = true;
        if (this._persistId) return;
        this._persistId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, PERSIST_DEBOUNCE_MS, () => {
                this._persistId = 0;
                this._writeVault(false);
                return GLib.SOURCE_REMOVE;
            });
    }

    // Write anything outstanding right now, synchronously. Only for shutdown,
    // where a brief block is the correct trade against losing the last copy.
    flush() {
        if (this._persistId) {
            GLib.source_remove(this._persistId);
            this._persistId = 0;
        }
        if (this._dirty) this._writeVault(true);
    }

    _writeVault(sync) {
        this._dirty = false;
        try {
            this._ensureDirs();
            const json = JSON.stringify(this._items, null, 2);
            const bytes = new TextEncoder().encode(json);
            if (sync) {
                this._writePrivate(this._vaultPath, bytes);
                return;
            }
            // replace_contents_bytes_async, not replace_contents_async: the
            // latter does not keep the buffer alive for the duration of the
            // write in GJS. A GBytes is owned by the callee.
            Gio.File.new_for_path(this._vaultPath).replace_contents_bytes_async(
                new GLib.Bytes(bytes), null, false, WRITE_FLAGS, null,
                (file, res) => {
                    try {
                        file.replace_contents_finish(res);
                    } catch (e) {
                        logError(e, 'omelette: failed to persist vault.json');
                    }
                });
        } catch (e) {
            logError(e, 'omelette: failed to persist vault.json');
        }
    }
});
