// The annotation model and its geometry.
//
// Imports nothing at all — not even GLib — which is what lets linux/tests
// load it in plain gjs with no display and no Shell, the same rule that
// governs match.js and pdfExtract.js.
//
// Annotations are kept as a display list and replayed over the source image on
// every draw, never composited into a buffer. Undo is then popping the list
// rather than re-decoding a pixmap, and the strokes stay crisp because they are
// re-rendered at whatever scale they are being shown at. Nothing is destructive
// until export.
//
// Every coordinate in a shape is in *image* space. The widget is a scaled,
// centred view onto that space and its pixels are a different unit — mixing the
// two is the mistake this module exists to make hard, which is why the mapping
// is a named function with its own tests rather than arithmetic inlined at each
// call site.

export const ARROW = 'arrow';
export const RECT = 'rect';
export const TEXT = 'text';
export const PICK = 'pick';

// The tools that produce a shape. `pick` is deliberately absent: the eyedropper
// reads a pixel and changes the current colour, it never draws.
export const DRAW_TOOLS = [ARROW, RECT, TEXT];

// Stroke widths offered in the toolbar, in image pixels.
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 24;

export function clampWidth(width) {
    if (!Number.isFinite(width)) return MIN_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

// Text has no stroke, so the width control has to mean something else for it.
// Tying font size to the same slider keeps one control instead of two that are
// each only live half the time.
export function fontSizeFor(width) {
    return Math.max(12, Math.round(clampWidth(width) * 5));
}

// --- Rectangles -----------------------------------------------------------

// A drag can start at any corner, so the raw points are not a rectangle until
// they have been ordered. Returning width/height rather than a second point
// because that is what every consumer (cairo, hit tests) actually wants.
export function normalizeRect({ x1, y1, x2, y2 }) {
    return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
    };
}

// --- Arrows ---------------------------------------------------------------

// How far the barbs reach back from the tip, in image pixels. Scaled off the
// stroke so a heavy arrow does not end in a pinhead.
export function headSizeFor(width) {
    return Math.max(9, clampWidth(width) * 3.5);
}

// Half-angle between the shaft and each barb. Narrow enough to read as an
// arrow rather than a splayed V at small sizes.
const BARB_SPREAD = Math.PI / 7;

// The two barb endpoints for an arrow from (x1,y1) to (x2,y2). The tip is
// (x2,y2) and is not returned — the caller already has it.
//
// Returns null for a zero-length arrow: atan2(0,0) is 0 rather than an error,
// so without this guard a click that never moved would draw a stray barb pair
// pointing due east.
export function arrowHead({ x1, y1, x2, y2 }, width) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) return null;

    const angle = Math.atan2(dy, dx);
    const size = headSizeFor(width);
    return {
        left: {
            x: x2 - size * Math.cos(angle - BARB_SPREAD),
            y: y2 - size * Math.sin(angle - BARB_SPREAD),
        },
        right: {
            x: x2 - size * Math.cos(angle + BARB_SPREAD),
            y: y2 - size * Math.sin(angle + BARB_SPREAD),
        },
    };
}

// --- View transform -------------------------------------------------------

// Scale-to-fit, centred. Capped at 1 before the optional user zoom. Blowing a small
// image up would make the
// annotations look sharp while the thing being annotated turned to mush, and
// picking a colour off an upscaled pixel invites off-by-one errors that are
// invisible on screen.
//
// A zero or missing dimension yields the identity rather than Infinity/NaN,
// because the first draw can arrive before the widget has been allocated.
export function viewTransform(imageW, imageH, viewW, viewH, zoom = 1) {
    if (!(imageW > 0) || !(imageH > 0) || !(viewW > 0) || !(viewH > 0))
        return { scale: 1, offsetX: 0, offsetY: 0 };

    const scale = Math.min(1, Math.min(viewW / imageW, viewH / imageH)) * zoom;
    return {
        scale,
        offsetX: (viewW - imageW * scale) / 2,
        offsetY: (viewH - imageH * scale) / 2,
    };
}

// Widget point -> image point. The inverse of the transform cairo is handed.
export function toImage({ x, y }, { scale, offsetX, offsetY }) {
    return { x: (x - offsetX) / scale, y: (y - offsetY) / scale };
}

// Image point -> widget point.
export function toView({ x, y }, { scale, offsetX, offsetY }) {
    return { x: x * scale + offsetX, y: y * scale + offsetY };
}

// Keep a point inside the image. Dragging past the edge should pin the shape to
// the border rather than draw into the letterboxing, and the eyedropper must
// never index outside the pixel buffer.
//
// The upper bound is width-1, not width: this addresses a pixel, and a point at
// exactly `width` is one past the end of the row.
export function clampToImage({ x, y }, imageW, imageH) {
    return {
        x: Math.min(Math.max(0, x), Math.max(0, imageW - 1)),
        y: Math.min(Math.max(0, y), Math.max(0, imageH - 1)),
    };
}

// --- The display list -----------------------------------------------------

export function createHistory() {
    return { shapes: [], undone: [] };
}

// Adding drops the redo stack. Anything else means undoing three strokes,
// drawing a fourth, and then "redo" resurrecting a stroke from a branch the
// user abandoned.
export function addShape(history, shape) {
    history.shapes.push(shape);
    history.undone.length = 0;
    return history;
}

export function canUndo(history) {
    return history.shapes.length > 0;
}

export function canRedo(history) {
    return history.undone.length > 0;
}

export function undo(history) {
    if (!canUndo(history)) return null;
    const shape = history.shapes.pop();
    history.undone.push(shape);
    return shape;
}

export function redo(history) {
    if (!canRedo(history)) return null;
    const shape = history.undone.pop();
    history.shapes.push(shape);
    return shape;
}

// Whether there is anything worth saving. Drives the "discard changes?" prompt
// and the sensitivity of Save.
export function isDirty(history) {
    return history.shapes.length > 0;
}
