// Two chrome rows that only exist when you ask for them by name: what this is
// and what version it is, and the way into the preferences window — which is
// otherwise reachable only from a terminal.
//
// Nothing here is content, so the section stays out of the way by matching a
// tight keyword set rather than anything the user happens to have copied. It
// still sits first in PROVIDERS: when "about" does match, the quicklink
// "Search the web for…" fallback also fires, and being last would bury it.

import { scoreAnyPre, normalize, byScore, NO_MATCH } from './match.js';
import { openUri } from './uri.js';

const PROJECT_URL = 'https://github.com/dfxe/omelette';

// Short enough that a stray keystroke can't summon the section, long enough
// that "abo" and "pre" still work.
const MIN_QUERY = 3;

const ABOUT_KEYWORDS = ['about', 'version', 'omelette'];
const PREFS_KEYWORDS = ['preferences', 'settings', 'prefs', 'options'];

// Prefixes only, unlike every other provider. The loose subsequence tier that
// makes `bgcol` find `background-color` is right for searching things you
// copied and wrong here: it would have `cot` summon an About section, because
// c-o-t runs through `omelette` in order. Score the survivors anyway so ties
// break the way they do everywhere else.
function scorePrefix(q, keywords) {
    const hits = keywords.filter(k => k.startsWith(q));
    return hits.length === 0 ? NO_MATCH : scoreAnyPre(q, hits);
}

export const aboutProvider = {
    id: 'about',
    title: 'About',
    cap: 2,

    search(query, ctx) {
        if (query.length < MIN_QUERY) return [];

        const q = normalize(query);
        const results = [];

        const aboutScore = scorePrefix(q, ABOUT_KEYWORDS);
        if (aboutScore !== NO_MATCH) {
            const version = ctx.version ? ` ${ctx.version}` : '';
            results.push({
                id: 'about:version',
                score: aboutScore,
                index: 0,
                title: `Omelette${version}`,
                subtitle: 'Early beta for coding agent workflows · MIT · github.com/dfxe/omelette',
                visual: { kind: 'icon', name: 'help-about-symbolic', size: 32 },
                accel: 'Open',
                run: () => {
                    // No flash: a browser window coming up is feedback enough,
                    // the same bargain quicklinks make.
                    openUri(PROJECT_URL);
                    return { close: true };
                },
            });
        }

        const prefsScore = scorePrefix(q, PREFS_KEYWORDS);
        if (prefsScore !== NO_MATCH) {
            results.push({
                id: 'about:preferences',
                score: prefsScore,
                index: 1,
                title: 'Preferences',
                subtitle: 'Snippets, quicklinks, shortcuts and limits',
                visual: { kind: 'icon', name: 'preferences-system-symbolic', size: 32 },
                accel: 'Open',
                run: ctx2 => {
                    ctx2.openPreferences?.();
                    return { close: true };
                },
            });
        }

        return results.sort(byScore);
    },
};
