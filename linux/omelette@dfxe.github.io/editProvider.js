// The annotation editor, as a command-bar tool.
//
// Pure and synchronous like every provider: the rows hand a path to
// ctx.openEditor and that is all. Spawning, and closing the popup first, both
// belong to the Indicator — the popup holds a modal grab, and a window opened
// underneath one receives no clicks at all (filePortal.js says the same thing
// about the file chooser).

import GLib from 'gi://GLib';

import { scoreAnyPre, scorePre, normalize, byScore, NO_MATCH } from './match.js';

const MIN_QUERY = 3;

const KEYWORDS = [
    'edit', 'annotate', 'annotation', 'draw', 'markup', 'arrow', 'crop',
    'screenshot edit', 'image editor',
].map(normalize);

// Enough to reach the shot you meant without burying the rest of the popup.
const RECENT_SHOTS = 4;

function shotResult(path, matchScore, index) {
    return {
        id: `edit:shot:${path}`,
        score: matchScore,
        index,
        title: `Edit ${GLib.path_get_basename(path)}`,
        subtitle: 'Arrows, boxes, text — saved as a copy',
        visual: { kind: 'gicon', path, size: 64 },
        accel: 'Enter',
        run: ctx => {
            ctx.openEditor?.(path);
            // No message: openEditor closes the popup itself, and a flash on a
            // row that is about to disappear only ever half-plays.
            return null;
        },
    };
}

export const editProvider = {
    id: 'edit',
    title: 'Edit an image',
    cap: 6,

    search(query, ctx) {
        const scoped = ctx.scope === 'edit';
        const q = normalize(query);
        if (!scoped && q.length < MIN_QUERY) return [];

        const keywordScore = scoped && q === '' ? 0 : scoreAnyPre(q, KEYWORDS);

        const shots = ctx.screenshots?.entries ?? [];
        const results = [];

        // When the query named the tool, offer the recent shots in order. When
        // it did not, still let a filename match — typing part of a screenshot
        // name is a reasonable way to reach it.
        shots.slice(0, RECENT_SHOTS).forEach((path, i) => {
            const named = q === '' ? NO_MATCH
                : scorePre(q, normalize(GLib.path_get_basename(path)));
            const best = Math.max(keywordScore, named);
            if (best === NO_MATCH) return;
            results.push(shotResult(path, best, i));
        });

        if (keywordScore !== NO_MATCH) {
            results.push({
                id: 'edit:open',
                score: keywordScore,
                // After the screenshots: reaching for a file is the rarer case.
                index: RECENT_SHOTS + 1,
                title: 'Open an image…',
                subtitle: 'Choose a file to annotate',
                visual: { kind: 'icon', name: 'document-open-symbolic', size: 32 },
                run: ctx2 => {
                    // No path: the editor puts up its own Gtk.FileDialog. That
                    // is why filePortal.js never had to grow an image mode —
                    // the portal exists because gnome-shell cannot show a GTK
                    // dialog, and the editor is a GTK app.
                    ctx2.openEditor?.(null);
                    return null;
                },
            });
        }

        return results.sort(byScore);
    },

    emptyMessage(ctx) {
        if (ctx.scope !== 'edit') return null;
        const missing = ctx.editorMissing?.() ?? [];
        if (missing.length > 0)
            return `The editor needs ${missing[0]}. Install the ${missing[0]} package.`;
        return 'No screenshots yet — capture one, or open an image to annotate.';
    },
};
