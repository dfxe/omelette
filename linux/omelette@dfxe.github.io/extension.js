import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ScreenshotStore, resolveScreenshotsDir } from './screenshotStore.js';
import { ClipboardMonitor } from './clipboardMonitor.js';
import { VaultStore } from './vaultStore.js';
import * as Capture from './capture.js';
import * as ColorPicker from './colorPicker.js';
import * as Paste from './paste.js';
import * as Currency from './currency.js';
import * as Sensors from './sensors.js';
import * as PdfRunner from './pdfRunner.js';
import * as FilePortal from './filePortal.js';
import * as Awake from './awake.js';
import * as EditorLauncher from './editorLauncher.js';
import * as Voce from './voce.js';
import { makeRing } from './gauge.js';
import { buildSensorsPanel } from './sensorsPanel.js';
import { buildPdfPanel } from './pdfPanel.js';
import { runSearch, totalResults } from './searchRegistry.js';
import { historyProvider, screenshotProvider } from './historyProvider.js';
import { answerProvider } from './answerProvider.js';
import { aboutProvider } from './aboutProvider.js';
import { quicklinkProvider } from './quicklinkProvider.js';
import { snippetProvider } from './snippetProvider.js';
import { emojiProvider } from './emojiProvider.js';
import { sensorsProvider } from './sensorsProvider.js';
import { pdfProvider } from './pdfProvider.js';
import { awakeProvider } from './awakeProvider.js';
import { editProvider } from './editProvider.js';
import {
    seedQuicklinksOnce, loadSnippets, saveSnippets, loadQuicklinks, newId,
} from './configStore.js';
import { ingestText, copyPngFile } from './clipboardUtil.js';

const KEYBINDINGS = [
    'toggle-menu', 'capture-area', 'capture-full', 'pick-color',
    'open-snippets', 'open-emoji', 'open-sensors', 'open-pdf',
    'toggle-awake', 'open-editor', 'voce-hold', 'voce-toggle',
];

// Search sources, in the order their sections appear in the popup. The tools
// added on top of clipboard history slot in ahead of it, Raycast-style: an
// answer or an exact snippet match is almost always what you meant, and history
// is what you fall back to browsing.
const PROVIDERS = [
    aboutProvider,
    answerProvider,
    quicklinkProvider,
    snippetProvider,
    emojiProvider,
    sensorsProvider,
    awakeProvider,
    pdfProvider,
    editProvider,
    historyProvider,
    screenshotProvider,
];

// How long the copied-row flash stays up. Activating a row closes the popup, so
// that path only needs long enough to register; a button that leaves the popup
// open holds the state until it would start to feel stuck.
const FLASH_CLOSE_MS = 420;
const FLASH_REVERT_MS = 1100;

// Typing rebuilds the whole list, and with several providers scoring their
// candidates that is worth coalescing across a fast burst of keystrokes.
const SEARCH_DEBOUNCE_MS = 80;

// How far Page Up/Down jump through the result list.
const PAGE_STEP = 8;

// Breathing room added to the measured chrome height, and the value used before
// the menu has ever been allocated (the first open).
const CHROME_PADDING_PX = 24;
const CHROME_FALLBACK_PX = 260;

const SEARCH_HINT = 'Find it, work it out, or just type…';

// What the search box says when the popup was opened by a tool's own shortcut.
// A map rather than a conditional so adding a tool cannot silently label itself
// as one of the others.
const SCOPE_HINTS = {
    snippet: 'Search snippets…',
    emoji: 'Search emoji and symbols…',
    sensors: 'Search devices and fans…',
    pdf: 'Pick a PDF, then a page range…',
    awake: 'Keep the screen awake for…',
    edit: 'Pick an image to annotate…',
};

// Scopes that open into a panel instead of a list of rows. A table for the same
// reason SCOPE_HINTS is one: a second `if` here is how a third tool ends up
// silently drawing the second tool's dashboard.
//
// Not a member on the provider, tempting as that is — providers must never
// import St (searchRegistry.js:6-8) and every builder here does. Each returns
// { actor, holdsFocus?, focus?, onEscape?, update? }, or null to fall through
// to ordinary rows and let the provider's emptyMessage explain why.
const PANELS = {
    sensors: (ctx, indicator) => {
        const actor = buildSensorsPanel(ctx.sensors?.());
        return actor ? { actor } : null;
    },
    pdf: (ctx, indicator) => indicator._buildPdfPanel(),
};


function revealInFiles(path) {
    try {
        const dir = GLib.path_get_dirname(path);
        Gio.AppInfo.launch_default_for_uri(`file://${dir}`, null);
    } catch (e) {
        Main.notifyError('Omelette', e.message ?? String(e));
    }
}

// GNOME 46 dropped St.ScrollView.add_actor in favour of a single child slot;
// 45 still only has add_actor. Cover both so the extension works across 45–47.
function setScrollChild(scrollView, child) {
    if (typeof scrollView.set_child === 'function') scrollView.set_child(child);
    else scrollView.add_actor(child);
}

// Scroll `actor` into view. The Shell used to export this from misc/util.js but
// no longer does (extensions that need it, like the shipped ubuntu-dock, carry
// their own copy), so here is ours. Same 45-vs-46 split as setScrollChild:
// St.ScrollView.vscroll was deprecated in favour of a direct .vadjustment.
function ensureVisible(scrollView, actor) {
    const adj = scrollView.vadjustment ?? scrollView.vscroll?.adjustment;
    if (!adj) return;

    // Allocation boxes are parent-relative, so walk up to the scroll view
    // accumulating offsets to get the actor's position within the scrolled area.
    let box;
    try { box = actor.get_allocation_box(); }
    catch (_) { return; }
    let y1 = box.y1;
    let y2 = box.y2;
    for (let parent = actor.get_parent(); parent && parent !== scrollView; parent = parent.get_parent()) {
        const pbox = parent.get_allocation_box();
        y1 += pbox.y1;
        y2 += pbox.y1;
    }

    const { value, pageSize, upper } = adj;
    if (y1 < value) adj.set_value(Math.max(0, y1));
    else if (y2 > value + pageSize) adj.set_value(Math.min(Math.max(0, upper - pageSize), y2 - pageSize));
}

