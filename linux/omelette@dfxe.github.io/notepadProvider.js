// The notepad in the command bar: matching lines from the scratchpad, plus a
// row that appends whatever was typed. Copying goes through ctx.copyText so this
// module stays free of St and loads in the plain-gjs test runner.

import { normalize, scorePre, byScore, NO_MATCH } from './match.js';

const PREVIEW_MAX = 84;

function preview(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= PREVIEW_MAX ? flat : `${flat.slice(0, PREVIEW_MAX - 1)}…`;
}

function lineResult(line, matchScore) {
    return {
        id: `notepad:line:${line.index}`,
        score: matchScore,
        index: line.index,
        title: preview(line.text),
        subtitle: `Notepad · line ${line.index + 1}`,
        visual: { kind: 'icon', name: 'accessories-text-editor-symbolic', size: 32 },
        accel: 'Copy',
        accessibleText: line.text,
        actions: [{
            icon: 'document-edit-symbolic',
            styleClass: '',
            run: ctx => { ctx.openTool?.('notepad'); return null; },
        }],
        run: ctx => {
            ctx.copyText?.(line.text.trim());
            return { message: 'Copied line', close: true };
        },
    };
}

function appendResult(query) {
    return {
        id: 'notepad:append',
        // Below every real match from any provider, so Enter never jots a
        // note when something else was meant.
        score: NO_MATCH,
        index: Number.MAX_SAFE_INTEGER,
        title: `Add “${preview(query)}” to notepad`,
        subtitle: 'Jot it down and keep going',
        visual: { kind: 'icon', name: 'list-add-symbolic', size: 32 },
        accel: 'Add',
        run: ctx => {
            if (!ctx.notepad?.append(query)) return null;
            return { message: 'Added to notepad', close: true };
        },
    };
}

export const notepadProvider = {
    id: 'notepad',
    title: 'Notepad',
    cap: 6,

    search(query, ctx) {
        const store = ctx.notepad;
        if (!store || query.trim() === '') return [];

        const q = normalize(query);
        const results = [];
        for (const line of store.lines()) {
            const s = scorePre(q, normalize(line.text));
            if (s !== NO_MATCH) results.push(lineResult(line, s));
        }
        results.sort(byScore);
        // cap - 1 so the append row is never the one runSearch cuts off.
        return [...results.slice(0, this.cap - 1), appendResult(query.trim())];
    },
};
