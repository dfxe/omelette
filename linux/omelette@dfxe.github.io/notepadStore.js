// The notepad: one scratchpad page that survives the popup closing, a shell
// restart and a reboot. Plain text in notepad.txt beside vault.json, written
// owner-only for the same reason the vault is — people paste tokens into
// scratchpads.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { dataDir } from './dataDir.js';

// Typing fires a change per keystroke; coalesce a burst into one write.
const PERSIST_DEBOUNCE_MS = 400;

const WRITE_FLAGS =
    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;

export const NotepadStore = GObject.registerClass({
    Signals: { 'changed': {} },
}, class NotepadStore extends GObject.Object {
    _init(dir = null) {
        super._init();
        this._dir = dir ?? dataDir();
        this._path = GLib.build_filenamev([this._dir, 'notepad.txt']);
        this._text = '';
        this._persistId = 0;
        this._dirty = false;
        // A notepad that could not be read is never written over; see load().
        this._readOnly = false;
    }

    get text() {
        return this._text;
    }

    get path() {
        return this._path;
    }

    load() {
        this._readOnly = false;
        if (!GLib.file_test(this._path, GLib.FileTest.EXISTS)) {
            this._text = '';
            this.emit('changed');
            return;
        }
        try {
            const [ok, contents] = GLib.file_get_contents(this._path);
            if (!ok) throw new Error('notepad.txt could not be read');
            this._text = new TextDecoder().decode(contents);
        } catch (e) {
            logError(e, 'omelette: failed to load notepad.txt');
            this._text = '';
            this._readOnly = true;
        }
        this.emit('changed');
    }

    set(text) {
        const next = text ?? '';
        if (next === this._text) return;
        this._text = next;
        this._persist();
        this.emit('changed');
    }

    // New text goes on its own line at the end, so quick captures from the
    // command bar read top to bottom in the order they were made.
    append(text) {
        const addition = (text ?? '').trim();
        if (addition === '') return false;
        const sep = this._text === '' || this._text.endsWith('\n') ? '' : '\n';
        this.set(`${this._text}${sep}${addition}\n`);
        return true;
    }

    clear() {
        this.set('');
    }

    // Non-blank lines with their index, for the command bar to search.
    lines() {
        const out = [];
        this._text.split('\n').forEach((line, index) => {
            if (line.trim() !== '') out.push({ index, text: line });
        });
        return out;
    }

    _persist() {
        if (this._readOnly) return;
        this._dirty = true;
        if (this._persistId) return;
        this._persistId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, PERSIST_DEBOUNCE_MS, () => {
                this._persistId = 0;
                this._write(false);
                return GLib.SOURCE_REMOVE;
            });
    }

    // Synchronous; for the popup closing and for disable().
    flush() {
        if (this._persistId) {
            GLib.source_remove(this._persistId);
            this._persistId = 0;
        }
        if (this._dirty) this._write(true);
    }

    _write(sync) {
        this._dirty = false;
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            const bytes = new TextEncoder().encode(this._text);
            const file = Gio.File.new_for_path(this._path);
            if (sync) {
                // A stream rather than replace_contents: GJS hands an empty
                // Uint8Array to C as NULL, which replace_contents rejects, and
                // an emptied notepad is a state worth saving.
                const stream = file.replace(null, false, WRITE_FLAGS, null);
                if (bytes.length > 0) stream.write_all(bytes, null);
                stream.close(null);
                return;
            }
            // The _bytes_ variant: GJS does not keep a plain buffer alive for
            // the duration of an async write. See vaultStore.js.
            file.replace_contents_bytes_async(
                new GLib.Bytes(bytes), null, false, WRITE_FLAGS, null,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        logError(e, 'omelette: failed to persist notepad.txt');
                    }
                });
        } catch (e) {
            logError(e, 'omelette: failed to persist notepad.txt');
        }
    }
});
