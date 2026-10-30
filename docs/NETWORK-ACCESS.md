# Local Network Access & HTTPS

By default MorrisCode listens on `127.0.0.1` and is reachable only from the machine running it.
This page covers reaching it from every other device on the same network, over HTTPS.

## Turning it on

Settings → **Advanced** → **Network** → **Local network access**:

- **Reachable from the local network** — binds `0.0.0.0` instead of `127.0.0.1`, so other machines can connect.
- **HTTPS (self-signed certificate)** — serves the same port over TLS.

Both switches persist to the global config and need a server restart; the panel says so.

The same settings are available from the CLI for a single run, and in the config file:

```bash
morriscode --network --https          # LAN + HTTPS, this run only
morriscode --host 0.0.0.0 --https
morriscode --https-cert /path/cert.pem --https-key /path/key.pem   # bring your own certificate
```

In an interactive terminal, `npm run dev` asks on every launch whether to use localhost only or allow
devices on the local network (including a phone). This choice happens before `tsx watch` starts,
so arrow keys and Enter belong to the menu. The selected host overrides the saved configuration for
that run. Use `npm run dev -- --network` or `npm run dev -- --host 127.0.0.1` to skip the menu.

The dev launcher checks ports starting at **10380**, using the first available port up to 10480,
so OpenFox can keep running on 10369. The selected port is printed at startup and kept across
watcher restarts. An explicit `--port`/`-p` or `MORRISCODE_PORT` takes precedence.

On a fresh production install the CLI asks once how the server should be reachable and writes the answer to
`config.json`. That prompt is skipped when the command line already answers the question
(`--network`, `--host`, `--https`, `--no-https`, `--https-cert`/`--https-key`, or
`--password <secret>` to require one), when stdin is not a terminal, and when
`MORRISCODE_NONINTERACTIVE=1` is set. The dev launcher sets this only for the child running under
`tsx watch`, after the menu has been answered. The watcher reads stdin to restart the process,
so the server process must not render its own interactive setup menu.

```json
// <config dir>/config.json
{
  "server": {
    "port": 10369,
    "host": "0.0.0.0",
    "https": true
  }
}
```

Config directories: `%APPDATA%\morriscode` on Windows, `~/Library/Application Support/morriscode`
on macOS, `~/.config/morriscode` on Linux (`-dev` suffix for development mode).

HTTPS replaces plain HTTP on the same port — there is no second listener, so nothing extra to open
in your firewall.

## The certificate

MorrisCode generates a self-signed certificate on the first start with HTTPS enabled and stores it in
`<config dir>/certs/` (`server.crt`, `server.key`, `meta.json`), with these subject alternative
names: `localhost`, `127.0.0.1`, `::1`, the machine hostname, `<hostname>.local`, and every LAN
address of the machine. It is reused as long as it still covers those names and does not expire within
30 days, so a browser exception you already accepted keeps working.

If your IP changes and the old address is no longer covered, delete the `certs` directory and restart
to get a fresh certificate.

## Trusting it on other devices

Every device shows a certificate warning once. Accept it in the browser, or import the certificate so
the warning never appears (needed for a clean PWA install):

```powershell
# Windows (current user)
certutil -addstore -user Root <config dir>\certs\server.crt
```

```bash
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain server.crt

# Linux (Debian/Ubuntu)
sudo cp server.crt /usr/local/share/ca-certificates/morriscode.crt && sudo update-ca-certificates
```

On iOS and Android, transfer `server.crt` to the device and install it as a profile / CA certificate
in the security settings, then enable trust for it.

## Firewall

The first time the server binds to `0.0.0.0`, Windows asks whether to allow Node.js through the
firewall — answering "Private networks" is enough. If the prompt was dismissed, add the rule manually
from an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "MorrisCode" -Direction Inbound -Protocol TCP -LocalPort 10369 -Action Allow -Profile Private
```

## Installing it as an app on another device

Open the HTTPS URL on that device (the Settings panel lists them, e.g. `https://192.168.1.23:10369`),
accept the certificate, then use the browser install action ("Install app" / "Add to Home Screen").
The PWA, the service worker and the clipboard API all need a secure context, which is exactly what
HTTPS provides here.

## Using your own certificate

Anything that produces a PEM pair works, including mkcert (https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert -cert-file cert.pem -key-file key.pem 192.168.1.23 localhost
```

Point `server.httpsCert` and `server.httpsKey` (or `--https-cert` / `--https-key`) at those files.
Both must be set together; a configured pair is used as-is and never regenerated.

## Troubleshooting

- **Another device cannot connect** — check the firewall rule above, and that both devices are on the
  same network. The startup banner lists the exact URLs to open.
- **`Blocked request. This host is not allowed` in dev mode** — Vite rejects hostname-based access
  (literal IPs pass). MorrisCode turns that check off for its own dev server; it still applies to the
  standalone `npm run dev:web` server, where you can add the host in `web/vite.config.local.ts`.
- **A tool refuses the certificate** — an MCP client or script that validates TLS rejects a self-signed
  certificate. Point it at `http://127.0.0.1:<port>` with HTTPS off, or use a certificate it trusts.

## Security

LAN access without a password means anyone on the network can drive the agent: read and write files,
run commands, spend your model quota. Keep it on trusted networks only.

The optional network-mode password is currently **not** enforced on Windows and macOS: the server
resolves `auth.json` under `~/.config/morriscode` while the CLI writes it to `%APPDATA%\morriscode`
(Windows) or `~/Library/Application Support/morriscode` (macOS), so it finds no password and asks for
none. Fixing that path mismatch is tracked separately — it would switch the password prompt on for
existing installs.

See also [REVERSE-PROXY.md](REVERSE-PROXY.md) for reaching MorrisCode through a domain, a tunnel, or a
load balancer.
