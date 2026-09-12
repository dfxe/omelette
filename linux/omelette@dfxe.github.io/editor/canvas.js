// The drawing surface.
//
// One Gtk.GestureDrag drives every tool, including the two that are really
// clicks. Adding a Gtk.GestureClick alongside it looks tidier and is a trap:
// the two gestures then compete for the same button press through GTK's
// conflict resolution, and which one wins depends on claim order and how far
// the pointer happened to move. A click is a zero-length drag, so treating it
// as one keeps the whole interaction in a single state machine.
//
// The widget is a scaled, centred view onto the image. Every coordinate that
// leaves this file is in *image* space — see shapes.js for why that separation
// is worth being strict about.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

import {
    ARROW, RECT, TEXT, PICK,
    viewTransform, toImage, toView, clampToImage, createHistory,
    addShape, undo, redo, canUndo, canRedo, isDirty,
} from './shapes.js';
import { drawImage, drawAll, drawShape } from './render.js';
import { pixelHex, parseHex, DEFAULT_HEX } from './palette.js';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const SCROLL_ZOOM_RATE = 1.1;

export const Canvas = GObject.registerClass({
    Signals: {
        // The eyedropper found a colour. Carries '#rrggbb'.
        'colour-picked': { param_types: [GObject.TYPE_STRING] },
        // The display list changed — undo sensitivity and the dirty flag.
        'history-changed': {},
    },
}, class Canvas extends Gtk.DrawingArea {
    _init(pixbuf) {
        super._init({ hexpand: true, vexpand: true, can_focus: true });

        this._pixbuf = pixbuf;
        this._history = createHistory();
        this._draft = null;

        this.tool = ARROW;
        this.colour = parseHex(DEFAULT_HEX);
        this.strokeWidth = 4;
        this._zoom = 1;

        // get_pixels() materialises a fresh Uint8Array view every call, so the
        // eyedropper would otherwise copy the whole image on each click.
        this._pixels = pixbuf.get_pixels();
        this._rowstride = pixbuf.get_rowstride();
        this._channels = pixbuf.get_n_channels();

        this.set_draw_func((_area, cr, width, height) => this._draw(cr, width, height));

        const drag = new Gtk.GestureDrag();
        drag.connect('drag-begin', (_g, x, y) => this._onDragBegin(x, y));
        drag.connect('drag-update', (_g, dx, dy) => this._onDragUpdate(dx, dy));
        drag.connect('drag-end', (_g, dx, dy) => this._onDragEnd(dx, dy));
        this.add_controller(drag);

        const scroll = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.VERTICAL,
        });
        scroll.connect('scroll', (_controller, _dx, dy) => {
            if (dy === 0) return Gdk.EVENT_PROPAGATE;
            this.zoom *= Math.pow(SCROLL_ZOOM_RATE, -dy);
            return Gdk.EVENT_STOP;
        });
        this.add_controller(scroll);

        this._buildTextPopover();
    }

    // --- geometry ---------------------------------------------------------

    get pixbuf() { return this._pixbuf; }
    get imageWidth() { return this._pixbuf.get_width(); }
    get imageHeight() { return this._pixbuf.get_height(); }
    get shapes() { return this._history.shapes; }
    get dirty() { return isDirty(this._history); }
    get canUndo() { return canUndo(this._history); }
    get canRedo() { return canRedo(this._history); }
    get zoom() { return this._zoom; }
    set zoom(value) {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
        if (zoom === this._zoom) return;
        this._zoom = zoom;
        this.queue_draw();
    }

    _transform() {
        return viewTransform(this.imageWidth, this.imageHeight,
            this.get_width(), this.get_height(), this._zoom);
    }

    // Widget point -> a point guaranteed to be inside the image.
    _imagePoint(x, y) {
        return clampToImage(toImage({ x, y }, this._transform()),
            this.imageWidth, this.imageHeight);
    }

    // --- drawing ----------------------------------------------------------

    _draw(cr, width, height) {
        const t = viewTransform(this.imageWidth, this.imageHeight, width, height, this._zoom);

        cr.save();
        cr.translate(t.offsetX, t.offsetY);
        cr.scale(t.scale, t.scale);
        drawImage(cr, this._pixbuf);
        drawAll(cr, this._history.shapes);
        // The in-progress shape is drawn but not committed, so abandoning a
        // drag leaves nothing behind.
        if (this._draft) drawShape(cr, this._draft);
        cr.restore();

        // GJS will not collect the context handed to a draw func on its own;
        // without this the surface's backing store is kept alive every frame.
        cr.$dispose();
    }

    // --- input ------------------------------------------------------------

    _onDragBegin(x, y) {
        this._origin = this._imagePoint(x, y);
        this._originView = { x, y };

        if (this.tool === PICK) {
            this._pick(this._origin);
            return;
        }
        if (this.tool === TEXT) {
            this._openTextPopover(x, y);
            return;
        }

        this._draft = {
            type: this.tool === RECT ? RECT : ARROW,
            x1: this._origin.x, y1: this._origin.y,
            x2: this._origin.x, y2: this._origin.y,
            color: this.colour,
            width: this.strokeWidth,
        };
    }

    _onDragUpdate(dx, dy) {
        if (!this._draft) return;
        const end = this._imagePoint(this._originView.x + dx, this._originView.y + dy);
        this._draft.x2 = end.x;
        this._draft.y2 = end.y;
        this.queue_draw();
    }

    _onDragEnd(dx, dy) {
        if (!this._draft) return;
        this._onDragUpdate(dx, dy);

        const shape = this._draft;
        this._draft = null;

        // A click with the arrow or box tool selected is not an annotation.
        // Committing it would leave an invisible entry that still costs an undo
        // press to clear.
        if (shape.x1 === shape.x2 && shape.y1 === shape.y2) {
            this.queue_draw();
            return;
        }

        this._commit(shape);
    }

    _pick(point) {
        const hex = pixelHex(this._pixels, this._rowstride, this._channels,
            Math.round(point.x), Math.round(point.y));
        if (!hex) return;
        this.colour = parseHex(hex);
        this.emit('colour-picked', hex);
    }

    _commit(shape) {
        addShape(this._history, shape);
        this.queue_draw();
        this.emit('history-changed');
    }

    // --- text -------------------------------------------------------------

    // A popover rather than an overlaid entry: it arrives at the click, takes
    // focus, commits on Enter and dismisses on Escape, all of which an entry
    // floating in a Gtk.Fixed would have to reimplement — along with mirroring
    // the canvas scale into its own font size.
    _buildTextPopover() {
        this._entry = new Gtk.Entry({
            placeholder_text: 'Type, then press Enter',
            activates_default: false,
            width_chars: 18,
        });
        this._entry.connect('activate', () => this._commitText());

        this._popover = new Gtk.Popover({ autohide: true, has_arrow: true });
        this._popover.set_child(this._entry);
        this._popover.set_parent(this);
        // Closing without Enter discards. Committing on click-away would drop
        // stray text into the image every time the popover lost focus.
        this._popover.connect('closed', () => { this._entry.set_text(''); });
    }

    _openTextPopover(viewX, viewY) {
        this._textAnchor = this._origin;
        this._popover.set_pointing_to(
            new Gdk.Rectangle({ x: Math.round(viewX), y: Math.round(viewY), width: 1, height: 1 }));
        this._entry.set_text('');
        this._popover.popup();
        this._entry.grab_focus();
    }

    _commitText() {
        const text = this._entry.get_text();
        this._popover.popdown();
        if (!text) return;

        this._commit({
            type: TEXT,
            x1: this._textAnchor.x, y1: this._textAnchor.y,
            x2: this._textAnchor.x, y2: this._textAnchor.y,
            color: this.colour,
            width: this.strokeWidth,
            text,
        });
    }

    // --- history ----------------------------------------------------------

    undoLast() {
        if (!undo(this._history)) return;
        this.queue_draw();
        this.emit('history-changed');
    }

    redoLast() {
        if (!redo(this._history)) return;
        this.queue_draw();
        this.emit('history-changed');
    }

    // A popover attached with set_parent() must be unparented before its parent
    // goes away, or GTK warns and leaks the popover's own surface.
    releaseTextPopover() {
        this._popover?.unparent();
        this._popover = null;
    }

    // Where the image sits inside the widget, for callers that need to place
    // something over it.
    viewPointFor(imagePoint) {
        return toView(imagePoint, this._transform());
    }
});
