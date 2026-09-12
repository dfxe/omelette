// The geometry behind omelette-edit. None of this needs a display, which is the
// point of keeping it in its own module: the view transform and the arrow trig
// are the two places a mistake shows up as annotations landing somewhere other
// than where they were drawn, and that is expensive to notice by eye and cheap
// to notice here.

import {
    normalizeRect, arrowHead, headSizeFor, viewTransform, toImage, toView,
    clampToImage, clampWidth, fontSizeFor,
    createHistory, addShape, undo, redo, canUndo, canRedo, isDirty,
} from '../omelette@dfxe.github.io/editor/shapes.js';
import { suite, it, eq, ok } from './harness.js';

suite('editShapes');

const near = (actual, expected, tol, label) =>
    ok(Math.abs(actual - expected) < tol, `${label ?? ''} expected ~${expected}, got ${actual}`);

// --- normalizeRect --------------------------------------------------------

it('orders a rectangle dragged from any corner', () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 };
    eq(normalizeRect({ x1: 10, y1: 20, x2: 40, y2: 60 }), expected, 'down-right');
    eq(normalizeRect({ x1: 40, y1: 60, x2: 10, y2: 20 }), expected, 'up-left');
    eq(normalizeRect({ x1: 40, y1: 20, x2: 10, y2: 60 }), expected, 'down-left');
    eq(normalizeRect({ x1: 10, y1: 60, x2: 40, y2: 20 }), expected, 'up-right');
});

it('gives a click that never moved a zero-sized rectangle rather than a negative one', () => {
    eq(normalizeRect({ x1: 5, y1: 5, x2: 5, y2: 5 }),
        { x: 5, y: 5, width: 0, height: 0 });
});

// --- arrowHead ------------------------------------------------------------

// The barbs sit behind the tip, symmetrically about the shaft. Checking the
// midpoint of the two barbs lands on the shaft is a stronger assertion than
// checking either barb alone, because it fails if the spread is applied
// asymmetrically.
it('puts the barbs symmetrically behind the tip', () => {
    const head = arrowHead({ x1: 0, y1: 0, x2: 100, y2: 0 }, 4);
    near((head.left.y + head.right.y) / 2, 0, 1e-9, 'barb midpoint y');
    ok(head.left.x < 100 && head.right.x < 100, 'barbs sit behind the tip');
    near(head.left.y, -head.right.y, 1e-9, 'barbs mirror each other');
});

it('rotates the head with the shaft rather than keeping it axis-aligned', () => {
    const flat = arrowHead({ x1: 0, y1: 0, x2: 100, y2: 0 }, 4);
    const steep = arrowHead({ x1: 0, y1: 0, x2: 0, y2: 100 }, 4);
    ok(steep.left.y < 100 && steep.right.y < 100, 'barbs trail a downward arrow');
    ok(Math.abs(steep.left.x) > 1, 'a vertical arrow spreads horizontally');
    ok(Math.abs(flat.left.x - steep.left.x) > 1, 'the two headings differ');
});

// atan2(0, 0) is 0 rather than an error, so without the guard a click that
// never moved draws a barb pair pointing due east out of nowhere.
it('refuses a zero-length arrow rather than pointing it due east', () => {
    eq(arrowHead({ x1: 7, y1: 7, x2: 7, y2: 7 }, 4), null);
});

it('scales the head with the stroke but never below a legible minimum', () => {
    eq(headSizeFor(1), 9, 'hairline still gets a visible head');
    ok(headSizeFor(20) > headSizeFor(4), 'heavier stroke, bigger head');
});

// --- viewTransform --------------------------------------------------------

it('fits a wide image by width and centres the leftover height', () => {
    const t = viewTransform(1000, 500, 500, 500);
    eq(t.scale, 0.5);
    eq(t.offsetX, 0);
    eq(t.offsetY, 125, 'letterboxed top and bottom');
});

it('fits a tall image by height and centres the leftover width', () => {
    const t = viewTransform(500, 1000, 500, 500);
    eq(t.scale, 0.5);
    eq(t.offsetX, 125);
    eq(t.offsetY, 0);
});

