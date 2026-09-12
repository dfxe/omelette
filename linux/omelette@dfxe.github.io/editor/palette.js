// Annotation colours, and the conversion between the two representations that
// meet in this app: `#rrggbb` strings, which is what the eyedropper produces
// and what the rest of Omelette already puts on the clipboard, and cairo's
// 0..1 floats.
//
// HEX_RE is imported rather than redeclared. It is the same predicate the popup
// uses to decide a copied string is a colour worth showing a swatch for
// (historyProvider.js:21), and a second copy here would be free to drift from
// it — at which point the editor would emit a hex the history refuses to
// recognise. That import pulls in GLib, which plain gjs has; it pulls in
// nothing from resource:///, so this module still loads under linux/tests.

import { HEX_RE } from '../format.js';

// Chosen to stay legible on a screenshot rather than to be a balanced palette:
// saturated, mid-to-dark, and none of them close to the greys and blues that
// dominate application chrome. Red first because it is what an annotation
// almost always wants to be.
export const PALETTE = [
    { name: 'Red', hex: '#e01b24' },
    { name: 'Orange', hex: '#ff7800' },
    { name: 'Yellow', hex: '#f6d32d' },
    { name: 'Green', hex: '#2ec27e' },
    { name: 'Blue', hex: '#3584e4' },
    { name: 'Purple', hex: '#9141ac' },
    { name: 'Black', hex: '#000000' },
    { name: 'White', hex: '#ffffff' },
];

export const DEFAULT_HEX = PALETTE[0].hex;

// `#rrggbb` -> {r, g, b, a} with each channel 0..1, or null when the string is
// not a colour. Null rather than a fallback colour: a caller that silently got
// red when it asked for garbage would be very hard to debug, and every call
// site here has a sensible default of its own to reach for.
export function parseHex(hex) {
    const text = (hex ?? '').trim();
    if (!HEX_RE.test(text)) return null;
    return {
        r: parseInt(text.slice(1, 3), 16) / 255,
        g: parseInt(text.slice(3, 5), 16) / 255,
        b: parseInt(text.slice(5, 7), 16) / 255,
        a: 1,
    };
}

function byteOf(channel) {
    if (!Number.isFinite(channel)) return 0;
    return Math.min(255, Math.max(0, Math.round(channel * 255)));
}

function pad(n) {
    return n.toString(16).padStart(2, '0');
}

// {r, g, b} 0..1 -> `#rrggbb`. Alpha is dropped: the hex goes to the clipboard
// for use as a colour literal, and `#rrggbbaa` is not what anyone pasting into
// a stylesheet or a design tool is expecting.
export function toHex({ r, g, b }) {
    return `#${pad(byteOf(r))}${pad(byteOf(g))}${pad(byteOf(b))}`;
}

// The form GdkPixbuf hands back — three 0..255 ints straight out of the pixel
// buffer.
export function fromBytes(r, g, b) {
    return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
}

export function hexFromBytes(r, g, b) {
    return toHex(fromBytes(r, g, b));
}

// Relative luminance, used to decide whether a swatch needs a light or a dark
// outline so a white chip is still visible against a white toolbar.
export function isLight({ r, g, b }) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

// The whole eyedropper, in one pure function.
//
// A GdkPixbuf's rows are padded to `rowstride`, which is NOT width * channels —
// so indexing by width is the classic way to read a colour that drifts further
// from the truth the further down the image you click. And `nChannels` is 4 for
// a PNG with alpha but 3 for a JPEG, which the editor's own file chooser will
// happily open, so it cannot be assumed either.
//
// Both of those are invisible on screen: you get *a* colour, just the wrong
// one. That is exactly the kind of bug worth a test rather than an eyeball,
// which is why the arithmetic lives here instead of inline in the canvas.
export function pixelHex(pixels, rowstride, nChannels, x, y) {
    const offset = y * rowstride + x * nChannels;
    if (offset < 0 || offset + 2 >= pixels.length) return null;
    return hexFromBytes(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
}
