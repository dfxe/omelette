// Colour conversion for omelette-edit. The round trip matters more than any
// single conversion: the eyedropper reads bytes out of a pixel buffer, shows
// them as a hex string, and puts that string on the clipboard, so a rounding
// error anywhere in that chain means the colour you copied is not the colour
// you clicked.

import {
    PALETTE, DEFAULT_HEX, parseHex, toHex, fromBytes, hexFromBytes, isLight, pixelHex,
} from '../omelette@dfxe.github.io/editor/palette.js';
import { suite, it, eq, ok } from './harness.js';

suite('editPalette');

it('round-trips every palette colour through parse and back', () => {
    for (const { name, hex } of PALETTE)
        eq(toHex(parseHex(hex)), hex, name);
});

it('round-trips every byte triple a pixel buffer can hold', () => {
    for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [1, 254, 128], [17, 34, 51]]) {
        const hex = hexFromBytes(r, g, b);
        const back = parseHex(hex);
        eq([Math.round(back.r * 255), Math.round(back.g * 255), Math.round(back.b * 255)],
            [r, g, b], hex);
    }
});

it('parses the channels in the right order rather than symmetrically', () => {
    // An all-equal colour would pass even with r and b swapped, so use one that
    // cannot.
    const c = parseHex('#102030');
    eq([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)],
        [0x10, 0x20, 0x30]);
});

it('returns null for something that is not a colour rather than a fallback', () => {
    for (const bad of ['', 'red', '#12345', '#1234567', '1e01b24', '#gggggg', null, undefined])
        eq(parseHex(bad), null, String(bad));
});

it('accepts a hex with surrounding whitespace, since it may come off the clipboard', () => {
    ok(parseHex('  #e01b24 ') !== null);
});

it('gives every colour full alpha, so a shape is never invisibly transparent', () => {
    eq(parseHex(DEFAULT_HEX).a, 1);
    eq(fromBytes(10, 20, 30).a, 1);
});

// Alpha is dropped on the way out: the hex goes to the clipboard as a colour
// literal, and #rrggbbaa is not what anyone pasting into a stylesheet expects.
it('writes six digits even when the colour carries an alpha', () => {
    eq(toHex({ r: 1, g: 0, b: 0, a: 0.5 }), '#ff0000');
});

it('clamps a channel out of range instead of emitting a malformed hex', () => {
    eq(toHex({ r: 2, g: -1, b: 0.5 }), '#ff0080');
    ok(/^#[0-9a-f]{6}$/.test(toHex({ r: NaN, g: NaN, b: NaN })), 'NaN still yields a hex');
});

// --- pixelHex -------------------------------------------------------------

// A 2x2 RGBA buffer with a deliberately over-long rowstride: 2 pixels of real
// data (8 bytes) padded to 12, which is what GdkPixbuf actually hands back and
// what indexing by width * channels would get wrong.
const rgbaBuffer = () => {
    const rowstride = 12;
    const px = new Uint8Array(rowstride * 2);
    const put = (x, y, r, g, b) => {
        const o = y * rowstride + x * 4;
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    };
    put(0, 0, 0xe0, 0x1b, 0x24);
    put(1, 0, 0x2e, 0xc2, 0x7e);
    put(0, 1, 0x35, 0x84, 0xe4);
    put(1, 1, 0xff, 0xff, 0xff);
    return { px, rowstride };
};

it('reads every pixel of a padded buffer, not just the first row', () => {
    const { px, rowstride } = rgbaBuffer();
    eq(pixelHex(px, rowstride, 4, 0, 0), '#e01b24');
    eq(pixelHex(px, rowstride, 4, 1, 0), '#2ec27e');
    eq(pixelHex(px, rowstride, 4, 0, 1), '#3584e4', 'second row respects rowstride');
    eq(pixelHex(px, rowstride, 4, 1, 1), '#ffffff');
});

// Indexing by width * channels instead of rowstride reads 4 bytes early on row
// 1 and returns a colour that is plausible but wrong — invisible on screen,
// which is the entire reason this is a tested function.
it('would read the wrong colour if rowstride were assumed to be width * channels', () => {
    const { px, rowstride } = rgbaBuffer();
    ok(pixelHex(px, rowstride, 4, 0, 1) !== pixelHex(px, 8, 4, 0, 1),
        'the padded and unpadded strides must disagree, or the test proves nothing');
});

// The file chooser will happily open a JPEG, which has no alpha channel.
it('reads a three-channel buffer, since a JPEG has no alpha', () => {
    const px = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    eq(pixelHex(px, 6, 3, 0, 0), '#112233');
    eq(pixelHex(px, 6, 3, 1, 0), '#445566');
});

it('returns null past the end of the buffer rather than reading whatever follows', () => {
    const { px, rowstride } = rgbaBuffer();
    eq(pixelHex(px, rowstride, 4, 0, 99), null);
    eq(pixelHex(px, rowstride, 4, -1, 0), null);
});

// --- isLight --------------------------------------------------------------

it('tells light colours from dark ones so a white swatch keeps an outline', () => {
    eq(isLight(parseHex('#ffffff')), true);
    eq(isLight(parseHex('#f6d32d')), true, 'yellow reads as light');
    eq(isLight(parseHex('#000000')), false);
    eq(isLight(parseHex('#e01b24')), false, 'saturated red reads as dark');
});