// A single-line title that ellipsizes instead of forcing the popup wider (the
// scroll region is width-capped, so long text would otherwise clip on the right).
function nameLabel(text, extraClass) {
    const label = new St.Label({
        text,
        style_class: extraClass ? `cb-name ${extraClass}` : 'cb-name',
        x_expand: true,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

// Whether this Shell understands -st-accent-color, which arrived in GNOME 47
// while metadata.json still claims 45. Asks the settings schema rather than
// parsing a version string: the accent keyword and the accent-color key landed
// together, and a capability check cannot drift from the Shell that is actually
// running the way a hardcoded version list can.
function accentColorSupported() {
    try {
        return new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' })
            .settings_schema.has_key('accent-color');
    } catch (_) {
        return false;
    }
}

// A provider title above its group of results. PopupSeparatorMenuItem draws the
// text as a plain label at body size, which reads as one more row; .cb-section
// shrinks and dims it into a heading. The class goes on the item rather than on
// the separator's own .label, so the stylesheet reaches the text with a type
// selector and nothing here depends on that internal staying put.
function sectionHeader(title) {
    const item = new PopupMenu.PopupSeparatorMenuItem(title);
    item.add_style_class_name('cb-section');
    return item;
}

// A compact icon button for the per-row Pin / Delete actions. St.Button consumes
// the click, so it never also triggers the row's recopy activation.
function iconButton(iconName, styleClass, onClick) {
    const btn = new St.Button({
        style_class: `cb-row-btn ${styleClass}`,
        can_focus: true,
        child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
    });
    btn.connect('clicked', () => { onClick(); return Clutter.EVENT_STOP; });
    return btn;
}

// A native symbolic icon and label for the two primary capture actions. Keeping
// this as a real actor tree (rather than a Unicode glyph in the label) lets the
// Shell theme recolour the whole button and keeps the text accessible.
function labelledButtonContent(iconName, label) {
    const box = new St.BoxLayout({
        style_class: 'cb-button-content',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(new St.Icon({ icon_name: iconName, icon_size: 16 }));
    box.add_child(new St.Label({
        text: label,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return box;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Omelette');

        this._vault = null;
        this._screenshots = null;
        this._monitor = null;
        this._settings = null;
        this._uuid = null;

        this._scrollView = null;
        this._listSection = null;
        this._searchEntry = null;
        this._capturedId = 0;
        this._focusIdleId = 0;
        this._pauseToggle = null;
        this._clearItem = null;
        this._revealItem = null;
        this._quitItem = null;
        this._filter = '';
        this._pausedChangedId = 0;
        this._pendingFlash = null;
        this._flashId = 0;
        this._searchDebounceId = 0;
        // Lazily filled from GSettings; see invalidateConfigCache().
        this._snippetCache = null;
        this._quicklinkCache = null;
        // Rebuilds are held while a row is activating; see _suspendRefresh().
        this._refreshSuspended = false;
        this._refreshPending = null;

        // Command-bar selection. `_rows` is the flat, display-ordered list of
        // activatable rows (section headers excluded) that the arrow keys walk;
        // `_selected` indexes into it. Selection is drawn by us rather than
        // handed to the menu's own key focus, which stays on the search entry.
        this._rows = [];
        this._selected = 0;
        this._pendingPaste = null;
        this._focusWmClass = null;
        this._scope = null;

        // A panel that owns a text entry also owns the keyboard, and rebuilds
        // are held for as long as it is on screen; see _panelHold in refresh().
        this._panel = null;
        this._panelHold = false;
        this._destroyed = false;

        // The PDF tool's working state. In memory rather than GSettings: which
        // document you were part-way through is not a preference, it should not
        // outlive the session, and a file path in dconf is not 0600-protected
        // the way vault.json is. It has to live out here rather than in the
        // panel because the panel is destroyed and rebuilt around it — the
        // popup closes while the file chooser is up.
        this._pdf = {
            path: null, name: '', pageCount: 0, encrypted: false,
            pages: '', error: '', missing: [],
        };

        // The mark is a file shipped with the extension rather than a stock
        // icon name, so it needs the extension's path — which arrives with
        // setContext(). Start on the stock icon so the panel is never empty if
        // that call never comes, or if the file has gone missing.
        this._panelIcon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._panelIcon);

        // Command-bar keys have to be caught here rather than on the search
        // entry, because PopupMenuManager connects its own 'captured-event' to
        // this same actor and closes the menu on Escape (popupMenu.js
        // _onCapturedEvent) — the capture phase runs before the focused entry
        // ever sees the key. Connecting in _init() puts us ahead of the manager
        // in connection order, since the manager only connects when
        // Main.panel.addToStatusArea() runs, which is after we are constructed.
        this._capturedId = this.menu.actor.connect('captured-event',
            (_actor, event) => this._onCapturedEvent(event));

        // Cap the list height against the current monitor whenever the popup
        // opens, so a long history scrolls instead of overflowing the screen.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                // Sample the paste target now, while it is still unambiguous —
                // by the time a row is activated the focus window may have
                // moved, and we need its class to pick Ctrl+V vs Ctrl+Shift+V.
                this._focusWmClass =
                    global.display.get_focus_window()?.get_wm_class() ?? null;
                // BlueZ signals and the fan tick only run while the popup is up.
                // Nothing polls a machine nobody is looking at.
                Sensors.startWatching(this._settings);
                // Rebuild unconditionally. The list is otherwise only rebuilt on
                // a store change or a keystroke, so a popup reopened after a
                // scoped session would still be showing that tool's rows.
                this.refresh({ resetSelection: true });
                this._syncScrollHeight();
                // Take focus now, then once more after PopupMenuManager has
                // completed this open signal. Some Shell versions assign their
                // default menu focus later in the same turn, stealing the first
                // grab when the panel icon itself opened the popup.
                this._focusInput();
                this._queueFocusInput();
            } else {
                this._cancelFocusInput();
                // Drop any in-flight copy flash, so a row we closed on early
                // isn't still lit up the next time the popup opens.
                this._cancelFlash();
                // Before _scope is cleared below: the panel is what holds
                // rebuilds off, and the refresh on the next open must not find
                // a stale one still claiming the keyboard.
                this._releasePanel();
                Sensors.stopWatching();
                // Before clearing the entry, not after: set_text('') fires
                // text-changed synchronously, which refreshes — and that
                // refresh must not run with _scope still pointing at a tool.
                this._scope = null;
                this._filter = '';
                if (this._searchEntry) {
                    this._searchEntry.set_text('');
                    this._searchEntry.hint_text = SEARCH_HINT;
                }
                // A paste armed by the row we just activated fires here, once
                // the popup is really gone and focus is back on the target
                // window. Anything still pending from an abandoned interaction
                // is dropped.
                this._firePendingPaste();
            }
        });
    }

    // Open the popup restricted to one tool, for the snippet/emoji shortcuts.
    // Scoping rather than pre-filling a prefix character keeps the query box
    // holding only what the user actually typed.
    openForTool(scope) {
        // Before refresh(), or the outgoing panel's hold blocks the rebuild
        // that is meant to replace it.
        this._releasePanel();
        this._scope = scope;
        this._filter = '';
        if (this._searchEntry) {
            this._searchEntry.set_text('');
            this._searchEntry.hint_text = SCOPE_HINTS[scope] ?? SEARCH_HINT;
        }
        // Refresh here as well as in the open handler: when the popup is
        // already open, menu.open() is a no-op and never fires it.
        this.refresh({ resetSelection: true });
        this.menu.open(BoxPointer.PopupAnimation.FULL);
        this._focusInput();
    }

    _clearScope() {
        if (!this._scope) return false;
        this._releasePanel();
        this._scope = null;
        if (this._searchEntry) this._searchEntry.hint_text = SEARCH_HINT;
        this.refresh({ resetSelection: true });
        // Load-bearing, not tidiness: the rebuild just destroyed the actor that
        // held key focus, and focus then falls to the stage — where key events
        // never reach menu.actor, so _onCapturedEvent stops firing and the
        // popup goes deaf to every key including Escape.
        this._focusInput();
        return true;
    }

    // A panel with its own text entry has already grabbed the keyboard from
    // inside refresh(); taking it back here would undo that a frame later.
    _focusInput() {
        if (this._panelHold) return;
        // Target the editable ClutterText directly. Focusing the St.Entry
        // wrapper is theme/version-dependent and can leave the caret inactive.
        this._searchEntry?.clutter_text.grab_key_focus();
    }

    _queueFocusInput() {
        this._cancelFocusInput();
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._focusIdleId = 0;
            if (!this._destroyed && this.menu.isOpen)
                this._focusInput();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelFocusInput() {
        if (!this._focusIdleId) return;
        GLib.source_remove(this._focusIdleId);
        this._focusIdleId = 0;
    }

    _releasePanel() {
        this._panel = null;
        this._panelHold = false;
    }

    _onCapturedEvent(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;

        // Ignore anything held down but Lock/NumLock, so Ctrl+A and friends
        // still reach the entry untouched.
        const state = event.get_state() &
            ~(Clutter.ModifierType.LOCK_MASK | Clutter.ModifierType.MOD2_MASK) &
            Clutter.ModifierType.MODIFIER_MASK;
        if (state !== 0) return Clutter.EVENT_PROPAGATE;

        // A panel with its own text entry owns the keyboard. _rows is empty by
        // construction on that path, so there is no selection for the arrows to
        // steer and no row for Enter to activate — every key but Escape belongs
        // to whichever field has focus.
        if (this._panelHold && event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;

        switch (event.get_key_symbol()) {
        case Clutter.KEY_Down:
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._moveSelection(PAGE_STEP);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._moveSelection(-PAGE_STEP);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            if (this._rows.length === 0) return Clutter.EVENT_PROPAGATE;
            // Act on the selection even if a debounced rebuild is still queued,
            // so a fast type-then-Enter can't fire against a stale list.
            this._flushSearchDebounce();
            this._activateSelected();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Escape:
            // Escape peels one layer at a time: a panel's own field, then the
            // query, then the tool scope, then the popup itself. Propagating is
            // what lets the menu manager close.
            if (this._panel?.onEscape?.()) return Clutter.EVENT_STOP;
            if (this._searchEntry && this._searchEntry.get_text() !== '') {
                this._searchEntry.set_text('');
                return Clutter.EVENT_STOP;
            }
            if (this._clearScope()) return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _snippets() {
        this._snippetCache ??= loadSnippets(this._settings);
        return this._snippetCache;
    }

    _quicklinks() {
        this._quicklinkCache ??= loadQuicklinks(this._settings);
        return this._quicklinkCache;
    }

    // Called from the changed::snippets / changed::quicklinks handlers, which
    // fire both for prefs-window edits and for our own use-count bumps.
    invalidateConfigCache() {
        this._snippetCache = null;
        this._quicklinkCache = null;
    }

    // Everything a provider needs to search and to act. Rebuilt per use so it
    // always reflects the current stores.
    _ctx() {
        return {
            vault: this._vault,
            screenshots: this._screenshots,
            monitor: this._monitor,
            settings: this._settings,
            // A thunk, not a table: resolving it can hit the network, and this
            // context is rebuilt on every refresh — including the empty-query
            // one that runs when the popup opens. calc.js calls it only once a
            // query has parsed as a currency conversion, which is what the
            // "fetches only when you type one" promise in the README rests on.
            //
            // Null unless the user opted into currency conversion. May resolve
            // to a stale table; calc.js labels it with its age rather than
            // hiding it.
            rates: codes => Currency.ratesFor(this._settings, () => {
                // Fresh rates arrived after the query was drawn — redraw so the
                // answer stops saying "unavailable".
                if (this.menu.isOpen) this.refresh();
            }, codes),
            // A thunk for the same reason as rates: resolving it can talk to
            // BlueZ, and this context is rebuilt on every keystroke. What comes
            // back is whatever sensors.js already holds — never a blocking read.
            // Null unless the user left system readings switched on.
            sensors: () => Sensors.snapshot(this._settings, () => {
                // A battery ticked over or a fan changed speed after the rows
                // were drawn — redraw so the numbers stay honest.
                if (this.menu.isOpen) this.refresh();
            }),
            // Both lists were being re-read from GSettings — get_strv plus a
            // JSON.parse per entry — on every keystroke. They only change when
            // the prefs window writes, which we already watch for.
            snippets: this._snippets(),
            quicklinks: this._quicklinks(),
            requestPaste: opts => this._armPaste(opts),
            saveSnippet: text => this._saveSnippet(text),
            // Both read by the About section only, which is why they are plain
            // values rather than anything the search path has to resolve.
            version: this._version,
            openPreferences: this._openPreferences,
            // Set when the popup was opened by a tool-specific shortcut; lets a
            // provider list everything it has instead of waiting for a query.
            scope: this._scope,
            // Lets a row switch the popup into a tool's own panel, the way
            // openPreferences lets one leave for another window entirely.
            openTool: scope => this.openForTool(scope),
            // A thunk, like rates and sensors: this walks PATH, and the context
            // is rebuilt on every keystroke. Cached inside pdfRunner.
            pdfMissing: () => PdfRunner.missingTools(),
            // Same shape, same reason — cached inside editorLauncher.
            editorMissing: () => EditorLauncher.missingTools(),
            // Closes the popup itself; see _openEditor for why a row cannot do
            // that by returning { close: true }.
            openEditor: path => this._openEditor(path),
        };
    }

    // Open an image in omelette-edit.
    //
    // The popup is closed *first*, and here rather than by the caller, for two
    // reasons. While the popup holds its modal grab a new window appears but
    // never receives a click — filePortal.js documents the same trap, and
    // _browsePdf closes for the same reason. And a row *action* cannot close
    // the popup on its own: the action handler in _makeResultRow only acts on
    // `outcome.message`, so a `{ close: true }` returned from one is dropped.
    _openEditor(path) {
        this.menu.close(BoxPointer.PopupAnimation.FULL);

        EditorLauncher.open(path, {
            extensionPath: this._path,
            outDir: this._captureDir(),
        }, {
            onReport: (kind, saved) => this._onEditorSaved(kind, saved),
            onError: e => {
                if (this._destroyed) return;
                Main.notifyError('Omelette', e.message ?? String(e));
            },
        });
    }

    // The editor finished writing a file. It saves into the screenshots folder,
    // which the ScreenshotStore already watches, so `saved` needs nothing doing
    // — the row appears on its own.
    //
    // `copy` is the case the editor cannot handle itself: on X11 clipboard
    // ownership dies with the process that took it, and closing the editor
    // would empty the clipboard. gnome-shell does not exit, so it owns the
    // write, through the one routine that also tells the monitor to ignore it.
    _onEditorSaved(kind, path) {
        if (this._destroyed || kind !== 'copy') return;
        copyPngFile(path, this._monitor);
    }

    // Promote a history entry to a snippet. Deliberately unlabelled and without
    // a keyword — naming it is a job for the preferences window, and demanding
    // that here would turn a one-click action into a dialog.
    _saveSnippet(text) {
        if (!this._settings || !text) return null;
        const body = text;
        const snippets = loadSnippets(this._settings);
        if (snippets.some(s => s.body === body))
            return { message: 'Already got that one' };
        snippets.push({ id: newId(), keyword: '', label: '', body, uses: 0 });
        saveSnippets(this._settings, snippets);
        return { message: 'Saved it as a snippet' };
    }

    // A provider calls ctx.requestPaste() at the exact moment the clipboard
    // actually holds its content — synchronously for text, from inside the file
    // read for an image. We only note it here; the keystroke itself has to wait
    // until the popup is gone and focus is back on the target window.
    _armPaste(opts = {}) {
        if (!this._settings?.get_boolean('auto-paste')) return;
        this._pendingPaste = { leftPresses: 0, ...opts };
        // The row that armed this may have closed the menu already (an image
        // read can finish after the flash), in which case fire now.
        if (!this.menu.isOpen) this._firePendingPaste();
    }

    _firePendingPaste() {
        const pending = this._pendingPaste;
        this._pendingPaste = null;
        if (!pending) return;
        Paste.pasteInto({
            wmClass: this._focusWmClass,
            settings: this._settings,
            leftPresses: pending.leftPresses,
        });
    }

    setContext({ vault, screenshots, monitor, settings, uuid, version, path, openPreferences }) {
        this._vault = vault;
        this._screenshots = screenshots;
        this._monitor = monitor;
        this._settings = settings;
        this._uuid = uuid;
        this._version = version ?? '';
        // Needed to find both the editor script and the icons directory, and
        // only the Extension object knows where it was installed.
        this._path = path ?? null;
        // Opening the prefs window is an Extension method, and the Indicator has
        // no handle on the Extension — so it arrives as a thunk.
        this._openPreferences = openPreferences ?? null;
        this._applyPanelIcon();
        this._buildMenu();
    }

    // Swap the stock icon for the omelette mark now that we know where it is.
    //
    // The symbolic mark shares the website and application logo while adapting
    // its colour to the current GNOME panel theme.
    _applyPanelIcon() {
        if (!this._path) return;
        const file = GLib.build_filenamev([this._path, 'icons', 'omelette-symbolic.svg']);
        if (!GLib.file_test(file, GLib.FileTest.EXISTS)) return;
        this._panelIcon.set_gicon(Gio.icon_new_for_string(file));
    }

    // Reflect Keep awake in the top bar. A glow rather than a different icon,
    // so the mark stays the extension's identity either way — and an
    // accessible_name alongside it, because a visual change alone says nothing
    // to a screen reader.
    _syncAwakeIcon() {
        const on = this._settings?.get_boolean('awake') ?? false;
        if (on) this._panelIcon.add_style_class_name('cb-awake');
        else this._panelIcon.remove_style_class_name('cb-awake');
        this.set_accessible_name(on ? 'Omelette — keeping awake' : 'Omelette');
    }

    // Build the persistent popup chrome once. Only the middle list is rebuilt on
    // every content change (see refresh) so the search entry keeps its focus and
    // text across rebuilds.
    _buildMenu() {
        this.menu.removeAll();

        this.menu.box.add_style_class_name('cb-menu');
        if (!this._appearanceSettings) {
            this._appearanceSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.interface',
            });
            this._appearanceChangedId = this._appearanceSettings.connect(
                'changed::color-scheme', () => this._syncAppearance());
        }
        this._syncAppearance();

        // Gates every -st-accent-color rule in the stylesheet on one ancestor
        // class, so on a Shell that never heard of the keyword those selectors
        // simply do not match. The alternative — a literal and the keyword as
        // two declarations of the same property — relies on the parser
        // discarding the one it cannot read, which would leave the element with
        // no colour at all if it instead stored it and failed to resolve later.
        if (accentColorSupported())
            this.menu.box.add_style_class_name('cb-accent');

        this.menu.addMenuItem(this._makeSearchRow());
        this.menu.addMenuItem(this._makeCaptureRow());

        this._pauseToggle = new PopupMenu.PopupSwitchMenuItem('Pause monitoring',
            this._settings ? this._settings.get_boolean('paused') : false);
        this._pauseToggle.add_style_class_name('cb-status-item');
        this._pauseToggle.connect('toggled', (_i, state) =>
            this._settings?.set_boolean('paused', state));
        if (this._settings) {
            this._pausedChangedId = this._settings.connect('changed::paused', () =>
                this._pauseToggle.setToggleState(this._settings.get_boolean('paused')));
        }
        this.menu.addMenuItem(this._pauseToggle);

        // Writes the setting and stops. Everything about the inhibitor itself —
        // acquiring it, the deadline, releasing it — is reconciled by one
        // `changed::awake` handler in enable(), so this switch, the shortcut,
        // the command-bar rows and the preferences window cannot disagree.
        this._awakeToggle = new PopupMenu.PopupSwitchMenuItem('Keep awake',
            this._settings ? this._settings.get_boolean('awake') : false);
        this._awakeToggle.add_style_class_name('cb-status-item');
        this._awakeToggle.connect('toggled', (_i, state) => {
            // Clear any deadline: the switch means "until I turn it off".
            // Leaving a stale one would expire the new hold immediately.
            this._settings?.set_int64('awake-until', 0);
            this._settings?.set_boolean('awake', state);
        });
        if (this._settings) {
            this._awakeChangedId = this._settings.connect('changed::awake', () => {
                this._awakeToggle.setToggleState(this._settings.get_boolean('awake'));
                this._syncAwakeIcon();
            });
        }
        this.menu.addMenuItem(this._awakeToggle);
        this._syncAwakeIcon();

        // The two variable-length lists live inside a single scroll view whose
        // height is capped on open (see _syncScrollHeight). Without this the
        // popup grows past the bottom of the screen and clips.
        this._listSection = new PopupMenu.PopupMenuSection();
        const scrollView = new St.ScrollView({
            style_class: 'cb-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            hscrollbar_policy: St.PolicyType.NEVER,
        });
        setScrollChild(scrollView, this._listSection.actor);
        const scrollWrapper = new PopupMenu.PopupMenuSection();
        scrollWrapper.actor.add_child(scrollView);
        this.menu.addMenuItem(scrollWrapper);
        this._scrollView = scrollView;

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._clearItem = new PopupMenu.PopupMenuItem('Clear history');
        this._clearItem.add_style_class_name('cb-footer-item');
        this._clearItem.connect('activate', () => this._vault?.clear());
        this.menu.addMenuItem(this._clearItem);

        this._revealItem = new PopupMenu.PopupMenuItem('Reveal newest in Files');
        this._revealItem.add_style_class_name('cb-footer-item');
        this._revealItem.connect('activate', () => {
            const shots = this._screenshots ? this._screenshots.entries : [];
            if (shots.length > 0) revealInFiles(shots[0]);
        });
        this.menu.addMenuItem(this._revealItem);

        // Unlike the vault/screenshot rows, this one doesn't override activate():
        // PopupMenuBase's default close-on-activate is exactly what we want here.
        this._quitItem = new PopupMenu.PopupMenuItem('Quit');
        this._quitItem.add_style_class_name('cb-footer-item');
        this._quitItem.connect('activate', () => this._quit());
        this.menu.addMenuItem(this._quitItem);

        this.refresh();
    }

    // An extension has no process to terminate, so Quit means "turn the
    // extension off" — the same thing the Extensions app toggle does. Going
    // through the Shell's own D-Bus method rather than Main.extensionManager
    // keeps this on the public interface; either way it writes
    // enabled-extensions/disabled-extensions, so it stays off across a reboot.
    //
    // Our own disable() runs as a *result* of that settings write, on a later
    // main loop turn, which is what makes calling this from inside a click
    // handler safe — nothing tears down this actor while the emission is still
    // unwinding. The call is fire-and-forget for the same reason: any reply
    // would land after we've been destroyed.
    //
    // Notify first, while we're still here to do it. Once the panel icon is
    // gone there's no in-UI way back, so the notification has to carry it.
    _quit() {
        if (!this._uuid) return;
        Main.notify('Omelette',
            `Turned off. Re-enable with: gnome-extensions enable ${this._uuid}`);
        Gio.DBus.session.call(
            'org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions',
            'DisableExtension', new GLib.Variant('(s)', [this._uuid]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    // Rebuild only the middle list by asking every provider for results at the
    // current query, then laying them out as headed sections.
    // `resetSelection` means "this is a new query, start at the top". It has to
    // be passed explicitly: _rows below still holds the *previous* rebuild's
    // rows, so a caller that just set _selected = 0 would have us read the old
    // top row's id and then chase it into the new list.
    refresh({ resetSelection = false } = {}) {
        if (!this._listSection) return;

        // An activation is in flight. Rebuilding now would destroy the row that
        // is about to show (or is showing) its ✓ confirmation — which is why
        // "Copied answer" and "Saved as snippet" were invisible: both mutate a
        // store, whose 'changed' signal lands here synchronously inside run().
        // Remember the rebuild and let _resumeRefresh() run it.
        if (this._refreshSuspended) {
            this._refreshPending = {
                resetSelection: (this._refreshPending?.resetSelection ?? false) || resetSelection,
            };
            return;
        }

        // A panel holding a live text entry is not rebuildable. Unlike a flash
        // there is nothing to replay afterwards — a rebuild takes the field and
        // whatever was half-typed into it — and the refresh sources here fire
        // on their own schedule: the fan tick alone lands every couple of
        // seconds while the popup is open. So this rebuild is dropped, not
        // queued. The three transitions that end a panel — leaving the scope,
        // entering another tool, closing the popup — all call _releasePanel()
        // first, so nothing can be held off indefinitely.
        //
        // The cost is that a copy landing while the panel is up doesn't update
        // the list underneath. Neither is on screen, so nothing looks stale.
        if (this._panelHold) return;

        // Remember what was selected so a rebuild triggered by a background
        // store change (a fresh copy landing) doesn't move the highlight out
        // from under the user mid-keystroke.
        const previousId = resetSelection
            ? null
            : this._rows[this._selected]?.result.id ?? null;

        this._releasePanel();
        this._listSection.removeAll();
        this._rows = [];

        const ctx = this._ctx();

        // Some shortcuts open into a panel rather than a list: seeing every
        // battery at once, or a file to pick and a range to type, is the whole
        // reason to ask. Typing falls through to ordinary rows, and so does a
        // builder returning null — which leaves the provider's emptyMessage to
        // explain why the popup is empty.
        const panel = this._filter === ''
            ? PANELS[this._scope]?.(ctx, this) ?? null
            : null;

        if (panel) {
            this._listSection.addMenuItem(sectionHeader(
                PROVIDERS.find(p => p.id === this._scope)?.title ?? ''));
            // Nothing here is activatable, so it stays out of _rows and the
            // arrow keys skip straight past it. can_focus/reactive stay false
            // on the item itself even when the panel inside it has a focusable
            // entry, so PopupBaseMenuItem's hover-to-grab_key_focus path stays
            // disarmed and the entry keeps focus on its own terms.
            const item = new PopupMenu.PopupBaseMenuItem({
                activate: false, hover: false, can_focus: false, reactive: false,
            });
            item.add_child(panel.actor);
            this._listSection.addMenuItem(item);
            this._panel = panel;
            this._panelHold = panel.holdsFocus === true;
            panel.focus?.();
        } else {
            const providers = this._scope
                ? PROVIDERS.filter(p => p.id === this._scope)
                : PROVIDERS;
            const groups = runSearch(providers, this._filter, ctx);

            for (const group of groups) {
                this._listSection.addMenuItem(sectionHeader(group.provider.title));

                if (group.results.length === 0) {
                    this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(
                        group.emptyMessage, { reactive: false }));
                    continue;
                }

                for (const result of group.results) {
                    const row = this._makeResultRow(result);
                    this._listSection.addMenuItem(row.item);
                    this._rows.push(row);
                }
            }

            // With a query, empty sections are hidden rather than each printing
            // its own "No matches" — so say it once, for the whole bar.
            if (this._filter !== '' && totalResults(groups) === 0) {
                this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(
                    'Nothing matches that.', { reactive: false }));
            }
        }

        const restored = previousId === null
            ? -1
            : this._rows.findIndex(r => r.result.id === previousId);
        this._setSelected(restored >= 0 ? restored : 0, { scroll: false });

        const hasItems = this._vault ? this._vault.items.length > 0 : false;
        const hasShots = this._screenshots ? this._screenshots.entries.length > 0 : false;
        this._clearItem?.setSensitive(hasItems);
        this._revealItem?.setSensitive(hasShots);

        // Content can change while the popup is open (a fresh copy triggers a
        // rebuild); re-apply the cap so the new scroll view is bounded too.
        if (this.menu.isOpen) this._syncScrollHeight();
    }

    // --- Selection -------------------------------------------------------
    //
    // Key focus stays on the search entry the whole time — moving it into the
    // menu items would fight PopupMenuBase's own navigation and cost the entry
    // its text cursor. So selection is ours to track and ours to draw.

    _setSelected(index, { scroll = true } = {}) {
        const clamped = this._rows.length === 0
            ? 0
            : Math.max(0, Math.min(index, this._rows.length - 1));

        const previous = this._rows[this._selected];
        if (previous && this._selected !== clamped)
            previous.item.remove_style_class_name('cb-selected');

        this._selected = clamped;

        const current = this._rows[clamped];
        if (!current) return;
        current.item.add_style_class_name('cb-selected');
        if (scroll && this._scrollView) ensureVisible(this._scrollView, current.item.actor);
    }

    _moveSelection(delta) {
        if (this._rows.length === 0) return;
        this._setSelected(this._selected + delta);
    }

    _activateSelected() {
        this._rows[this._selected]?.item.activate();
    }

    _syncAppearance() {
        const scheme = this._appearanceSettings?.get_string('color-scheme') ?? 'default';
        const light = scheme === 'prefer-light';
        this.menu.box.remove_style_class_name(light ? 'cb-dark' : 'cb-light');
        this.menu.box.add_style_class_name(light ? 'cb-light' : 'cb-dark');
    }

    _syncScrollHeight() {
        if (!this._scrollView) return;
        let index = Main.layoutManager.findIndexForActor(this);
        if (index < 0) index = Main.layoutManager.primaryIndex;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(index);
        if (!workArea) return;
        // Reserve space for the panel plus everything outside the scroll region.
        // Measuring the fixed rows rather than hardcoding a number keeps this
        // honest as chrome is added — the old constant was already drifting.
        const reserved = Main.panel.height + this._chromeHeight();
        const maxHeight = Math.max(160, workArea.height - reserved);
        this._scrollView.style = `max-height: ${maxHeight}px;`;
    }

    // Height of every menu item except the one holding the scroll view. Falls
    // back to a sane constant before the menu has been allocated, which is the
    // case the very first time the popup opens.
    _chromeHeight() {
        const scrollParent = this._scrollView?.get_parent();
        let total = 0;
        for (const child of this.menu.box.get_children()) {
            if (child === scrollParent) continue;
            total += child.get_preferred_height(-1)[1];
        }
        return total > 0 ? total + CHROME_PADDING_PX : CHROME_FALLBACK_PX;
    }

    _makeSearchRow() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const entry = new St.Entry({
            style_class: 'cb-search',
            hint_text: SEARCH_HINT,
            can_focus: true,
            x_expand: true,
        });

        entry.clutter_text.connect('text-changed', () => {
            const text = entry.get_text();
            // Every keystroke re-runs every provider and rebuilds every row, so
            // coalesce a fast burst into one rebuild. A cleared box refreshes
            // immediately — that path is cheap and the delay would be visible.
            this._cancelSearchDebounce();
            if (text === '') {
                this._filter = '';
                this.refresh({ resetSelection: true });
                return;
            }
            this._searchDebounceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                    this._searchDebounceId = 0;
                    this._filter = entry.get_text();
                    // A new query means the old selection is meaningless; start
                    // at the top so Enter always hits the best match.
                    this.refresh({ resetSelection: true });
                    return GLib.SOURCE_REMOVE;
                });
        });

        this._searchEntry = entry;
        item.add_child(entry);
        return item;
    }

    _cancelSearchDebounce() {
        if (!this._searchDebounceId) return;
        GLib.source_remove(this._searchDebounceId);
        this._searchDebounceId = 0;
    }

    // Apply a queued query now instead of waiting out the debounce.
    _flushSearchDebounce() {
        if (!this._searchDebounceId) return;
        this._cancelSearchDebounce();
        this._filter = this._searchEntry ? this._searchEntry.get_text() : '';
        this.refresh({ resetSelection: true });
    }

    _makeCaptureRow() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ x_expand: true, style_class: 'cb-btn-row' });

        const area = new St.Button({
            child: labelledButtonContent('camera-photo-symbolic', 'Area'),
            x_expand: true, can_focus: true,
            style_class: 'cb-capture-btn button',
            accessible_name: 'Capture an area',
        });
        area.connect('clicked', () => { this.menu.close(); this._capture('area'); });

        const screen = new St.Button({
            child: labelledButtonContent('video-display-symbolic', 'Screen'),
            x_expand: true, can_focus: true,
            style_class: 'cb-capture-btn button',
            accessible_name: 'Capture the full screen',
        });
        screen.connect('clicked', () => { this.menu.close(); this._capture('full'); });

        // An eyedropper rather than a third labelled button. Picking a colour is
        // a different kind of act from capturing a region, and at icon size it
        // stops competing with the two captures for the row — which is also why
        // it is the one button here that does not x_expand.
        const color = new St.Button({
            can_focus: true,
            style_class: 'cb-pick-btn button',
            child: new St.Icon({ icon_name: 'color-select-symbolic', icon_size: 16 }),
            accessible_name: 'Pick a color from the screen',
        });
        color.connect('clicked', () => { this.menu.close(); this._pickColor(); });

        this._voceButtonIcon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic', icon_size: 16,
        });
        this._voceButton = new St.Button({
            can_focus: true,
            toggle_mode: true,
            style_class: 'cb-pick-btn cb-voce-btn button',
            child: this._voceButtonIcon,
            accessible_name: 'Start dictation',
        });
        this._voceButton.connect('clicked', () => {
            // Close first so the overlay is the only Shell surface left and
            // the focused application remains the paste target.
            this.menu.close();
            Voce.toggle();
        });

        box.add_child(area);
        box.add_child(screen);
        box.add_child(color);
        box.add_child(this._voceButton);
        item.add_child(box);
        return item;
    }

    _captureDir() {
        return resolveScreenshotsDir(this._settings);
    }

    _capture(mode) {
        const dir = this._captureDir();
        GLib.mkdir_with_parents(dir, 0o755);
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
        const destPath = GLib.build_filenamev([dir, `Screenshot from ${stamp}.png`]);

        const onDone = (pathUsed, err) => {
            if (err || !pathUsed) {
                if (err && err.message?.includes('cancel')) return; // user aborted SelectArea
                Main.notifyError('Omelette', err?.message ?? 'Screenshot failed');
                return;
            }
            this._ingestCaptured(pathUsed);
        };

        if (mode === 'area') Capture.captureArea(destPath, onDone);
        else Capture.captureFull(destPath, onDone);
    }

    _ingestCaptured(path) {
        const base = GLib.path_get_basename(path);
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            let ok, bytes;
            try { [ok, bytes] = file.load_contents_finish(res); }
            catch (_) { return; }
            if (!ok) return;
            const item = this._vault?.add({
                kind: 'image', bytes, contentType: 'image/png', title: base,
            });
            if (item) this._monitor?.ignore(item.fingerprint);
            St.Clipboard.get_default().set_content(
                St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));

            // Off by default. When on, the capture still lands in history and
            // on the clipboard exactly as before — the editor is additional,
            // not a replacement, so turning it on cannot lose a capture.
            if (this._settings?.get_boolean('edit-after-capture')) {
                this._openEditor(path);
                return;
            }
            Main.notify('Omelette', `Captured ${base}`);
        });
    }

    // --- The PDF tool ----------------------------------------------------

    _buildPdfPanel() {
        this._pdf.missing = PdfRunner.missingTools();
        return buildPdfPanel(this._pdf, {
            onBrowse: () => this._browsePdf(),
            onExtract: range => this._extractPdf(range),
        });
    }

    // The popup holds a Shell modal grab, so the portal's file chooser would
    // appear and then ignore every click and keystroke. Close first — the same
    // trade the Area and Screen buttons make — and reopen once a file comes
    // back.
    _browsePdf() {
        this.menu.close(BoxPointer.PopupAnimation.FULL);
        FilePortal.pickPdf((path, err) => {
            if (this._destroyed) return;
            if (err) {
                Main.notifyError('Omelette', err.message ?? String(err));
                return;
            }
            // No path and no error is a cancelled dialog. Stay as quiet about
            // it as _capture() is about an abandoned SelectArea.
            if (!path) return;

            this._pdf.path = path;
            this._pdf.name = GLib.path_get_basename(path);
            this._pdf.pageCount = 0;
            this._pdf.encrypted = false;
            this._pdf.error = '';
            this.openForTool('pdf');

            PdfRunner.readInfo(path, (info, infoErr) => {
                if (this._destroyed || this._pdf.path !== path) return;
                if (infoErr) {
                    this._pdf.error = infoErr.message ?? String(infoErr);
                } else {
                    this._pdf.pageCount = info.pageCount;
                    this._pdf.encrypted = info.encrypted;
                }
                // Update in place rather than refreshing: a rebuild here would
                // destroy the range field the user may already be typing into.
                this._panel?.update?.(this._pdf);
            });
        });
    }

    _extractPdf({ first, last }) {
        const source = this._pdf.path;
        if (!source) return;

        // Extraction outlives the popup, so close now and report through a
        // notification, the way a capture does.
        this.menu.close(BoxPointer.PopupAnimation.FULL);
        PdfRunner.extractRange({ source, first, last }, (dest, err) => {
            if (this._destroyed) return;
            if (err || !dest) {
                Main.notifyError('Omelette', err?.message ?? 'Could not extract those pages.');
                return;
            }
            const pages = first === last ? `page ${first}` : `pages ${first}–${last}`;
            Main.notify('Omelette', `Extracted ${pages} to ${GLib.path_get_basename(dest)}`);
        });
    }

    _pickColor() {
        ColorPicker.pickColor((hex, err) => {
            if (err) {
                Main.notifyError('Omelette', err.message ?? 'Color pick failed');
                return;
            }
            // No hex and no error means Escape or a right click — stay as quiet
            // as _capture() does about a cancelled SelectArea.
            if (!hex) return;
            this._ingestColor(hex);
        });
    }

    // A pick can complete while the popup is closed, so unlike the row copies
    // this one still notifies — there is no row to flash.
    _ingestColor(hex) {
        // No paste here: the picker runs with the popup closed, and typing a
        // colour into whatever happens to have focus is not what anyone means
        // by "pick a colour".
        ingestText(hex, { ...this._ctx(), requestPaste: null }, { store: true, title: hex });
        Main.notify('Omelette', `Copied ${hex}`);
    }

    // Confirm a copy on the row the user actually clicked: highlight the row,
    // pop the thumbnail, and swap the hint line for a checkmark. `close` closes
    // the popup once the flash has been seen — row activation used to close it
    // instantly (see the activate() override below), which left no room for any
    // feedback at all.
    _flash({ item, hint, thumb, message, close = false }) {
        this._cancelFlash();

        const previousHint = hint.text;
        item.add_style_class_name('cb-copied');
        hint.text = `✓ ${message}`;
        hint.add_style_class_name('cb-hint-ok');

        if (St.Settings.get().enable_animations) {
            thumb.remove_all_transitions();
            // Without a pivot the icon would scale out of its top-left corner.
            thumb.set_pivot_point(0.5, 0.5);
            thumb.ease({
                scale_x: 1.12, scale_y: 1.12,
                duration: 110,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => thumb.ease({
                    scale_x: 1, scale_y: 1,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                }),
            });
        }

        const flash = {
            item,
            destroyId: 0,
            undo: () => {
                item.remove_style_class_name('cb-copied');
                hint.text = previousHint;
                hint.remove_style_class_name('cb-hint-ok');
                thumb.remove_all_transitions();
                thumb.set_scale(1, 1);
            },
        };
        // refresh() rebuilds the whole list on any store change; if that lands
        // mid-flash these actors are already gone, so stop trying to restore
        // them. The pending close still runs.
        flash.destroyId = item.connect('destroy', () => {
            flash.undo = null;
            flash.destroyId = 0;
        });
        this._pendingFlash = flash;

        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            close ? FLASH_CLOSE_MS : FLASH_REVERT_MS, () => {
                this._flashId = 0;
                this._cancelFlash();
                if (close) this.menu.close(BoxPointer.PopupAnimation.FULL);
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelFlash() {
        if (this._flashId) {
            GLib.source_remove(this._flashId);
            this._flashId = 0;
        }
        const flash = this._pendingFlash;
        this._pendingFlash = null;
        if (flash) {
            if (flash.destroyId) flash.item.disconnect(flash.destroyId);
            flash.undo?.();
        }
        // Whatever ended the flash — timeout, a new one, or the popup closing —
        // rebuilds are owed again.
        this._resumeRefresh();
    }

    // Hold list rebuilds while a row is being activated and its confirmation
    // shown, then apply whatever was requested in the meantime.
    _suspendRefresh() {
        this._refreshSuspended = true;
        this._refreshPending = null;
    }

    _resumeRefresh() {
        if (!this._refreshSuspended) return;
        this._refreshSuspended = false;
        const pending = this._refreshPending;
        this._refreshPending = null;
        if (pending) this.refresh(pending);
    }

    // One row builder for every provider. Result.visual is plain data so
    // providers never have to touch St; the mapping to actors happens here.
    _makeVisual(visual) {
        // Never let a bad visual abort the rebuild: this runs inside the loop
        // that fills _rows, so a throw here leaves a half-populated list whose
        // _rows no longer matches what is on screen — and then the arrow keys
        // and Enter address the wrong rows.
        try {
            return this._buildVisual(visual);
        } catch (e) {
            logError(e, 'omelette: could not build row visual');
            return new St.Icon({
                icon_name: 'text-x-generic-symbolic',
                icon_size: visual?.size ?? 32, style_class: 'cb-thumb',
            });
        }
    }

    _buildVisual(visual) {
        switch (visual?.kind) {
        case 'gicon':
            // St.Icon scales a file icon proportionally into its square rather
            // than cropping it. Keep the actor unrotated and unobstructed so
            // the complete image remains visible, whatever its aspect ratio.
            return new St.Icon({
                gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(visual.path) }),
                icon_size: visual.size ?? 64,
                style_class: 'cb-thumb cb-image-thumb',
            });
        case 'swatch':
            // The inline colour wins over .cb-swatch, which only carries the
            // size and border.
            return new St.Widget({
                style_class: 'cb-thumb cb-swatch',
                style: `background-color: ${visual.color};`,
            });
        case 'glyph':
            return new St.Label({ text: visual.text, style_class: 'cb-thumb cb-glyph' });
        case 'ring':
            return makeRing({
                percent: visual.percent,
                size: visual.size ?? 32,
                styleClass: 'cb-thumb',
            });
        case 'icon':
        default:
            return new St.Icon({
                icon_name: visual?.name ?? 'text-x-generic-symbolic',
                icon_size: visual?.size ?? 32, style_class: 'cb-thumb',
            });
        }
    }

    _makeResultRow(result) {
        // hover:false and can_focus:false are load-bearing. By default
        // PopupBaseMenuItem binds hover -> active, and the active setter calls
        // grab_key_focus() — so simply moving the mouse across the list would
        // pull key focus off the search entry and swallow the next keystroke.
        // Selection is drawn by us instead (see _setSelected); the ClickAction
        // is unaffected, so mouse activation still works.
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: true, hover: false, can_focus: false,
        });
        // Selection and the copy flash are painted on the item rather than on
        // the box inside it, so the highlight fills the row the theme already
        // laid out instead of drawing a second, inset rectangle within it.
        item.add_style_class_name('cb-item');
        const row = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'cb-row' });

        const thumb = this._makeVisual(result.visual);

        const labelBox = new St.BoxLayout({
            vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'cb-meta',
        });
        labelBox.add_child(nameLabel(result.title, result.titleClass));
        const hint = new St.Label({ text: result.subtitle ?? '', style_class: 'cb-hint' });
        labelBox.add_child(hint);

        // Light-touch preview: the full (single-line) text is reachable via the
        // accessible name even though the visible label is ellipsized.
        if (result.accessibleText) item.accessible_name = result.accessibleText;

        row.add_child(thumb);
        row.add_child(labelBox);

        if (result.accel)
            row.add_child(new St.Label({ text: result.accel, style_class: 'cb-accel' }));

        const flashFor = message => this._flash({ item, hint, thumb, message });

        if (result.actions?.length) {
            const actions = new St.BoxLayout({ style_class: 'cb-row-actions' });
            for (const action of result.actions) {
                actions.add_child(iconButton(action.icon, action.styleClass ?? '', () => {
                    // Same reasoning as item.activate below: an action that
                    // writes to a store would otherwise destroy this row before
                    // its confirmation is drawn.
                    this._suspendRefresh();
                    let outcome;
                    try {
                        outcome = action.run(this._ctx());
                    } catch (e) {
                        logError(e, `omelette: row action on "${result.id}" failed`);
                        this._resumeRefresh();
                        return;
                    }
                    if (outcome?.message) flashFor(outcome.message);
                    else this._resumeRefresh();
                }));
            }
            row.add_child(actions);
        }

        item.add_child(row);

        // Hovering should move the selection, or the mouse and the keyboard end
        // up disagreeing about which row Enter would fire.
        item.connect('notify::hover', () => {
            if (!item.hover) return;
            const index = this._rows.findIndex(r => r.item === item);
            if (index >= 0) this._setSelected(index, { scroll: false });
        });

        // PopupMenuBase listens to 'activate' with ConnectFlags.AFTER and closes
        // the top menu from there. Overriding activate() rather than emitting it
        // keeps the popup up for the flash, which then closes it. The
        // ClickAction, the Return/space key handler and our own command-bar
        // Enter all route through here.
        item.activate = () => {
            // run() usually mutates a store, and that emits 'changed'
            // synchronously — so without this the rebuild lands before the
            // flash below and animates actors that no longer exist.
            this._suspendRefresh();
            let outcome;
            try {
                outcome = result.run(this._ctx());
            } catch (e) {
                // Uncaught, this escapes into Clutter's click handler and
                // leaves the popup with no flash and no close.
                logError(e, `omelette: result "${result.id}" failed`);
                this._resumeRefresh();
                return;
            }
            if (outcome?.message) {
                this._flash({ item, hint, thumb, message: outcome.message, close: outcome.close });
                return;   // _cancelFlash resumes when the flash ends
            }
            this._resumeRefresh();
            if (outcome?.close) this.menu.close(BoxPointer.PopupAnimation.FULL);
        };

        return { item, row, hint, thumb, result };
    }

    destroy() {
        // Read by the PDF callbacks, which can land long after this: a file
        // chooser is open for as long as the user leaves it open.
        this._destroyed = true;
        this._cancelFlash();
        this._cancelSearchDebounce();
        this._cancelFocusInput();
        this._releasePanel();
        this._rows = [];
        if (this._capturedId) {
            this.menu.actor.disconnect(this._capturedId);
            this._capturedId = 0;
        }
        if (this._settings && this._pausedChangedId) {
            this._settings.disconnect(this._pausedChangedId);
            this._pausedChangedId = 0;
        }
        if (this._settings && this._awakeChangedId) {
            this._settings.disconnect(this._awakeChangedId);
            this._awakeChangedId = 0;
        }
        if (this._appearanceSettings && this._appearanceChangedId) {
            this._appearanceSettings.disconnect(this._appearanceChangedId);
            this._appearanceChangedId = 0;
        }
        this._appearanceSettings = null;
        super.destroy();
    }
});

