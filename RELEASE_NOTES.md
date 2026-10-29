The first public release of Memora: notes, spending and plans in one private notebook, with a Vault for
passwords and AI contacts that suggest changes you approve with a tap. Bring your own AI key.

## Which download?

| You want | Download |
|---|---|
| Memora on a home server or NAS, for all your devices | `memora-server-<version>.zip` (Docker or Python, see `SERVER.md` inside) |
| Memora on a Windows PC | `Memora-<version>-win-x64.zip`: unzip, run `Memora.exe` |
| Memora on a Mac with Apple silicon | `Memora-<version>-mac-arm64.zip`: unzip, move `Memora.app` to Applications |
| Memora on Linux | `Memora-<version>-linux-x86_64.AppImage` (or the `.tar.gz`) |
| Memora on Android | [Google Play](https://play.google.com/store/apps/details?id=com.laplacengan.memora) |

The desktop apps can host the sync server themselves (Settings → Host sync on this computer), so you
don't need a separate server to sync your phone.

The desktop builds are not signed. Windows SmartScreen may say "Windows protected your PC": choose
More info → Run anyway. On a Mac, if macOS says the app is damaged or can't be opened, run
`xattr -dr com.apple.quarantine /Applications/Memora.app` once.

How Memora is built, as diagrams you can tap through on a phone: https://rustcoleone.github.io/memora/architecture/

## In this version

- Planner: a repeating event uses a single reminder that moves on to the next time after each alert.
- Purchases saved without a date show the local day, not the next day in the evening.
- Mods: drop a folder into the mods folder and turn it on in Settings → Mods (see `docs/MODS.md`).
- About links to this source code (AGPL-3.0).
