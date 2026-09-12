// The editor window: a header bar, a tool strip, and the canvas.
//
// Every control here is a toggle in a group rather than a menu or a spin
// button. Annotating is a rapid, repetitive act — pick a colour, drag, pick
// another colour, drag — and anything that costs a second click to open is
// a tax on every stroke.
//
// Adw.ToggleGroup would be the obvious widget for the tool selector and it is
// Adw 1.7; this targets 1.5, so the groups are linked Gtk.ToggleButtons joined
// with set_group(), which is what Adw.ToggleGroup wraps anyway.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';

import { Canvas } from './canvas.js';
import { ARROW, RECT, TEXT, PICK } from './shapes.js';
import { PALETTE, DEFAULT_HEX, parseHex, toHex } from './palette.js';
import { savePng } from './exportImage.js';

const TOOLS = [
    { id: ARROW, icon: 'mail-forward-symbolic', tip: 'Arrow' },
    { id: RECT, icon: 'checkbox-symbolic', tip: 'Box' },
    { id: TEXT, icon: 'insert-text-symbolic', tip: 'Text' },
    { id: PICK, icon: 'color-select-symbolic', tip: 'Pick a colour from the image' },
];

const STROKES = [
    { label: 'S', width: 2 },
    { label: 'M', width: 4 },
    { label: 'L', width: 8 },
];

// Big enough to work in, small enough to open on a laptop. A 4K screenshot
// scales down to fit rather than opening a 3840px window.
const MAX_WIDTH = 1400;
const MAX_HEIGHT = 900;
const CHROME_HEIGHT = 110;
const ZOOM_STEP = Math.SQRT2;

