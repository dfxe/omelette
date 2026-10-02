// The panel the Notepad chip opens into: one multi-line page that saves as you
// type. A UI module, like pdfPanel.js, so it may import St.
//
// Holds focus the way the PDF panel does, which is what lets Enter insert a
// newline instead of activating a row, and what stops background refreshes from
// destroying the page mid-sentence. See _panelHold in extension.js.

import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

const CLEAR_CONFIRM_MS = 2500;

function countLabel(text) {
    const chars = [...text].length;
    if (chars === 0) return 'Empty page';
    const lines = text.split('\n').filter(l => l.trim() !== '').length;
    return `${lines === 1 ? '1 line' : `${lines} lines`} · ${chars === 1 ? '1 char' : `${chars} chars`}`;
}

// -> { actor, holdsFocus, focus, onEscape }
//
// `store` is the NotepadStore; `handlers.onCopyAll(text)` puts the page on the
// clipboard. The panel keeps no copy of the text — the store is the one place
// it lives, so a rebuild picks up exactly where the last keystroke left it.
export function buildNotepadPanel(store, handlers) {
    const panel = new St.BoxLayout({
        vertical: true,
        style_class: 'cb-panel cb-notepad',
        x_expand: true,
    });

    // The sheet carries the paper look and the minimum height, not the entry:
    // St.Entry centres its text vertically, so a tall entry would start a
    // short note halfway down the page.
    const sheet = new St.BoxLayout({
        vertical: true,
        style_class: 'cb-notepad-sheet',
        x_expand: true,
        reactive: true,
    });
    const scroll = new St.ScrollView({
        style_class: 'cb-notepad-scroll',
        overlay_scrollbars: true,
        x_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
    });
    const page = new St.BoxLayout({ vertical: true, x_expand: true });

    const entry = new St.Entry({
        style_class: 'cb-notepad-entry',
        hint_text: 'Jot anything down. It stays here until you clear it.',
        can_focus: true,
        x_expand: true,
    });
    const text = entry.clutter_text;
    text.single_line_mode = false;
    text.activatable = false;
    text.line_wrap = true;
    text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    entry.set_text(store.text);
    page.add_child(entry);

    if (typeof scroll.set_child === 'function') scroll.set_child(page);
    else scroll.add_actor(page);
    sheet.add_child(scroll);
    panel.add_child(sheet);

    // Clicking the blank paper under the text should put the caret at the end,
    // the way it would in any editor.
    sheet.connect('button-press-event', () => {
        text.grab_key_focus();
        text.set_cursor_position(-1);
        text.set_selection_bound(-1);
        return Clutter.EVENT_STOP;
    });
    text.connect('key-focus-in', () => sheet.add_style_class_name('cb-notepad-focused'));
    text.connect('key-focus-out', () => sheet.remove_style_class_name('cb-notepad-focused'));

    const footer = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'cb-notepad-footer' });
    const status = new St.Label({
        text: countLabel(store.text),
        style_class: 'cb-notepad-status',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    footer.add_child(status);

    const copy = new St.Button({
        label: 'Copy all',
        can_focus: true,
        style_class: 'cb-chip button',
    });
    copy.connect('clicked', () => {
        if (store.text.trim() === '') return;
        handlers.onCopyAll(store.text);
    });
    footer.add_child(copy);

    // Two clicks, because there is no undo and the whole point of the page is
    // that it is still there next time.
    const clear = new St.Button({
        label: 'Clear',
        can_focus: true,
        style_class: 'cb-chip button',
    });
    let confirmId = 0;
    const disarm = () => {
        if (confirmId) {
            GLib.source_remove(confirmId);
            confirmId = 0;
        }
        clear.label = 'Clear';
        clear.remove_style_class_name('cb-chip-danger');
    };
    clear.connect('clicked', () => {
        if (!confirmId) {
            if (store.text === '') return;
            clear.label = 'Really clear?';
            clear.add_style_class_name('cb-chip-danger');
            confirmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLEAR_CONFIRM_MS, () => {
                confirmId = 0;
                disarm();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        disarm();
        entry.set_text('');
        entry.grab_key_focus();
    });
    clear.connect('destroy', () => {
        if (confirmId) GLib.source_remove(confirmId);
        confirmId = 0;
    });
    footer.add_child(clear);
    panel.add_child(footer);

    text.connect('text-changed', () => {
        const value = entry.get_text();
        store.set(value);
        status.text = countLabel(value);
    });

    // A multi-line entry inside a scroll view does not scroll itself; follow
    // the caret so typing past the bottom edge stays visible.
    text.connect('cursor-changed', () => {
        const adj = scroll.vadjustment ?? scroll.vscroll?.adjustment;
        if (!adj) return;
        const [ok, , y, lineHeight] = text.position_to_coords(text.cursor_position);
        if (!ok) return;
        const { value, pageSize } = adj;
        if (y < value) adj.set_value(y);
        else if (y + lineHeight > value + pageSize) adj.set_value(y + lineHeight - pageSize);
    });

    const grab = target => {
        if (target.mapped) {
            target.grab_key_focus();
            return;
        }
        const id = target.connect('notify::mapped', () => {
            if (!target.mapped) return;
            target.disconnect(id);
            target.grab_key_focus();
        });
    };

    return {
        actor: panel,
        holdsFocus: true,
        focus() {
            grab(text);
            // Land at the end, where the next thought goes.
            text.set_cursor_position(-1);
            text.set_selection_bound(-1);
        },
        // Escape always leaves the page rather than clearing it; the text is
        // already saved.
        onEscape() {
            disarm();
            return false;
        },
    };
}
