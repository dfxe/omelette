// The arithmetic behind Keep awake.
//
// Only the pure half is covered — the D-Bus half needs a session bus and a
// running gnome-session, and awake.js is split precisely so that the part worth
// checking does not. The split is also why awake.js takes onExpire/onError
// callbacks instead of importing Main: an import from resource:/// would make
// this file unloadable outside gnome-shell.

import {
    INHIBIT_FLAGS, DURATION_CHOICES,
    deadlineFor, remainingSeconds, formatRemaining, describeAwake,
} from '../omelette@dfxe.github.io/awake.js';
import { suite, it, eq, ok } from './harness.js';

suite('awake');

// Idle alone still lets the machine suspend on the power setting; suspend alone
// still lets the screen blank and lock underneath you. "Keep awake" is both.
it('inhibits suspend and idle together, not one or the other', () => {
    eq(INHIBIT_FLAGS, 12);
    ok((INHIBIT_FLAGS & 4) !== 0, 'suspend bit');
    ok((INHIBIT_FLAGS & 8) !== 0, 'idle bit');
});

// --- deadlineFor ----------------------------------------------------------

it('turns a duration into an absolute time', () => {
    eq(deadlineFor(1_000_000, 15), 1_000_900);
    eq(deadlineFor(1_000_000, 120), 1_007_200);
});

// 0 is "until turned off", and it has to stay 0 rather than becoming "now",
// or the first reconcile would treat an indefinite hold as already expired.
it('keeps an indefinite hold indefinite rather than making it expire at once', () => {
    eq(deadlineFor(1_000_000, 0), 0);
    eq(deadlineFor(1_000_000, -5), 0);
    eq(deadlineFor(1_000_000, NaN), 0);
});

// --- remainingSeconds -----------------------------------------------------

it('distinguishes "no deadline" from "no time left"', () => {
    eq(remainingSeconds(0, 1_000_000), null, 'indefinite');
    eq(remainingSeconds(1_000_000, 1_000_000), 0, 'exactly due');
    eq(remainingSeconds(1_000_060, 1_000_000), 60);
});

// A deadline in the past is what a lock, a suspend or a shell restart leaves
// behind. It must read as expired, not as a negative countdown.
it('reads a deadline that passed while the extension was off as expired', () => {
    eq(remainingSeconds(1_000_000, 9_999_999), 0);
});

// --- formatRemaining ------------------------------------------------------

it('formats a countdown at the granularity a person would say it', () => {
    eq(formatRemaining(5), '5s');
    eq(formatRemaining(59), '59s');
    eq(formatRemaining(60), '1m');
    eq(formatRemaining(3540), '59m');
    // 59m59s rounds up into the next unit rather than reading "60m", which is
    // not how anyone says it.
    eq(formatRemaining(3599), '1h');
    eq(formatRemaining(3600), '1h');
    eq(formatRemaining(7500), '2h 5m');
    eq(formatRemaining(7200), '2h', 'a whole number of hours drops the minutes');
});

// --- describeAwake --------------------------------------------------------

it('describes each state distinctly', () => {
    eq(describeAwake({ on: false, until: 0, now: 100 }), 'Off');
    eq(describeAwake({ on: true, until: 0, now: 100 }), 'On, until you turn it off');
    eq(describeAwake({ on: true, until: 1000, now: 100 }), 'On, 15m left');
    eq(describeAwake({ on: true, until: 100, now: 100 }), 'Ending now');
});

// Off is off however stale the deadline is — the flag wins, so a leftover
// `awake-until` can never make the UI claim it is still holding.
it('reports off as off even with a deadline still in the future', () => {
    eq(describeAwake({ on: false, until: 9_999_999, now: 100 }), 'Off');
});

// --- DURATION_CHOICES -----------------------------------------------------

it('offers "until turned off" first, since that is what the toggle means', () => {
    eq(DURATION_CHOICES[0].minutes, 0);
    ok(DURATION_CHOICES.length >= 3, 'and some timed options');
    ok(DURATION_CHOICES.slice(1).every(c => c.minutes > 0), 'the rest are real durations');
});