// Upscaling would make the annotations look sharp while the thing being
// annotated turned to mush, and picking a colour off a stretched pixel invites
// an off-by-one nobody can see on screen.
it('centres a small image at 1:1 rather than blowing it up to fill the view', () => {
    const t = viewTransform(100, 100, 900, 500);
    eq(t.scale, 1);
    eq(t.offsetX, 400);
    eq(t.offsetY, 200);
});

it('applies user zoom after fitting while keeping the image centred', () => {
    const t = viewTransform(1000, 500, 500, 500, 2);
    eq(t.scale, 1);
    eq(t.offsetX, -250);
    eq(t.offsetY, 0);
});

// The first draw can arrive before the widget has been allocated.
it('answers an unallocated view with the identity rather than NaN', () => {
    for (const t of [viewTransform(0, 0, 0, 0), viewTransform(100, 100, 0, 500)]) {
        eq(t.scale, 1);
        eq(t.offsetX, 0);
        eq(t.offsetY, 0);
    }
});

it('round-trips a point through the view and back to the image', () => {
    const t = viewTransform(1000, 500, 500, 500);
    const point = { x: 640, y: 130 };
    const back = toImage(toView(point, t), t);
    near(back.x, point.x, 1e-9, 'x');
    near(back.y, point.y, 1e-9, 'y');
});

// The centring offset is the part that is easy to drop, and dropping it shifts
// every annotation by half the letterbox — so pin the corners explicitly.
it('maps the image origin to the top-left of the drawn area, not of the widget', () => {
    const t = viewTransform(500, 1000, 500, 500);
    eq(toView({ x: 0, y: 0 }, t), { x: 125, y: 0 });
    eq(toImage({ x: 125, y: 0 }, t), { x: 0, y: 0 });
});

// --- clampToImage ---------------------------------------------------------

// width-1, not width: this addresses a pixel, and a point at exactly `width` is
// one past the end of the row — which is where the eyedropper would read
// whatever bytes follow the buffer.
it('clamps to the last addressable pixel rather than one past the end', () => {
    eq(clampToImage({ x: 999, y: 999 }, 100, 50), { x: 99, y: 49 });
    eq(clampToImage({ x: -20, y: -1 }, 100, 50), { x: 0, y: 0 });
    eq(clampToImage({ x: 40, y: 20 }, 100, 50), { x: 40, y: 20 }, 'interior is untouched');
});

it('survives a zero-sized image rather than clamping to -1', () => {
    eq(clampToImage({ x: 5, y: 5 }, 0, 0), { x: 0, y: 0 });
});

// --- widths ---------------------------------------------------------------

it('clamps a nonsense stroke width instead of passing it to cairo', () => {
    eq(clampWidth(0), 1);
    eq(clampWidth(1000), 24);
    eq(clampWidth(NaN), 1);
    eq(clampWidth(3.4), 3, 'rounded, so cairo never sees a fractional width');
});

it('keeps text legible at the thinnest stroke', () => {
    ok(fontSizeFor(1) >= 12, 'a hairline stroke still gets readable text');
    ok(fontSizeFor(10) > fontSizeFor(2), 'the slider still means something for text');
});

// --- the display list -----------------------------------------------------

it('undoes and redoes in order', () => {
    const h = createHistory();
    addShape(h, 'a');
    addShape(h, 'b');
    eq(undo(h), 'b');
    eq(h.shapes, ['a']);
    eq(redo(h), 'b');
    eq(h.shapes, ['a', 'b']);
});

it('reports what it can do rather than making the caller inspect the arrays', () => {
    const h = createHistory();
    eq([canUndo(h), canRedo(h), isDirty(h)], [false, false, false]);
    addShape(h, 'a');
    eq([canUndo(h), canRedo(h), isDirty(h)], [true, false, true]);
    undo(h);
    eq([canUndo(h), canRedo(h), isDirty(h)], [false, true, false]);
});

it('returns null from undo on an empty list rather than throwing', () => {
    const h = createHistory();
    eq(undo(h), null);
    eq(redo(h), null);
});

// Otherwise undoing three strokes, drawing a fourth, and hitting redo
// resurrects a stroke from the branch the user abandoned.
it('drops the redo stack when a new shape is drawn', () => {
    const h = createHistory();
    addShape(h, 'a');
    addShape(h, 'b');
    undo(h);
    eq(canRedo(h), true);
    addShape(h, 'c');
    eq(canRedo(h), false);
    eq(h.shapes, ['a', 'c']);
});
