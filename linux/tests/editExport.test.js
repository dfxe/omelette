// Where an edited image is allowed to land.
//
// These two functions are the guard on a data-loss bug rather than a
// convenience: vaultStore names image files after a hash of their contents and
// declines to rewrite a file it already has (vaultStore.js:184-188), so editing
// one in place would permanently replace the original with the annotated
// version — and _gcImages would delete a new file written alongside it. The
// rule "an edit never goes back into images/" is what these tests pin down.

import { outputName, defaultOutDir } from '../omelette@dfxe.github.io/editor/exportImage.js';
import { suite, it, eq } from './harness.js';

suite('editExport');

const dirs = {
    vaultImagesDir: '/home/u/.local/share/omelette/images',
    screenshotsDir: '/home/u/Pictures/Screenshots',
};

it('sends an edit of a vault image to the screenshots folder, never back to images/', () => {
    eq(defaultOutDir(`${dirs.vaultImagesDir}/abc123.png`, dirs), dirs.screenshotsDir);
});

it('leaves an edit beside the file the user opened', () => {
    eq(defaultOutDir('/home/u/Desktop/diagram.png', dirs), '/home/u/Desktop');
    eq(defaultOutDir(`${dirs.screenshotsDir}/Screenshot.png`, dirs), dirs.screenshotsDir);
});

// A path merely *containing* the images directory's name is not in it — a
// prefix test rather than an exact dirname test would send edits of
// ~/images-backup/ somewhere surprising.
it('matches the images directory exactly rather than by prefix', () => {
    eq(defaultOutDir('/home/u/.local/share/omelette/images-old/x.png', dirs),
        '/home/u/.local/share/omelette/images-old');
});

it('falls back to the screenshots folder when there is no source file', () => {
    eq(defaultOutDir(null, dirs), dirs.screenshotsDir);
    eq(defaultOutDir('', dirs), dirs.screenshotsDir);
});

it('marks the copy as edited instead of shadowing the original name', () => {
    eq(outputName('/x/Screenshot from 2026-08-03 14-02-10.png'),
        'Screenshot from 2026-08-03 14-02-10 (edited).png');
});

// Annotations have soft edges and a translucent halo, both of which JPEG would
// smear — and re-encoding someone's JPEG at a quality this tool has no basis
// for choosing is worse than changing the extension.
it('always writes .png, whatever went in', () => {
    eq(outputName('/x/photo.jpeg'), 'photo (edited).png');
    eq(outputName('/x/no-extension'), 'no-extension (edited).png');
});

it('keeps a leading dot as part of the name rather than treating it as an extension', () => {
    eq(outputName('/x/.hidden'), '.hidden (edited).png');
});

it('names something even when handed a path with no basename', () => {
    eq(outputName(''), 'Image (edited).png');
    eq(outputName(null), 'Image (edited).png');
});
