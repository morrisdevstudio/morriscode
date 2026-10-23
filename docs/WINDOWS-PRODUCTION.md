# Windows local production

Local production does not require publishing to npm, creating a release tag or merging into `main`.
Build and test the intended checkout, commit it with a conventional commit, then deploy an isolated copy
of `dist/`, `package.json` and its runtime dependencies. Record the commit in the deployment manifest.
The public release process remains in [RELEASE.md](RELEASE.md).

Production now follows signed GitHub releases instead. The one-time migration to a release that ships the updater is described in
[AUTO-UPDATE.md](AUTO-UPDATE.md): the installer verifies the release, writes `current.json`, and replaces
the `MorrisCode Server` task action with the stable `launcher.mjs`. After that, new versions are detected
and downloaded automatically; installing them still requires a click. The launcher keeps the previous
release and restores it if the new one does not become healthy.

The configuration in `%APPDATA%\morriscode` and the database in
`%LOCALAPPDATA%\morriscode\sessions.db` are not moved. Before the first migration, stop the task and copy
both locations outside the repository. `plugins/`, `skills/` and `workflows/` are never written by the
update mechanism.

## Data and backups

On Windows, configuration lives in `%APPDATA%\morriscode` and the production database lives in
`%LOCALAPPDATA%\morriscode\sessions.db`. Development uses the `morriscode-dev` directories.

Before changing production, take consistent SQLite backups of every source database and preserve the
configuration directories and exported Windows task definitions outside the repository. Never commit
configuration, credential stores, encryption keys, database snapshots or application logs.

The historical `migrate-from-openfox.mjs` script replaces the destination database. Do not use it to
combine independent histories. Instead, create a new candidate from stopped applications or their
consistent backups:

```powershell
node scripts/merge-session-histories.mjs --destination NEW.db `
  --source PRODUCTION-BACKUP.db --label Production `
  --source OPENFOX-BACKUP.db --label OpenFox `
  --source DEVELOPMENT-BACKUP.db --label Development
```

The destination must not exist. Shared event prefixes are retained in their longest form. Divergent
histories become separate sessions with a source suffix in the title. Production settings win on
conflict; all source files remain available for recovery. The tool checks database integrity and
foreign keys before returning success. Review the report and verify source histories before replacing
the stopped production database. Preserve its database sidecars together with the original file.

## Startup and HTTPS

The Windows tasks `MorrisCode Server` and `MorrisCode HTTPS` start at user logon without opening a
console window. Their launchers live outside the development checkout, in `%USERPROFILE%\morriscode`.
The application serves HTTPS on port 10369. The existing Caddy executable can preserve the previous
LAN address on port 443, validating the application's certificate when proxying to port 10369.
Use the existing server certificate for the public address to preserve browser trust.

Export the former OpenFox tasks before replacing them. Remove them only after the MorrisCode tasks
start successfully and unauthenticated API access is rejected. Keep the OpenFox installation and
original data available for rollback. Do not restart a development server as part of deployment.

## Manual verification

1. Open the usual HTTPS address and confirm that the login screen is required.
2. Open the newest OpenFox conversation and a MorrisCode conversation; check their last messages.
3. Check sessions labelled `[Development]` when histories diverged.
4. Select each provider and check its models and usage indicator; send a short message.
5. Sign out and back into Windows, then reopen the same HTTPS address.

For rollback, stop the MorrisCode tasks, preserve any conversations created since the switch, restore
the production database and configuration backups, and reimport the exported OpenFox tasks. Never
replace newer conversations without first backing them up.
