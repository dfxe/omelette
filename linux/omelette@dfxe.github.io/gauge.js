// The circular battery gauge.
//
// This is the extension's only custom drawing, and it has to be: an arc cannot
// be faked faithfully with a styled St widget. That
// leaves St.DrawingArea and Cairo.
//
// Colours come from the stylesheet as custom theme properties rather than being
// written here, so .cb-ring stays the one place they are defined.

import St from 'gi://St';
import cairo from 'gi://cairo';

// Below this the percentage reads better without the sign — at 32px there is
// room for "85" and not for "85%".
const PERCENT_SIGN_MIN_PX = 44;

// Battery thresholds. Matched to the Shell's own low/critical battery points so
// a red ring here means the same thing it means in the system menu.
const WARN_BELOW = 50;
const LOW_BELOW = 20;

// Clutter.Color became Cogl.Color in GNOME 47, and the two disagree about
// channel scale: one stores 0–255 bytes, the other 0–1 floats. metadata.json
// claims 45 through 49, so detect rather than assume. Any channel above 1 can
// only be a byte; the stylesheet deliberately avoids near-black values like
// rgb(1,1,1), which is the one case this cannot tell apart.
function rgbaOf(color, fallback) {
    if (!color) return fallback;
    const { red, green, blue, alpha } = color;
    if ([red, green, blue, alpha].some(c => typeof c !== 'number')) return fallback;

    const scale = (red > 1 || green > 1 || blue > 1 || alpha > 1) ? 255 : 1;
    return [red / scale, green / scale, blue / scale, alpha / scale];
}

// lookup_color rather than get_color: the latter warns and returns garbage for
// a property the theme never defined, and a user stylesheet may well not.
function themeColor(node, name, fallback) {
    try {
        const [found, color] = node.lookup_color(name, true);
        if (found) return rgbaOf(color, fallback);
    } catch (_) {
        // Custom property unsupported on this Shell — fall through.
    }
    return fallback;
}

function levelColor(node, percent) {
    if (percent < LOW_BELOW)
        return themeColor(node, '-cb-ring-low', [0.88, 0.11, 0.14, 1]);
    if (percent < WARN_BELOW)
        return themeColor(node, '-cb-ring-warn', [0.96, 0.76, 0.07, 1]);
    return themeColor(node, '-cb-ring-fill', [0.21, 0.52, 0.89, 1]);
}

// A ring showing `percent` of a full turn, with the number in the middle.
// `size` is the actor's side in pixels; the stroke and the type scale with it,
// so the same widget works at 32px in a result row and at 56px in the panel.
export function makeRing({ percent, size = 32, showLabel = true, styleClass = '' }) {
    const pct = Math.max(0, Math.min(100, Math.round(percent ?? 0)));

    const area = new St.DrawingArea({
        style_class: styleClass ? `cb-ring ${styleClass}` : 'cb-ring',
        width: size,
        height: size,
        accessible_name: `${pct}%`,
    });

    area.connect('repaint', () => {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const node = area.get_theme_node();

            const stroke = Math.max(2, Math.round(size / 8));
            const cx = w / 2;
            const cy = h / 2;
            // Half a stroke in from the edge, or the arc's outer half clips.
            const radius = Math.max(1, Math.min(w, h) / 2 - stroke / 2 - 1);

            cr.setLineWidth(stroke);
            cr.setLineCap(cairo.LineCap.ROUND);

            // newPath() before each arc: arc() draws a line from the current
            // point to where the arc begins, so any leftover point — from a
            // previous shape, or from text if these are ever reordered — comes
            // out as a stray spoke across the gauge.
            //
            // Track: the full circle, so an almost-empty battery still reads as
            // a gauge rather than as a stray tick.
            const track = themeColor(node, '-cb-ring-track', [0.5, 0.5, 0.5, 0.28]);
            cr.newPath();
            cr.setSourceRGBA(...track);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            if (pct > 0) {
                // From twelve o'clock, clockwise, the way every battery dial and
                // progress ring reads.
                const start = -Math.PI / 2;
                cr.newPath();
                cr.setSourceRGBA(...levelColor(node, pct));
                cr.arc(cx, cy, radius, start, start + 2 * Math.PI * (pct / 100));
                cr.stroke();
            }

            if (showLabel) {
                const text = size >= PERCENT_SIGN_MIN_PX ? `${pct}%` : `${pct}`;
                cr.selectFontFace('Sans', cairo.FontSlant.NORMAL, cairo.FontWeight.BOLD);
                cr.setFontSize(Math.max(8, Math.round(size * 0.3)));

                const fg = rgbaOf(node.get_foreground_color(), [1, 1, 1, 1]);
                cr.setSourceRGBA(...fg);

                // Centre on the ink, not the advance: the bearings are what put
                // "9" and "100" in the same visual place.
                const ext = cr.textExtents(text);
                cr.moveTo(cx - ext.width / 2 - ext.xBearing,
                          cy - ext.height / 2 - ext.yBearing);
                cr.showText(text);
            }
        } catch (e) {
            logError(e, 'omelette: ring repaint failed');
        } finally {
            // GJS will not free the Cairo context for us, and this redraws on
            // every keystroke that rebuilds the list.
            cr.$dispose();
        }
    });

    return area;
}
