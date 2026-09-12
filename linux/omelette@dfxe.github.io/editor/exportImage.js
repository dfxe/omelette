// Writing an edited image back out.
//
// The single most important rule here is that **nothing is ever overwritten**,
// and in particular nothing under the vault's images/ directory is ever
// written to at all. That is not caution, it is a correctness requirement:
//
//   - vaultStore.js names each image `<sha256-of-its-bytes>.png` and, on a
//     fingerprint it has seen before, *skips the write because the file already
//     exists* (vaultStore.js:184-188). Edit one of those files in place and its
//     name no longer describes its contents — for good. Re-copying the original
//     image later would find the fingerprint, find the file, decline to rewrite
//     it, and hand back the edited version instead. The original is gone.
//   - _gcImages() (vaultStore.js:141-159) unlinks every .png under images/ that
//     no live item references, so a *new* file written there is deleted on the
//     next load.
//
// So an edit of a clipboard image lands in the screenshots folder, like a
// capture does, and reaches history through the same file monitor. An edit of a
// file the user opened themselves lands beside that file.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import cairo from 'cairo';

import { uniquePath } from '../pdfExtract.js';
import { drawImage, drawAll } from './render.js';

// Always .png, whatever went in. The annotations have soft edges and the halo
// behind text is translucent, both of which JPEG would smear; and re-encoding
// someone's JPEG at an arbitrary quality is a decision this tool has no basis
// for making.
export function outputName(sourcePath) {
    // path_get_basename('') is '.' and path_get_basename('/') is '/', neither of
    // which is a name — so check for those rather than for an empty string.
    const raw = GLib.path_get_basename(sourcePath ?? '');
    const base = raw === '' || raw === '.' || raw === '/' ? 'Image' : raw;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return `${stem} (edited).png`;
}

// Where an edit of `sourcePath` should go. See the header for why an image that
// came out of the vault must not go back there.
export function defaultOutDir(sourcePath, { vaultImagesDir, screenshotsDir }) {
    if (!sourcePath) return screenshotsDir;
    const dir = GLib.path_get_dirname(sourcePath);
    return dir === vaultImagesDir ? screenshotsDir : dir;
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

// Render at the image's native size onto a fresh surface with no transform.
// Deliberately not the widget's surface: that one is scaled to fit and, on a
// HiDPI display, pre-scaled again by the device factor — saving through it
// would quietly resample a 4K screenshot down to whatever the window happened
// to be.
export function renderToSurface(pixbuf, shapes) {
    const surface = new cairo.ImageSurface(
        cairo.Format.ARGB32, pixbuf.get_width(), pixbuf.get_height());
    const cr = new cairo.Context(surface);
    try {
        drawImage(cr, pixbuf);
        drawAll(cr, shapes);
    } finally {
        // GJS will not collect a cairo context on its own, and an undisposed
        // one keeps the surface's backing store alive.
        cr.$dispose();
    }
    return surface;
}

// Returns the path actually written. Throws on failure — the caller has a
// toast to put the message in.
export function savePng(pixbuf, shapes, outDir, sourcePath) {
    if (GLib.mkdir_with_parents(outDir, 0o755) !== 0)
        throw new Error(`Could not create ${outDir}.`);

    const wanted = GLib.build_filenamev([outDir, outputName(sourcePath)]);
    const dest = uniquePath(wanted, exists);
    if (!dest) throw new Error('Too many files with that name already.');

    const surface = renderToSurface(pixbuf, shapes);
    surface.writeToPNG(dest);
    surface.finish();
    return dest;
}

// The editor may be launched with a path that has since been deleted, or with
// something that is not an image at all.
export function readableImage(path) {
    return !!path && Gio.File.new_for_path(path).query_exists(null);
}
