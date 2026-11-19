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
 *
 * Lifecycle of a task this plugin creates (1.2.0):
 *
 *   created ──┬── user shows any intent ──► kept forever (tracking dropped)
 *             └── nothing typed, view left ──► archived + folder deleted
 *
 * "Intent" is deliberately broad — a sent turn, a running turn, a persisted
 * draft (text / reference / quote / attachment / command), or anything sitting
 * in the live composer — because the cost of a false positive is a folder the
 * user deletes by hand, while a false negative destroys work. The plugin never
 * writes DSH's draft storage: Harness already persists each session's draft,
 * and mirroring it a second time made sent messages reappear as leftovers.
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
    const PENDING_STORAGE_KEY = 'dsh.independent-task.pending';

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

        // ---- Empty task auto-cleanup & draft preservation -------------------
        // Reads stay authoritative (localStorage is shared with the host and any
        // other window), but writes are suppressed when the tracked set is
        // unchanged: the check runs on every session-list frame, and flushing a
        // redundant write per frame is pure churn.
        let pendingSignature = null;

        const signatureOf = (tasks) => tasks
          .map((task) => `${task.sessionId}:${task.opened ? 1 : 0}:${task.attempts ?? 0}:${task.path}`)
          .join('|');

        const readPendingTasks = () => {
          try {
            const raw = localStorage.getItem(PENDING_STORAGE_KEY);
            if (raw === null) {
              pendingSignature = '';
              return [];
            }
            const list = JSON.parse(raw);
            const tasks = Array.isArray(list) ? list : [];
            pendingSignature = signatureOf(tasks);
            return tasks;
          } catch {
            pendingSignature = '';
            return [];
          }
        };

        const savePendingTasks = (tasks) => {
          const signature = signatureOf(tasks);
          if (signature === pendingSignature) return;
          pendingSignature = signature;
          try {
            if (tasks.length === 0) localStorage.removeItem(PENDING_STORAGE_KEY);
            else localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(tasks));
          } catch {
            /* quota or storage disabled */
          }
        };

        const trackPendingTask = (task) => {
          const list = readPendingTasks().filter((t) => t.sessionId !== task.sessionId);
          list.push({
            workspaceId: task.workspaceId,
            sessionId: task.sessionId,
            path: task.path,
            opened: false,
            createdAt: Date.now(),
          });
          savePendingTasks(list);
        };

        /**
         * True when a plugin-created session already carries user intent.
         * Reads only; never writes the composer store (writing there makes a
         * sent message reappear as a leftover draft).
         */
        const checkUserContent = (sessionId) => {
          // 1. Session turn / run status: a sent turn flips blank, a live turn runs.
          try {
            const summary = ctx.get('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId];
            if (summary) {
              if (summary.blank === false || summary.running === true) return true;
            }
          } catch {}

          // 2. DSH's own per-session draft store; the composer persists every keystroke here.
          try {
            const raw = localStorage.getItem('dsh.conversation.' + sessionId);
            if (raw) {
              const stored = JSON.parse(raw);
              const draft = stored?.draft;
              if (typeof draft === 'string' && draft.trim() !== '') return true;
              if (typeof draft === 'object' && draft !== null) {
                if (typeof draft.text === 'string' && draft.text.trim() !== '') return true;
                if (Array.isArray(draft.references) && draft.references.length > 0) return true;
                if (Array.isArray(draft.quotes) && draft.quotes.length > 0) return true;
                if (Array.isArray(draft.attachmentIds) && draft.attachmentIds.length > 0) return true;
                if (draft.command && typeof draft.command.token === 'string' && draft.command.token.trim() !== '') return true;
              }
            }
          } catch {}

          // 3. Live composer DOM — only while THIS session is the visible one. The
          // mounted editor always belongs to the current session, so reading it for
          // a background session would be a false positive. The composer's own
          // element carries `data-composer-input` (see ComposerContentEditable);
          // a bare `[contenteditable]` search could hit an unrelated field.
          if (getCurrentSessionId() === sessionId) {
            try {
              const editable = document.querySelector('[data-composer-input]')
                ?? document.querySelector('[contenteditable="true"]');
              if (editable) {
                const text = (editable.innerText || editable.textContent || '').trim();
                if (text !== '') return true;
                if (editable.querySelector('img, [data-lexical-decorator], [data-reference], [data-command]')) return true;
              }
            } catch {}
          }

          return false;
        };

        /**
         * Keep a plugin-created session alive in the sidebar before its first
         * send. DSH hides every not-yet-engaged ("blank") session that is not
         * current, so typing without sending would make the row vanish.
         *
         * Scope: only sessions this plugin created and still tracks as pending,
         * and only once per session — repeating the mutation on every keystroke
         * would force a re-projection each time.
         *
         * The three writes below are exactly the ones DSH performs when a real
         * prompt is accepted (`onEngaged`), and the manager re-projects the list
         * itself right after. The projection store is deliberately NOT touched:
         * writing a snapshot built from a read that already happened races with
         * the host's own projection frames, and a stale snapshot written back
         * that way freezes the sidebar on an old view until reload.
         */
        const engagedSessions = new Set();
        /** Cap on remembered ids: a long-lived page must not grow without bound. */
        const ENGAGED_MEMORY_LIMIT = 512;
        const rememberEngaged = (sessionId) => {
          engagedSessions.add(sessionId);
          if (engagedSessions.size <= ENGAGED_MEMORY_LIMIT) return;
          // Never evict the session we just recorded: a repeat visit would then
          // re-run the three host writes this set exists to make once-only.
          for (const id of engagedSessions) {
            if (engagedSessions.size <= ENGAGED_MEMORY_LIMIT) break;
            if (id !== sessionId) engagedSessions.delete(id);
          }
        };
        const markSessionEngaged = (sessionId) => {
          if (!sessionId || engagedSessions.has(sessionId)) return;
          if (!readPendingTasks().some((task) => task.sessionId === sessionId)) return;
          rememberEngaged(sessionId);
          try {
            const manager = ctx.get('sessions')?.manager;
            if (!manager) return;
            if (manager.engagedSessions && typeof manager.engagedSessions.add === 'function') {
              manager.engagedSessions.add(sessionId);
            }
            if (typeof manager.recordMutation === 'function') {
              manager.recordMutation({ kind: 'engaged', sessionId });
            }
            if (manager.sessions && typeof manager.sessions.get === 'function') {
              manager.sessions.get(sessionId)?.handleBlank?.(false);
            }
          } catch (error) {
            engagedSessions.delete(sessionId);
            console.warn('[independent-task] markSessionEngaged failed:', error);
          }
        };

        const getCurrentSessionId = () => {
          // Preferred source: the public session-list snapshot. `retainedBy
          // .mainView` is exactly what the host's own `publishMain` uses to
          // decide which session owns the main view, so it carries the same
          // meaning without reaching into a private field. Only an unambiguous
          // winner is accepted — with several sessions retained we cannot tell
          // which one the user sees, and a guess here could read as "left".
          try {
            const byId = ctx.get('sessions')?.list?.getSnapshot?.()?.byId;
            if (byId) {
              const retained = Object.values(byId)
                .filter((row) => (row?.retainedBy?.mainView ?? 0) > 0)
                .map((row) => row.id)
                .filter((id) => typeof id === 'string' && id !== '');
              if (retained.length === 1) return retained[0];
            }
          } catch {}
          // Best-effort: the navigation controller keeps this store private, so
          // it may be absent (or renamed) at runtime. Never required.
          try {
            const sel = ctx.uiWorkspace?.selection?.getSnapshot?.();
            if (typeof sel?.sessionId === 'string' && sel.sessionId !== '') return sel.sessionId;
          } catch {}
          try {
            const raw = localStorage.getItem('dsh.sessions.current');
            if (raw) {
              const sid = JSON.parse(raw)?.sessionId;
              if (typeof sid === 'string' && sid !== '') return sid;
            }
          } catch {}
          return null;
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
            trackPendingTask(payload);
            await waitForReady(payload.workspaceId, payload.sessionId);
            try {
              ctx.uiWorkspace.openSession(payload.sessionId);
            } catch (openError) {
              // Defensive: connect a blank in that Workspace instead.
              console.warn('[independent-task] openSession failed, falling back:', openError);
              ctx.uiWorkspace.startSession(payload.workspaceId);
            }
            // Deliberately NOT marking the task as opened here: `openSession` is
            // asynchronous, so for a moment the UI still reports the previous
            // session. `opened` therefore flips only when a check actually sees
            // the task in the main view — that observation is what licenses the
            // "user left an empty task" cleanup later on.
            scheduleCheck();
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

        // ---- Lifecycle wiring ----------------------------------------------
        // This block is strictly read-only towards every host store. An earlier
        // version mirrored drafts into localStorage and wrote them back, which
        // made a sent message reappear as leftover text; DSH already persists
        // each session's draft itself, so the plugin must not.
        ctx.effect(() => {
          // No standing tick: the watchdog is armed only while a task is
          // tracked, it only reads, and it retires itself. The previous
          // unconditional 1s pass rewrote a host store every second and made
          // sends appear unresponsive.
          const offSelection = ctx.uiWorkspace?.selection?.subscribe?.(scheduleCheck);
          const offSessions = ctx.get('sessions')?.list?.subscribe?.(scheduleCheck);
          const offLayout = ctx.get('layout')?.panelInfo?.subscribe?.(scheduleCheck);

          // Typing in a plugin-created session counts as intent: keep the row.
          // `onInput` fires for every keystroke in the whole app, so this stays
          // behind a single in-memory check; the storage read only happens when
          // the plugin is actually tracking a task.
          let inputCheckQueued = false;
          const onInput = () => {
            if (pendingSignature === '') return;
            if (inputCheckQueued) return;
            inputCheckQueued = true;
            later(() => {
              inputCheckQueued = false;
              if (pendingSignature === '') return;
              const sid = getCurrentSessionId();
              if (!sid) return;
              if (!readPendingTasks().some((task) => task.sessionId === sid)) return;
              if (checkUserContent(sid)) markSessionEngaged(sid);
            }, 150);
          };

          if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', checkPendingTasks);
            window.addEventListener('visibilitychange', checkPendingTasks);
            window.addEventListener('input', onInput, true);
            window.addEventListener('paste', onInput, true);
          }

          scheduleCheck();

          return () => {
            offSelection?.();
            offSessions?.();
            offLayout?.();
            if (typeof window !== 'undefined') {
              window.removeEventListener('beforeunload', checkPendingTasks);
              window.removeEventListener('visibilitychange', checkPendingTasks);
              window.removeEventListener('input', onInput, true);
              window.removeEventListener('paste', onInput, true);
            }
          };
        }, 'independent-task auto-cleanup & intent keep-alive');
      },
    };
  },
});
