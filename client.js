/**
 * Client half of the "Independent tasks" plugin.
 *
 * Placement: the sidebar's own "New session" button is hard-coded and has no
 * slot directly beneath it. The first rendered row after that button is the
 * global-panel nav, whose rows come from `sidebar.panellist` registrations
 * (the host reads entriesOfSlot("sidebar.panellist") and sorts by `order`).
 * Registering there with a very low `order` puts our entry at the very top,
 * immediately under "New session". The native button itself is untouched.
 *
 * A `sidebar.panellist` row is rendered by the host as
 *   <button onClick={() => selectPanel(id)}>
 *     <span aria-hidden>{renderSlot("sidebar.panellist", {size,active}, {only:id})}</span>
 *     <span>{label}</span>
 *   </button>
 * so the glyph must NOT be a nested <button>. Our glyph is an inline SVG that
 * stops propagation and runs the create flow in place. For the defensive case
 * where the click lands on the host button instead (e.g. its label), a minimal
 * `main` panel under the same id is registered; it runs the same flow once on
 * mount and returns to the conversation, which also keeps selectPanel(id)
 * from throwing.
 *
 * The create flow POSTs the Host's authenticated route — the same core
 * operation the `/new-independent-task` command runs — waits briefly for the
 * new Workspace to reach the Client roster, then calls uiWorkspace.openSession()
 * with the exact Session id the Host already minted. openSession() retains that
 * Session lazily (the Client Session Controller builds it on demand and reads
 * its log from the Host) and reveals the conversation panel: folder, Workspace,
 * and an open new conversation all arrive in ONE click. It never creates a
 * second Session; startSession(workspaceId) is only a defensive fallback.
 *
 * Every registration, timer and dictionary is owned by ctx.effect /
 * ctx.slots.inject, so unloading the plugin removes all of it.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-independent-task',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API_PATH = '/api/dsh-independent-task/create';
    const NS = 'independentTask';
    const PANEL_ID = 'independent-task-new';

    const en = {
      label: 'New independent task',
      tooltip: 'Create a timestamped folder and start a new session inside it',
      busy: 'Creating independent task…',
      failed: 'Could not create an independent task: {reason}',
    };
    const zh = {
      label: '新建独立任务',
      tooltip: '创建时间戳目录，并在其中开启一个新会话',
      busy: '正在创建独立任务…',
      failed: '创建独立任务失败：{reason}',
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

        /** POST the Host route; resolves the created identities or throws. */
        const requestCreate = async () => {
          const response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            credentials: 'same-origin',
          });
          const payload = await response.json();
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`);
          }
          return payload;
        };

        /** Lazy read of the Client Workspace Controller's snapshot store. */
        const workspaceItems = () => {
          try {
            return ctx.get('workspaces')?.list?.getSnapshot?.().items;
          } catch {
            return undefined;
          }
        };

        /**
         * Wait until the Client Workspace roster publishes the new entry AND
         * the Host-minted Session is an attached member of it. The Host creates
         * the Workspace, then the Session, then attaches it; the Client stream
         * carries those facts a moment later. Opening before that races the
         * remote and leaves the user staring at a folder with no conversation.
         */
        const waitForReady = (workspaceId, sessionId) =>
          new Promise((resolve) => {
            let attempts = 0;
            const check = () => {
              const items = workspaceItems();
              const ws = Array.isArray(items)
                ? items.find((w) => w.workspaceId === workspaceId)
                : undefined;
              const attached = ws !== undefined
                && (ws.sessionIds ?? []).includes(sessionId);
              if (attached) {
                resolve();
                return;
              }
              attempts += 1;
              // Bound the wait: openSession() lazily opens the Session from the
              // Host log even if the roster frame is late, so resolve after a
              // short grace period rather than making the click feel stuck.
              if (attempts < 30) later(check, 100);
              else resolve();
            };
            check();
          });

        /** The shared create flow used by both click paths. */
        let creating = false;
        const runCreate = async (fromPanel = false) => {
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
            const payload = await requestCreate();
            await waitForReady(payload.workspaceId, payload.sessionId);
            // Open the exact Session the Host minted. openSession() ->
            // replaceMain(..., "reveal") selects the conversation panel, so the
            // folder AND the new conversation arrive in one click. We must NOT
            // use startSession(workspaceId): that is "create/connect another
            // blank" and races the Session the Host just created.
            try {
              ctx.uiWorkspace.openSession(payload.sessionId);
            } catch (openError) {
              // Defensive fallback for a roster frame that never arrived:
              // startSession() still connects a blank in that Workspace.
              console.warn('[independent-task] openSession failed, falling back:', openError);
              ctx.uiWorkspace.startSession(payload.workspaceId);
            }
            back();
          } catch (error) {
            console.warn('[independent-task] create failed:', error);
            const message = t('failed', { reason: error?.message ?? String(error) });
            try {
              if (typeof ctx.toast === 'function') ctx.toast({ tone: 'error', text: message });
            } catch {
              /* no toast service */
            }
            console.warn('[independent-task]', message);
            back();
          } finally {
            creating = false;
          }
        };

        /**
         * Panel glyph: timestamp-folder icon at the host's icon size. It is a
         * plain inline SVG (the host row is already a <button>), with pointer
         * events re-enabled over the decorative glyph CSS; stopPropagation
         * prevents the host row's selectPanel onClick from firing.
         * `runCreate`/`t` are captured in a stable closure instead of relying
         * on the slot's props injection.
         */
        const TaskGlyph = (props) =>
          h(
            'svg',
            {
              width: props?.size ?? 18,
              height: props?.size ?? 18,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
              focusable: false,
              style: { display: 'block', pointerEvents: 'auto', cursor: 'pointer' },
              onClick: (event) => {
                event.stopPropagation();
                event.preventDefault();
                runCreate(false);
              },
            },
            h('title', null, t('tooltip')),
            h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }),
            h('path', { d: 'M12 11v6M9 14h6' }),
          );

        /**
         * Defensive `main` panel for the same id: if a click reaches the host's
         * row button (e.g. its label), selectPanel(id) lands here. It runs the
         * create flow once, then returns to the conversation.
         */
        const LaunchPanel = () => {
          const started = React.useRef(false);
          React.useEffect(() => {
            if (started.current) return;
            started.current = true;
            runCreate(true);
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
