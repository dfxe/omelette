import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VocePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({title: 'Shortcuts', icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'Global shortcuts'});
        page.add(group);
        const settings = this.getSettings();
        group.add(shortcutRow('Hold to talk', 'hold-shortcut', settings));
        group.add(shortcutRow('Toggle dictation', 'toggle-shortcut', settings));
        const apps = new Adw.EntryRow({title: 'Terminal application names', text: settings.get_strv('terminal-apps').join(', ')});
        apps.connect('changed', row => settings.set_strv('terminal-apps', row.text.split(',').map(value => value.trim()).filter(Boolean)));
        group.add(apps);
        window.add(page);
    }
}

function shortcutRow(title, key, settings) {
    const row = new Adw.EntryRow({title, text: settings.get_strv(key)[0] || ""});
    row.connect("changed", current => settings.set_strv(key, current.text ? [current.text] : []));
    return row;
}

