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
    const CLEANUP_PATH = '/api/dsh-independent-task/cleanup';
    const NS = 'independentTask';
    const PANEL_ID = 'independent-task-new';
    const STORAGE_KEY = 'dsh.independent-task.settings';
    const PENDING_STORAGE_KEY = 'dsh.independent-task.pending';
    /** Grace period before an unopened task is judged empty (ms). */
    const CLEANUP_GRACE_MS = 20000;
    /**
     * Watchdog period while at least one task is tracked (ms). The watch exists
     * only because the UI can stay completely silent: the navigation controller
     * keeps its selection store private, so a task created and immediately
     * abandoned might never be looked at again. The tick is read-only and stops
     * itself as soon as the tracked set empties (see `armWatch`).
     */
    const WATCH_INTERVAL_MS = 1000;
    /**
     * Upper bound on watchdog passes per plugin lifetime (≈1 minute at 1s).
     * A task whose view can never be resolved must not keep a timer alive; it
     * stays tracked and any later store event still settles it.
     */
    const WATCH_MAX_TICKS = 60;
    /**
     * Settle period after creation before an untyped task may be cleaned (ms).
     * The freshly created session is not always the one the UI already reports
     * as current (`openSession` is asynchronous), so without this gap the first
     * watchdog pass could mistake that startup lag for the user leaving.
     */
    const CLEANUP_SETTLE_MS = 3000;

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
      activityMode: 'Activity groups',
      nativeMode: 'Native view',
      switchToActivity: 'Group by activity',
      toggleToNativeTip: 'Switch to native workspace view',
      toggleToActivityTip: 'Group sessions by activity',
      moreActions: 'More actions',
      bucket1d: 'Active in 1 day',
      bucket2to7d: 'Active 2–7 days',
      bucketInactive: 'Inactive',
      bucketHidden: 'Hidden (Bot)',
      emptyBucket: 'No sessions',
      newSession: 'New session',
      untitledSession: 'Untitled session',
      ungroupedWorkspace: 'Ungrouped',
      justNow: 'Just now',
      minutesAgo: '{n}m ago',
      hoursAgo: '{n}h ago',
      daysAgo: '{n}d ago',
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
      activityMode: '按活跃度收纳',
      nativeMode: '原生视图',
      switchToActivity: '切换活跃度收纳',
      toggleToNativeTip: '切换为原生工作区视图',
      toggleToActivityTip: '按活跃度分类收纳会话',
      moreActions: '更多操作',
      bucket1d: '最近 1 天',
      bucket2to7d: '最近 2~7 天',
      bucketInactive: '不活跃',
      bucketHidden: '隐藏会话 (Bot)',
      emptyBucket: '暂无会话',
      newSession: '新会话',
      untitledSession: '未命名会话',
      ungroupedWorkspace: '未分组',
      justNow: '刚刚',
      minutesAgo: '{n}分钟前',
      hoursAgo: '{n}小时前',
      daysAgo: '{n}天前',
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
          // A one-shot wake-up at the grace deadline. The check is otherwise
          // event-driven, and a quiet UI emits no events at all — without this
          // the grace timer would only be observed the next time something
          // unrelated happened to change a store.
          later(() => checkPendingTasks(), CLEANUP_GRACE_MS + 500);
          // Track the fresh task every `WATCH_INTERVAL_MS` until it settles, so
          // "created and immediately abandoned" is noticed even if the UI never
          // emits another store event. A fresh task gets a fresh tick budget.
          watchTicks = 0;
          armWatch();
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

        /**
         * True when the host still retains this session in the main view.
         *
         * An independent, public signal that the session is on screen. The
         * cleanup decision requires BOTH this to be false AND the current id to
         * name a different session; either one alone is a guess, and this route
         * deletes directories.
         */
        const isRetainedByMainView = (sessionId) => {
          try {
            const row = ctx.get('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId];
            return (row?.retainedBy?.mainView ?? 0) > 0;
          } catch {
            return false;
          }
        };

        const isPanelActive = () => {
          try {
            const panelId = ctx.get('layout')?.panelInfo?.getSnapshot?.()?.activePanelId;
            return panelId !== null && panelId !== undefined;
          } catch {}
          return false;
        };

        // Re-queue a task whose cleanup did not settle. A transient failure (Host
        // restarting, request rejected by the trust fence) must not leak the
        // folder forever, so it is retried a couple of times before giving up.
        const CLEANUP_RETRY_LIMIT = 3;

        /** Drop one task from the persisted tracking set. */
        const removePendingTask = (sessionId) => {
          const list = readPendingTasks().filter((task) => task.sessionId !== sessionId);
          savePendingTasks(list);
        };

        const retrackTask = (task) => {
          const attempts = (task.attempts ?? 0) + 1;
          if (attempts >= CLEANUP_RETRY_LIMIT) {
            // Out of attempts: stop tracking so the check does not keep
            // re-queueing it forever. The folder stays; the user can delete it
            // by hand, and the Host logged why the last attempt failed.
            console.warn('[independent-task] cleanup gave up after', attempts, 'attempts:', task.path);
            removePendingTask(task.sessionId);
            return;
          }
          const list = readPendingTasks().filter((t) => t.sessionId !== task.sessionId);
          list.push({ ...task, attempts });
          savePendingTasks(list);
          // A retry needs its own ticks: the budget that drove the failed attempt
          // may already be spent, and without a reset the retry would never run.
          watchTicks = 0;
          armWatch();
        };

        /** Sessions with a cleanup request in flight; prevents duplicate requests. */
        const inFlightCleanup = new Set();

        /**
         * Ask the Host to delete one task.
         *
         * The task is removed from the tracking set only once the Host confirms,
         * never before: a request that dies with the page (closing the tab) or
         * that the Host defers must leave the record in place so the next check
         * can retry it. `keepalive` lets the request survive the `beforeunload`
         * that starts it.
         */
        const executeCleanup = async (task) => {
          if (inFlightCleanup.has(task.sessionId)) return;
          inFlightCleanup.add(task.sessionId);
          try {
            const response = await fetch(CLEANUP_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: task.workspaceId,
                sessionId: task.sessionId,
                path: task.path,
              }),
              credentials: 'same-origin',
              keepalive: true,
              signal: cleanupAbort.signal,
            });
            const payload = await response.json();
            if (payload?.ok === true) {
              removePendingTask(task.sessionId);
              try {
                localStorage.removeItem('dsh.conversation.' + task.sessionId);
              } catch {}
              return;
            }
            // A refusal means "this folder must stay under our rules": the
            // session already has a real turn, the folder is not ours, or the
            // inputs no longer agree. Retrying asks the Host the same question.
            const reason = payload?.error ?? response.status;
            if (
              reason === 'session-has-messages' ||
              reason === 'not-plugin-owned' ||
              reason === 'missing-workspace' ||
              reason === 'workspace-mismatch' ||
              reason === 'session-mismatch' ||
              reason === 'missing-path'
            ) {
              console.warn('[independent-task] cleanup refused:', reason);
              removePendingTask(task.sessionId);
              return;
            }
            console.warn('[independent-task] cleanup deferred:', reason);
            retrackTask(task);
          } catch (error) {
            if (error?.name === 'AbortError') return; // plugin unloaded mid-flight
            console.warn('[independent-task] cleanup failed:', error);
            retrackTask(task);
          } finally {
            inFlightCleanup.delete(task.sessionId);
          }
        };

        const checkPendingTasks = () => {
          // Cheapest possible exit: the check is wired to every session-list
          // frame, and most of the time nothing is being tracked.
          const tasks = readPendingTasks();
          if (tasks.length === 0) {
            if (watchTicks !== 0) watchTicks = 0;
            return;
          }

          const currentId = getCurrentSessionId();
          const panelActive = isPanelActive();

          // Rebuilt every pass; a dispatched cleanup keeps its entry here until
          // the Host confirms, because `executeCleanup` is what removes it.
          const remaining = [];
          for (const task of tasks) {
            const isInTaskView = currentId === task.sessionId && !panelActive;

            // User intent ends the trial period: the session is a real task now,
            // so stop tracking it (cleanup must never touch it again).
            if (checkUserContent(task.sessionId)) {
              markSessionEngaged(task.sessionId);
              continue;
            }

            const age = Date.now() - (task.createdAt || 0);
            // Leaving requires POSITIVE evidence of another session AND that the
            // host no longer retains this one in the main view. Either signal
            // alone can be wrong (a panel covering the view, a still-mounting
            // session, an unresolved selection), and a wrong guess here deletes
            // a folder.
            const provablyElsewhere =
              currentId !== null &&
              currentId !== task.sessionId &&
              !isRetainedByMainView(task.sessionId);

            if (isInTaskView) {
              task.opened = true;
              remaining.push(task);
            } else if (!provablyElsewhere) {
              // Still on this session (only a panel covers it), or the current
              // session is unknown. Either way the user has not left.
              remaining.push(task);
            } else if (task.opened && age > CLEANUP_SETTLE_MS) {
              // Left the window without typing anything. `CLEANUP_SETTLE_MS`
              // absorbs the gap where `openSession` has not resolved yet.
              // executeCleanup owns the tracking entry from here: it removes it
              // only after the Host confirms, so a dropped request retries.
              remaining.push(task);
              void executeCleanup(task);
            } else if (!task.opened && age > CLEANUP_GRACE_MS) {
              // Never observed on screen and already gone: the open attempt did
              // not take, so this is an orphan of a failed create.
              remaining.push(task);
              void executeCleanup(task);
            } else {
              remaining.push(task);
            }
          }

          savePendingTasks(remaining);
          // Second chance while anything is still tracked. The store
          // subscriptions above are best-effort: `uiWorkspace.selection` is not
          // part of the documented service surface, so a quiet UI can emit no
          // event at all between "task created" and "user left".
          if (remaining.length > 0 || inFlightCleanup.size > 0) {
            armWatch();
          } else {
            // Nothing tracked: hand the next task a fresh tick budget.
            watchTicks = 0;
          }
        };

        // One coalesced watchdog at a time, only while tasks are tracked. It is
        // capped so a task whose view can never be resolved stops costing ticks;
        // the task stays tracked and a later store event still decides it.
        let watchArmed = false;
        let watchTicks = 0;
        const armWatch = () => {
          if (watchArmed) return;
          if (watchTicks >= WATCH_MAX_TICKS) return;
          watchArmed = true;
          watchTicks += 1;
          later(() => {
            watchArmed = false;
            checkPendingTasks();
          }, WATCH_INTERVAL_MS);
        };

        // Coalesce bursts: a single send flushes the session list many times,
        // and each flush must not queue its own pass over the pending tasks.
        let checkScheduled = false;
        const scheduleCheck = () => {
          // No `pendingSignature` shortcut here: the tracked set lives in
          // localStorage and another window may have written it, so only a real
          // read can decide. `checkPendingTasks` still exits on its first line
          // when nothing is tracked, which costs one `getItem`.
          if (checkScheduled) return;
          checkScheduled = true;
          later(() => {
            checkScheduled = false;
            checkPendingTasks();
          }, 100);
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
        const cleanupAbort = new AbortController();
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
            cleanupAbort.abort();
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

        // ---- Activity-based session grouping in sidebar ---------------------
        const ACTIVITY_ENABLED_KEY = 'dsh.independent-task.activity-enabled';
        const ACTIVITY_GROUPS_KEY = 'dsh.independent-task.activity-groups';
        const DAY_MS = 24 * 60 * 60 * 1000;
        const WEEK_MS = 7 * DAY_MS;

        const readBoolStorage = (key, fallback) => {
          try {
            const raw = localStorage.getItem(key);
            if (raw === null) return fallback;
            return raw === 'true';
          } catch {
            return fallback;
          }
        };

        const readGroupExpansion = () => {
          const defaults = { recent1d: true, recent2to7d: false, inactive: false, hidden: false };
          try {
            const raw = localStorage.getItem(ACTIVITY_GROUPS_KEY);
            if (!raw) return defaults;
            const parsed = JSON.parse(raw);
            return {
              recent1d: typeof parsed?.recent1d === 'boolean' ? parsed.recent1d : true,
              recent2to7d: typeof parsed?.recent2to7d === 'boolean' ? parsed.recent2to7d : false,
              inactive: typeof parsed?.inactive === 'boolean' ? parsed.inactive : false,
              hidden: typeof parsed?.hidden === 'boolean' ? parsed.hidden : false,
            };
          } catch {
            return defaults;
          }
        };

        const saveGroupExpansion = (next) => {
          try {
            localStorage.setItem(ACTIVITY_GROUPS_KEY, JSON.stringify(next));
          } catch {}
        };

        const formatRelativeTime = (ts, now) => {
          if (!ts || ts <= 0) return '';
          const diff = Math.max(0, now - ts);
          if (diff < 60 * 1000) return t('justNow');
          if (diff < 60 * 60 * 1000) return t('minutesAgo', { n: Math.floor(diff / (60 * 1000)) });
          if (diff < DAY_MS) return t('hoursAgo', { n: Math.floor(diff / (60 * 60 * 1000)) });
          const days = Math.floor(diff / DAY_MS);
          if (days <= 30) return t('daysAgo', { n: days });
          const d = new Date(ts);
          const p = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        };

        const BOT_PATH_RE = /[/\\]\.dsh[/\\](?:bot[/\\]workspace|im)[/\\]?$/i;
        const isBotSession = (ws, session) => {
          if (ws) {
            if (typeof ws.title === 'string' && ws.title.trim().toLowerCase() === 'ds bot') return true;
            if (typeof ws.path === 'string' && BOT_PATH_RE.test(ws.path.trim())) return true;
          }
          if (typeof session?.cwd === 'string' && BOT_PATH_RE.test(session.cwd.trim())) return true;
          return false;
        };

        const workspaceDisplayName = (ws, session) => {
          if (ws) {
            if (typeof ws.title === 'string' && ws.title.trim() !== '') return ws.title.trim();
            if (typeof ws.path === 'string' && ws.path.trim() !== '') {
              const parts = ws.path.split(/[\\/]/).filter(Boolean);
              if (parts.length > 0) return parts[parts.length - 1];
            }
          }
          if (typeof session?.cwd === 'string' && session.cwd.trim() !== '') {
            const parts = session.cwd.split(/[\\/]/).filter(Boolean);
            if (parts.length > 0) return parts[parts.length - 1];
          }
          return t('ungroupedWorkspace');
        };

        const ActivityChevron = ({ expanded }) =>
          h(
            'svg',
            {
              width: 12,
              height: 12,
              viewBox: '0 0 12 12',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
              style: {
                flexShrink: 0,
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 120ms ease',
              },
            },
            h('path', { d: 'M4.5 2.5L8 6l-3.5 3.5' }),
          );

        const classifyAndSortSessions = ({ sessionSnapshot, workspaceSnapshot, currentSessionId, now }) => {
          const byId = sessionSnapshot?.byId ?? {};
          const workspaces = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : [];
          const archived = new Set(workspaceSnapshot?.archivedSessionIds ?? []);
          const pinned = new Set(workspaceSnapshot?.pinnedSessionIds ?? []);

          const wsBySession = new Map();
          for (const ws of workspaces) {
            for (const sid of ws.sessionIds ?? []) {
              if (!wsBySession.has(sid)) wsBySession.set(sid, ws);
            }
          }

          const recent1d = [];
          const recent2to7d = [];
          const inactive = [];
          const hidden = [];
          const bucketMap = new Map();

          for (const session of Object.values(byId)) {
            if (!session || session.origin === 'subagent') continue;
            if (archived.has(session.id)) continue;
            const isCurrent = session.id === currentSessionId;
            if (session.blank && !isCurrent) continue;

            const ownerWs = wsBySession.get(session.id);
            const rawTitle = typeof session.title === 'string' ? session.title.trim() : '';
            const wsLabel = workspaceDisplayName(ownerWs, session);
            const isTimestampWs = /^\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?$/.test(wsLabel);
            const showWorkspaceSubtitle = !(isTimestampWs && rawTitle !== '');
            const rawTs = Number(session.updatedAt || session.header?.createdAt || 0);
            const isLive = session.running === true || (session.blank === true && isCurrent);
            const lastActiveAt = isLive ? Math.max(rawTs, now) : rawTs;
            const age = lastActiveAt > 0 ? Math.max(0, now - lastActiveAt) : Number.MAX_SAFE_INTEGER;

            let bucketKey = 'inactive';
            if (isBotSession(ownerWs, session)) bucketKey = 'hidden';
            else if (isLive || age <= DAY_MS) bucketKey = 'recent1d';
            else if (age <= WEEK_MS) bucketKey = 'recent2to7d';

            bucketMap.set(session.id, bucketKey);
            const item = {
              id: session.id,
              rawTitle: typeof session.title === 'string' ? session.title : '',
              blank: session.blank === true,
              title: rawTitle !== ''
                ? rawTitle
                : session.blank ? t('newSession') : t('untitledSession'),
              workspaceLabel: wsLabel,
              showWorkspaceSubtitle,
              lastActiveAt,
              running: session.running === true,
              completed: session.completed === true,
              failed: session.failed === true,
              pinned: pinned.has(session.id),
              isCurrent,
              timeLabel: formatRelativeTime(lastActiveAt, now),
            };

            if (bucketKey === 'hidden') hidden.push(item);
            else if (bucketKey === 'recent1d') recent1d.push(item);
            else if (bucketKey === 'recent2to7d') recent2to7d.push(item);
            else inactive.push(item);
          }

          const sortDesc = (a, b) => {
            if (a.lastActiveAt !== b.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
            return a.id < b.id ? -1 : 1;
          };
          recent1d.sort(sortDesc);
          recent2to7d.sort(sortDesc);
          inactive.sort(sortDesc);
          hidden.sort(sortDesc);

          return {
            buckets: [
              { key: 'recent1d', label: t('bucket1d'), items: recent1d },
              { key: 'recent2to7d', label: t('bucket2to7d'), items: recent2to7d },
              { key: 'inactive', label: t('bucketInactive'), items: inactive },
              { key: 'hidden', label: t('bucketHidden'), items: hidden },
            ],
            totalCount: recent1d.length + recent2to7d.length + inactive.length,
            nextBucketMap: bucketMap,
          };
        };

        const openSessionRow = (sessionId) => {
          try {
            ctx.uiWorkspace?.openSession?.(sessionId);
          } catch (err) {
            console.warn('[independent-task] openSession failed:', err);
          }
        };

        const openSessionContextMenu = (item, x, y) => {
          if (item.blank) return;
          try {
            ctx.get('contextMenus')?.open?.(
              { kind: 'session', value: { sessionId: item.id, displayTitle: item.rawTitle } },
              { x, y },
            );
          } catch (err) {
            console.warn('[independent-task] open context menu failed:', err);
          }
        };

        const ActivitySessionRow = ({ item }) =>
          h(
            'div',
            {
              role: 'button',
              tabIndex: 0,
              className: `dsh-it-session-row${item.isCurrent ? ' selected' : ''}`,
              title: `${item.title} (${item.workspaceLabel})`,
              onClick: () => openSessionRow(item.id),
              onContextMenu: (event) => {
                if (item.blank) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.clientX === 0 && event.clientY === 0
                  ? event.currentTarget.getBoundingClientRect()
                  : null;
                openSessionContextMenu(
                  item,
                  rect ? rect.left : event.clientX,
                  rect ? rect.bottom : event.clientY,
                );
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openSessionRow(item.id);
                  return;
                }
                if (item.blank || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
                if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openSessionContextMenu(item, rect.left, rect.bottom);
                }
              },
            },
            h(
              'div',
              { className: 'dsh-it-session-top' },
              item.running && h('span', { className: 'dsh-it-dot running' }),
              !item.running && item.completed && h('span', { className: `dsh-it-dot ${item.failed ? 'failed' : 'done'}` }),
              h('span', { className: 'dsh-it-session-title' }, item.title),
              item.timeLabel && h('span', { className: 'dsh-it-session-time' }, item.timeLabel),
              !item.blank && h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-it-more-btn',
                  title: t('moreActions'),
                  'aria-label': t('moreActions'),
                  onClick: (event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openSessionContextMenu(item, rect.left, rect.bottom + 4);
                  },
                },
                h(
                  'svg',
                  {
                    width: 14,
                    height: 14,
                    viewBox: '0 0 16 16',
                    fill: 'currentColor',
                    'aria-hidden': true,
                  },
                  h('circle', { cx: 3.5, cy: 8, r: 1.2 }),
                  h('circle', { cx: 8, cy: 8, r: 1.2 }),
                  h('circle', { cx: 12.5, cy: 8, r: 1.2 }),
                ),
              ),
            ),
            item.showWorkspaceSubtitle && h('div', { className: 'dsh-it-session-ws' }, item.workspaceLabel),
          );

        const ActivityBucketSection = ({ bucket, isExpanded, onToggle }) => {
          const isHiddenBucket = bucket.key === 'hidden';
          return h(
            'div',
            { className: `dsh-it-bucket${isHiddenBucket ? ' dsh-it-bucket-hidden' : ''}` },
            isHiddenBucket && h('div', { className: 'dsh-it-divider' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-it-bucket-header',
                'aria-expanded': isExpanded,
                onClick: () => onToggle(bucket.key),
              },
              h(ActivityChevron, { expanded: isExpanded }),
              h('span', { className: 'dsh-it-bucket-title' }, bucket.label),
              h('span', { className: 'dsh-it-bucket-count' }, String(bucket.items.length)),
            ),
            isExpanded &&
              h(
                'div',
                { className: 'dsh-it-bucket-list' },
                bucket.items.length === 0
                  ? h('div', { className: 'dsh-it-empty' }, t('emptyBucket'))
                  : bucket.items.map((item) => h(ActivitySessionRow, { key: item.id, item })),
              ),
          );
        };

        const ActivitySessionBrowser = ({ isWide, isSearching }) => {
          const [enabled, setEnabled] = React.useState(() => readBoolStorage(ACTIVITY_ENABLED_KEY, true));
          const [expansion, setExpansion] = React.useState(() => readGroupExpansion());
          const [, setRevision] = React.useState(0);
          const prevBucketsRef = React.useRef(null);

          React.useEffect(() => {
            const bump = () => setRevision((v) => v + 1);
            const offSessions = ctx.get('sessions')?.list?.subscribe?.(bump);
            const offWorkspaces = ctx.get('workspaces')?.list?.subscribe?.(bump);
            const offSelection = ctx.uiWorkspace?.selection?.subscribe?.(bump);
            const offLayout = ctx.get('layout')?.panelInfo?.subscribe?.(bump);
            const timer = setInterval(bump, 60000);
            return () => {
              offSessions?.();
              offWorkspaces?.();
              offSelection?.();
              offLayout?.();
              clearInterval(timer);
            };
          }, []);

          // Sync host list visibility class on [data-sidebar-list-area].
          React.useEffect(() => {
            if (typeof document === 'undefined') return;
            const area = document.querySelector('[data-sidebar-list-area]');
            if (!area) return;
            const shouldTakeOver = enabled && isWide && !isSearching;
            area.classList.toggle('dsh-it-activity-active', shouldTakeOver);
            return () => {
              area.classList.remove('dsh-it-activity-active');
            };
          }, [enabled, isWide, isSearching]);

          const sessionSnapshot = ctx.get('sessions')?.list?.getSnapshot?.();
          const workspaceSnapshot = ctx.get('workspaces')?.list?.getSnapshot?.();
          const currentSessionId = getCurrentSessionId();

          const { buckets, totalCount, nextBucketMap } = React.useMemo(
            () => classifyAndSortSessions({
              sessionSnapshot,
              workspaceSnapshot,
              currentSessionId,
              now: Date.now(),
            }),
            [sessionSnapshot, workspaceSnapshot, currentSessionId],
          );

          // Auto-jump out of collapsed state when a new session arrives or an
          // existing session becomes active again (promoted to recent1d).
          React.useEffect(() => {
            const prev = prevBucketsRef.current;
            prevBucketsRef.current = nextBucketMap;
            if (prev === null) return;

            let shouldExpandRecent = false;
            for (const [sid, bucket] of nextBucketMap) {
              if (bucket !== 'recent1d') continue;
              const prevBucket = prev.get(sid);
              if (prevBucket === undefined || prevBucket !== 'recent1d') {
                shouldExpandRecent = true;
                break;
              }
            }

            if (shouldExpandRecent) {
              setExpansion((curr) => {
                if (curr.recent1d) return curr;
                const next = { ...curr, recent1d: true };
                saveGroupExpansion(next);
                return next;
              });
            }
          }, [nextBucketMap]);

          if (!isWide || isSearching) return null;

          const toggleEnabled = () => {
            const next = !enabled;
            setEnabled(next);
            try {
              localStorage.setItem(ACTIVITY_ENABLED_KEY, String(next));
            } catch {}
          };

          const toggleBucket = (key) => {
            setExpansion((curr) => {
              const next = { ...curr, [key]: !curr[key] };
              saveGroupExpansion(next);
              return next;
            });
          };

          const headerEl = typeof document !== 'undefined'
            ? document.querySelector('[data-sidebar-workspace-header]')
            : null;

          const toggleButton = h(
            'button',
            {
              type: 'button',
              className: `dsh-it-header-toggle${enabled ? ' active' : ''}`,
              title: enabled ? t('toggleToNativeTip') : t('toggleToActivityTip'),
              'aria-label': enabled ? t('toggleToNativeTip') : t('toggleToActivityTip'),
              'aria-pressed': enabled,
              onClick: (event) => {
                event.stopPropagation();
                toggleEnabled();
              },
            },
            h(
              'svg',
              {
                width: 14,
                height: 14,
                viewBox: '0 0 16 16',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true,
              },
              h('circle', { cx: 8, cy: 8, r: 6 }),
              h('path', { d: 'M8 4.8V8l2.2 1.4' }),
            ),
          );

          const headerPortal = headerEl ? ReactDOM.createPortal(toggleButton, headerEl) : null;

          if (!enabled) {
            return h(
              React.Fragment,
              null,
              headerPortal,
              !headerEl && h(
                'div',
                { className: 'dsh-it-activity-banner' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-it-mode-btn',
                    onClick: toggleEnabled,
                  },
                  t('switchToActivity'),
                ),
              ),
            );
          }

          return h(
            'div',
            { className: 'dsh-it-activity-panel' },
            headerPortal,
            !headerEl && h(
              'div',
              { className: 'dsh-it-activity-toolbar' },
              h('span', { className: 'dsh-it-activity-heading' }, `${t('activityMode')} (${totalCount})`),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-it-mode-btn',
                  onClick: toggleEnabled,
                },
                t('nativeMode'),
              ),
            ),
            ...buckets.map((bucket) =>
              h(ActivityBucketSection, {
                key: bucket.key,
                bucket,
                isExpanded: expansion[bucket.key] === true,
                onToggle: toggleBucket,
              }),
            ),
          );
        };

        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;

          const styleId = 'dsh-it-activity-styles';
          let styleEl = document.getElementById(styleId);
          if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            styleEl.textContent = [
              '[data-sidebar-list-area].dsh-it-activity-active > :not(.dsh-it-activity-root) { display: none !important; }',
              '.dsh-it-activity-root { width: 100%; box-sizing: border-box; }',
              '.dsh-it-header-toggle { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, #8e8e93); cursor: pointer; flex-shrink: 0; }',
              '.dsh-it-header-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-primary, #fff); }',
              '.dsh-it-header-toggle.active { color: var(--dsw-alias-label-primary, #fff); background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)); }',
              '.dsh-it-activity-banner { display: flex; justify-content: flex-end; padding: 2px 10px 6px; }',
              '.dsh-it-activity-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 2px 10px 6px; gap: 6px; }',
              '.dsh-it-activity-heading { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-tertiary, #8e8e93); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
              '.dsh-it-mode-btn { border: 1px solid var(--dsw-alias-border-l2, rgba(140,140,150,0.25)); background: transparent; color: var(--dsw-alias-label-secondary, #a1a1aa); border-radius: 5px; padding: 2px 7px; font-size: 11px; line-height: 16px; cursor: pointer; flex-shrink: 0; }',
              '.dsh-it-mode-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-primary, #fff); }',
              '.dsh-it-bucket { margin-bottom: 2px; }',
              '.dsh-it-divider { height: 1px; margin: 6px 12px; background: var(--dsw-alias-border-l2, rgba(140,140,150,0.2)); }',
              '.dsh-it-bucket-header { display: flex; align-items: center; gap: 6px; width: 100%; height: 30px; padding: 0 8px; padding-inline-start: calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 8px)); border: none; border-inline: var(--dsh-sidebar-paint-inset, 8px) solid transparent; border-radius: var(--dsw-radius-md, 8px); background: transparent; background-clip: padding-box; color: var(--dsw-alias-label-secondary, #c9c9cf); font-size: 12px; font-weight: 500; text-align: left; cursor: pointer; box-sizing: border-box; }',
              '.dsh-it-bucket-header:hover { background-color: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-primary, #fff); }',
              '.dsh-it-bucket-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
              '.dsh-it-bucket-count { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-tertiary, #8e8e93); flex-shrink: 0; }',
              '.dsh-it-bucket-list { display: flex; flex-direction: column; gap: 1px; padding: 2px 0 4px; }',
              '.dsh-it-empty { padding: 4px 12px 4px 28px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8e8e93); }',
              '.dsh-it-session-row { display: flex; flex-direction: column; align-items: stretch; gap: 1px; width: 100%; padding: 5px 8px; padding-inline-start: calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 8px) + 12px); border: none; border-inline: var(--dsh-sidebar-paint-inset, 8px) solid transparent; border-radius: var(--dsw-radius-md, 8px); background: transparent; background-clip: padding-box; color: var(--dsw-alias-label-primary, #fff); text-align: left; cursor: pointer; box-sizing: border-box; outline: none; }',
              '.dsh-it-session-row:hover, .dsh-it-session-row:focus-visible, .dsh-it-session-row.selected { background-color: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)); }',
              '.dsh-it-session-top { display: flex; align-items: center; gap: 6px; min-width: 0; height: 20px; }',
              '.dsh-it-session-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; line-height: 19px; }',
              '.dsh-it-session-time { flex-shrink: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8e8e93); }',
              '.dsh-it-more-btn { display: none; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: none; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary, #c9c9cf); cursor: pointer; flex-shrink: 0; }',
              '.dsh-it-more-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.12)); color: var(--dsw-alias-label-primary, #fff); }',
              '.dsh-it-session-row:hover .dsh-it-session-time, .dsh-it-session-row:focus-within .dsh-it-session-time { display: none; }',
              '.dsh-it-session-row:hover .dsh-it-more-btn, .dsh-it-session-row:focus-within .dsh-it-more-btn { display: inline-flex; }',
              '.dsh-it-session-ws { font-size: 11px; line-height: 15px; opacity: 0.8; color: var(--dsw-alias-label-tertiary, #8e8e93); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
              '.dsh-it-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }',
              '.dsh-it-dot.running { background: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.25); }',
              '.dsh-it-dot.done { background: #22c55e; }',
              '.dsh-it-dot.failed { background: #ef4444; }',
            ].join('\n');
            document.head.appendChild(styleEl);
          }

          let createRootFn = null;
          try {
            createRootFn = require('react-dom/client')?.createRoot ?? null;
          } catch {
            createRootFn = null;
          }

          let mountedArea = null;
          let hostEl = null;
          let reactRoot = null;
          let observedRoot = null;

          const unmountHost = () => {
            if (reactRoot) {
              try {
                reactRoot.unmount();
              } catch {}
              reactRoot = null;
            } else if (hostEl && typeof ReactDOM.unmountComponentAtNode === 'function') {
              try {
                ReactDOM.unmountComponentAtNode(hostEl);
              } catch {}
            }
            if (hostEl) {
              hostEl.remove();
              hostEl = null;
            }
            if (mountedArea) {
              mountedArea.classList.remove('dsh-it-activity-active');
              mountedArea = null;
            }
          };

          const isSidebarSearching = (area) => {
            const container = area?.parentElement;
            if (!container) return false;
            const inputs = container.querySelectorAll('input');
            for (const input of inputs) {
              if (typeof input.value === 'string' && input.value.trim() !== '') return true;
            }
            return false;
          };

          const isSidebarWide = (area) => {
            try {
              const sidebarSnap = ctx.get('layout')?.sidebar?.getSnapshot?.();
              if (typeof sidebarSnap?.collapsed === 'boolean') return !sidebarSnap.collapsed;
            } catch {}
            return area.clientWidth > 80;
          };

          const observer = new MutationObserver(() => scheduleSync());
          const attachObserver = (target) => {
            if (observedRoot === target) return;
            observer.disconnect();
            observedRoot = target;
            if (target) observer.observe(target, { childList: true, subtree: true });
          };

          const syncMount = () => {
            const area = document.querySelector('[data-sidebar-list-area]');
            if (!area) {
              unmountHost();
              attachObserver(document.body);
              return;
            }
            if (mountedArea !== area) {
              unmountHost();
              mountedArea = area;
              hostEl = document.createElement('div');
              hostEl.className = 'dsh-it-activity-root';
              area.prepend(hostEl);
              if (createRootFn) {
                reactRoot = createRootFn(hostEl);
              }
            }
            // Narrow observation to the sidebar container instead of document.body
            // so main-view streaming tokens do not trigger sidebar re-syncs.
            const sidebarContainer = area.closest('aside, nav') ?? area.parentElement ?? document.body;
            attachObserver(sidebarContainer);

            const isWide = isSidebarWide(area);
            const isSearching = isSidebarSearching(area);
            const element = h(ActivitySessionBrowser, { isWide, isSearching });
            if (reactRoot) {
              reactRoot.render(element);
            } else if (typeof ReactDOM.render === 'function') {
              ReactDOM.render(element, hostEl);
            }
          };

          let syncQueued = false;
          const scheduleSync = () => {
            if (syncQueued) return;
            syncQueued = true;
            later(() => {
              syncQueued = false;
              syncMount();
            }, 50);
          };

          const onHeaderInput = (event) => {
            if (event.target?.closest?.('[data-sidebar-workspace-header]')) scheduleSync();
          };
          const offSidebarLayout = ctx.get('layout')?.sidebar?.subscribe?.(scheduleSync);
          window.addEventListener('input', onHeaderInput, true);
          window.addEventListener('resize', scheduleSync);
          syncMount();

          return () => {
            observer.disconnect();
            observedRoot = null;
            offSidebarLayout?.();
            window.removeEventListener('input', onHeaderInput, true);
            window.removeEventListener('resize', scheduleSync);
            unmountHost();
            styleEl?.remove();
          };
        }, 'independent-task activity sidebar');
      },
    };
  },
});
