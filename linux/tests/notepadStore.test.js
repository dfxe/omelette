// Writes real files, so like vaultStore.test.js it insists on the sandbox
// run.sh sets up.

import GLib from 'gi://GLib';

import { NotepadStore } from '../omelette@dfxe.github.io/notepadStore.js';
import { suite, it, eq, ok } from './harness.js';

suite('notepadStore');

const sandboxed = GLib.getenv('OMELETTE_TEST_SANDBOX') === '1';
const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'omelette-notepad-test']);
const path = GLib.build_filenamev([dir, 'notepad.txt']);

const read = () => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
const fresh = () => {
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) GLib.unlink(path);
    const s = new NotepadStore(dir);
    s.load();
    return s;
};

if (sandboxed) {
    it('starts empty when there is no file yet', () => {
        const s = fresh();
        eq(s.text, '');
        eq(s.lines(), []);
    });

    it('defers writes until flush()', () => {
        const s = fresh();
        s.set('hello');
        ok(!GLib.file_test(path, GLib.FileTest.EXISTS), 'nothing on disk before the debounce');
        s.flush();
        eq(read(), 'hello');
    });

    it('survives a reload', () => {
        const s = fresh();
        s.set('line one\nline two');
        s.flush();
        const again = new NotepadStore(dir);
        again.load();
        eq(again.text, 'line one\nline two');
    });

    it('appends on a new line and ignores blank input', () => {
        const s = fresh();
        ok(s.append('first'));
        s.set(`${s.text}trailing`);
        ok(s.append('  second  '));
        eq(s.text, 'first\ntrailing\nsecond\n');
        eq(s.append('   '), false);
    });

    it('lists non-blank lines with their index', () => {
        const s = fresh();
        s.set('a\n\n  \nb');
        eq(s.lines(), [{ index: 0, text: 'a' }, { index: 3, text: 'b' }]);
    });

    it('emits changed only when the text actually changes', () => {
        const s = fresh();
        let n = 0;
        s.connect('changed', () => n++);
        s.set('x');
        s.set('x');
        eq(n, 1);
    });

    it('writes the file owner-only', () => {
        const s = fresh();
        s.set('token');
        s.flush();
        const [, out] = GLib.spawn_command_line_sync(`stat -c %a ${path}`);
        eq(new TextDecoder().decode(out).trim(), '600');
    });

    it('clear() empties the page and persists it', () => {
        const s = fresh();
        s.set('gone soon');
        s.flush();
        s.clear();
        s.flush();
        eq(read(), '');
    });
}
