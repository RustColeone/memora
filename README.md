# Memora

Notes, spending and plans in one private notebook, with a Vault for passwords and AI contacts
that can look things up and suggest changes you approve with a tap.

Memora works on its own on each device, and any copy can sync with a server you run yourself.
There is no account and no developer cloud.

## Get Memora

| | | |
|---|---|---|
| **Android** | [Google Play](https://play.google.com/store/apps/details?id=com.laplacengan.memora) (paid) | An encrypted database on the phone |
| **Windows, macOS, Linux** | [Releases](https://github.com/RustColeone/memora/releases): `Memora-<version>-win-x64.zip`, `-mac-arm64.zip`, `-linux-x86_64.AppImage` | An encrypted database file on the computer; it can also host the sync server |
| **Server** | [Releases](https://github.com/RustColeone/memora/releases): `memora-server-<version>.zip`, or Docker from this repository ([SERVER.md](SERVER.md)) | On your server; open it in a browser |

**Which one?** If you have a home server or NAS, run the server there and point every device at it.
If not, use a desktop app: Settings → **Host sync on this computer** runs the same server while the
app is open, and shows a QR code your phone can scan.

The Play app is how we fund Memora. Nothing stops you from building any of it yourself: everything
is in this repository (see below).

The desktop builds are not signed. On Windows, SmartScreen may say "Windows protected your PC": choose
More info → Run anyway. On a Mac, if macOS says the app is damaged or can't be opened, run
`xattr -dr com.apple.quarantine /Applications/Memora.app` once. On Linux, make the AppImage executable
(`chmod +x`); the app keeps its key in the system keyring (GNOME Keyring or KWallet).

## Bring your own key (BYOK)

Memora has no AI service and includes no AI key. To use AI (chats, AI contacts, photo reading),
add your own key in the Vault: DeepSeek, Gemini (free tier), OpenAI, Claude, or any
OpenAI-compatible service, including your own Ollama. Or point a contact at your server's own AI,
which uses only the key or model its owner configures. What you send, and the notes an AI contact
is allowed to read, go to the provider you chose under its privacy policy. Keys are stored
encrypted in the Vault and sync only inside it. Every change an AI proposes waits for your tap.

### Layout

```
backend/                              # Flask server (run: python backend/server.py)
  server.py  backend_context.py       #   entry + app context
  memora_server.py                    #   one-program server (memora-server.exe) with CLI options
  api/                                #   route blueprints (memo, chat, upload, ocr, export, …)
  services/                           #   storage/business logic (db, memos, finance, ai_step, …)
src/                                  # web frontend — SHARED by the phone, the desktop app and the server
  index.html  finance.html  planner.html   #   pages (at src/ root, like www/)
  partials/                           #   shared-chrome includes (head, scripts-core, dialogs, …)
  static/  css/  js/{memo,planner}/  vendor/   #   assets, served at /static/…
desktop/                              # desktop app (Electron): main.cjs, preload.cjs
build_tools/                          # build.js (src/ -> www/), build-server.cjs, gen-icons.js, .bat helpers
www/                                  # GENERATED app bundle — gitignored, never edit
android/                              # Capacitor Android project (generated, committed)
data/  uploads/                       # live user data — gitignored, never committed
```

## Build from source

### Run the server

```sh
pip install -r requirements.txt
python backend/server.py    # serves on http://0.0.0.0:5050
```

Data lives in `data/` and `uploads/`. Both are gitignored — keep your own backups. A page opened
from the server reads and writes the server directly ("server mode"). Set a sync password with the
`MEMO_SYNC_PASSWORD` environment variable or `data/sync_auth.json` (`{"password": "…"}`), and
use HTTPS anywhere you don't trust the network.

#### Reaching your server away from home (HTTPS)

Plain HTTP is fine on a home network you trust. To reach the server from outside, don't open a port to
plain HTTP; put HTTPS in front of it in one of two ways (the phone and desktop apps work with either):

- **Tailscale** (private, nothing exposed to the internet): install Tailscale on the server and your
  phone, then `tailscale serve --bg 5050`. Use the `https://<machine>.<tailnet>.ts.net` address it
  shows as the Server URL.
- **A domain with a reverse proxy**: run the server on `--host 127.0.0.1` and let Caddy add a real
  certificate automatically. A `Caddyfile` with `memora.example.com { reverse_proxy 127.0.0.1:5050 }`
  is all it takes.

Either way, set a long sync password. The server slows down guessing: ten wrong passwords or agent tokens
from one address within a minute make that address wait (behind a proxy, all clients share the proxy's
address). Outside agents should use their own tokens (see API_DOCUMENTATION.md, Agent API), never the
sync password.

As one program, with its data in a folder of your choice:

```sh
npm run build:server        # PyInstaller → dist-server/memora-server/memora-server.exe
dist-server/memora-server/memora-server.exe --base-dir "D:/Memora server" --port 5050
python backend/memora_server.py --host 127.0.0.1    # the same, from source, this computer only
```

### Run the desktop app

```sh
cd desktop
npm install                  # Electron and the encrypted SQLite module
npm start                    # rebuilds www/ and opens the app
```

The app keeps its data in `%APPDATA%\Memora` on Windows, `~/Library/Application Support/Memora` on
macOS and `~/.config/Memora` on Linux: an encrypted SQLite file whose key the system protects for your
user account (Windows DPAPI, the macOS Keychain, or the Linux keyring). Settings → **Host sync on this computer** starts the bundled
`memora-server` (from `npm run build:server`, or Python from source) so your phone can sync with
this PC; it shows the address and sync password. The server runs only while the app is open.
`MEMORA_USER_DATA=<folder>` runs the app on a separate profile, and `MEMORA_DOWNLOAD_DIR=<folder>` saves exports there
instead of asking where (the tests use both).

To package it like the release (after `npm run build` and `npm run build:server`): `cd desktop && npm run dist`.
The result is in `desktop/dist/`.

Offline browser/Android metadata uses validated SQLite generations:
`memosystem.sqlite` (current), `memosystem.sqlite.tmp` (staged/recoverable), and
`memosystem.sqlite.bak` (last known good). Each staged and promoted snapshot is
read back and checked with SQLite `PRAGMA quick_check`; startup recovers a valid
temporary/backup snapshot instead of silently opening a corrupt database as empty.

#### Backend SQLite startup and recovery

The self-hosted server checks an existing `data/memosystem.db` with SQLite
`PRAGMA quick_check` through a read-only connection before enabling WAL mode or
running schema migrations. If SQLite cannot verify the database, server startup
fails with the database path and recovery guidance. It does not rename, delete,
or replace the primary with an empty database. A committed WAL is included in
the check, so its rows remain visible on a normal restart.

If startup reports an integrity failure:

1. Stop every MemoSystem server process. Do not delete or separate WAL files
   while a server may still be running.
2. Copy `memosystem.db` and any matching `memosystem.db-wal` and
   `memosystem.db-shm` files together to a recovery directory. Work only on
   that copy; committed data may exist only in `-wal`.
3. Prefer restoring a known-good backup. Otherwise use the SQLite CLI against
   the copy: run `PRAGMA quick_check;`; if necessary, use `.recover` to create a
   separate database, then run `PRAGMA quick_check;` on the recovered result.
4. Replace the stopped server's database only after the replacement reports
   `ok` and the original database/WAL set is safely retained.

### Build the Android app

Requires Node + Android Studio. From this folder:

```sh
npm install
npm run cap:add:android      # first time only — generates android/
npm run cap:sync             # rebuilds www/ from src/, then `cap sync`
npm run cap:open:android     # open in Android Studio
```

`build_tools/build.js` regenerates `www/` from `src/` on every `cap:sync` (via the
`precap:sync` hook), so the frontend is edited in `src/` only — never in `www/`.
The committed UniversalReader copy is updated explicitly with `npm run sync-reader`;
normal builds verify it is synchronized and do not rewrite tracked source.

### Run checks

```sh
npm run test:state       # fast SQLite migration/recovery/fault checks
npm test                 # Playwright browser suite
npm run test:backend     # Flask/backend suites, including server DB startup integrity
npx playwright test tests/desktop-app.spec.js   # the desktop app (after npm install in desktop/)
```

`npm run test:all` runs the backend, storage, browser, and two-client sync gates.
Android Java compilation can be checked with
`android\gradlew.bat :app:compileDebugJavaWithJavac` from this directory.

#### Android release build

```sh
build_tools\build-release-aab.bat
```

Create `android/key.properties` from `android/key.properties.example` first (keystore path +
passwords). `key.properties`, `*.jks`, and `*.aab` are gitignored.

The Windows `.bat` helpers in `build_tools/` wrap the npm scripts:
`sync-app.bat`, `sync-and-open-android.bat`, `add-android-platform.bat`,
`open-android.bat`, `capacitor-doctor.bat`, `build-release-aab.bat`.

## How it is built, and mods

[The architecture page](https://rustcoleone.github.io/memora/architecture/) draws Memora's code as diagrams you can
tap through, on a computer or a phone: from the whole app down to one function and its code. It is made from the code
itself (`npm run docs:architecture` writes `docs/architecture/data.js`; open `docs/architecture/index.html`).

Memora takes **mods**: drop a folder into the mods folder, turn it on in Settings → Mods. See
[Writing a mod](docs/MODS.md) and the example in [`mods-examples/`](mods-examples/).

## About this repository

This is the published stable copy of Memora. Development happens in a private repository, and each
stable version is copied here with its release. Issues and pull requests are welcome: accepted changes
are merged upstream and arrive here with the next version.

## License

Memora is free software under the [GNU Affero General Public License v3.0 or later](LICENSE). If you
distribute a changed version, or run one as a service for others, you must offer its source under the
same license. Artwork and bundled libraries keep their own licenses, and the license does not grant use
of the Memora name for changed versions: see [NOTICE.md](NOTICE.md).

