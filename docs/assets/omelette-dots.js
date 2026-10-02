// The footer's omelette: the app icon redrawn as an ordered-dither stipple of
// square dots, with a little dust scattered around it. Drawn from the icon at
// load time, so the art follows the icon if it ever changes.

const CELL = 3; // CSS px per dot cell
const ART = 300; // CSS px the omelette spans
const SOURCE = 'assets/omelette.png';

// The icon sits on a near-black rounded tile (luminance ~0.1-0.2). Anything
// that dark is left empty so the tile never shows up as a block of dots; the
// cast-iron rim and handle are only slightly brighter, and the egg is the only
// warm colour in the picture.
const TILE_LUM = 0.19;
const RIM_LUM = 0.45;

// 8×8 Bayer matrix, the classic ordered-dither pattern.
const BAYER = (() => {
    const m = [[0]];
    let size = 1;
    let out = m;
    while (size < 8) {
        const next = [];
        for (let y = 0; y < size * 2; y++) {
            next.push([]);
            for (let x = 0; x < size * 2; x++) {
                const base = out[y % size][x % size] * 4;
                const quadrant = [0, 2, 3, 1][(y < size ? 0 : 2) + (x < size ? 0 : 1)];
                next[y].push(base + quadrant);
            }
        }
        out = next;
        size *= 2;
    }
    return out;
})();

const clamp01 = v => Math.min(Math.max(v, 0), 1);

// Seeded so the dust lands in the same places on every visit.
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shadeColor(shade) {
    // Dim warm grey through to cream, matching the page's Yolk palette.
    const lo = [96, 84, 72];
    const hi = [246, 232, 204];
    const c = lo.map((l, i) => Math.round(l + (hi[i] - l) * shade));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function buildDots(img, cols, rows) {
    const artCells = Math.round(ART / CELL);
    const ox = Math.floor((cols - artCells) / 2);
    const oy = rows - artCells;

    const off = document.createElement('canvas');
    off.width = artCells;
    off.height = artCells;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, artCells, artCells);
    const px = octx.getImageData(0, 0, artCells, artCells).data;

    const dots = [];
    for (let y = 0; y < artCells; y++) {
        for (let x = 0; x < artCells; x++) {
            const i = (y * artCells + x) * 4;
            const alpha = px[i + 3] / 255;
            if (alpha < 0.5) continue;
            const lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

            // The egg reads as dense cream, the pan as a sparse, dim stipple,
            // and the tile behind them as nothing.
            const warmth = (px[i] - px[i + 2]) / 255;
            const egg = warmth > 0.3 ? clamp01(0.35 + ((lum - 0.4) / 0.5) * 0.65) : 0;
            const pan = egg ? 0 : clamp01((lum - TILE_LUM) / (RIM_LUM - TILE_LUM)) * 0.6;
            const density = Math.max(egg, pan);
            const threshold = (BAYER[y % 8][x % 8] + 0.5) / 64;
            if (density > threshold) {
                dots.push({ x: ox + x, y: oy + y, shade: egg ? 0.5 + egg * 0.5 : 0.2 + pan * 0.5 });
            }
        }
    }

    // Dust: thickest just around the omelette, thinning out toward the edges.
    const rand = rng(1254);
    const cx = ox + artCells / 2;
    const cy = oy + artCells / 2;
    const reach = Math.max(cols, rows) * 0.55;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const inside = x >= ox && x < ox + artCells && y >= oy && y < oy + artCells;
            if (inside) continue;
            const d = Math.hypot((x - cx) * 0.8, y - cy) / reach;
            if (rand() < 0.035 * Math.pow(clamp01(1 - d), 2.2)) {
                dots.push({ x, y, shade: 0.15 + rand() * 0.35 });
            }
        }
    }
    return dots;
}

function init() {
    const canvas = document.getElementById('footer-omelette');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.src = SOURCE;

    let dots = [];
    let shown = 0;
    let started = false;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const layout = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cols = Math.floor(canvas.clientWidth / CELL);
        const rows = Math.floor(canvas.clientHeight / CELL);
        if (cols <= 0 || rows <= 0 || !img.complete || !img.naturalWidth) return false;
        canvas.width = cols * CELL * dpr;
        canvas.height = rows * CELL * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        dots = buildDots(img, cols, rows);
        // Shuffle once so the reveal fades in as a scatter, not a scanline.
        const rand = rng(7);
        for (let i = dots.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [dots[i], dots[j]] = [dots[j], dots[i]];
        }
        return true;
    };

    const paint = count => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < count; i++) {
            const d = dots[i];
            ctx.fillStyle = shadeColor(d.shade);
            ctx.fillRect(d.x * CELL, d.y * CELL, CELL - 1, CELL - 1);
        }
    };

    const reveal = () => {
        if (reduced) {
            shown = dots.length;
            paint(shown);
            return;
        }
        const start = performance.now();
        const step = now => {
            const t = clamp01((now - start) / 1400);
            shown = Math.round(dots.length * (1 - Math.pow(1 - t, 3)));
            paint(shown);
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    };

    const start = () => {
        if (started || !layout()) return;
        started = true;
        reveal();
    };

    img.addEventListener('load', () => {
        if (!('IntersectionObserver' in window)) return start();
        const io = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) {
                io.disconnect();
                start();
            }
        });
        io.observe(canvas);
    });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (!started || !layout()) return;
            shown = dots.length;
            paint(shown);
        }, 150);
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
