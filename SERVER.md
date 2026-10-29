# Memora server

The Memora server keeps your notebook on a computer you own and syncs it between your phone, your
computers and a browser. Open it in a browser to use Memora there, or enter its address as the
**Server URL** in the app (Settings → Sync).

No home server? Use the desktop app instead: Settings → **Host sync on this computer** runs this same
server while the app is open.

## With Docker (recommended)

```sh
# in the unzipped memora-server-<version> folder, or a clone of the repository
echo "MEMO_SYNC_PASSWORD=choose-a-long-password" > .env
docker compose up -d
```

The server listens on port 5050. Data (the database and uploads) lives in the `memora-data` volume.
Back it up like any other volume. To update, replace the folder with the new version and run
`docker compose up -d --build`.

## With Python

Python 3.10 or newer:

```sh
pip install -r requirements.txt
pip install pillow pypdf          # optional: photo and PDF reading
MEMO_SYNC_PASSWORD=choose-a-long-password python backend/memora_server.py --base-dir ./memora-data
```

| Option | Default | |
|---|---|---|
| `--base-dir` | the program's folder | where `data/` and `uploads/` are kept |
| `--port` | `5050` | |
| `--host` | `0.0.0.0` | `127.0.0.1` keeps it to this computer (for a reverse proxy) |
| `MEMO_SYNC_PASSWORD` | none | the password every device needs; or put `{"password": "…"}` in `<base-dir>/data/sync_auth.json` |

Run it as a service (systemd, a NAS task, `nssm` on Windows) to keep it up.

## Mods

Mods for the pages this server shows go in `<base-dir>/mods` (with Docker: `/data/mods` in the volume). Each browser
turns them on in Settings → Mods. See `docs/MODS.md`.

## Reaching it away from home

Plain HTTP is fine on a home network you trust. To reach the server from outside, don't open a port to
plain HTTP; put HTTPS in front of it:

- **Tailscale** (private, nothing exposed to the internet): install Tailscale on the server and your
  phone, then `tailscale serve --bg 5050`. Use the `https://<machine>.<tailnet>.ts.net` address it shows.
- **A domain with a reverse proxy**: run the server with `--host 127.0.0.1` and let Caddy add a
  certificate. A `Caddyfile` with `memora.example.com { reverse_proxy 127.0.0.1:5050 }` is all it takes.

Either way, use a long sync password. Ten wrong passwords from one address within a minute make that
address wait. Outside agents should use their own tokens (`memora_server.py token create …`, see
`API_DOCUMENTATION.md`), never the sync password.

## AI

The server has no AI key of its own, and devices normally use the key saved in their own Vault. To give
the server an AI that AI contacts can use, set your own provider key in its environment (in `.env` for
Docker, then add the variable under `environment:` in `compose.yaml`):

| Provider | Variables |
|---|---|
| Gemini | `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` (needs `pip install google-generativeai`) |
| OpenAI | `LLM_PROVIDER=openai`, `OPENAI_API_KEY` |
| DeepSeek | `LLM_PROVIDER=deepseek`, `DEEPSEEK_API_KEY` |
| Claude | `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` |
| Any OpenAI-compatible service (Ollama, OpenRouter…) | `LLM_PROVIDER=custom`, `LLM_CUSTOM_BASE_URL`, `LLM_CUSTOM_API_KEY` |

`LLM_MODEL` picks a model other than the provider's default. The Docker image includes the `openai` and
`anthropic` libraries; with plain Python, `pip install openai` (OpenAI, DeepSeek, custom) or
`pip install anthropic` (Claude) as needed.
