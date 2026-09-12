// Starting omelette-edit, and listening to what it says.
//
// The house rule for subprocesses is set by pdfRunner.js — argv arrays never
// shell strings, always asynchronous — and this follows it with one deliberate
// difference, called out here because the codebase documents its deviations.
//
// pdfRunner uses communicate_utf8_async because poppler is a short-lived filter
// whose stderr *is* the error message. That is exactly wrong for a window: it
// only delivers at exit, so it would hold two pipe FDs and a GSubprocess
// reference inside the compositor for as long as the user has the editor open,
// and then deliver into a callback that may belong to a torn-down Indicator.
// Here stderr is inherited (GTK and GJS warnings belong in the journal, where
// anyone debugging will look for them) and stdout is read a line at a time.
//
// == The line protocol ==
//
// The editor prints `saved\t<path>` or `copy\t<path>` when it writes a file.
//
// `copy` exists because clipboard ownership on X11 belongs to a process: if the
// editor took the clipboard itself, closing the window would empty it, and
// GNOME ships no clipboard manager to hold the bytes. gnome-shell does not
// exit, so it is the right owner — and it already has the one correct routine
// for this in clipboardUtil.copyPngFile, which also tells the monitor to ignore
// the write so the image does not come straight back in as a new history entry.
//
// == Lifetime ==
//
// The child is deliberately not tied to the extension. A window someone is
// drawing in should survive disable(), a shell restart, or the extension being
// switched off, so nothing here ever kills it. reset() only cancels our *reads*
// — cancelling a Gio.Cancellable does not signal the process — which is the
// orphaning behaviour we want.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// The console interpreter, which is not the same package as the one gnome-shell
// itself needs: the Shell links libgjs, so an extension can run without
// /usr/bin/gjs ever being installed. Checked rather than assumed, or launching
// the editor fails silently on a stock install.
const TOOL = 'gjs';

// A failure this soon after spawning is a failure to start. Later than this and
// the process ran and then exited, which is the user closing a window.
const STARTUP_GRACE_US = 2_000_000;

let _missing = null;
let _cancellable = null;

export function missingTools() {
    _missing ??= GLib.find_program_in_path(TOOL) ? [] : [TOOL];
    return _missing;
}

// Called from both enable() and disable(): module state survives an extension
// reload, so a stale answer here would outlive the reload that was meant to
// pick up a newly installed gjs.
export function reset() {
    _missing = null;
    _cancellable?.cancel();
    _cancellable = null;
}

function cancellable() {
    _cancellable ??= new Gio.Cancellable();
    return _cancellable;
}

// One line at a time, so a report is acted on the moment the editor makes it
// rather than when the window is finally closed.
function readReports(proc, onReport) {
    const stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
    const token = _cancellable;

    const pump = () => {
        stream.read_line_utf8_async(GLib.PRIORITY_DEFAULT, token, (source, res) => {
            let line;
            try {
                [line] = source.read_line_utf8_finish(res);
            } catch (_) {
                // Cancelled, or the pipe died with the process. Either way
                // there is nothing left to read and nothing worth reporting.
                return;
            }
            if (line === null) {
                try { source.close(null); } catch (_) { /* already gone */ }
                return;
            }
            // Tab-separated: a path can contain spaces, but a tab or a newline
            // in one is not a case worth supporting.
            const tab = line.indexOf('\t');
            if (tab > 0) onReport?.(line.slice(0, tab), line.slice(tab + 1));
            pump();
        });
    };
    pump();
}

// `onReport(kind, path)` fires per completed write; `onError(e)` only for a
// failure to start.
export function open(imagePath, { extensionPath, outDir }, { onReport, onError } = {}) {
    const missing = missingTools();
    if (missing.length > 0) {
        onError?.(new Error(`The editor needs ${missing[0]}. Install the ${missing[0]} package.`));
        return;
    }

    const argv = [TOOL, '-m', GLib.build_filenamev([extensionPath, 'editor', 'main.js'])];
    if (outDir) argv.push('--out-dir', outDir);
    // Last, and only if there is one: with no path the editor puts up its own
    // file chooser. Absolute, because gnome-shell's working directory is /.
    if (imagePath) argv.push(imagePath);

    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
    } catch (e) {
        onError?.(e);
        return;
    }

    readReports(proc, onReport);

    const startedAt = GLib.get_monotonic_time();
    proc.wait_check_async(cancellable(), (p, res) => {
        try {
            p.wait_check_finish(res);
        } catch (e) {
            if (e instanceof Gio.IOErrorEnum || e.code === Gio.IOErrorEnum.CANCELLED) return;
            // A non-zero exit long after launch is a window that closed badly,
            // which the user has already seen. Only a prompt failure means it
            // never came up at all, and that is worth saying.
            if (GLib.get_monotonic_time() - startedAt < STARTUP_GRACE_US) onError?.(e);
        }
    });
}
