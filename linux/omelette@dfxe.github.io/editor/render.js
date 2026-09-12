// Painting a display list onto a cairo context.
//
// This is the only code that draws annotations, and it is used twice: once per
// frame by the canvas widget, and once at native resolution by the exporter.
// One function rather than two is the whole point — a separate export path is
// how "what you saved" quietly stops being "what you saw", usually at the
// moment a stroke width or a font size is scaled in one place and not the
// other.
//
// Everything here works in *image* coordinates. The canvas sets up a
// translate/scale before calling in, so nothing below needs to know whether it
// is drawing to a 400px preview or a 3840px export.

import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
// Pinned: Gdk has two versions installed and an unqualified import picks one by
// whatever was resolved first, which in a GTK4 process must never be Gdk 3.
import Gdk from 'gi://Gdk?version=4.0';
import cairo from 'cairo';

import { ARROW, RECT, TEXT, normalizeRect, arrowHead, fontSizeFor } from './shapes.js';
import { isLight } from './palette.js';

// How far the text halo extends, as a fraction of the font size. Enough to
// separate a glyph from a busy background, not so much that it reads as an
// outlined font.
const HALO_RATIO = 0.14;

export function drawImage(cr, pixbuf) {
    Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
    cr.paint();
}

function setColor(cr, { r, g, b, a }) {
    cr.setSourceRGBA(r, g, b, a ?? 1);
}

function drawRect(cr, shape) {
    const { x, y, width, height } = normalizeRect(shape);
    // A zero-sized rectangle is a click that never moved. Stroking it leaves a
    // dot, which looks like a bug rather than an annotation.
    if (width === 0 && height === 0) return;

    setColor(cr, shape.color);
    cr.setLineWidth(shape.width);
    cr.setLineJoin(cairo.LineJoin.ROUND);
    cr.rectangle(x, y, width, height);
    cr.stroke();
}

function drawArrow(cr, shape) {
    const head = arrowHead(shape, shape.width);
    if (!head) return;

    setColor(cr, shape.color);
    cr.setLineWidth(shape.width);
    cr.setLineCap(cairo.LineCap.ROUND);
    cr.setLineJoin(cairo.LineJoin.ROUND);

    cr.moveTo(shape.x1, shape.y1);
    cr.lineTo(shape.x2, shape.y2);
    cr.stroke();

    // Filled rather than stroked: a stroked triangle at a heavy line width
    // grows a rounded blob at the tip instead of a point.
    cr.moveTo(shape.x2, shape.y2);
    cr.lineTo(head.left.x, head.left.y);
    cr.lineTo(head.right.x, head.right.y);
    cr.closePath();
    cr.fill();
}

// Absolute size rather than a point size in the font string: points are scaled
// by the surface's notional DPI, which is not a thing an image has. Absolute
// size is in image pixels, which is the unit every other shape here uses.
function layoutFor(cr, shape) {
    const layout = PangoCairo.create_layout(cr);
    const font = Pango.FontDescription.from_string('Sans Bold');
    font.set_absolute_size(fontSizeFor(shape.width) * Pango.SCALE);
    layout.set_font_description(font);
    layout.set_text(shape.text ?? '', -1);
    return layout;
}

function drawText(cr, shape) {
    if (!shape.text) return;

    const layout = layoutFor(cr, shape);
    cr.moveTo(shape.x1, shape.y1);

    // Red text on a red button is unreadable, and asking the user to notice and
    // change colour is asking them to do the tool's job. The halo is the
    // cheapest fix that works on any background: lay the glyphs down as a path,
    // stroke it wide in the opposite tone, then fill it in the chosen colour.
    const halo = fontSizeFor(shape.width) * HALO_RATIO;
    PangoCairo.layout_path(cr, layout);
    const tone = isLight(shape.color) ? 0 : 1;
    cr.setSourceRGBA(tone, tone, tone, 0.85);
    cr.setLineWidth(halo * 2);
    cr.setLineJoin(cairo.LineJoin.ROUND);
    cr.strokePreserve();
    setColor(cr, shape.color);
    cr.fill();
}

export function drawShape(cr, shape) {
    // save/restore per shape so one shape's line width or cap cannot leak into
    // the next. Cheap, and the alternative is a class of bug that only appears
    // once two particular tools are used in a particular order.
    cr.save();
    try {
        if (shape.type === RECT) drawRect(cr, shape);
        else if (shape.type === ARROW) drawArrow(cr, shape);
        else if (shape.type === TEXT) drawText(cr, shape);
    } finally {
        cr.restore();
    }
}

export function drawAll(cr, shapes) {
    for (const shape of shapes) drawShape(cr, shape);
}

// The rendered size of a text shape, for placing the editing popover over the
// text it is editing. Needs a context because Pango measures against one.
export function textSize(cr, shape) {
    const [width, height] = layoutFor(cr, shape).get_pixel_size();
    return { width, height };
}
