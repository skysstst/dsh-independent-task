/**
 * Client half of the "Independent tasks" plugin.
 *
 * ONE sidebar entry (order -1000, immediately under the native "New session"
 * button): a split control.
 *
 *   [ folder icon | ▾ ]  新建独立任务
 *
 *   - Clicking the folder icon (or the row itself) creates a timestamped folder
 *     and opens a new session inside it, using the REMEMBERED task root.
 *   - Clicking the small ▾ opens a dropdown that holds the folder settings:
 *       · "Choose task folder…" — native OS folder picker. On pick it is saved
 *         as the remembered root AND a new task is created there immediately.
 *       · "Reset to default" — forgets the saved root (falls back to the parent
 *         of the current workspace).
 *
 * The remembered root persists across restarts (Host config route + localStorage
 * cache), so after setting it once, plain clicks on the main button keep using
 * it until you change it again.
 *
 * The host renders a `sidebar.panellist` row as
 *   <button onClick={() => selectPanel(id)}>
 *     <span aria-hidden>{renderSlot("sidebar.panellist", {size,active}, {only:id})}</span>
 *     <span class=panelTitle>{label}</span>
 *   </button>
 * so the glyph must NOT be a nested <button>, and the label must stay a plain
 * string (the host also uses it as aria-label). The split control therefore
 * lives entirely inside the glyph span: two inline-flex children, each with its
 * own click handler that stops propagation. The dropdown itself is portaled to
 * document.body and stops propagation on every event, because a React portal
 * still bubbles synthetic events through the host button's tree.
 *
 * Every registration, timer and dictionary is owned by ctx.effect /
 * ctx.slots.inject, so unloading the plugin removes all of it.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-independent-task',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const API_PATH = '/api/dsh-independent-task/create';
    const CONFIG_PATH = '/api/dsh-independent-task/config';
    const NS = 'independentTask';
    const PANEL_ID = 'independent-task-new';
    const STORAGE_KEY = 'dsh.independent-task.settings';

    const en = {
      label: 'New independent task',
      tooltip: 'Create a timestamped folder and start a new session inside it',
      menuTooltip: 'Task folder options',
      menuTitle: 'Task folder',
      usingDefault: 'Default (next to the current workspace)',
      chooseFolder: 'Choose task folder…',
      chooseFolderHint: 'Pick a folder, save it, and create a task there right away',
      resetFolder: 'Reset to default',
      busy: 'Creating independent task…',
      failed: 'Could not create an independent task: {reason}',
      saved: 'Task folder saved: {path}',
      reset: 'Task folder reset to default',
      pickFailed: 'Could not open the folder picker: {reason}',
    };

    const zh = {
      label: '新建独立任务',
      tooltip: '创建时间戳目录，并在其中开启一个新会话',
      menuTooltip: '任务目录选项',
      menuTitle: '任务目录',
      usingDefault: '默认（当前工作区同级目录）',
      chooseFolder: '选择任务目录…',
      chooseFolderHint: '选定后立即保存，并在此目录新建一个独立任务',
      resetFolder: '恢复默认目录',
      busy: '正在创建独立任务…',
      failed: '创建独立任务失败：{reason}',
      saved: '任务目录已保存：{path}',
      reset: '已恢复默认任务目录',
      pickFailed: '无法打开目录选择器：{reason}',
    };

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'independent-task locale');
        const t = ctx.locale.bind(NS);

        // Bounded, self-terminating timers, cleared when the plugin unloads.
        const pending = new Set();
        ctx.effect(
          () => () => {
            for (const id of pending) clearTimeout(id);
            pending.clear();
          },
          'independent-task timers',
        );
        const later = (fn, ms) => {
          const id = setTimeout(() => {
            pending.delete(id);
            fn();
          }, ms);
          pending.add(id);
        };

        // ---- Remembered settings -------------------------------------------
        // `parentPath` is the remembered task root; '' means "derive it from the
        // current workspace". Cached in localStorage for an instant first paint,
        // then reconciled with the Host, which is the durable authority.
        const settings = { parentPath: '', defaultParent: '' };

        try {
          const cached = localStorage.getItem(STORAGE_KEY);
          if (cached !== null) {
            const parsed = JSON.parse(cached);
            if (typeof parsed?.parentPath === 'string') settings.parentPath = parsed.parentPath;
          }
        } catch {
          /* localStorage unavailable */
        }

        const cacheLocally = () => {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ parentPath: settings.parentPath }));
          } catch {
            /* quota or disabled storage: the Host copy still persists it */
          }
        };

        const refreshConfig = async () => {
          try {
            const response = await fetch(CONFIG_PATH, { credentials: 'same-origin' });
            if (!response.ok) return;
            const payload = await response.json();
            if (payload?.ok !== true) return;
            if (typeof payload.parentPath === 'string') settings.parentPath = payload.parentPath;
            if (typeof payload.defaultParent === 'string') settings.defaultParent = payload.defaultParent;
            cacheLocally();
          } catch {
            /* route not ready or offline: keep the cached value */
          }
        };
        void refreshConfig();

        const persistConfig = async (next) => {
          if (typeof next.parentPath === 'string') settings.parentPath = next.parentPath;
          cacheLocally();
          try {
            const response = await fetch(CONFIG_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ parentPath: settings.parentPath }),
              credentials: 'same-origin',
            });
            if (!response.ok) return;
            const payload = await response.json();
            if (payload?.ok === true && typeof payload.defaultParent === 'string') {
              settings.defaultParent = payload.defaultParent;
            }
          } catch {
            /* best effort: the local cache already holds the new value */
          }
        };

        // ---- Native folder picker ------------------------------------------
        const pickDirectory = async () => {
          try {
            if (typeof globalThis.__DSH_DIRECTORY_PICKER__?.pick === 'function') {
              return await globalThis.__DSH_DIRECTORY_PICKER__.pick();
            }
            if (typeof ctx.uiWorkspace?.pickDirectory === 'function') {
              return await ctx.uiWorkspace.pickDirectory();
            }
          } catch (error) {
            console.warn('[independent-task] pickDirectory failed:', error);
            notify('error', t('pickFailed', { reason: error?.message ?? String(error) }));
          }
          return null;
        };

        /** Best-effort toast; the service is optional in some compositions. */
        const notify = (tone, text) => {
          try {
            if (typeof ctx.toast === 'function') ctx.toast({ tone, text });
          } catch {
            /* no toast service */
          }
        };

        // ---- Create flow ----------------------------------------------------
        const requestCreate = async (parentOverride) => {
          const body = {};
          const parent = typeof parentOverride === 'string' && parentOverride.trim() !== ''
            ? parentOverride.trim()
            : settings.parentPath.trim();
          if (parent !== '') body.parentPath = parent;
          const response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin',
          });
          const payload = await response.json();
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`);
          }
          return payload;
        };

        const workspaceItems = () => {
          try {
            return ctx.get('workspaces')?.list?.getSnapshot?.().items;
          } catch {
            return undefined;
          }
        };

        /** Wait (bounded) until the minted Session is attached to the Workspace. */
        const waitForReady = (workspaceId, sessionId) =>
          new Promise((resolve) => {
            let attempts = 0;
            const check = () => {
              const items = workspaceItems();
              const ws = Array.isArray(items)
                ? items.find((w) => w.workspaceId === workspaceId)
                : undefined;
              if (ws !== undefined && (ws.sessionIds ?? []).includes(sessionId)) {
                resolve();
                return;
              }
              attempts += 1;
              if (attempts < 30) later(check, 100);
              else resolve();
            };
            check();
          });

        let creating = false;
        const runCreate = async (fromPanel = false, directParent) => {
          if (creating) return;
          creating = true;
          const back = () => {
            if (!fromPanel) return;
            try {
              ctx.get('layout')?.selectPanel?.(null);
            } catch {
              /* layout unavailable: nothing to restore */
            }
          };
          try {
            const payload = await requestCreate(directParent);
            await waitForReady(payload.workspaceId, payload.sessionId);
            try {
              ctx.uiWorkspace.openSession(payload.sessionId);
            } catch (openError) {
              // Defensive: connect a blank in that Workspace instead.
              console.warn('[independent-task] openSession failed, falling back:', openError);
              ctx.uiWorkspace.startSession(payload.workspaceId);
            }
            back();
          } catch (error) {
            console.warn('[independent-task] create failed:', error);
            notify('error', t('failed', { reason: error?.message ?? String(error) }));
            back();
          } finally {
            creating = false;
          }
        };

        // ---- Dropdown menu --------------------------------------------------
        /**
         * The ▾ menu. Portaled to document.body; every event stops propagation so
         * a click never reaches the host row button (which would select a panel).
         */
        const DirectoryMenu = (props) => {
          const { x, y, parentPath, onClose, onChoose, onReset } = props;

          React.useEffect(() => {
            const onKey = (event) => {
              if (event.key === 'Escape') onClose();
            };
            window.addEventListener('keydown', onKey);
            return () => window.removeEventListener('keydown', onKey);
          }, []);

          if (typeof document === 'undefined') return null;

          const stop = (event) => event.stopPropagation();
          const viewportWidth = window.innerWidth || 1024;
          const left = Math.max(8, Math.min(x, viewportWidth - 292));

          const itemStyle = {
            display: 'block',
            width: '100%',
            padding: '7px 10px',
            border: 'none',
            borderRadius: '6px',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary, #ffffff)',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: '20px',
            textAlign: 'left',
            cursor: 'pointer',
          };

          const overlay = h('div', {
            key: 'overlay',
            style: { position: 'fixed', inset: 0, zIndex: 999998, background: 'transparent' },
            onClick: (event) => {
              event.stopPropagation();
              onClose();
            },
            onMouseDown: stop,
            onContextMenu: (event) => {
              event.stopPropagation();
              event.preventDefault();
              onClose();
            },
          });

          const card = h(
            'div',
            {
              key: 'card',
              role: 'menu',
              style: {
                position: 'fixed',
                left: `${left}px`,
                top: `${y}px`,
                zIndex: 999999,
                minWidth: '264px',
                maxWidth: '288px',
                padding: '6px',
                background: 'var(--dsw-alias-bg-elevated, #1f1f23)',
                border: '1px solid var(--dsw-alias-border-l1, #333338)',
                borderRadius: '8px',
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
                color: 'var(--dsw-alias-label-primary, #ffffff)',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              },
              onClick: stop,
              onMouseDown: stop,
              onContextMenu: (event) => {
                event.stopPropagation();
                event.preventDefault();
              },
            },
            // Current root
            h(
              'div',
              {
                style: {
                  padding: '4px 10px 8px',
                  fontSize: '12px',
                  lineHeight: '1.45',
                  color: 'var(--dsw-alias-label-tertiary, #8e8e93)',
                  wordBreak: 'break-all',
                },
              },
              h(
                'div',
                {
                  style: {
                    fontWeight: 500,
                    marginBottom: '2px',
                    color: 'var(--dsw-alias-label-secondary, #c9c9cf)',
                  },
                },
                t('menuTitle'),
              ),
              parentPath !== '' ? parentPath : t('usingDefault'),
            ),
            h('div', {
              style: {
                height: '1px',
                margin: '2px 0 6px',
                background: 'var(--dsw-alias-border-l2, #2e2e33)',
              },
            }),
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                style: itemStyle,
                title: t('chooseFolderHint'),
                onClick: (event) => {
                  event.stopPropagation();
                  onChoose();
                },
              },
              t('chooseFolder'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                style: itemStyle,
                onClick: (event) => {
                  event.stopPropagation();
                  onReset();
                },
              },
              t('resetFolder'),
            ),
          );

          return ReactDOM.createPortal([overlay, card], document.body);
        };

        // ---- Split glyph: [ folder | ▾ ] ------------------------------------
        const FolderIcon = ({ size }) =>
          h(
            'svg',
            {
              width: size,
              height: size,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
              focusable: false,
              style: { display: 'block' },
            },
            h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }),
            h('path', { d: 'M12 11v6M9 14h6' }),
          );

        const ChevronIcon = ({ size }) =>
          h(
            'svg',
            {
              width: 10,
              height: size,
              viewBox: '0 0 10 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
              focusable: false,
              style: { display: 'block' },
            },
            h('path', { d: 'M2 11l3 3 3-3' }),
          );

        /**
         * Glyph with two hit targets. It must stay a plain inline-flex fragment:
         * the host already wraps this in a <button>, so no nested buttons here.
         */
        const TaskGlyph = (props) => {
          const [menu, setMenu] = React.useState(null);
          const size = props?.size ?? 18;

          const openMenu = async (event) => {
            event.stopPropagation();
            event.preventDefault();
            // Read the anchor synchronously: currentTarget is gone after await.
            const rect = event.currentTarget.getBoundingClientRect();
            await refreshConfig();
            setMenu({
              x: rect.left,
              y: rect.bottom + 6,
              parentPath: settings.parentPath,
            });
          };

          const onCreate = (event) => {
            event.stopPropagation();
            event.preventDefault();
            void runCreate(false);
          };

          const hit = {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          };

          return h(
            React.Fragment,
            null,
            h(
              'span',
              {
                role: 'presentation',
                title: t('tooltip'),
                onClick: onCreate,
                onContextMenu: openMenu,
                style: hit,
              },
              h(FolderIcon, { size }),
            ),
            h(
              'span',
              {
                role: 'presentation',
                title: t('menuTooltip'),
                onClick: openMenu,
                style: {
                  ...hit,
                  paddingLeft: '2px',
                  marginLeft: '2px',
                  borderLeft: '1px solid var(--dsw-alias-border-l3, rgba(140, 140, 150, 0.45))',
                  opacity: 0.75,
                },
              },
              h(ChevronIcon, { size }),
            ),
            menu === null
              ? null
              : h(DirectoryMenu, {
                  x: menu.x,
                  y: menu.y,
                  parentPath: menu.parentPath,
                  onClose: () => setMenu(null),
                  onChoose: () => {
                    setMenu(null);
                    void chooseFolderAndCreate();
                  },
                  onReset: () => {
                    setMenu(null);
                    void resetFolder();
                  },
                }),
          );
        };

        /** Pick a root, remember it, and create a task there right away. */
        const chooseFolderAndCreate = async () => {
          const picked = await pickDirectory();
          if (typeof picked !== 'string' || picked.trim() === '') return; // cancelled
          const path = picked.trim();
          await persistConfig({ parentPath: path });
          notify('success', t('saved', { path }));
          await runCreate(false, path);
        };

        /** Forget the saved root; the next click derives it from the workspace. */
        const resetFolder = async () => {
          await persistConfig({ parentPath: '' });
          notify('success', t('reset'));
        };

        /**
         * Panel view for the row click (host button, e.g. on its label): run the
         * normal create flow once, then return to the conversation.
         */
        const LaunchPanel = () => {
          const started = React.useRef(false);
          React.useEffect(() => {
            if (started.current) return;
            started.current = true;
            void runCreate(true);
          }, []);
          return h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                padding: '24px',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: '13px',
              },
            },
            t('busy'),
          );
        };

        // 1. Top-of-sidebar row, immediately under the "New session" button.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: -1000,
              label: () => t('label'),
              locale: NS,
            },
            TaskGlyph,
          ),
        );

        // 2. Safe target for the host row click (its label), same id.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            LaunchPanel,
          ),
        );
      },
    };
  },
});