export default class OmeletteExtension extends Extension {
    enable() {
        // The ESM modules stay loaded across disable/enable, so clear any state
        // that survived a teardown which threw partway through.
        ColorPicker.cancelActive();
        Paste.shutdown();
        Currency.shutdown();
        Sensors.shutdown();
        FilePortal.cancelActive();
        PdfRunner.reset();
        // Both hold something that outlives a reload: an inhibitor cookie that
        // cannot be recovered from the bus once orphaned, and a read on the
        // editor's stdout.
        Awake.shutdown();
        EditorLauncher.reset();
        Voce.shutdown();

        this._settings = this.getSettings();
        seedQuicklinksOnce(this._settings);

        this._vault = new VaultStore(this._settings);
        this._vault.load();
        this._screenshots = new ScreenshotStore(this._settings);
        this._monitor = new ClipboardMonitor(this._settings);

        this._indicator = new Indicator();
        this._indicator.setContext({
            vault: this._vault,
            screenshots: this._screenshots,
            monitor: this._monitor,
            settings: this._settings,
            uuid: this.uuid,
            version: this.metadata['version-name'] ?? '',
            path: this.path,
            openPreferences: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._vaultId = this._vault.connect('changed', () => this._indicator?.refresh());
        this._shotsId = this._screenshots.connect('changed', () => this._indicator?.refresh());
        this._monitorId = this._monitor.connect('captured', (_m, payload) => {
            this._vault.add(payload);
        });

        // React to settings that affect stored data live.
        this._settingsIds = [
            this._settings.connect('changed::max-items', () => this._vault.applyLimits()),
            this._settings.connect('changed::entry-ttl-days', () => this._vault.applyLimits()),
            this._settings.connect('changed::screenshots-dir', () => this._screenshots.restart()),
            // Edited in the prefs window, which is a separate process — this is
            // what makes an edit show up in the popup without a shell restart.
            this._settings.connect('changed::snippets', () => {
                this._indicator?.invalidateConfigCache();
                this._indicator?.refresh();
            }),
            this._settings.connect('changed::quicklinks', () => {
                this._indicator?.invalidateConfigCache();
                this._indicator?.refresh();
            }),
            // Switching system readings off has to stop the watchers, not just
            // hide the rows — otherwise the fan timer keeps ticking against a
            // section nobody can see.
            this._settings.connect('changed::sensors-enabled', () => {
                Sensors.stopWatching();
                if (this._indicator?.menu.isOpen)
                    Sensors.startWatching(this._settings);
                this._indicator?.refresh();
            }),
            // One reconciler for Keep awake, watching both keys. Every way of
            // turning it on — the switch, the shortcut, a command-bar row, the
            // preferences window — only writes settings, so this is the single
            // place that talks to gnome-session and the single place that owns
            // the timer. Awake.apply() is idempotent, so a doubled notification
            // costs nothing.
            this._settings.connect('changed::awake', () => this._applyAwake()),
            this._settings.connect('changed::awake-until', () => this._applyAwake()),
        ];

        // Reconcile once at startup, which is also what re-acquires the
        // inhibitor after the extension was disabled and re-enabled — locking
        // the screen does exactly that. A deadline that passed while we were
        // gone is caught here rather than being silently re-armed, which is
        // what the absolute `awake-until` is for.
        this._applyAwake();

        this._addKeybindings();
        this._warnIfNoClipboardHelper();
        this._warnIfVaultUnreadable();

        this._screenshots.start();
        this._monitor.start();
        this._indicator.refresh();
        Voce.enable({
            onState: state => {
                const button = this._indicator?._voceButton;
                const icon = this._indicator?._voceButtonIcon;
                if (!button || !icon) return;
                const active = state === 'recording' || state === 'transcribing';
                button.set_checked(active);
                button.set_accessible_name(state === 'recording'
                    ? 'Stop dictation' : state === 'transcribing'
                        ? 'Transcribing' : 'Start dictation');
                icon.icon_name = state === 'recording'
                    ? 'media-record-symbolic' : state === 'transcribing'
                        ? 'content-loading-symbolic' : 'audio-input-microphone-symbolic';
            },
            onTranscript: ({ id, text, wmClass }) => {
                ingestText(text, {
                    vault: this._vault,
                    monitor: this._monitor,
                    requestPaste: () => {
                        const inserted = this._settings?.get_boolean('auto-paste') ?? false;
                        if (inserted)
                            Paste.pasteInto({ wmClass, settings: this._settings });
                        Voce.markInserted(id, inserted);
                    },
                }, { store: true, title: 'Dictation' });
            },
        });
    }

    // Terminal apps (Claude Code, editors) shell out to xclip on X11 or wl-paste
    // on Wayland to read the clipboard. Without one, clicking an image row looks
    // like it worked but Ctrl+V in a terminal pastes nothing — so say it once.
    // Deferred a few seconds because at login we'd otherwise notify before the
    // session's notification handling is up.
    _warnIfNoClipboardHelper() {
        if (this._settings.get_boolean('clipboard-helper-warned')) return;
        const wayland = Meta.is_wayland_compositor();
        if (GLib.find_program_in_path(wayland ? 'wl-paste' : 'xclip')) return;
        this._warnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._warnId = 0;
            Main.notify('Omelette',
                `Install ${wayland ? 'wl-clipboard' : 'xclip'} so terminal apps can ` +
                'paste clipboard images with Ctrl+V.');
            this._settings?.set_boolean('clipboard-helper-warned', true);
            return GLib.SOURCE_REMOVE;
        });
    }

