#!/usr/bin/env -S gjs -m
//
// omelette-edit — annotate a screenshot.
//
//     gjs -m main.js [--out-dir DIR] [IMAGE]
//
// A separate process, deliberately. The obvious alternative — drawing into the
// popup with St actors — puts a canvas, hit-testing and an undo stack inside
// gnome-shell, where a mistake does not throw an exception, it freezes the
// desktop. It also means this whole file can be run straight from a terminal
// with a real stack trace on stderr, which is most of why it was buildable
// without restarting the shell once.
//
// == Talking back to the extension ==
//
// One line per completed write on stdout: `saved\t<path>` or `copy\t<path>`.
//
// The clipboard is the reason this exists rather than the editor simply owning
// it. On X11 clipboard ownership belongs to a *process*: copy here, close the
// window, and the clipboard is empty — GNOME ships no clipboard manager to hold
// the bytes. gnome-shell does not exit, so it is the right owner, and it
// already has the one correct routine for this (clipboardUtil.copyPngFile,
// which also tells the monitor to ignore the write so the image does not come
// straight back in as a new history entry).
//
// Tab-separated because a path may contain spaces but not a tab or a newline in
// any case worth supporting, and one line per event survives partial reads.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

import { EditorWindow, installSwatchCss } from './window.js';
import { defaultOutDir, readableImage } from './exportImage.js';
import { dataDir } from '../dataDir.js';
import { defaultScreenshotsDir } from '../screenshotStore.js';

const APP_ID = 'io.github.dfxe.OmeletteEdit';
const APP_ICON = 'omelette';

// Where this file sits, so the icon theme can be pointed at the sibling
// icons/ directory however the extension was installed.
function hereDir() {
    return GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
}

// argv is `[IMAGE]` plus optional flags. Kept to a hand-rolled parse rather
// than GOption because there are two options and GOption's GJS binding costs
// more lines than it saves.
function parseArgs(argv) {
    let path = null;
    let outDir = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out-dir') outDir = argv[++i] ?? null;
        else if (arg.startsWith('--out-dir=')) outDir = arg.slice('--out-dir='.length);
        else if (!arg.startsWith('-') && path === null) path = arg;
    }
    return { path, outDir };
}

function report(kind, path) {
    // print() rather than a Gio stream: it is line-buffered and flushed, which
    // is exactly the contract the reader on the other end depends on.
    print(`${kind}\t${path}`);
}

function openWindow(app, { path, outDir }) {
    let pixbuf;
    try {
        pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    } catch (e) {
        const alert = new Gtk.AlertDialog({
            message: 'That image could not be opened.',
            detail: e.message ?? String(e),
        });
        alert.show(app.get_active_window());
        return;
    }

    const resolved = outDir ?? defaultOutDir(path, {
        vaultImagesDir: GLib.build_filenamev([dataDir(), 'images']),
        screenshotsDir: defaultScreenshotsDir(),
    });

    const win = new EditorWindow(app, {
        pixbuf,
        sourcePath: path,
        outDir: resolved,
        onExport: report,
    });
    win.set_icon_name(APP_ICON);
    win.present();
}

// No image on the command line — the command bar's "Open an image…" row, or a
// bare launch from a terminal. A Gtk.FileDialog here is why filePortal.js did
// not have to grow an image mode: the portal exists because gnome-shell cannot
// put up a GTK dialog, and this process is a GTK app.
function chooseImage(app, outDir) {
    const filter = new Gtk.FileFilter({ name: 'Images' });
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
        filter.add_mime_type(type);

    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
    filters.append(filter);

    const dialog = new Gtk.FileDialog({ title: 'Choose an image', filters, default_filter: filter });
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
    if (pictures) dialog.set_initial_folder(Gio.File.new_for_path(pictures));

    // Hold the application alive across the dialog: with no window yet, the
    // last unref would otherwise quit before anything was chosen.
    app.hold();
    dialog.open(null, null, (source, res) => {
        try {
            const file = source.open_finish(res);
            if (file) openWindow(app, { path: file.get_path(), outDir });
        } catch (_) {
            // Dismissed. Nothing to say — the same way _capture() stays quiet
            // about an abandoned SelectArea.
        } finally {
            app.release();
        }
    });
}

const app = new Adw.Application({
    application_id: APP_ID,
    // Without this a second launch registers as remote and fires `activate` on
    // the primary instance with its arguments silently dropped — so clicking
    // edit on a second screenshot would raise the first one and open nothing.
    // HANDLES_OPEN forwards files but not options, which leaves no room for
    // --out-dir.
    flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
});

app.connect('startup', () => {
    installSwatchCss();
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        .add_search_path(GLib.build_filenamev([hereDir(), '..', 'icons']));
});

app.connect('command-line', (_a, commandLine) => {
    const { path, outDir } = parseArgs(commandLine.get_arguments().slice(1));

    if (path && !readableImage(path)) {
        commandLine.printerr(`omelette-edit: no such file: ${path}\n`);
        commandLine.set_exit_status(1);
        return 1;
    }

    if (!path) chooseImage(app, outDir);
    else {
        // Editing one file in two windows would give two windows racing to
        // write the same output path, so raise the one that is already open.
        const open = app.get_windows().find(w => w.sourcePath === path);
        if (open) open.present();
        else openWindow(app, { path, outDir });
    }

    commandLine.set_exit_status(0);
    return 0;
});

// programInvocationName is 'gjs'; ARGV holds only what followed the script.
app.run([System.programInvocationName, ...ARGV]);
