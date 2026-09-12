// The Keep awake rows.
//
// The contract worth pinning down is that the provider only ever *writes
// settings*. It holds no cookie and makes no D-Bus call, so the popup toggle,
// the keyboard shortcut, these rows and the preferences window cannot disagree
// about the state — there is one reconciler, in extension.js, watching
// `changed::awake`.

import { awakeProvider } from '../omelette@dfxe.github.io/awakeProvider.js';
import { suite, it, eq, ok } from './harness.js';

suite('awakeProvider');

// Stands in for Gio.Settings, the way configStore.test.js does — the provider
// only ever touches these four methods.
const fakeSettings = ({ awake = false, until = 0 } = {}) => {
    const bools = { awake };
    const ints = { 'awake-until': until };
    return {
        get_boolean: k => bools[k] ?? false,
        set_boolean: (k, v) => { bools[k] = v; },
        get_int64: k => ints[k] ?? 0,
        set_int64: (k, v) => { ints[k] = v; },
        _bools: bools,
        _ints: ints,
    };
};

const ctx = (opts = {}) => ({ settings: fakeSettings(opts), scope: opts.scope ?? null });

it('answers to the name the feature has everywhere else', () => {
    for (const query of ['awake', 'caffeine', 'coffee', 'insomnia', 'nosleep'])
        ok(awakeProvider.search(query, ctx()).length > 0, query);
});

it('ignores queries too short to be meant', () => {
    eq(awakeProvider.search('aw', ctx()).length, 0);
    eq(awakeProvider.search('', ctx()).length, 0);
});

it('stays out of the way of unrelated queries', () => {
    for (const query of ['screenshot', 'git commit', 'https://example.com'])
        eq(awakeProvider.search(query, ctx()).length, 0, query);
});

it('lists everything it has when the popup was opened scoped to it', () => {
    const results = awakeProvider.search('', ctx({ scope: 'awake' }));
    ok(results.length >= 3, 'the durations are listed without typing');
});

it('offers no way to turn it off while it is already off', () => {
    const results = awakeProvider.search('awake', ctx());
    eq(results.some(r => r.id === 'awake:off'), false);
});

it('offers turning it off, and extending it, once it is on', () => {
    const results = awakeProvider.search('awake', ctx({ awake: true }));
    eq(results.some(r => r.id === 'awake:off'), true);
    ok(results.some(r => r.id.startsWith('awake:') && r.id !== 'awake:off'),
        'durations stay available so a running hold can be extended');
});

// --- what the rows actually do -------------------------------------------

it('writes the deadline before the flag, so the reconciler sees the right one', () => {
    // Order is not directly observable through the fake, so assert the state it
    // produces: both must be set, and consistently.
    const c = ctx();
    const row = awakeProvider.search('awake', c).find(r => r.id === 'awake:60');
    row.run(c);
    eq(c.settings._bools.awake, true);
    ok(c.settings._ints['awake-until'] > 0, 'a timed hold gets a deadline');
});

it('leaves an indefinite hold with no deadline at all', () => {
    const c = ctx();
    const row = awakeProvider.search('awake', c).find(r => r.id === 'awake:0');
    row.run(c);
    eq(c.settings._bools.awake, true);
    eq(c.settings._ints['awake-until'], 0);
});

// A stale deadline left behind would be read by the next reconcile and could
// expire a fresh indefinite hold immediately.
it('clears the deadline when turned off, not just the flag', () => {
    const c = ctx({ awake: true, until: 9_999_999 });
    const row = awakeProvider.search('awake', c).find(r => r.id === 'awake:off');
    row.run(c);
    eq(c.settings._bools.awake, false);
    eq(c.settings._ints['awake-until'], 0);
});

it('touches nothing but settings', () => {
    const c = ctx();
    // No vault, no monitor, no clipboard on the ctx: a row that reached for one
    // would throw here rather than in the compositor.
    for (const row of awakeProvider.search('awake', c))
        ok(row.run(c) !== undefined, row.id);
});

// --- shape ----------------------------------------------------------------

it('gives every row a stable id and something to draw', () => {
    const results = awakeProvider.search('awake', ctx({ awake: true }));
    const ids = results.map(r => r.id);
    eq(ids.length, new Set(ids).size, 'ids are unique within a refresh');
    for (const r of results) {
        ok(r.title, `${r.id} has a title`);
        eq(r.visual.kind, 'icon', `${r.id} draws an icon`);
    }
});

it('survives having no settings at all rather than throwing into the rebuild', () => {
    eq(awakeProvider.search('awake', { settings: null, scope: null }), []);
});
