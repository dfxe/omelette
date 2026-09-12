import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    loadSnippets, saveSnippets, loadQuicklinks, saveQuicklinks, newId,
} from './configStore.js';

const MB = 1024 * 1024;

// Typing in a text field writes straight through to GSettings, which the Shell
// is listening to — debounce so a rebuild isn't triggered per keystroke.
const WRITE_DEBOUNCE_MS = 400;

function debounced(fn) {
    let pending = 0;
    return (...args) => {
        if (pending) GLib.source_remove(pending);
        pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WRITE_DEBOUNCE_MS, () => {
            pending = 0;
            fn(...args);
            return GLib.SOURCE_REMOVE;
        });
    };
}

// A delete button that matches the destructive-action styling Adwaita expects.
function deleteButton(onClick) {
    const button = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Delete',
    });
    button.add_css_class('flat');
    button.add_css_class('destructive-action');
    button.connect('clicked', onClick);
    return button;
}

// A shortcut is stored as a GSettings `as` array. We keep the prefs UI simple
// and robust: the user types an accelerator string (e.g. <Super><Shift>V) which
// we validate with Gtk.accelerator_parse before storing; blank clears it.
function shortcutRow(settings, key, title) {
    const row = new Adw.EntryRow({ title });
    const current = settings.get_strv(key);
    row.set_text(current.length ? current[0] : '');

    row.connect('changed', () => {
        const text = row.get_text().trim();
        if (text === '') {
            settings.set_strv(key, []);
            row.remove_css_class('error');
            return;
        }
        const [ok, keyval] = Gtk.accelerator_parse(text);
        if (ok && keyval !== 0) {
            settings.set_strv(key, [text]);
            row.remove_css_class('error');
        } else {
            // Leave the stored value alone until it parses.
            row.add_css_class('error');
        }
    });
    return row;
}

// A list editor shared by snippets and quicklinks: one ExpanderRow per entry,
// an Add button in the group header, and a Delete inside each row. The whole
// group is torn down and rebuilt on structural changes (add/delete), which is
// cheap at this size and much simpler than reconciling rows in place.
function listEditor({ group, load, save, blank, title, fields }) {
    let rows = [];

    const rebuild = () => {
        for (const row of rows) group.remove(row);
        rows = [];

        const items = load();
        if (items.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'Nothing here yet',
                subtitle: 'Use the + button to add one.',
                sensitive: false,
            });
            group.add(empty);
            rows.push(empty);
            return;
        }

        items.forEach((item, index) => {
            const row = new Adw.ExpanderRow({ title: title(item) });

            for (const field of fields) {
                const child = field.multiline
                    ? multilineRow(field, item, () => commit(index, item))
                    : entryRow(field, item, () => {
                        row.title = title(item);
                        commit(index, item);
                    });
                row.add_row(child);
            }

            const actions = new Adw.ActionRow();
            actions.add_suffix(deleteButton(() => {
                const list = load();
                list.splice(index, 1);
                save(list);
                rebuild();
            }));
            row.add_row(actions);

            group.add(row);
            rows.push(row);
        });
    };

    // Writes are debounced per editor, so holding down a key doesn't make the
    // Shell rebuild its popup on every character.
    const commit = debounced((index, item) => {
        const list = load();
        if (index < list.length) {
            list[index] = item;
            save(list);
        }
    });

    const add = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER });
    add.add_css_class('flat');
    add.connect('clicked', () => {
        const list = load();
        list.push({ ...blank(), id: newId(), uses: 0 });
        save(list);
        rebuild();
    });
    group.set_header_suffix(add);

    rebuild();
}

function entryRow(field, item, onChange) {
    const row = new Adw.EntryRow({ title: field.title });
    row.set_text(item[field.key] ?? '');
    row.connect('changed', () => {
        item[field.key] = row.get_text();
        onChange();
    });
    return row;
}

