import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientPath = join(__dirname, '..', 'client.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function loadActivityBrowser({ sessionsById, workspaces, archivedSessionIds = [], currentSessionId = null }) {
  const code = readFileSync(clientPath, 'utf8');
  let pluginDef = null;

  const elements = [];
  const createElement = (type, props, ...children) => ({ type, props, children });

  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    AbortController,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    window: {
      __ModuleLoader__: {
        load(def) {
          pluginDef = def;
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };

  vm.runInNewContext(code, sandbox);
  assert.ok(pluginDef, 'client.js should register plugin via __ModuleLoader__.load');

  const ReactMock = {
    Fragment: Symbol('Fragment'),
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (val) => ({ current: val }),
  };

  let capturedEl = null;
  const plugin = pluginDef.factory((id) => {
    if (id === 'react') return ReactMock;
    if (id === 'react-dom') return { createPortal: (el) => el };
    if (id === 'react-dom/client') {
      return {
        createRoot: () => ({
          render: (el) => {
            capturedEl = el;
          },
          unmount: () => {},
        }),
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  });

  let activityBrowser = null;
  const ctx = {
    effect: (fn) => {
      // Capture ActivitySessionBrowser when the activity sidebar effect is skipped in headless env,
      // or invoke render directly below.
      void fn;
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: () => {},
      register: () => {},
    },
    uiWorkspace: {
      selection: { getSnapshot: () => ({ sessionId: currentSessionId }), subscribe: () => () => {} },
      openSession: () => {},
    },
    get(name) {
      if (name === 'sessions') {
        return {
          list: {
            getSnapshot: () => ({ byId: sessionsById }),
            subscribe: () => () => {},
          },
        };
      }
      if (name === 'workspaces') {
        return {
          list: {
            getSnapshot: () => ({ items: workspaces, archivedSessionIds, pinnedSessionIds: [] }),
            subscribe: () => () => {},
          },
        };
      }
      return null;
    },
  };

  // Expose React.createElement capture by rendering ActivitySessionBrowser via a tiny hook
  const origEffect = ctx.effect;
  ctx.effect = (fn, label) => {
    if (label === 'independent-task activity sidebar') {
      // Simulate document + hostEl mount to capture the rendered React element
      sandbox.document = {
        getElementById: () => null,
        createElement: (tag) => ({
          tag,
          id: '',
          textContent: '',
          className: '',
          classList: { toggle: () => {}, remove: () => {} },
          remove: () => {},
        }),
        head: { appendChild: () => {} },
        body: {},
        querySelector: (sel) => {
          if (sel === '[data-sidebar-list-area]') {
            return {
              clientWidth: 260,
              parentElement: { querySelectorAll: () => [] },
              closest: () => null,
              prepend: () => {},
              classList: { toggle: () => {}, remove: () => {} },
            };
          }
          return null;
        },
      };
      sandbox.MutationObserver = class {
        observe() {}
        disconnect() {}
      };
      const cleanup = fn();
      activityBrowser = capturedEl?.type;
      cleanup?.();
      return;
    }
    return origEffect(fn, label);
  };

  plugin.apply(ctx);
  assert.equal(typeof activityBrowser, 'function', 'ActivitySessionBrowser should be captured');
  const tree = activityBrowser({ isWide: true, isSearching: false });
  // Flatten ActivityBucketSection children to inspect buckets
  return tree.children
    .filter((c) => c && typeof c === 'object' && c.props && c.props.bucket)
    .map((c) => c.props.bucket);
}

test('classifies sessions into 1d, 2-7d, inactive, and hidden(Bot) buckets', () => {
  const now = Date.now();
  const buckets = loadActivityBrowser({
    now,
    currentSessionId: 's-1d',
    archivedSessionIds: ['s-archived'],
    workspaces: [
      { workspaceId: 'w-main', title: '电脑优化', path: 'D:\\AI Code\\电脑优化', sessionIds: ['s-1d', 's-2d', 's-old', 's-archived', 's-blank-other'] },
      { workspaceId: 'w-task', title: '2026-11-25_120000', path: 'D:\\AI Code\\2026-11-25_120000', sessionIds: ['s-task'] },
      { workspaceId: 'w-bot', title: 'DS Bot', path: 'C:\\Users\\12802\\.dsh\\bot\\workspace', sessionIds: ['s-bot'] },
    ],
    sessionsById: {
      's-1d': { id: 's-1d', title: 'Recent 1d', updatedAt: now - DAY_MS + 1000, blank: false },
      's-task': { id: 's-task', title: 'Task Title', updatedAt: now - 1000, blank: false },
      's-2d': { id: 's-2d', title: 'Recent 2d', updatedAt: now - DAY_MS - 1000, blank: false },
      's-7d': { id: 's-7d', title: 'Recent 7d', updatedAt: now - WEEK_MS + 1000, blank: false },
      's-old': { id: 's-old', title: 'Old Session', updatedAt: now - WEEK_MS - 1000, blank: false },
      's-bot': { id: 's-bot', title: 'Bot Ping', updatedAt: now, blank: false },
      's-im': { id: 's-im', title: 'IM Bot', updatedAt: now, cwd: 'C:\\Users\\12802\\.dsh\\im', blank: false },
      's-sub': { id: 's-sub', title: 'Subagent', origin: 'subagent', updatedAt: now, blank: false },
      's-archived': { id: 's-archived', title: 'Archived', updatedAt: now, blank: false },
      's-blank-other': { id: 's-blank-other', title: '', updatedAt: now, blank: true },
    },
  });

  const byKey = Object.fromEntries(buckets.map((b) => [b.key, Array.from(b.items)]));

  assert.deepEqual(Array.from(byKey.recent1d, (i) => i.id), ['s-task', 's-1d']);
  assert.equal(byKey.recent1d[0].showWorkspaceSubtitle, false, 'timestamp workspace subtitle hidden when titled');
  assert.equal(byKey.recent1d[1].showWorkspaceSubtitle, true, 'normal workspace subtitle shown');

  assert.deepEqual(Array.from(byKey.recent2to7d, (i) => i.id), ['s-2d', 's-7d']);
  assert.deepEqual(Array.from(byKey.inactive, (i) => i.id), ['s-old']);
  assert.deepEqual(Array.from(byKey.hidden, (i) => i.id).sort(), ['s-bot', 's-im']);
});

test('places running and current blank sessions at the top of recent1d', () => {
  const now = Date.now();
  const buckets = loadActivityBrowser({
    currentSessionId: 's-blank-current',
    workspaces: [],
    sessionsById: {
      's-older': { id: 's-older', title: 'Older', updatedAt: now - 5000, blank: false },
      's-running': { id: 's-running', title: 'Running', updatedAt: now - 3 * DAY_MS, running: true, blank: false },
      's-blank-current': { id: 's-blank-current', title: '', updatedAt: now - 10000, blank: true },
    },
  });

  const byKey = Object.fromEntries(buckets.map((b) => [b.key, Array.from(b.items)]));
  const recentIds = Array.from(byKey.recent1d, (i) => i.id);
  assert.equal(recentIds.length, 3);
  assert.ok(recentIds.slice(0, 2).includes('s-running'));
  assert.ok(recentIds.slice(0, 2).includes('s-blank-current'));
  assert.equal(recentIds[2], 's-older');
});
