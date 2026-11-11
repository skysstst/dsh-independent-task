/**
 * Host half of the "Independent tasks" plugin.
 *
 * One operation, two entry points (a slash command and an authenticated HTTP
 * route used by the sidebar button):
 *
 *   1. Pick a parent directory (the configured one, or the parent of the
 *      current workspace).
 *   2. Create a child directory named by the current wall-clock second, e.g.
 *      2026-11-11_173005. On a same-second collision it waits for the next
 *      second and re-stamps, so rapid clicks always get distinct, clean
 *      timestamp names (no _2/_3 suffix).
 *   3. Register that directory as a Workspace with ctx.workspaceRegistry.create.
 *   4. Create a new Session in that Workspace with ctx.sessionController.create.
 *      The Host derives header.cwd from the Workspace path and attaches the
 *      Session itself; this plugin never edits header.cwd and never rewrites a
 *      SessionCreateRequest location (there is no `location` field in 0.2.2).
 *      If step 3 or 4 fails, the freshly created directory is rolled back.
 *
 * A separate session/event listener syncs a generated Session title onto the
 * Workspace's DISPLAY title via workspace.setTitle(). The physical directory
 * name (and the immutable Workspace.path) is never touched.
 */

// Vendored MIT copy (see vendor/LICENSE.*): a linked local bundle resolves ESM
// bare imports from its real checkout, which has no node_modules. A relative
// import keeps this plugin self-contained in every profile.
import z from './vendor/schemastery.mjs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Marker written inside directories this plugin owns, so only they get titles synced. */
const MARKER_FILE = '.dsh-independent-task.json';
const MARKER_TAG = 'dsh-independent-task';
export const API_PATH = '/api/dsh-independent-task/create';

export const name = 'independent-task';

/** Services this half needs; declared so the row stays inactive without them. */
export const inject = [
  'workspaceRegistry',
  'sessionController',
  'commands',
  'webServer',
  'connection',
];

/**
 * Volatile settings field: only .volatile() fields are projected into the
 * Settings UI form. Read live via config.parentPath.get().
 * Empty string = use the parent directory of the current workspace.
 */
export const Config = z.object({
  parentPath: z.string().default('').volatile(),
});

function readConfigField(field, fallback) {
  if (field === undefined || field === null) return fallback;
  if (typeof field === 'object' && typeof field.get === 'function') return field.get();
  return field;
}

function configParentPath(config) {
  const raw = readConfigField(config?.parentPath, '');
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Local wall-clock stamp: YYYY-MM-DD_HHmmss (local timezone, matching the GUI).
 * Seconds keep rapid successive clicks distinct without the ugly _2/_3 suffix.
 */
function timestampName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * Resolve the parent directory for a new timestamped task folder.
 * - A non-empty config value is used as-is (absolute, or resolved against the
 *   Host process cwd when relative).
 * - Otherwise: the parent of the current workspace. "Current" = the workspace
 *   owning the most recently created live session; falls back to the first
 *   (newest) registered workspace; then to the Host process cwd's parent.
 */
function resolveParent(ctx, config) {
  const configured = configParentPath(config);
  if (configured !== '') {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  const workspaces = ctx.workspaceRegistry.list();
  let currentPath;
  try {
    const sessions = ctx.get('sessions');
    const list = sessions?.list?.() ?? [];
    const ordered = [...list].sort(
      (a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0),
    );
    for (const session of ordered) {
      const owner = workspaces.find((w) => w.sessionIds.includes(session.id));
      if (owner !== undefined) {
        currentPath = owner.path;
        break;
      }
    }
  } catch {
    /* the sessions service is optional in some compositions */
  }
  if (currentPath === undefined && workspaces.length > 0) currentPath = workspaces[0].path;
  if (currentPath !== undefined && currentPath !== '') return dirname(currentPath);
  return dirname(process.cwd());
}

/**
 * Create a fresh child directory under parent, named by the current wall-clock
 * second. On a same-second collision we wait for the clock to advance and
 * re-stamp, so rapid clicks still get distinct, clean timestamp names and never
 * an ugly _2/_3 suffix. A total deadline keeps a frozen/rolled-back clock from
 * hanging a request; exceeding it fails loudly instead of writing a suffix.
 */
async function makeTaskDirectory(parent) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`could not allocate a timestamp directory under ${parent} within 5s`);
    }
    const name = timestampName();
    const full = join(parent, name);
    try {
      await mkdir(full, { recursive: false });
      return { name, full };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // Same second as an existing task: wait until the second changes.
      const current = name;
      while (timestampName() === current && Date.now() <= deadline) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
}

