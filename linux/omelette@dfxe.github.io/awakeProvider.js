// Keep awake, as a command-bar tool.
//
// Pure and synchronous like every other provider: rows write GSettings and
// nothing else. The D-Bus inhibitor is reconciled by a single `changed::`
// handler in extension.js, so this file never talks to the bus, never holds a
// cookie, and never has to know whether one is held.
//
// That is not only tidiness — it is what makes the toggle, the shortcut, these
// rows and the preferences window agree with each other by construction rather
// than by four copies of the same logic.

import { scoreAnyPre, normalize, byScore, NO_MATCH } from './match.js';
import { DURATION_CHOICES, deadlineFor, describeAwake, nowSeconds } from './awake.js';

// Below this a query is more likely to be the start of something else. `pdf`
// uses the same guard for the same reason.
const MIN_QUERY = 3;

// The words someone might reach for. "caffeine" and "coffee" are here because
// that is what the feature is called everywhere else in the world, even though
// nothing in this extension is named after it.
const KEYWORDS = [
    'keep awake', 'awake', 'caffeine', 'coffee', 'insomnia',
    'sleep', 'nosleep', 'no sleep', 'stay awake', 'idle', 'suspend',
].map(normalize);

function setAwake(ctx, minutes) {
    const settings = ctx.settings;
    if (!settings) return null;

    // The deadline is written *before* the flag. extension.js reconciles on
    // `changed::awake`, so the reverse order would have it read the previous
    // deadline and arm the wrong timer.
    settings.set_int64('awake-until', deadlineFor(nowSeconds(), minutes));
    settings.set_boolean('awake', true);
    return {
        message: minutes > 0 ? `Awake for ${minutes} min` : 'Keeping awake',
        close: true,
    };
}

function turnOff(ctx) {
    ctx.settings?.set_boolean('awake', false);
    ctx.settings?.set_int64('awake-until', 0);
    return { message: 'Sleep allowed', close: true };
}

export const awakeProvider = {
    id: 'awake',
    title: 'Keep awake',
    cap: 5,

    search(query, ctx) {
        const settings = ctx.settings;
        if (!settings) return [];

        const scoped = ctx.scope === 'awake';
        const q = normalize(query);
        if (!scoped && q.length < MIN_QUERY) return [];

        const matchScore = scoped && q === '' ? 0 : scoreAnyPre(q, KEYWORDS);
        if (matchScore === NO_MATCH) return [];

        const on = settings.get_boolean('awake');
        const until = Number(settings.get_int64('awake-until'));
        const state = describeAwake({ on, until, now: nowSeconds() });

        const results = [];

        if (on) {
            results.push({
                id: 'awake:off',
                score: matchScore,
                index: 0,
                title: 'Let the screen sleep again',
                subtitle: state,
                visual: { kind: 'icon', name: 'weather-clear-night-symbolic', size: 32 },
                accel: 'Enter',
                run: ctx2 => turnOff(ctx2),
            });
        }

        // Offered whether or not it is already on: picking a duration while it
        // is running is how you extend it.
        DURATION_CHOICES.forEach((choice, i) => {
            results.push({
                id: `awake:${choice.minutes}`,
                score: matchScore,
                // Keeps the durations in their declared order under a tie,
                // rather than letting the sort shuffle them per keystroke.
                index: i + 1,
                title: on ? `Keep awake — ${choice.label.toLowerCase()}` : `Keep awake ${choice.label.toLowerCase()}`,
                subtitle: on ? state : 'Stops the screen blanking and the machine suspending',
                visual: { kind: 'icon', name: 'weather-clear-symbolic', size: 32 },
                run: ctx2 => setAwake(ctx2, choice.minutes),
            });
        });

        return results.sort(byScore);
    },

    emptyMessage(ctx) {
        if (ctx.scope !== 'awake') return null;
        return 'Keep awake needs the session manager, which is not answering.';
    },
};
