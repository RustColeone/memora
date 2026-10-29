"""
memora_server.py — run the Memora sync server as one program.

This is what `memora-server.exe` runs (build_tools/build-server.cjs packages
it with PyInstaller). The desktop app starts it when "Host sync for my other
devices" is turned on; anyone can also run it on its own as the open-source
server.

    memora-server --base-dir "D:/Memora server" --port 5050
    memora-server --host 127.0.0.1          # this computer only

Tokens for outside agents (the Agent API, /api/agent/v1/*):

    memora-server token create "Mailbox receipts" --spending propose --notes read
    memora-server token list
    memora-server token revoke <id>

Data (data/, uploads/) lives in --base-dir. The pages the server shows in a
browser are bundled next to the program. A sync password comes from the
MEMO_SYNC_PASSWORD environment variable (kept out of the process list) or
<base-dir>/data/sync_auth.json. AI is bring-your-own-key: the server only uses
a key its owner configures.

When the server is listening it prints one line, which the desktop app waits
for:
    MEMORA_SERVER_READY {"host": "...", "port": 5050, "version": "..."}
"""

import argparse
import json
import os
import sys


def _app_dir():
    # PyInstaller unpacks bundled files (src/, package.json) into sys._MEIPASS.
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    return os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def _prepare(base_dir_arg):
    """Point the server at its data before importing it; returns the base folder."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    app_dir = _app_dir()
    base_dir = os.path.abspath(base_dir_arg or (os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else app_dir))
    os.makedirs(os.path.join(base_dir, 'data'), exist_ok=True)
    os.makedirs(os.path.join(base_dir, 'uploads'), exist_ok=True)
    os.environ['MEMO_APP_DIR'] = app_dir
    os.environ['MEMO_BASE_DIR'] = base_dir
    os.environ['MEMO_DATA_DIR'] = os.path.join(base_dir, 'data')
    os.environ['MEMO_UPLOAD_DIR'] = os.path.join(base_dir, 'uploads')
    if not getattr(sys, 'frozen', False):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    return base_dir


def token_main(argv):
    parser = argparse.ArgumentParser(prog='memora-server token', description='Agent API tokens')
    parser.add_argument('--base-dir', default=os.environ.get('MEMO_BASE_DIR'))
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('create', help='make a token (shown once)')
    create.add_argument('name')
    for page in ('notes', 'spending', 'plans'):
        create.add_argument('--' + page, choices=['read', 'propose', 'write'], help=page + ': read, propose or write')
    sub.add_parser('list', help='list tokens')
    revoke = sub.add_parser('revoke', help='revoke a token')
    revoke.add_argument('id')
    args = parser.parse_args(argv)
    _prepare(args.base_dir)
    import server  # noqa: E402
    tokens = server.app.memora_context.agent_tokens
    if args.command == 'create':
        scopes = {p: getattr(args, p) for p in ('notes', 'spending', 'plans') if getattr(args, p)}
        try:
            record, token = tokens.create(args.name, scopes)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        print('Token for %s (%s): %s' % (record['name'], ', '.join('%s %s' % kv for kv in record['scopes'].items()), token))
        print('Shown once. Give it to the agent as:  Authorization: Bearer <token>')
        print('id ' + record['id'])
    elif args.command == 'list':
        for r in tokens.list():
            print('%s  %-24s %-40s %s' % (r['id'], r['name'][:24], ', '.join('%s %s' % kv for kv in r['scopes'].items()), 'revoked' if r.get('revoked') else 'active'))
    else:
        if not tokens.revoke(args.id):
            print('No active token with id ' + args.id, file=sys.stderr)
            return 1
        print('Revoked ' + args.id)
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ['token']:
        sys.exit(token_main(argv[1:]))
    parser = argparse.ArgumentParser(prog='memora-server', description='Memora sync server')
    parser.add_argument('--host', default=os.environ.get('MEMO_HOST', '0.0.0.0'),
                        help='address to listen on (0.0.0.0 = every network, 127.0.0.1 = this computer only)')
    parser.add_argument('--port', type=int, default=int(os.environ.get('MEMO_PORT', '5050')))
    parser.add_argument('--base-dir', default=os.environ.get('MEMO_BASE_DIR'),
                        help='folder for the server\'s data/ and uploads/ (default: next to the program)')
    parser.add_argument('--threads', type=int, default=8)
    args = parser.parse_args(argv)
    base_dir = _prepare(args.base_dir)   # Windows consoles default to a legacy code page; the server logs emoji

    import server  # noqa: E402  (reads the environment above)
    from waitress import create_server  # noqa: E402

    httpd = create_server(server.app, host=args.host, port=args.port, threads=args.threads)
    ready = {'host': args.host, 'port': int(httpd.effective_port), 'version': server._read_app_version(), 'baseDir': base_dir}
    print('MEMORA_SERVER_READY ' + json.dumps(ready), flush=True)
    try:
        httpd.run()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.close()


if __name__ == '__main__':
    main()