    // A vault that failed to parse is never silently replaced — VaultStore moves
    // it aside and refuses to persist over it. Say so, because the alternative
    // is the user discovering an empty history with no explanation. Deferred for
    // the same reason as the helper warning above.
    _warnIfVaultUnreadable() {
        const failure = this._vault?.loadFailure;
        if (!failure) return;
        this._vaultWarnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._vaultWarnId = 0;
            Main.notifyError('Omelette', failure.archivedTo
                ? `History could not be read and was saved to ${failure.archivedTo}. Starting empty.`
                : 'History could not be read. Nothing new will be saved until ' +
                  'vault.json is repaired or removed.');
            return GLib.SOURCE_REMOVE;
        });
    }

    // Settings in, inhibitor out. Nothing else in the extension calls
    // Awake.apply().
    _applyAwake() {
        Awake.apply({
            on: this._settings.get_boolean('awake'),
            until: Number(this._settings.get_int64('awake-until')),
            appId: this.uuid,
        }, {
            onExpire: () => {
                // Writing `awake` false re-enters this method once through
                // `changed::awake`. That is harmless — apply() finds nothing
                // held and does nothing — and it is what keeps the switch, the
                // panel tint and the rows all correct without a second path.
                this._settings?.set_int64('awake-until', 0);
                this._settings?.set_boolean('awake', false);
                Main.notify('Omelette', 'Keep awake has ended.');
            },
            onError: e => Main.notifyError('Omelette', e.message ?? String(e)),
        });
        this._indicator?._syncAwakeIcon();
    }

    _addKeybindings() {
        const flags = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        const handlers = {
            'toggle-menu': () => this._indicator?.menu.toggle(),
            'capture-area': () => { this._indicator?.menu.close(); this._indicator?._capture('area'); },
            'capture-full': () => { this._indicator?.menu.close(); this._indicator?._capture('full'); },
            'pick-color': () => { this._indicator?.menu.close(); this._indicator?._pickColor(); },
            'open-snippets': () => this._indicator?.openForTool('snippet'),
            'open-emoji': () => this._indicator?.openForTool('emoji'),
            'open-sensors': () => this._indicator?.openForTool('sensors'),
            'open-pdf': () => this._indicator?.openForTool('pdf'),
            // Writes the setting and stops, like every other way in. Clears the
            // deadline too, so the shortcut means "until I turn it off" rather
            // than silently reviving whatever duration was last used.
            'toggle-awake': () => {
                const on = this._settings.get_boolean('awake');
                this._settings.set_int64('awake-until', 0);
                this._settings.set_boolean('awake', !on);
                Main.notify('Omelette', on ? 'Sleep allowed again' : 'Keeping awake');
            },
            'open-editor': () => {
                const shots = this._screenshots?.entries ?? [];
                if (shots.length === 0) {
                    Main.notify('Omelette', 'No screenshots to edit yet.');
                    return;
                }
                this._indicator?._openEditor(shots[0]);
            },
            'voce-hold': () => Voce.beginHold(),
            'voce-toggle': () => Voce.toggle(),
        };
        for (const name of KEYBINDINGS) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.NONE, flags, handlers[name]);
        }
    }

    _removeKeybindings() {
        for (const name of KEYBINDINGS) Main.wm.removeKeybinding(name);
    }

    disable() {
        // First, before anything below can throw: a colour pick holds a modal
        // grab, and one that outlives the extension leaves the session unable to
        // click anything. ExtensionManager only logs a throw from disable().
        ColorPicker.cancelActive();
        // Likewise before anything else: a queued paste firing after we are gone
        // would type into whatever window happens to have focus.
        Paste.shutdown();
        // Cancels any rate fetch still in flight.
        Currency.shutdown();
        // Drops the BlueZ subscriptions and the fan timer, both of which would
        // otherwise keep firing into an indicator that no longer exists.
        Sensors.shutdown();
        // Same reasoning: a file chooser the user has left open would otherwise
        // deliver its Response to a callback holding a destroyed Indicator.
        FilePortal.cancelActive();
        PdfRunner.reset();
        // Before anything else that could throw, and unconditionally: an
        // inhibitor cookie is not recoverable once this object is gone —
        // GetInhibitors does not expose cookies — so leaking one here means the
        // machine will not sleep again until the session ends. The setting is
        // left alone, so re-enabling picks it back up.
        Awake.shutdown();
        // Stops reading the editor's stdout. Deliberately does not kill it: a
        // window someone is drawing in should outlive the extension.
        EditorLauncher.reset();
        Voce.shutdown();

        this._removeKeybindings();

        if (this._warnId) {
            GLib.source_remove(this._warnId);
            this._warnId = 0;
        }
        if (this._vaultWarnId) {
            GLib.source_remove(this._vaultWarnId);
            this._vaultWarnId = 0;
        }

        if (this._settings && this._settingsIds) {
            for (const id of this._settingsIds) this._settings.disconnect(id);
            this._settingsIds = null;
        }

        if (this._monitor) {
            if (this._monitorId) this._monitor.disconnect(this._monitorId);
            this._monitor.stop();
            this._monitor = null;
            this._monitorId = 0;
        }
        if (this._screenshots) {
            if (this._shotsId) this._screenshots.disconnect(this._shotsId);
            this._screenshots.stop();
            this._screenshots = null;
            this._shotsId = 0;
        }
        if (this._vault) {
            if (this._vaultId) this._vault.disconnect(this._vaultId);
            // Vault writes are coalesced and asynchronous, so anything from the
            // last few hundred milliseconds is still only in memory.
            this._vault.flush();
            this._vault = null;
            this._vaultId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