async function writeMarker(full, name) {
  await writeFile(
    join(full, MARKER_FILE),
    JSON.stringify({ tag: MARKER_TAG, name, createdAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

async function hasMarker(path) {
  try {
    const text = await readFile(join(path, MARKER_FILE), 'utf8');
    return JSON.parse(text).tag === MARKER_TAG;
  } catch {
    return false;
  }
}

function warn(message, error) {
  console.warn(`[independent-task] ${message}`, error);
}

/**
 * The single core operation. Returns the created identities or throws with a
 * human-readable reason. Both the command and the HTTP route call this.
 */
export async function createIndependentTask(ctx, config) {
  const parent = resolveParent(ctx, config);

  // The parent must exist: workspaceRegistry.create resolves paths through
  // fs.realpath and rejects a nonexistent directory.
  await mkdir(parent, { recursive: true });

  const { name, full } = await makeTaskDirectory(parent);

  // Anything below this point failing leaves a half-created task. Roll back the
  // fresh directory (and the Workspace row, if it was already registered) so a
  // failed click never litters the parent with orphan folders.
  let workspace;
  try {
    await writeMarker(full, name);
    // create(path, title?) — path must already exist; the timestamp name is the
    // initial display title (later replaced by the generated session title).
    workspace = await ctx.workspaceRegistry.create(full, name);
    // The Host maps workspaceId -> workspace.path -> header.cwd and calls
    // workspace.attachSession(sessionId) itself. No cwd/location is rewritten.
    const created = await ctx.sessionController.create({ workspaceId: workspace.id });
    return { workspaceId: workspace.id, path: full, name, sessionId: created.sessionId };
  } catch (error) {
    if (workspace !== undefined) {
      try {
        await ctx.workspaceRegistry.delete(workspace.id);
      } catch (cleanupError) {
        warn('workspace rollback failed', cleanupError);
      }
    }
    try {
      await rm(full, { recursive: true, force: true });
    } catch (cleanupError) {
      warn('directory rollback failed', cleanupError);
    }
    const stage = workspace === undefined ? 'registering workspace' : 'creating a session';
    throw new Error(`${stage} at ${full} failed: ${error?.message ?? String(error)}`);
  }
}

/**
 * Find the plugin-owned Workspace that owns a session.
 *
 * Fast path: the in-memory set of ids WE created this run (createIndependentTask
 * adds to it). Membership alone is then enough; no filesystem access at all.
 * Cold path (plugin reloaded, so the set is empty): resolve by durable
 * membership or cwd, then verify the on-disk marker so we never rename a
 * Workspace this plugin did not create. The marker read is cached per path.
 */
async function ownedWorkspaceForSession(ctx, session, ownedIds, markerCache) {
  const workspaces = ctx.workspaceRegistry.list();
  const byId = workspaces.find((w) => ownedIds.has(w.id) && w.sessionIds.includes(session.id));
  if (byId !== undefined) return byId;

  const byMembership = workspaces.find((w) => w.sessionIds.includes(session.id));
  const cwd = session.header?.cwd;
  const byPath = cwd !== undefined && byMembership === undefined
    ? await ctx.workspaceRegistry.resolveByPath(cwd)
    : undefined;
  const candidate = byMembership ?? byPath;
  if (candidate === undefined) return undefined;

  let owned = markerCache.get(candidate.path);
  if (owned === undefined) {
    owned = await hasMarker(candidate.path);
    markerCache.set(candidate.path, owned);
  }
  return owned ? candidate : undefined;
}

/**
 * Trust fence matching the Host's own /api route families.
 *
 * The Host's connection service is the authority when it is present. Otherwise
 * fall back to a strict loopback check: the socket must be a loopback peer AND
 * the Host header must name a loopback host exactly (no `127.0.0.10`,
 * `localhost.evil.com`, or other prefix look-alikes), and a cross-site fetch
 * is always refused. This blocks a browser page on another origin from
 * reaching the route through the user's own loopback interface.
 */
function requestAllowed(ctx, req) {
  const connection = ctx.connection;
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    if (connection.requestRejection(req) === undefined) return true;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;

  const addr = String(req.socket?.remoteAddress ?? '');
  const loopbackSocket =
    addr === '::1' || addr === '127.0.0.1' || /^::ffff:127\.0\.0\.1$/.test(addr);

  // Strip the port; keep IPv6 literals bracketed so `[::1]:1234` parses.
  const hostHeader = String(req.headers.host ?? '').toLowerCase();
  let hostname;
  if (hostHeader.startsWith('[')) hostname = hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  else hostname = hostHeader.split(':')[0];
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';

  return loopbackSocket && loopbackHost;
}

export function apply(ctx, config) {
  // Workspace ids created by this plugin instance: lets the title listener skip
  // filesystem work for every unrelated session/title event. Also lets a
  // successful create be recognised immediately on replay after a reload.
  const ownedIds = new Set();
  const markerCache = new Map();

  /** Create a task and remember its Workspace id for the title fast path. */
  const createAndTrack = async () => {
    const result = await createIndependentTask(ctx, config);
    ownedIds.add(result.workspaceId);
    return result;
  };

  // ---- 1. Slash command ----------------------------------------------------
  const commandOff = ctx.commands.register({
    name: 'new-independent-task',
    description: 'Create a timestamped workspace folder and start a new session inside it',
    input: { hint: '[optional first task description]' },
    handler: async () => {
      try {
        const result = await createAndTrack();
        return {
          kind: 'success',
          text: `Independent task created in ${result.path} (workspace ${result.workspaceId}, session ${result.sessionId}).`,
        };
      } catch (error) {
        return { kind: 'error', text: `Could not create an independent task: ${error?.message ?? String(error)}` };
      }
    },
  });

  // ---- 2. Authenticated HTTP route for the sidebar button -----------------
  const route = {
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      const json = (status, body) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST') return json(405, { ok: false, error: 'method-not-allowed' });
      if (!requestAllowed(ctx, req)) return json(403, { ok: false, error: 'forbidden' });
      try {
        return json(200, { ok: true, ...(await createAndTrack()) });
      } catch (error) {
        return json(500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };
  const routeOff = ctx.webServer.register(route);

  // ---- 3. Session title -> Workspace display title ------------------------
  // session/title is a durable, log-only event; session/event is emitted for
  // every committed append, so this works across resume and replay too.
  const eventOff = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'session/title') return;
    const title = event?.data?.title;
    if (typeof title !== 'string' || title.trim() === '') return;
    void (async () => {
      try {
        const workspace = await ownedWorkspaceForSession(ctx, session, ownedIds, markerCache);
        if (workspace === undefined) return;
        if (workspace.title === title.trim()) return; // no-op: avoid a write
        // setTitle only changes the record's display title. Workspace.path and
        // the on-disk timestamp directory are immutable and stay untouched.
        await workspace.setTitle(title.trim());
      } catch (error) {
        warn('title sync failed', error);
      }
    })();
  });

  // Everything is registered inside ctx.effect: unloading the plugin disposes
  // the command, the route, and the listener in reverse order, automatically.
  ctx.effect(function* () {
    yield commandOff;
    yield routeOff;
    yield eventOff;
  }, 'independent-task lifecycle');
}
