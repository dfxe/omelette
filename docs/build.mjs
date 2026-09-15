#!/usr/bin/env node
//
// Builds the GitHub Pages site in docs/.
//
//   node docs/build.mjs            render the shots, then build docs/_site/
//   node docs/build.mjs --check    verify the committed shots are current (CI)
//
// The page carries no prose of its own. One region is lifted out of
// README.md at build time and substituted into index.template.html, so the two
// cannot drift: docs/_site/ is generated and gitignored, and the workflow
// rebuilds it on every push to main. The page deliberately uses only the README
// tagline; the full details remain in the README.
//
// No package.json and no dependencies, matching the rest of the repo — the one
// exception is Playwright, which is imported lazily so that --check (the mode
// CI runs on every push and PR) needs nothing installed at all.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DOCS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DOCS);
const MOCKS = join(DOCS, 'mocks');
const SHOTS = join(DOCS, 'shots');
const MANIFEST = join(SHOTS, 'manifest.json');

// What GitHub Pages actually publishes. Separate from docs/ so the artifact is
// exactly the page and its images — no mocks, no build script, and above all no
// node_modules, which npm puts next to package.json in docs/.
const SITE = join(DOCS, '_site');

// One entry per screenshot. `width` is the viewport the mock is laid out in —
// only a lower bound on the PNG, since what actually gets captured is the
// .mock element's own box.
const SHOT_LIST = [
    { name: 'gnome-command-bar', width: 700, height: 900 },
    { name: 'gnome-history', width: 700, height: 1000 },
    { name: 'macos-popover', width: 820, height: 900 },
];

// 2x so the PNGs stay sharp on the HiDPI screens most visitors have.
const SCALE = 2;

// ─── README extraction ─────────────────────────────────────────────────────

// Split the README into its preamble (everything above the first `## `) and a
// map of level-2 sections keyed by a slug of the heading. Headings in this
// README lead with an emoji, so those are dropped along with the case.
function readSections(markdown) {
    const lines = markdown.split('\n');
    const preamble = [];
    const sections = new Map();

    let current = null;
    for (const line of lines) {
        const heading = /^##\s+(.*)$/.exec(line);
        if (heading) {
            current = [];
            sections.set(slug(heading[1]), current);
            continue;
        }
        (current ?? preamble).push(line);
    }

    return { preamble: preamble.join('\n'), sections };
}

