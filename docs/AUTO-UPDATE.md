# Automatic updates from GitHub releases

MorrisCode updates itself from the public release repository
`morrisdevstudio/morriscode-releases`. The source repository stays private; only
the signed packages and their release notes are public.

## Trust model

Each release publishes:

- `morriscode-<version>-win32-x64.zip`
- `morriscode-<version>-linux-x64.tar.gz`
- `manifest.json` and `manifest.json.sig`
- `release-public-key.pem`, `install.ps1`, `install.sh`, `launcher.mjs`
  and `verify-release.mjs`

The manifest lists every package name, size and SHA-256 digest. It is signed
with an Ed25519 private key that never enters the repository. The application
embeds the matching public key in `src/server/update/trusted-keys.ts` and
refuses an unsigned manifest, an unknown key, a different digest, or a package
built for another platform. Nothing is extracted or executed before those
checks pass.

## One-time signing setup

Generate the key pair outside the repository:

```powershell
node scripts/setup-release-signing.mjs "$env:USERPROFILE\.morriscode\release-signing.key" `
  --public-key-out release-public-key.pem --update-code --key-id release
```

The command writes the private key outside the checkout, writes the public key
to `release-public-key.pem`, and patches `src/server/update/trusted-keys.ts`.
Commit the public key and the updated trusted-keys file.

Then add the private key to GitHub as the secret `RELEASE_SIGNING_KEY`, encoded
in base64:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.morriscode\release-signing.key"))
```

Create a fine-grained token with `contents: write` on
`morrisdevstudio/morriscode-releases` and store it as `RELEASES_REPO_TOKEN`.
Create that repository first with an initial README; it only holds release
assets and never receives source code. GitHub needs at least one commit before
it can host a tag and a release.
Optionally set the repository variable `RELEASE_KEY_ID` (defaults to
`release`). Protect the `release` environment with a required reviewer so the
signing key cannot be used by an unreviewed tag.

## Publishing a release

Pushing a `v*` tag starts `.github/workflows/release.yml`. The workflow checks
the version, builds and tests both platforms, prunes development dependencies,
creates both archives, signs the manifest, publishes a draft release in the
public repository, uploads every asset, then makes the release public. The
application only sees releases that passed the whole chain.

The tag must match `package.json`: `v0.3.1` for version `0.3.1`.

## Update lifecycle in the application

1. The server checks `releases/latest` on startup and every 30 minutes (with an
   ETag cache and jitter), provided automatic updates are enabled.
2. Only newer stable releases are considered. Drafts and prereleases are
   ignored.
3. The package is downloaded in the background into
   `releases/.staging/<version>`, verified, extracted, and smoke-tested with
   `dist/cli/index.js --version`.
4. The package stays ready on disk. MorrisCode never restarts by itself.
5. The user clicks **Install and restart**. The next step is the only moment
   when the current release is replaced.
6. Before switching, MorrisCode backs up `config.json`, `auth.json`, `auth.key`,
   `certs/` and a consistent SQLite copy to `update-backups/<timestamp>` (three
   snapshots are kept). Then it writes `current.json` and exits cleanly.
7. `launcher.mjs` starts the new version, waits up to 90 seconds for
   `/api/health`, and restores the previous package plus the configuration and
   database snapshots if the new version does not start. Otherwise it records
   the success in `last-update.json` and removes older releases.

The configuration (`%APPDATA%\morriscode`, `~/.config/morriscode`) and the
database (`%LOCALAPPDATA%\morriscode\sessions.db`,
`~/.local/share/morriscode/sessions.db`) keep their existing locations. Updating
only adds a version directory and changes the launcher pointer.

## Installation

Windows, new machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Existing production on this machine (stop the task first):

```powershell
powershell -ExecutionPolicy Bypass -File .\backup-production.ps1 -StopTask
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -Root "C:\Users\Yann\morriscode" `
  -TaskName "MorrisCode Server" -ExistingTask -Start `
  -PreviousVersion 0.1.0 -PreviousDir releases/2026-10-16-production `
  -Arguments "--port 10369 --host 127.0.0.1 --no-https --no-browser"
```

The installer downloads the latest signed release, verifies it, extracts it,
updates the startup task and leaves `%APPDATA%\morriscode` untouched. Before
running it on production, copy the configuration and stop the server so the
database snapshot is consistent.

Linux:

```bash
bash ./install.sh
```

Options include `--root`, `--no-auto-update`, `--no-service`, `--no-start` and
`--bundle` with `--manifest`, `--signature` and `--public-key` for an offline
install. `--no-auto-update` only changes the initial default; the setting can be
reenabled later from Settings → Advanced.

## First deployment and rollback

The current production build (0.1.0) predates the launcher. Install 0.3.1 once
with the command above; every later release updates itself. Keep the old
`releases/2026-10-16-production` directory and the exported task XML until the
new version has been verified.

Automatic rollback covers a package that cannot become healthy. For a manual
rollback, stop the task, restore `current.json` to the previous entry, copy the
desired `update-backups/<timestamp>` files back, and start the task again. Never
delete the current release or the database before preserving the conversations
created since the update.

## Troubleshooting

- `manifest signature is not trusted`: `release-public-key.pem` and
  `trusted-keys.ts` do not contain the same key, or the tag was signed with
  another key.
- `No published release found`: the public repository is private, empty, or the
  token used by the workflow cannot write to it.
- `No release package for <platform>-<arch>`: the manifest has no matching
  asset; only Windows x64 and Linux x64 are built for now.
- The new version is not healthy: read `logs/launcher.log`, then restore the
  previous pointer or rerun the installer.
