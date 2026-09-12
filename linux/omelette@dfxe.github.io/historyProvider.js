// The two original lists — clipboard history and the screenshots folder —
// expressed as command-bar providers. Behaviour is unchanged from when they were
// hardcoded in Indicator.refresh(); they just go through the same ranking and
// row-building path as the tools now.

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { collapseText } from './vaultStore.js';
import { formatBytes, relativeAge, HEX_RE } from './format.js';
import { copyPngFile, copyPathText } from './clipboardUtil.js';
import { score, scoreAnyPre, normalize, byScore, NO_MATCH } from './match.js';

function vaultVisual(it) {
    if (it.kind === 'image' && it.imagePath)
        return { kind: 'gicon', path: it.imagePath, size: 64 };
    // Same 32px footprint as the icon it replaces, so rows keep their rhythm.
    if (it.kind === 'text' && HEX_RE.test((it.text ?? '').trim()))
        return { kind: 'swatch', color: it.text.trim() };
    return {
        kind: 'icon',
        name: it.kind === 'text' ? 'text-x-generic-symbolic' : 'image-x-generic-symbolic',
        size: 32,
    };
}

// Put the item back on the clipboard. Text is synchronous, so the paste can be
// requested straight away; an image has to wait for the file read or Ctrl+V
// would fire against whatever was on the clipboard before.
function recopy(it, ctx) {
    ctx.monitor?.ignore(it.fingerprint);
    const clipboard = St.Clipboard.get_default();

    if (it.kind === 'text') {
        clipboard.set_text(St.ClipboardType.CLIPBOARD, it.text ?? '');
        ctx.requestPaste?.();
        return;
    }

    if (!it.imagePath) return;
    Gio.File.new_for_path(it.imagePath).load_contents_async(null, (file, res) => {
        let ok, bytes;
        try { [ok, bytes] = file.load_contents_finish(res); }
        catch (_) { ok = false; }
        if (!ok) {
            Main.notifyError('Omelette', 'Image is no longer available');
            return;
        }
        clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
        ctx.requestPaste?.();
    });
}

function vaultResult(it, matchScore, index) {
    const isText = it.kind === 'text';
    const title = isText
        ? (collapseText(it.title || it.text) || 'Text')
        : (it.title || 'Image');

    const actions = [{
        icon: it.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
        styleClass: it.pinned ? 'cb-pinned' : '',
        run: ctx => { ctx.vault?.togglePin(it.id); return null; },
    }];

    // Turning something you already copied into a snippet is how most snippets
    // will actually get made — going to the preferences window first is a step
    // nobody takes.
    if (isText && it.text) {
        actions.push({
            icon: 'insert-text-symbolic',
            styleClass: '',
            run: ctx => ctx.saveSnippet?.(it.text) ?? null,
        });
    }

    if (!isText && it.imagePath) {
        actions.push({
            icon: 'document-edit-symbolic',
            styleClass: '',
            // Returns null rather than a message: openEditor closes the popup
            // itself (a row *action* cannot — the handler in _makeResultRow
            // only acts on `outcome.message`), and a flash on a row that is
            // disappearing only ever half-plays.
            run: ctx => { ctx.openEditor?.(it.imagePath); return null; },
        });

        actions.push({
            icon: 'insert-link-symbolic',
            styleClass: '',
            run: ctx => {
                copyPathText(it.imagePath, ctx.monitor);
                return { message: 'Copied file path' };
            },
        });
    }

    actions.push({
        icon: 'user-trash-symbolic',
        styleClass: '',
        run: ctx => { ctx.vault?.remove(it.id); return null; },
    });

    return {
        id: `history:${it.id}`,
        score: matchScore,
        tiebreak: it.pinned ? 1 : 0,
        index,
        title,
        subtitle: `${isText ? 'Text' : 'Image'} · ${formatBytes(it.byteCount)} · ${relativeAge(it.createdAt)}`,
        visual: vaultVisual(it),
        // Light-touch preview: the full (single-line) text is reachable via the
        // accessible name even though the visible label is ellipsized.
        accessibleText: isText ? it.text : undefined,
        actions,
        item: it,
        run: ctx => {
            recopy(it, ctx);
            return { message: isText ? 'Copied text' : 'Copied image', close: true };
        },
    };
}

// Normalized copies of the two searchable fields, cached on the item itself.
//
// Without this, every keystroke re-lowercased and re-regexed the *full body* of
// every history entry — with the default 200-item cap and multi-KB entries that
// is megabytes of string churn per keystroke, on the compositor thread.
//
// A Symbol key deliberately: JSON.stringify ignores symbol-keyed properties, so
// the cache never reaches vault.json and cannot double the file size. Title and
// text are immutable once an item exists (re-copying reuses the same object), so
// the cache never goes stale.
const FIELDS = Symbol('normalized search fields');

function searchFields(it) {
    let cached = it[FIELDS];
    if (cached === undefined) {
        cached = [normalize(it.title ?? ''), normalize(it.text ?? '')];
        it[FIELDS] = cached;
    }
    return cached;
}

export const historyProvider = {
    id: 'history',
    title: 'Things you copied',
    cap: 25,

    search(query, ctx) {
        const all = ctx.vault ? ctx.vault.items : [];
        // Browsing: keep the store's own pinned-first, newest-first order rather
        // than re-sorting everything to the same score.
        if (query === '') return all.map((it, i) => vaultResult(it, 0, i));

        const q = normalize(query);
        const scored = [];
        all.forEach((it, i) => {
            const s = scoreAnyPre(q, searchFields(it));
            if (s !== NO_MATCH) scored.push(vaultResult(it, s, i));
        });
        return scored.sort(byScore);
    },

    emptyMessage(ctx) {
        const all = ctx.vault ? ctx.vault.items : [];
        return all.length === 0
            ? 'Nothing pinned up yet. Copy anything and it lands here.'
            : null;
    },
};

export const screenshotProvider = {
    id: 'screenshot',
    title: 'Screenshots',
    cap: 10,

    search(query, ctx) {
        const all = ctx.screenshots ? ctx.screenshots.entries : [];

        const make = (path, matchScore, index) => ({
            id: `shot:${path}`,
            score: matchScore,
            index,
            title: GLib.path_get_basename(path),
            subtitle: 'Click to copy image',
            visual: { kind: 'gicon', path, size: 64 },
            actions: [{
                icon: 'document-edit-symbolic',
                styleClass: '',
                // See vaultResult above for why this returns null.
                run: ctx2 => { ctx2.openEditor?.(path); return null; },
            }, {
                icon: 'insert-link-symbolic',
                styleClass: '',
                run: ctx2 => {
                    copyPathText(path, ctx2.monitor);
                    return { message: 'Copied file path' };
                },
            }],
            run: ctx2 => {
                copyPngFile(path, ctx2.monitor, () => ctx2.requestPaste?.());
                return { message: 'Copied image', close: true };
            },
        });

        if (query === '') return all.map((p, i) => make(p, 0, i));

        const scored = [];
        all.forEach((path, i) => {
            const s = score(query, GLib.path_get_basename(path));
            if (s !== NO_MATCH) scored.push(make(path, s, i));
        });
        return scored.sort(byScore);
    },

    emptyMessage(ctx) {
        const all = ctx.screenshots ? ctx.screenshots.entries : [];
        return all.length === 0
            ? 'No shots yet. Press PrtScn and one turns up here.'
            : null;
    },
};
