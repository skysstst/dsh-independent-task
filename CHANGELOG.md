# Changelog

All notable changes to this plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-11

### Added

- **New independent task** entry at the top of the sidebar, immediately under
  the native "New session" button (registered in `sidebar.panellist` with a
  negative `order`; the native button is untouched).
- Slash command `/new-independent-task` and an authenticated loopback HTTP
  route, both running the same core operation.
- Timestamped workspace folder creation (`YYYY-MM-DD_HHmmss`), Workspace
  registration, and new-session creation in one click; the Client opens the
  minted session directly via `uiWorkspace.openSession()`.
- Workspace **display-title** sync from the generated session title, scoped to
  folders carrying the `.dsh-independent-task.json` marker. `Workspace.path`
  and the on-disk folder name are never changed.
- `parentPath` setting (`Settings → Independent tasks`), blank = parent of the
  current workspace.

### Reliability

- Same-second clicks wait for the clock to advance and re-stamp instead of
  appending `_2`/`_3`, keeping folder names clean (5 s deadline).
- Failed workspace registration or session creation rolls back the fresh
  folder and any half-registered workspace.
- In-memory cache of plugin-owned Workspace ids keeps the title listener off
  the filesystem for unrelated sessions.
- Strict loopback trust fence on the HTTP route (exact `Host`, no cross-site).
- All registrations go through `ctx.effect`, so unloading disposes cleanly.

### Notes

- Requires DeepSeek Harness `>= 0.2.2-rc.1`.
- `@deepseek-ai/schemastery` and `@deepseek-ai/cosmokit` are vendored (MIT) and
  imported by relative path, so a linked local install stays self-contained.
