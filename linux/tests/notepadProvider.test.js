import { notepadProvider } from '../omelette@dfxe.github.io/notepadProvider.js';
import { suite, it, eq, ok } from './harness.js';

suite('notepadProvider');

// Stands in for NotepadStore; the provider only touches lines() and append().
const fakeStore = (text = '') => ({
    text,
    lines() {
        return this.text.split('\n')
            .map((t, index) => ({ index, text: t }))
            .filter(l => l.text.trim() !== '');
    },
    append(t) {
        if (t.trim() === '') return false;
        this.text += `${t}\n`;
        return true;
    },
});

const ctx = (text, extra = {}) => ({ notepad: fakeStore(text), ...extra });

it('stays silent with an empty query', () => {
    eq(notepadProvider.search('', ctx('anything')), []);
    eq(notepadProvider.search('   ', ctx('anything')), []);
});

it('stays silent without a store', () => {
    eq(notepadProvider.search('hi', {}), []);
});

it('always offers to append, as the last row', () => {
    const results = notepadProvider.search('buy milk', ctx(''));
    eq(results.length, 1);
    eq(results[0].id, 'notepad:append');
});

it('lists matching lines ahead of the append row', () => {
    const results = notepadProvider.search('deploy', ctx('deploy staging\nlunch\nredeploy prod'));
    const ids = results.map(r => r.id);
    eq(ids[ids.length - 1], 'notepad:append');
    ok(ids.includes('notepad:line:0'));
    ok(ids.includes('notepad:line:2'));
    ok(!ids.includes('notepad:line:1'));
});

it('keeps the append row inside the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => `todo ${i}`).join('\n');
    const results = notepadProvider.search('todo', ctx(many));
    ok(results.length <= notepadProvider.cap);
    eq(results[results.length - 1].id, 'notepad:append');
});

it('append row writes the trimmed query to the store', () => {
    const c = ctx('');
    const row = notepadProvider.search('  call Sam  ', c).find(r => r.id === 'notepad:append');
    const outcome = row.run(c);
    eq(c.notepad.text, 'call Sam\n');
    eq(outcome.close, true);
});

it('line rows copy the line through ctx.copyText', () => {
    let copied = null;
    const c = ctx('ssh box', { copyText: t => { copied = t; } });
    const row = notepadProvider.search('ssh', c).find(r => r.id === 'notepad:line:0');
    row.run(c);
    eq(copied, 'ssh box');
});