// "## ✨ At a glance" -> "at a glance". Strips anything that is not a letter,
// digit or space so the key survives an emoji being changed or dropped.
function slug(heading) {
    return heading
        .replace(/[^\p{L}\p{N} ]/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function section(sections, key) {
    const found = sections.get(key);
    if (!found) {
        throw new Error(
            `README.md has no "## … ${key}" section any more. ` +
                `Either restore the heading or update SOURCES in docs/build.mjs.`
        );
    }
    return found.join('\n');
}

function paragraphs(markdown) {
    return markdown
        .split(/\n{2,}/)
        .map(block => block.trim())
        .filter(Boolean);
}

// Branding blocks in the preamble are the page's own business rather than content it
// should reprint: the app icon, the H1, because the page has a header, and the shields row,
// because the header states the platforms already. Dropping them here is also
// what makes the positional indices below stable.
// The optional leading [ catches a shield that has been wrapped in a link.
const SKIP_IN_PREAMBLE = [/^\*\*Early beta\*\*$/, /^#\s/, /^\[?!\[/, /^<img\s[^>]*src="docs\/assets\/omelette\.png"/];

function extract(markdown) {
    const { preamble, sections } = readSections(markdown);

    // Addressed by position because the README's opening has no headings to
    // hang off: after the branding skips, blocks 0 and 1 are the tagline and
    // supporting sentence. The full lede stays in the README.
    const intro = paragraphs(preamble).filter(
        block => !SKIP_IN_PREAMBLE.some(pattern => pattern.test(block))
    );
    if (intro.length < 2) {
        throw new Error(
            `Expected a tagline and supporting sentence above the first "## " in README.md.`
        );
    }

    return {
        tagline: render(intro[0]),
        supporting: render(intro[1]),
    };
}

// ─── A markdown subset ─────────────────────────────────────────────────────

// Deliberately partial: it handles the one extracted region
// contain and throws on anything else. A page that silently prints raw
// asterisks, or swallows a list, is worse than a build that stops — and the
// alternative, pulling in a full markdown parser, would be the repo's first
// runtime dependency.
function render(markdown) {
    const out = [];
    const lines = markdown.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;

        // Fenced code. The opening fence's info string is kept as a class so
        // the page could highlight later; nothing inside is interpreted.
        const fence = /^```(\w*)\s*$/.exec(line);
        if (fence) {
            const body = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
            if (i >= lines.length) throw new Error('Unterminated ``` fence in an extracted section.');
            const lang = fence[1] ? ` class="lang-${fence[1]}"` : '';
            out.push(`<pre${lang}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
            continue;
        }

        // A GFM table: a header row, an alignment row, then body rows.
        if (line.trimStart().startsWith('|')) {
            const block = [];
            while (i < lines.length && lines[i].trimStart().startsWith('|')) block.push(lines[i++]);
            i--;
            out.push(renderTable(block));
            continue;
        }

        // Anything else is a paragraph, gathered until a blank line.
        const block = [];
        while (i < lines.length && lines[i].trim() !== '') {
            reject(lines[i]);
            block.push(lines[i++]);
        }
        i--;
        out.push(`<p>${inline(block.join(' '))}</p>`);
    }

    return out.join('\n');
}

// Block constructs that would be silently mangled if they ever appeared inside
// one of the extracted regions. Each is cheap to add support for; failing is
// the point, so that adding one is a decision rather than an accident.
const UNSUPPORTED = [
    [/^\s*>/, 'blockquote'],
    [/^\s*[-*+]\s/, 'bullet list'],
    [/^\s*\d+\.\s/, 'numbered list'],
    [/^#{1,6}\s/, 'heading'],
    [/^\s*(?:[-*_]\s*){3,}$/, 'thematic break'],
    [/^\s{4,}\S/, 'indented code block'],
    [/<[a-zA-Z/]/, 'raw HTML'],
    [/!\[/, 'image'],
];

function reject(line) {
    for (const [pattern, what] of UNSUPPORTED) {
        if (pattern.test(line)) {
            throw new Error(
                `docs/build.mjs cannot render a ${what}, and one appeared in an extracted ` +
                    `README section:\n  ${line.trim()}\n` +
                    `Either keep it out of that section or teach render() about it.`
            );
        }
    }
}

function renderTable(block) {
    const rows = block.map(splitRow);
    if (rows.length < 2 || !rows[1].every(cell => /^:?-{1,}:?$/.test(cell.trim()))) {
        throw new Error('A table in an extracted section has no alignment row.');
    }

    // Cells are trimmed: the README pads them to line the pipes up in a text
    // editor, and that padding has no business reaching the page.
    const head = rows[0].map(cell => `<th>${inline(cell.trim())}</th>`).join('');
    const body = rows
        .slice(2)
        .map(
            cells =>
                `<tr>${cells
                    .map(cell => `<td${cellClass(cell)}>${inline(cell.trim())}</td>`)
                    .join('')}</tr>`
        )
        .join('\n');

    return [
        // The support matrix is the one thing on the page that can outgrow a
        // phone, so it scrolls inside its own box rather than pushing the body
        // sideways.
        '<div class="scroll-x">',
        '<table>',
        `<thead><tr>${head}</tr></thead>`,
        `<tbody>\n${body}\n</tbody>`,
        '</table>',
        '</div>',
    ].join('\n');
}

// "| a | b |" -> ["a", "b"]. Leading and trailing pipes are delimiters, not
// empty cells.
function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

// The support matrix marks a feature with ✅ or —, which the page needs to
// colour and to centre. Tagging it here keeps that knowledge out of the CSS,
// which would otherwise have to guess from cell contents.
function cellClass(cell) {
    const text = cell.trim();
    if (text === '✅') return ' class="yes"';
    if (text === '—' || text === '-') return ' class="no"';
    return '';
}

// Inline spans, innermost first: code before emphasis, so `**` inside a code
// span is left alone.
//
// Code spans are parked behind an index while the rest is processed, delimited
// by NUL because the delimiter has to be something the README cannot contain. A
// printable one such as " 3 " would collide with ordinary prose, and "capped at
// 200 entries" would come back with that number replaced by a code span.
function inline(markdown) {
    const code = [];
    let text = markdown.replace(/`([^`]+)`/g, (_, body) => {
        code.push(`<code>${escapeHtml(body)}</code>`);
        return `\0${code.length - 1}\0`;
    });

    text = escapeHtml(text)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

    const leftover = /\*\*?/.exec(text);
    if (leftover) {
        throw new Error(`Unbalanced emphasis in an extracted README section:\n  ${markdown.trim()}`);
    }

    return text.replace(/\0(\d+)\0/g, (_, index) => code[Number(index)]);
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── The 12px floor ────────────────────────────────────────────────────────

// No text on the page may render below this. Enforced by measuring the built
// page rather than by reading the stylesheet, because the sizes are in rem and
// clamp() and the only number that matters is the one that reaches the screen.
const MIN_FONT_PX = 12;

async function checkFontFloor() {
    const { chromium } = await import('playwright');

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
        await page.goto(pathToFileURL(join(SITE, 'index.html')).href, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);

        const tooSmall = await page.evaluate(min => {
            const found = [];
            for (const el of document.body.querySelectorAll('*')) {
                // Only leaves hold text; a wrapper's font-size is inherited by
                // children that may override it. And aria-hidden marks
                // decoration, which is exempt by decision.
                if (el.closest('[aria-hidden="true"]')) continue;
                const text = Array.from(el.childNodes)
                    .filter(n => n.nodeType === Node.TEXT_NODE)
                    .map(n => n.textContent.trim())
                    .join('');
                if (!text) continue;

                const px = parseFloat(getComputedStyle(el).fontSize);
                if (px < min) {
                    found.push({
                        tag: el.tagName.toLowerCase(),
                        cls: el.className || '',
                        px,
                        sample: text.slice(0, 40),
                    });
                }
            }
            return found;
        }, MIN_FONT_PX);

        if (tooSmall.length) {
            console.error(`Text below the ${MIN_FONT_PX}px floor:\n`);
            for (const f of tooSmall) {
                const where = f.cls ? `${f.tag}.${f.cls}` : f.tag;
                console.error(`  ${f.px}px  ${where}  "${f.sample}"`);
            }
            console.error('');
            throw new Error(`${tooSmall.length} element(s) render text below ${MIN_FONT_PX}px.`);
        }

        console.log(`  check every text node renders at ${MIN_FONT_PX}px or larger`);
    } finally {
        await browser.close();
    }
}

// ─── Screenshots ───────────────────────────────────────────────────────────

async function renderShots() {
    // Lazy so --check never needs Playwright installed.
    const { chromium } = await import('playwright');

    await mkdir(SHOTS, { recursive: true });
    const sizes = {};
    const browser = await chromium.launch();
    try {
        for (const shot of SHOT_LIST) {
            const page = await browser.newPage({
                viewport: { width: shot.width, height: shot.height },
                deviceScaleFactor: SCALE,
            });
            await page.goto(pathToFileURL(join(MOCKS, `${shot.name}.html`)).href, {
                waitUntil: 'load',
            });

            // Masked icons and webfonts both land after load; without this the
            // first shot of a cold run can catch an unstyled row.
            await page.evaluate(() => document.fonts.ready);

            const mock = page.locator('.mock');
            const count = await mock.count();
            if (count !== 1) {
                throw new Error(`${shot.name}.html has ${count} .mock elements, expected exactly 1.`);
            }

            const path = join(SHOTS, `${shot.name}.png`);
            await mock.screenshot({ path });
            await page.close();

            // Read back rather than trusting the bounding box: it is fractional,
            // and these numbers become the img width/height that keep the page
            // from reflowing as the screenshots load.
            const png = await readFile(path);
            sizes[shot.name] = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
            console.log(
                `  shot  docs/shots/${shot.name}.png  ` +
                    `${sizes[shot.name].width}×${sizes[shot.name].height}`
            );
        }
    } finally {
        await browser.close();
    }

    return sizes;
}

// ─── The staleness guard ───────────────────────────────────────────────────

// The PNGs are committed because README.md points at them, and GitHub renders
// the README from the repo rather than from a build. So they can rot: edit a
// mock, forget to re-render, and the live page (which CI rebuilds) moves on
// while the README's images do not.
//
// Comparing PNG bytes would be the obvious check and is the wrong one — two
// chromium builds do not agree to the byte. Hashing the *inputs* instead is
// exact and stable. Only mocks/ is hashed, not this file: changing the
// extraction logic cannot change a pixel, and pretending otherwise would
// invalidate the shots on every unrelated edit.
async function hashMocks() {
    const names = (await readdir(MOCKS)).sort();
    const hashes = {};
    for (const name of names) {
        const bytes = await readFile(join(MOCKS, name));
        hashes[name] = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    }
    return hashes;
}

async function check() {
    const current = await hashMocks();

    let recorded;
    try {
        recorded = JSON.parse(await readFile(MANIFEST, 'utf8')).mocks;
    } catch {
        fail(['docs/shots/manifest.json is missing or unreadable.']);
    }

    const problems = [];
    for (const name of Object.keys(current)) {
        if (!(name in recorded)) problems.push(`new mock, never rendered: docs/mocks/${name}`);
        else if (recorded[name] !== current[name]) problems.push(`changed since rendering: docs/mocks/${name}`);
    }
    for (const name of Object.keys(recorded)) {
        if (!(name in current)) problems.push(`rendered from a mock that no longer exists: docs/mocks/${name}`);
    }

    if (problems.length) fail(problems);
    console.log(`docs/shots: up to date with ${Object.keys(current).length} mock files.`);
}

function fail(problems) {
    console.error('The committed screenshots are out of date:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nRun `node docs/build.mjs` and commit docs/shots/.');
    process.exit(1);
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function build() {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    const parts = extract(readme);

    const sizes = await renderShots();
    await writeFile(MANIFEST, `${JSON.stringify({ mocks: await hashMocks() }, null, 2)}\n`);

    const template = await readFile(join(DOCS, 'index.template.html'), 'utf8');
    let page = template;
    for (const [key, html] of Object.entries(parts)) {
        const placeholder = `<!-- cb:${key} -->`;
        if (!page.includes(placeholder)) {
            throw new Error(`index.template.html is missing the ${placeholder} placeholder.`);
        }
        page = page.replace(placeholder, html);
    }

    // Intrinsic sizes come from the PNGs that were just written, so the template
    // never carries a number that a re-render could invalidate.
    page = page.replace(/<img\s+src="shots\/([\w-]+)\.png"/g, (tag, name) => {
        const size = sizes[name];
        if (!size) {
            throw new Error(
                `index.template.html shows shots/${name}.png, which no entry in SHOT_LIST produces.`
            );
        }
        return `${tag} width="${size.width}" height="${size.height}"`;
    });

    const missed = /<!--\s*cb:(\w+)\s*-->/.exec(page);
    if (missed) {
        throw new Error(
            `index.template.html asks for <!-- cb:${missed[1]} -->, which build.mjs does not produce.`
        );
    }

    // Rebuilt from scratch so a renamed shot cannot linger in the published
    // site after it has stopped being referenced.
    await rm(SITE, { recursive: true, force: true });
    await mkdir(join(SITE, 'shots'), { recursive: true });
    await mkdir(join(SITE, 'assets'), { recursive: true });
    await writeFile(join(SITE, 'index.html'), page);
    for (const shot of SHOT_LIST) {
        await copyFile(join(SHOTS, `${shot.name}.png`), join(SITE, 'shots', `${shot.name}.png`));
    }
    await copyFile(join(DOCS, 'assets', 'omelette.png'), join(SITE, 'assets', 'omelette.png'));
    console.log(`  site  docs/_site/index.html  (+ ${SHOT_LIST.length} images, 1 app icon)`);

    await checkFontFloor();
}

const mode = process.argv[2];
if (mode === '--check') await check();
else if (mode === undefined) await build();
else {
    console.error(`Usage: node docs/build.mjs [--check]`);
    process.exit(2);
}