// Adw has no multi-line entry row, so wrap a TextView. Snippet bodies are
// routinely several lines, which an EntryRow cannot show at all.
function multilineRow(field, item, onChange) {
    const row = new Adw.PreferencesRow({ activatable: false });
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 6,
        margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
    });
    box.append(new Gtk.Label({
        label: field.title, xalign: 0, css_classes: ['heading'],
    }));

    const view = new Gtk.TextView({
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 6, bottom_margin: 6, left_margin: 6, right_margin: 6,
        monospace: field.monospace ?? false,
    });
    view.buffer.set_text(item[field.key] ?? '', -1);
    view.buffer.connect('changed', () => {
        const { buffer } = view;
        item[field.key] = buffer.get_text(
            buffer.get_start_iter(), buffer.get_end_iter(), false);
        onChange();
    });

    const frame = new Gtk.Frame({ child: view, height_request: 120 });
    box.append(frame);

    if (field.hint) {
        box.append(new Gtk.Label({
            label: field.hint, xalign: 0, wrap: true,
            css_classes: ['dim-label', 'caption'],
        }));
    }

    row.set_child(box);
    return row;
}

export default class OmelettePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'General', icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        this._addToolsPage(window, settings);
        this._addSnippetsPage(window, settings);
        this._addQuicklinksPage(window, settings);

        // --- History ---------------------------------------------------------
        const history = new Adw.PreferencesGroup({ title: 'History' });
        page.add(history);

        const maxItems = new Adw.SpinRow({
            title: 'Maximum entries',
            subtitle: 'Oldest unpinned entries drop beyond this.',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 1000, step_increment: 10, page_increment: 50 }),
        });
        settings.bind('max-items', maxItems, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(maxItems);

        const ttl = new Adw.SpinRow({
            title: 'Auto-expire after (days)',
            subtitle: '0 disables expiry. Pinned entries never expire.',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 3650, step_increment: 1, page_increment: 7 }),
        });
        settings.bind('entry-ttl-days', ttl, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(ttl);

        // --- Images ----------------------------------------------------------
        const images = new Adw.PreferencesGroup({ title: 'Images' });
        page.add(images);

        const storeImages = new Adw.SwitchRow({
            title: 'Store copied images',
            subtitle: 'Explicit Area/Screen captures are always stored.',
        });
        settings.bind('store-images', storeImages, 'active', Gio.SettingsBindFlags.DEFAULT);
        images.add(storeImages);

        // Stored as bytes; presented in whole megabytes.
        const maxImg = new Adw.SpinRow({
            title: 'Max copied-image size (MB)',
            subtitle: '0 means unlimited. Does not affect captures.',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 500, step_increment: 1, page_increment: 10 }),
        });
        maxImg.set_value(Math.round(settings.get_int('max-image-bytes') / MB));
        maxImg.connect('notify::value', () =>
            settings.set_int('max-image-bytes', Math.round(maxImg.get_value()) * MB));
        settings.connect('changed::max-image-bytes', () =>
            maxImg.set_value(Math.round(settings.get_int('max-image-bytes') / MB)));
        images.add(maxImg);

        const dir = new Adw.EntryRow({ title: 'Screenshots folder' });
        dir.set_text(settings.get_string('screenshots-dir'));
        dir.connect('changed', () => settings.set_string('screenshots-dir', dir.get_text().trim()));
        images.add(dir);
        const dirHint = new Adw.ActionRow({
            subtitle: 'Blank uses the default ~/Pictures/Screenshots.',
        });
        images.add(dirHint);

        const editAfter = new Adw.SwitchRow({
            title: 'Open the editor after a capture',
            subtitle: 'The capture still lands in history and on the clipboard.',
        });
        settings.bind('edit-after-capture', editAfter, 'active', Gio.SettingsBindFlags.DEFAULT);
        images.add(editAfter);

        // --- Privacy ---------------------------------------------------------
        const privacy = new Adw.PreferencesGroup({ title: 'Privacy' });
        page.add(privacy);

        const paused = new Adw.SwitchRow({
            title: 'Pause monitoring',
            subtitle: 'While on, newly copied content is not recorded.',
        });
        settings.bind('paused', paused, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacy.add(paused);

        const encrypt = new Adw.SwitchRow({
            title: 'Encrypt history at rest',
            subtitle: 'Not yet implemented.',
            sensitive: false,
        });
        settings.bind('encrypt-at-rest', encrypt, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacy.add(encrypt);

        // --- Keep awake ------------------------------------------------------
        const awakeGroup = new Adw.PreferencesGroup({
            title: 'Keep awake',
            description: 'Holds an inhibitor against the session so the screen '
                + 'does not blank and the machine does not suspend.',
        });
        page.add(awakeGroup);

        const awake = new Adw.SwitchRow({
            title: 'Keep awake',
            subtitle: 'Stays on until switched off. Locking the screen ends it.',
        });
        awakeGroup.add(awake);

        // Not settings.bind(), for two reasons. Switching it on here has to
        // clear any deadline a timed hold left behind, or the new hold expires
        // the moment it starts. And the mirror below has to be able to move the
        // switch *without* writing back — otherwise a timed hold started from
        // the command bar would arrive here as `changed::awake`, flip the
        // switch, and the resulting notify would wipe the deadline it came with.
        let syncing = false;
        awake.set_active(settings.get_boolean('awake'));
        awake.connect('notify::active', () => {
            if (syncing) return;
            settings.set_int64('awake-until', 0);
            settings.set_boolean('awake', awake.get_active());
        });
        settings.connect('changed::awake', () => {
            syncing = true;
            try { awake.set_active(settings.get_boolean('awake')); }
            finally { syncing = false; }
        });

        // --- Shortcuts -------------------------------------------------------
        const shortcuts = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            // Escaped: Adw renders this as Pango markup, so a literal
            // <Super><Shift> is parsed as tags and the description comes out
            // blank with a warning on stderr.
            description: 'Type an accelerator such as &lt;Super&gt;&lt;Shift&gt;V. '
                + 'Leave blank to disable.',
        });
        page.add(shortcuts);
        shortcuts.add(shortcutRow(settings, 'toggle-menu', 'Open clipboard menu'));
        shortcuts.add(shortcutRow(settings, 'capture-area', 'Capture area'));
        shortcuts.add(shortcutRow(settings, 'capture-full', 'Capture screen'));
        shortcuts.add(shortcutRow(settings, 'pick-color', 'Pick color'));
        shortcuts.add(shortcutRow(settings, 'open-snippets', 'Open snippets'));
        shortcuts.add(shortcutRow(settings, 'open-emoji', 'Open emoji picker'));
        shortcuts.add(shortcutRow(settings, 'open-sensors', 'Open system readings'));
        shortcuts.add(shortcutRow(settings, 'open-pdf', 'Extract PDF pages'));
        shortcuts.add(shortcutRow(settings, 'toggle-awake', 'Keep awake'));
        shortcuts.add(shortcutRow(settings, 'open-editor', 'Edit newest screenshot'));
        shortcuts.add(shortcutRow(settings, 'voce-hold', 'Hold to dictate'));
        shortcuts.add(shortcutRow(settings, 'voce-toggle', 'Toggle dictation'));
    }

    _addToolsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Tools', icon_name: 'applications-utilities-symbolic',
        });
        window.add(page);

        const paste = new Adw.PreferencesGroup({
            title: 'Pasting',
            description: 'Activating a result copies it. It can also paste it for you.',
        });
        page.add(paste);

        const autoPaste = new Adw.SwitchRow({
            title: 'Paste after copying',
            subtitle: 'Sends Ctrl+V to the window that had focus. Turn off to only copy.',
        });
        settings.bind('auto-paste', autoPaste, 'active', Gio.SettingsBindFlags.DEFAULT);
        paste.add(autoPaste);

        const shiftTerminals = new Adw.SwitchRow({
            title: 'Use Ctrl+Shift+V in terminals',
            subtitle: 'Terminals bind paste differently. Matched on the window class.',
        });
        settings.bind('paste-shortcut-terminals', shiftTerminals, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        settings.bind('auto-paste', shiftTerminals, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        paste.add(shiftTerminals);

        const delay = new Adw.SpinRow({
            title: 'Paste delay (ms)',
            subtitle: 'Time allowed for focus to return. Raise if pastes land in the wrong place.',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000, step_increment: 10, page_increment: 50,
            }),
        });
        settings.bind('auto-paste-delay-ms', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('auto-paste', delay, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        paste.add(delay);

        const web = new Adw.PreferencesGroup({ title: 'Web search' });
        page.add(web);

        const searchUrl = new Adw.EntryRow({ title: 'Fallback search URL' });
        searchUrl.set_text(settings.get_string('search-url'));
        searchUrl.connect('changed', () =>
            settings.set_string('search-url', searchUrl.get_text().trim()));
        web.add(searchUrl);
        web.add(new Adw.ActionRow({
            subtitle: 'Used when nothing else matches. {query} is replaced with what you typed.',
            sensitive: false,
        }));

        const money = new Adw.PreferencesGroup({
            title: 'Currency',
            description: 'The only feature that uses the network. Everything else stays on this machine.',
        });
        page.add(money);

        const currencyOn = new Adw.SwitchRow({
            title: 'Convert currencies',
            subtitle: 'Fetches exchange rates at most twice a day, and only when you type one.',
        });
        settings.bind('currency-enabled', currencyOn, 'active', Gio.SettingsBindFlags.DEFAULT);
        money.add(currencyOn);

        const apiUrl = new Adw.EntryRow({ title: 'Exchange rate endpoint' });
        apiUrl.set_text(settings.get_string('currency-api-url'));
        apiUrl.connect('changed', () =>
            settings.set_string('currency-api-url', apiUrl.get_text().trim()));
        settings.bind('currency-enabled', apiUrl, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        money.add(apiUrl);

        const system = new Adw.PreferencesGroup({
            title: 'System',
            description: 'Read from BlueZ and /sys/class/hwmon. Nothing leaves this machine.',
        });
        page.add(system);

        const sensorsOn = new Adw.SwitchRow({
            title: 'Show device batteries and fan speeds',
            subtitle: 'Connected Bluetooth devices that report a battery, plus any fans this machine has.',
        });
        settings.bind('sensors-enabled', sensorsOn, 'active', Gio.SettingsBindFlags.DEFAULT);
        system.add(sensorsOn);

        const pollSeconds = new Adw.SpinRow({
            title: 'Fan reading interval (seconds)',
            subtitle: 'Only while the popup is open. Batteries are not polled — BlueZ signals a change.',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 30, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('sensors-poll-seconds', pollSeconds, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('sensors-enabled', pollSeconds, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        system.add(pollSeconds);
    }

    _addSnippetsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Snippets', icon_name: 'insert-text-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Snippets',
            description: 'Search these from the popup. A keyword makes one easy to reach; '
                + 'the label is what the result row shows.',
        });
        page.add(group);

        listEditor({
            group,
            load: () => loadSnippets(settings),
            save: items => saveSnippets(settings, items),
            blank: () => ({ keyword: '', label: '', body: '' }),
            title: s => s.label || s.keyword || (s.body || '').split('\n')[0] || 'Untitled',
            fields: [
                { key: 'label', title: 'Label' },
                { key: 'keyword', title: 'Keyword' },
                {
                    key: 'body', title: 'Body', multiline: true, monospace: true,
                    hint: 'Placeholders: {date} {time} {clipboard} {uuid} {cursor}. '
                        + 'Use {date:%d %b %Y} for a custom format. {cursor} moves the caret '
                        + 'back after pasting, and only works when pasting is on.',
                },
            ],
        });
    }

    _addQuicklinksPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Quicklinks', icon_name: 'web-browser-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Quicklinks',
            description: 'Type the keyword followed by your search — "gh omelette" — '
                + 'and press Enter to open it.',
        });
        page.add(group);

        listEditor({
            group,
            load: () => loadQuicklinks(settings),
            save: items => saveQuicklinks(settings, items),
            blank: () => ({ keyword: '', name: '', url: 'https://example.com/search?q={query}' }),
            title: q => q.name || q.keyword || 'Untitled',
            fields: [
                { key: 'name', title: 'Name' },
                { key: 'keyword', title: 'Keyword' },
                {
                    key: 'url', title: 'URL', multiline: true, monospace: true,
                    hint: '{query} is replaced with the text after the keyword, URL-encoded.',
                },
            ],
        });
    }
}
