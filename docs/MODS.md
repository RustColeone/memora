# Writing a mod

A mod adds to Memora from a folder: a menu item with a sheet of its own, an image tool, translations,
or anything else its script does with what Memora gives it. You drop the folder in, turn the mod on
in **Settings → Mods**, and tap **Apply changes**. No rebuild, no store.

A mod runs with Memora's own rights. It can read every entry and the Vault, and save entries. So a
new mod is off until you turn it on, on each device, and Memora shows the mod's name and description
before you do. Turn on only mods you trust, as you would a browser extension.

## Where the folder goes

| Memora | Mods folder |
|---|---|
| Windows app | `%APPDATA%\Memora\mods` |
| macOS app | `~/Library/Application Support/Memora/mods` |
| Linux app | `~/.config/Memora/mods` |
| Android app | `Android/data/com.laplacengan.memora/files/mods` (connect the phone to a computer over USB) |
| Pages opened from a Memora server | `<base-dir>/mods` on the server (the Docker image: `/data/mods`) |

Settings → Mods shows the folder, and on the desktop apps **Open mods folder** opens it. A plain web
page that is not served by a Memora server has no mods.

One folder per mod, any name:

```
mods/
  notebook-stats/
    mod.json
    main.js
    style.css
```

[`mods-examples/notebook-stats`](../mods-examples/notebook-stats) is a complete mod to copy.

## mod.json

```json
{
  "id": "notebook-stats",
  "name": "Notebook stats",
  "version": "1.0",
  "memora": 1,
  "description": "How many notes and words you have, this month's spending, and the to-dos still open.",
  "scripts": ["main.js"],
  "styles": ["style.css"]
}
```

| Field | |
|---|---|
| `id` | Lowercase letters, digits, `-` and `_`, up to 48 characters. Unique among your mods. |
| `name`, `version`, `description` | Shown in Settings → Mods. |
| `memora` | The mod API version the mod is written for. This Memora understands `1`; a mod for another version is listed but not loaded. |
| `scripts`, `styles` | Files inside the mod's folder, loaded in order. Paths may use subfolders but never `..`. |

## The script

A script registers its mod with `Memora.mod(id, setup)`. Memora calls `setup(memora)` once, after the
notebook has loaded; it may be `async`.

```js
Memora.mod('notebook-stats', function (memora) {
  memora.menu.add({ label: 'Notebook stats', icon: 'svg-icon-chart', run: () => {
    memora.ui.sheet('Notebook stats', (body) => {
      body.textContent = memora.data.list('notes').length + ' notes';
    });
  } });
});
```

What `memora` offers (API version 1):

| | |
|---|---|
| `memora.data.list(page)` | Copies of the entries on a page: `'notes'`, `'spending'` or `'plans'`. Deleted entries and the ones the privacy lock hides are left out. |
| `memora.data.add(page, fields)` | Adds an entry and returns its id. Saved like any edit, so it syncs. The entry gets `mod: '<id>'`. |
| `memora.data.update(page, id, fields)` | Changes fields of an entry. |
| `memora.menu.add({ label, icon, run })` | A row in the menu's **Mods** section. `icon` is one of Memora's `svg-icon-*` names. |
| `memora.ui.sheet(title, render)` | Opens a sheet; `render(body, close)` fills `body`. Returns `{ close, element }`. |
| `memora.ui.toast(message, kind)` | A short message at the bottom (`kind`: `'error'` or none). |
| `memora.tools.register(tool)` | An image tool in the Tools sheet, like Memora's own (see `src/static/js/memo/memo-tools.js`). |
| `memora.i18n.add(rows)`, `memora.i18n.t(text)` | Translations: rows of `[English, Español, Français, Deutsch, 中文]`; `t` translates for the current language. |
| `memora.on(event, fn)` | `'saved'` (an entry was added, changed or deleted on this device: `{ type, id, page }`), `'resume'` (the app came back), `'localechange'`. |
| `memora.settings.get(key, fallback)`, `.set(key, value)` | Small values of the mod's own, on this device. |
| `memora.url(file)` | The address of a file in the mod's folder. |
| `memora.id`, `memora.manifest`, `memora.version` | The mod's id, its mod.json, and the API version. |

Entry fields are the ones Memora itself saves: a note has `description`, `category`, `tags`, `ts`; a
purchase adds `total`, `tax`, `purchaseDate` (`YYYY-MM-DD`); a plan is a to-do (`kind: 'todo'`,
`title`, `done`, `due`) or an event (`kind: 'event'`, `title`, `date`, `start`, `end`).

To use another file from the mod's folder (data, an image), ask for its address:
`fetch(memora.url('data/words.json'))`. A relative path alone would resolve against the app's page,
not the mod's folder.

## When something goes wrong

Settings → Mods shows each mod's problem in red: a mod.json that is not JSON, a wrong `memora`
version, a file outside the folder, a script that never called `Memora.mod`, or the error its setup
threw. A failing mod never stops Memora. The browser console (desktop: Ctrl+Shift+I in a
development build; Android: `chrome://inspect` with a debug build) shows the details with a
`[mods]` or `[mod <id>]` prefix.

To turn a mod off, clear its switch and tap **Apply changes**, or delete its folder.

## Sharing a mod

A mod is its folder: zip it and share it. Say what it reads and saves. A mod you publish is your
own work under the license you choose; one that copies Memora's code is under the AGPL like Memora.
