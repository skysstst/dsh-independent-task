# Changelog

All notable changes to this plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-19

### Added

- **Empty tasks clean themselves up.** A task created and left without any user
  intent is archived, its workspace row is removed, and its timestamp folder is
  deleted from disk. Nothing to clean out by hand any more.
- **User intent keeps a task alive.** Typing text, pasting, attaching an image or
  a file, quoting a message or invoking a command all count as intent: the
  session stops being a disposable trial and is never auto-deleted, even if you
  switch to another conversation before sending.
- **Typed-but-unsent drafts survive navigation.** A plugin-created session whose
  session row would otherwise be hidden by Harness (blank sessions disappear off
  focus) now stays in the sidebar once you have typed something into it.
- New Host route `POST /api/dsh-independent-task/cleanup`, guarded by the same
  loopback trust fence as the create route.

### Changed

- The cleanup route **fails closed**. The Host's own connection authority is the
  only authority: a rejection from it is final for this route too, because the
  route deletes directories. When that service is absent the plugin's own fence
  requires a same-authority `Origin`, rejects `Sec-Fetch-Site: cross-site`, and
  accepts only loopback sockets and loopback `Host` headers.
- Cleanup deletes the folder **first** and unregisters the workspace only after
  the folder is really gone, so a failed delete leaves a working row instead of
  an orphan folder with no UI entry. Failures are retried a few times with
  backoff before the plugin gives up and says so in the console.
- Ownership is proved, not asserted: the folder name must be a timestamp this
  plugin could have minted, the marker's recorded `name` must match the folder,
  the workspace must point at the same real path, and the session must belong to
  that workspace. A copied marker file no longer makes an arbitrary folder
  deletable.
- A session whose surface cannot be read is treated as busy, not as empty.

### Notes

- The plugin only ever **reads** DSH's per-session draft storage
  (`dsh.conversation.*`); it never writes it. Harness already persists each
  session's draft, so mirroring it a second time is redundant and was the source
  of drafts reappearing after a send in some development builds. No such build
  was ever published, so there is nothing to fix for users of 1.1.0.

## [1.1.0] - 2026-11-11

### Added

- **Task-folder menu folded into the sidebar button** (no separate settings entry):
  - The sidebar control is now a split button: `[ 📁 │ ▾ ] New independent task`.
  - The small **▾** opens a dropdown holding the folder settings: **Choose task
    folder…** and **Reset to default**, with the root currently in use shown in
    the header.
  - **Choose task folder…** opens the native OS folder picker; the picked folder
    is saved as the remembered root **and** a new task is created there
    immediately, in one step.
  - The remembered root persists across restarts, so plain clicks on the main
    button keep using the last choice until it is changed again.
- New Host config route `POST/GET /api/dsh-independent-task/config` plus disk
  persistence in `~/.dsh/dsh-independent-task.json` (the Settings → parent path
  field edits the same value).
- `parentPath` can now be passed explicitly with a create request; it wins over
  the remembered folder (used by the ▾ menu right after picking).

### Removed

- The separate "Task folder settings" sidebar row and its modal dialog.
- The `alwaysPrompt` config flag (memory is now the default behaviour).

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
