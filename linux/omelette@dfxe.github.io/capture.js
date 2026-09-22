import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { SelectArea, Flashspot } from 'resource:///org/gnome/shell/ui/screenshot.js';

// Extensions run inside the Shell. Its D-Bus screenshot service restricts
// callers to approved applications, so even a call from the Shell's own bus
// connection is rejected. Use the in-process APIs instead; screenshot.js has
// already promisified Shell.Screenshot's capture methods.
function afterMenuCloses() {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function capture(destPath, selectArea, onDone) {
    let stream = null;
    let pathUsed = null;
    let error = null;
    try {
        // Let the popup fade out and release its grab before capturing or
        // asking SelectArea to take a new grab.
        await afterMenuCloses();
        const area = selectArea ? await new SelectArea().selectAsync() : null;
        if (selectArea && !area)
            throw new Error('Screenshot selection cancelled');

        const file = Gio.File.new_for_path(destPath);
        stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shooter = new Shell.Screenshot();
        // SelectArea returns stage coordinates, which the native capture API
        // accepts directly. D-Bus's scale/unscale conversions are unnecessary.
        const [capturedArea] = area
            ? await shooter.screenshot_area(area.x, area.y, area.width, area.height, stream)
            : await shooter.screenshot(false, stream);
        stream.close(null);
        stream = null;
        pathUsed = destPath;
        new Flashspot(capturedArea).fire();
    } catch (e) {
        error = e;
    } finally {
        if (stream) {
            try { stream.close(null); }
            catch (_) { /* Preserve the original capture error. */ }
        }
    }
    onDone(pathUsed, error);
}

// onDone(pathUsed | null, error | null). Existing callers ingest the finished
// PNG into the vault and clipboard; the screenshot folder watcher also sees it.
export function captureFull(destPath, onDone) {
    void capture(destPath, false, onDone);
}

export function captureArea(destPath, onDone) {
    void capture(destPath, true, onDone);
}
