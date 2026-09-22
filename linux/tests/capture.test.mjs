// The Shell-only module is loaded with substitutes for its GI/resource imports.
// Run with: node --test linux/tests/capture.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

let selection;
let captureError;
let calls;
const rectangle = { x: 240, y: 120, width: 640, height: 480 };
const stream = { close: () => calls.push(['close']) };
globalThis.captureMocks = {
    Gio: {
        FileCreateFlags: { NONE: 0 },
        File: { new_for_path: path => ({
            replace: () => { calls.push(['open', path]); return stream; },
        }) },
    },
    GLib: {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        timeout_add: (_priority, delay, cb) => {
            calls.push(['delay', delay]);
            queueMicrotask(cb);
        },
    },
    Shell: { Screenshot: class {
        async screenshot(...args) {
            calls.push(['screen', ...args]);
            if (captureError) throw captureError;
            return [rectangle];
        }
        async screenshot_area(...args) {
            calls.push(['area', ...args]);
            if (captureError) throw captureError;
            return [rectangle];
        }
    } },
    SelectArea: class {
        async selectAsync() { calls.push(['select']); return selection; }
    },
    Flashspot: class {
        constructor(area) { assert.equal(area, rectangle); }
        fire() { calls.push(['flash']); }
    },
};
const source = (await readFile(new URL('../omelette@dfxe.github.io/capture.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '')
    .replace(/^/, 'const { Gio, GLib, Shell, SelectArea, Flashspot } = globalThis.captureMocks;\n');
const { captureFull, captureArea } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function run(fn) {
    calls = [];
    return new Promise(resolve => fn('/tmp/capture.png', (path, error) => resolve({ path, error })));
}

test('full screen closes the PNG before reporting success', async () => {
    captureError = null;
    assert.deepEqual(await run(captureFull), { path: '/tmp/capture.png', error: null });
    assert.deepEqual(calls, [
        ['delay', 200], ['open', '/tmp/capture.png'], ['screen', false, stream], ['close'], ['flash'],
    ]);
});
test('area capture preserves native stage coordinates', async () => {
    selection = rectangle;
    assert.deepEqual(await run(captureArea), { path: '/tmp/capture.png', error: null });
    assert.deepEqual(calls, [
        ['delay', 200], ['select'], ['open', '/tmp/capture.png'],
        ['area', 240, 120, 640, 480, stream], ['close'], ['flash'],
    ]);
});
test('cancelled selection does not create a PNG', async () => {
    selection = null;
    const result = await run(captureArea);
    assert.equal(result.path, null);
    assert.match(result.error.message, /cancel/);
    assert.deepEqual(calls, [['delay', 200], ['select']]);
});
test('capture failure closes the stream and reports the error', async () => {
    captureError = new Error('capture failed');
    assert.deepEqual(await run(captureFull), { path: null, error: captureError });
    assert.deepEqual(calls, [
        ['delay', 200], ['open', '/tmp/capture.png'], ['screen', false, stream], ['close'],
    ]);
});