// One provider for the whole process, holding a background rule per palette
// entry. Generated rather than written out by hand so the swatches cannot drift
// from the colours they actually apply.
function installSwatchCss() {
    const rules = PALETTE.map((c, i) =>
        `.omelette-swatch-${i} { background-image: none; background-color: ${c.hex}; }`).join('\n');
    const provider = new Gtk.CssProvider();
    // Every swatch carries an outline, not just the pale ones. Without it the
    // white chip is invisible against a light toolbar — and picking the outline
    // per colour from isLight() would make the row of swatches sit unevenly,
    // since a border only some of them have changes their apparent size.
    provider.load_from_string(`
        .omelette-swatch {
            min-width: 22px;
            min-height: 22px;
            padding: 0;
            border-radius: 6px;
            box-shadow: inset 0 0 0 1px alpha(currentColor, 0.35);
        }
        ${rules}
    `);
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

function linkedBox() {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    box.add_css_class('linked');
    return box;
}

export const EditorWindow = GObject.registerClass(
class EditorWindow extends Adw.ApplicationWindow {
    // `onExport(kind, path)` reports a completed write back to whoever launched
    // us; see main.js for why that is a line on stdout rather than a clipboard
    // write done here.
    _init(app, { pixbuf, sourcePath, outDir, onExport }) {
        const width = Math.min(pixbuf.get_width(), MAX_WIDTH);
        const height = Math.min(pixbuf.get_height(), MAX_HEIGHT) + CHROME_HEIGHT;
        super._init({ application: app, default_width: width, default_height: height });

        this.sourcePath = sourcePath;
        this._outDir = outDir;
        this._onExport = onExport;
        this._settingColour = false;

        this._canvas = new Canvas(pixbuf);
        this._canvas.connect('colour-picked', (_c, hex) => this._onPicked(hex));
        this._canvas.connect('history-changed', () => this._syncActions());

        const toasts = new Adw.ToastOverlay();
        const view = new Adw.ToolbarView();
        view.add_top_bar(this._buildHeader(sourcePath));
        view.add_top_bar(this._buildToolStrip());
        view.set_content(this._canvas);
        toasts.set_child(view);
        this.set_content(toasts);
        this._toasts = toasts;

        this._installShortcuts();
        this._syncActions();

        // The popover is attached with set_parent(), which GTK requires be
        // undone before the parent widget goes away.
        this.connect('close-request', () => {
            this._canvas.releaseTextPopover();
            return false;
        });
    }

    // --- chrome -----------------------------------------------------------

    _buildHeader(sourcePath) {
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: sourcePath ? GLib.path_get_basename(sourcePath) : 'Untitled',
            subtitle: 'Omelette',
        }));

        this._undoBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic', tooltip_text: 'Undo (Ctrl+Z)',
        });
        this._undoBtn.connect('clicked', () => this._canvas.undoLast());
        header.pack_start(this._undoBtn);

        this._redoBtn = new Gtk.Button({
            icon_name: 'edit-redo-symbolic', tooltip_text: 'Redo (Ctrl+Shift+Z)',
        });
        this._redoBtn.connect('clicked', () => this._canvas.redoLast());
        header.pack_start(this._redoBtn);

        const zoomOut = new Gtk.Button({
            icon_name: 'zoom-out-symbolic', tooltip_text: 'Zoom out (Ctrl+-)',
        });
        zoomOut.connect('clicked', () => this._zoomBy(1 / ZOOM_STEP));
        header.pack_start(zoomOut);

        const zoomIn = new Gtk.Button({
            icon_name: 'zoom-in-symbolic', tooltip_text: 'Zoom in (Ctrl++)',
        });
        zoomIn.connect('clicked', () => this._zoomBy(ZOOM_STEP));
        header.pack_start(zoomIn);

        const save = new Gtk.Button({ label: 'Save', tooltip_text: 'Save a copy (Ctrl+S)' });
        save.add_css_class('suggested-action');
        save.connect('clicked', () => this._export('saved'));
        header.pack_end(save);

        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic', tooltip_text: 'Copy to clipboard (Ctrl+C)',
        });
        copy.connect('clicked', () => this._export('copy'));
        header.pack_end(copy);

        return header;
    }

    _buildToolStrip() {
        const strip = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 12,
            margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 6,
        });
        strip.add_css_class('toolbar');

        const tools = linkedBox();
        let first = null;
        for (const tool of TOOLS) {
            const btn = new Gtk.ToggleButton({
                icon_name: tool.icon, tooltip_text: tool.tip,
            });
            if (first) btn.set_group(first);
            else first = btn;
            btn.set_active(tool.id === ARROW);
            btn.connect('toggled', () => {
                if (btn.get_active()) this._canvas.tool = tool.id;
            });
            tools.append(btn);
        }
        strip.append(tools);

        const strokes = linkedBox();
        let firstStroke = null;
        for (const stroke of STROKES) {
            const btn = new Gtk.ToggleButton({
                label: stroke.label, tooltip_text: `${stroke.width}px stroke`,
            });
            if (firstStroke) btn.set_group(firstStroke);
            else firstStroke = btn;
            btn.set_active(stroke.width === this._canvas.strokeWidth);
            btn.connect('toggled', () => {
                if (btn.get_active()) this._canvas.strokeWidth = stroke.width;
            });
            strokes.append(btn);
        }
        strip.append(strokes);

        strip.append(this._buildSwatches());
        return strip;
    }

    _buildSwatches() {
        const box = linkedBox();
        this._swatches = [];

        let first = null;
        PALETTE.forEach((colour, i) => {
            const btn = new Gtk.ToggleButton({ tooltip_text: colour.name });
            btn.add_css_class('omelette-swatch');
            btn.add_css_class(`omelette-swatch-${i}`);
            if (first) btn.set_group(first);
            else first = btn;
            btn.set_active(colour.hex === DEFAULT_HEX);
            btn.connect('toggled', () => {
                if (btn.get_active()) this._setColour(colour.hex, { fromSwatch: true });
            });
            box.append(btn);
            this._swatches.push({ hex: colour.hex, btn });
        });

        this._custom = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({ with_alpha: false }),
            tooltip_text: 'Another colour',
        });
        this._custom.set_rgba(new Gdk.RGBA({ red: 0.88, green: 0.11, blue: 0.14, alpha: 1 }));
        this._custom.connect('notify::rgba', () => {
            // Set programmatically when the eyedropper picks — without this
            // guard that write bounces straight back in as a user choice.
            if (this._settingColour) return;
            const c = this._custom.get_rgba();
            this._setColour(toHex({ r: c.red, g: c.green, b: c.blue }));
        });
        box.append(this._custom);

        return box;
    }

    _installShortcuts() {
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => {
            const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
            const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

            if (ctrl && (keyval === Gdk.KEY_z || keyval === Gdk.KEY_Z)) {
                if (shift) this._canvas.redoLast();
                else this._canvas.undoLast();
                return Gdk.EVENT_STOP;
            }
            if (ctrl && (keyval === Gdk.KEY_y || keyval === Gdk.KEY_Y)) {
                this._canvas.redoLast();
                return Gdk.EVENT_STOP;
            }
            if (ctrl && (keyval === Gdk.KEY_s || keyval === Gdk.KEY_S)) {
                this._export('saved');
                return Gdk.EVENT_STOP;
            }
            if (ctrl && (keyval === Gdk.KEY_c || keyval === Gdk.KEY_C)) {
                this._export('copy');
                return Gdk.EVENT_STOP;
            }
            if (ctrl && (keyval === Gdk.KEY_plus || keyval === Gdk.KEY_equal)) {
                this._zoomBy(ZOOM_STEP);
                return Gdk.EVENT_STOP;
            }
            if (ctrl && keyval === Gdk.KEY_minus) {
                this._zoomBy(1 / ZOOM_STEP);
                return Gdk.EVENT_STOP;
            }
            return Gdk.EVENT_PROPAGATE;
        });
        this.add_controller(keys);
    }

    // --- state ------------------------------------------------------------

    _setColour(hex, { fromSwatch = false } = {}) {
        const colour = parseHex(hex);
        if (!colour) return;
        this._canvas.colour = colour;

        this._settingColour = true;
        try {
            if (!fromSwatch) {
                this._custom.set_rgba(new Gdk.RGBA({
                    red: colour.r, green: colour.g, blue: colour.b, alpha: 1,
                }));
            }
            // A picked colour is usually not in the palette, so clear the
            // swatch selection rather than leave one lit that is no longer
            // the colour being drawn with.
            const match = this._swatches.find(s => s.hex === hex);
            if (match) match.btn.set_active(true);
            else this._swatches.forEach(s => s.btn.set_active(false));
        } finally {
            this._settingColour = false;
        }
    }

    _onPicked(hex) {
        this._setColour(hex);
        this._toast(`Picked ${hex}`);
    }

    _syncActions() {
        this._undoBtn.set_sensitive(this._canvas.canUndo);
        this._redoBtn.set_sensitive(this._canvas.canRedo);
    }

    _zoomBy(factor) {
        this._canvas.zoom *= factor;
    }

    _toast(message) {
        this._toasts.add_toast(new Adw.Toast({ title: message, timeout: 2 }));
    }

    // --- export -----------------------------------------------------------

    // Copy saves too. The bytes have to exist somewhere for the shell to put
    // them on the clipboard, and writing them to the place Save would have used
    // means one code path and no temporary file to clean up.
    _export(kind) {
        let dest;
        try {
            dest = savePng(this._canvas.pixbuf, this._canvas.shapes,
                this._outDir, this.sourcePath);
        } catch (e) {
            this._toast(e.message ?? String(e));
            return;
        }
        this._toast(kind === 'copy'
            ? `Copied · saved to ${GLib.path_get_basename(dest)}`
            : `Saved ${GLib.path_get_basename(dest)}`);
        this._onExport?.(kind, dest);
    }
});

export { installSwatchCss };
