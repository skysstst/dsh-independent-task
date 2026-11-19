# Independent Tasks for DeepSeek Harness

One click creates a **timestamped workspace folder** and opens a **brand-new
session inside it** — no manual "make a folder, then add it as a workspace,
then start a session" dance.

[English](#english) · [简体中文](#简体中文)

---

## English

### The problem it solves

DeepSeek Harness starts every session in the *same* workspace unless you first
create a folder and register it. Splitting work into independent tasks therefore
means repeating the same three manual steps every time.

This plugin adds a single **New independent task** entry at the very top of the
sidebar (immediately under the native "New session" button). Clicking it:

1. creates `YYYY-MM-DD_HHmmss` under your chosen root folder,
2. registers that folder as a Workspace,
3. creates a session inside it **and opens it**, and
4. later renames the Workspace's **display title** to the session's generated
   title — while the physical folder name stays the timestamp.

Tasks you never touch clean themselves up; tasks you type into stay and keep
their draft.

The root folder is chosen from a small dropdown on that same button
(`[ 📁 │ ▾ ]`) and then **remembered**, so everyday use is a single click.

The native "New session" button is never modified or hijacked.

### Install

Requires DeepSeek Harness **>= 0.2.2-rc.1**.

```bash
# From a local checkout
#   then, in the Harness UI: Plugins → install bundle from a directory path,
#   or use the plugin_manager tool with action "install_bundle" and this
#   directory as the target.
git clone https://github.com/skysstst/dsh-independent-task.git
```

The bundle installs as `@local/dsh-independent-task` and applies live
(`application: applied`); no restart is needed for the Client half.

### Use

| Entry point | How |
|---|---|
| Sidebar button | Click the folder-plus icon at the top of the sidebar (inherits the remembered task folder) |
| Slash command | Type `/new-independent-task` in a session |
| HTTP route | `POST /api/dsh-independent-task/create` (loopback + same-origin only) |

The sidebar control is a small **split button**:

```
[ 📁 │ ▾ ]  New independent task
```

- Click the **folder icon** (or the row) → creates a timestamped folder and opens
  a session inside it, under the *remembered* task folder.
- Click the small **▾** → opens the task-folder menu:
  - **Choose task folder…** — opens the native OS folder picker. The picked
    folder is saved as the remembered root **and** a new task is created there
    immediately (one click, no extra step).
  - **Reset to default** — forgets the saved root; new folders go next to the
    current workspace again.
  - The menu header always shows the root currently in use.

The choice is remembered across restarts, so afterwards you normally just click
the main button — it keeps using the same folder until you pick another one.

### Empty tasks clean themselves up

A task you create and then abandon does not linger. If you leave the conversation
without typing anything, the plugin archives the session, removes the workspace
row and deletes the timestamp folder from disk a few seconds later.

The moment you show any intent, that stops being a disposable task:

- typing text into the composer (even without sending),
- pasting,
- attaching an image or a file,
- quoting a message,
- invoking a slash command.

From then on the session is a real task: it is never auto-deleted, its row stays
in the sidebar even while you are looking at another conversation, and an unsent
draft is still there when you come back. After you **send**, the input box is
empty again — the plugin does not preserve sent text (DeepSeek Harness persists
unsent drafts per session on its own; the plugin only ever reads that storage).

Deletion is only ever attempted for folders this plugin created, verified by the
`.dsh-independent-task.json` marker, and never for a session whose log already
contains a real user turn.

### Configuration

Task folder precedence (highest first):

1. A `parentPath` sent explicitly with the create request (used by the ▾ menu).
2. The remembered root saved via the ▾ menu (`/api/dsh-independent-task/config`,
   persisted in `~/.dsh/dsh-independent-task.json`).
3. **Settings → Independent tasks → parent path** (same value, editable as text).
4. Blank → the new folder is created next to the *current* workspace.

Relative paths are resolved against the Harness process working directory.

### How it works

```
click / command
      │
      ▼
 resolve parent  ──▶  mkdir YYYY-MM-DD_HHmmss  ──▶  write marker file
      │
      ▼
workspaceRegistry.create(path)  ──▶  sessionController.create({ workspaceId })
      │                                        │
      │                                        └─ Host derives header.cwd from
      │                                           workspace.path and attaches the
      │                                           session itself
      ▼
 client: uiWorkspace.openSession(sessionId)  → conversation opens in one click
```

- The session's `header.cwd` is set by the Host from `workspace.path`; this
  plugin never rewrites it and never renames the directory on disk.
- `Workspace.path` is immutable, so title sync goes through `setTitle()` — only
  the display title changes.
- Only folders carrying the `.dsh-independent-task.json` marker are ever
  retitled or deleted, so the plugin cannot touch workspaces you created
  yourself.

### Robustness details

- **Same-second clicks**: instead of appending `_2`/`_3`, the plugin waits for
  the clock to advance and re-stamps, so names stay clean. A 5 s deadline
  prevents a frozen clock from hanging a request.
- **Failure rollback**: if workspace registration or session creation fails, the
  fresh folder and any half-registered workspace are removed.
- **Fast title path**: Workspace ids created by this plugin instance are cached
  in memory, so unrelated `session/title` events cost no filesystem access.
- **Trust fence**: the Host's own connection authority is the *only* authority —
  a rejection from it is final for these routes too. When that service is absent
  the plugin's own fence requires a same-authority `Origin`, accepts only
  loopback sockets with an exact loopback `Host`, and refuses
  `sec-fetch-site: cross-site`. These routes delete directories, so the fence
  fails closed rather than open.
- **Cleanup is double-guarded**: the Client only asks to delete a task it
  believes untouched, and the Host independently re-reads the session surface
  through `sessionQuery.readSurface()` before deleting anything. A stale pending
  list in another window can therefore never delete a conversation you are
  working in — and a surface it cannot read is treated as busy, not as empty.
- **Cleanup deletes the folder first**: the workspace is unregistered only after
  the folder is really gone, so a failed delete leaves you a working sidebar row
  instead of an orphan folder with no way to reach it.
- **Ownership is proved**: the folder name must be a timestamp this plugin could
  have minted, the marker's recorded name must match the folder, the workspace
  must point at the same real path and own the session. Copying the marker file
  into some other folder does not make it deletable.
- **Cleanup retries**: a transient failure (Host restarting, a folder briefly
  locked by the OS) is retried up to three times; an explicit refusal
  (`session-has-messages`, `not-plugin-owned`, `workspace-mismatch`,
  `session-mismatch`, `missing-path`) is never retried, because retrying it would
  only ask the same question again.
- **No periodic tick**: checks are driven by store events plus a self-terminating
  watchdog that only runs while a task is tracked, so the plugin does no work in
  the background once everything has settled.
- **Read-only towards host state**: the only host mutations are the three writes
  Harness itself performs when a prompt is accepted (`engagedSessions`,
  `recordMutation({kind:'engaged'})`, `handleBlank(false)`), issued at most once
  per session. DSH's draft storage (`dsh.conversation.*`) is only ever read — the
  one exception is deleting the entry of a session the plugin itself has just
  removed.
- **Clean unload**: command, routes, listener, slot registrations and timers are
  all registered through `ctx.effect` / `ctx.slots.inject`, so disabling the
  plugin removes everything.

### Compatibility

- Host and Client halves in one bundle (`dsh.bundle.patch` + `dsh.client`).
- Client module is a lazy `__ModuleLoader__` factory; it needs no build step.
- `@deepseek-ai/schemastery` and `@deepseek-ai/cosmokit` are **vendored** under
  `vendor/` (MIT, licenses included) and imported by relative path, so a linked
  local install resolves them from the plugin's own directory — a linked bundle
  has no `node_modules` of its own.
- No writes to your profile `package.json` / `cordis.patch.yml`; installation
  goes through `plugin_manager`.

### Troubleshooting

| Symptom | Check |
|---|---|
| Button missing | The sidebar is collapsed to the icon rail — expand it; the row appears under "New session". |
| Nothing happens on click | Open DevTools console; a failing route returns `403 forbidden` (non-loopback) or `500` with the reason. |
| Folder created, no conversation | The Client roster frame may be late; the plugin waits up to 3 s, then opens anyway. Report the session id shown in the console. |
| The ▾ does not respond to keyboard | It lives inside the host's decorative icon slot (mouse-only). Right-click the folder icon also opens the menu, and **Settings → Independent tasks → parent path** edits the same value. |
| A leftover draft came back after sending | Not reproducible in 1.2.0: the plugin never writes draft storage. After upgrading, reload once (`Ctrl+R`) so the new Client module is picked up. If it still happens, it is a Harness-side draft issue and worth reporting upstream. |
| An empty task folder was not deleted | Console warnings explain the reason: `cleanup refused: session-has-messages` means the session already had a real turn, `not-plugin-owned` means the folder is not provably plugin-owned, `workspace-mismatch` / `session-mismatch` means the record no longer matches the workspace, `cleanup deferred` means it will be retried. |
| A task disappeared that you wanted to keep | Any typing, paste, attachment or command counts as intent and keeps it — but a task left completely untouched is by design disposable. Recreate it with the button. |

### License

MIT. Vendored third-party licenses live in `vendor/LICENSE.schemastery` and
`vendor/LICENSE.cosmokit`.

---

## 简体中文

### 解决的问题

DeepSeek Harness 默认让所有会话共用同一个工作区；想按任务拆开，就得先建文件夹、
再注册成工作区、再新建会话——每次重复三步。

本插件在侧栏**最顶部**（紧贴原生「新会话」按钮）增加一个「新建独立任务」入口，点一下：

1. 在指定根目录下创建 `YYYY-MM-DD_HHmmss` 目录；
2. 把该目录注册为 Workspace；
3. 在其中创建会话**并直接打开**；
4. 会话标题生成后，把该 Workspace 的**显示标题**同步成会话标题，磁盘目录名始终是时间戳。

没动过的任务会自动清理；输入过内容的任务会保留，草稿也会留着。

根目录通过同一个按钮上的小三角下拉（`[ 📁 │ ▾ ]`）选择，选完即被**记住**，日常使用就是点一下。

原生「新建会话」按钮完全不被修改或劫持。

### 安装

需要 DeepSeek Harness **>= 0.2.2-rc.1**。

```bash
git clone https://github.com/skysstst/dsh-independent-task.git
```

然后在 Harness 里用「插件 → 从目录安装」，或用 `plugin_manager` 工具、
`action: "install_bundle"`、以该目录为 target 安装。bundle 名为
`@local/dsh-independent-task`，`application: applied` 即时生效，Client 半无需重启。

### 使用

| 入口 | 方式 |
|---|---|
| 侧栏按钮 | 点击侧栏顶部「文件夹+加号」图标（沿用已记住的任务目录） |
| 斜杠命令 | 会话里输入 `/new-independent-task` |
| HTTP 路由 | `POST /api/dsh-independent-task/create`（仅限本机回环 + 同源） |

侧栏控件是一个小的**分离式按钮**：

```
[ 📁 │ ▾ ]  新建独立任务
```

- 点**文件夹图标**（或整行）→ 在**已记住的任务目录**下创建时间戳目录并打开新会话；
- 点右侧**小三角 ▾** → 打开任务目录菜单：
  - **选择任务目录…**：呼出系统原生文件夹选择框；选定后**立即保存并马上在该目录新建一个独立任务**（一步到位）；
  - **恢复默认目录**：清除记住的目录，回到「当前工作区同级」；
  - 菜单顶部始终显示当前正在使用的目录。

选择会被持久记住，重启后依然生效。之后通常**直接点主按钮**即可，它会继承上一次的设置，直到你再次通过 ▾ 修改。

### 空任务自动清理

建了就丢下的任务不会一直留着。如果你没输入任何内容就离开这个对话，插件会在几秒后归档该会话、移除工作区行，并把时间戳目录从磁盘删除。

一旦你表现出任何意图，它就不再是可丢弃的临时任务：

- 在输入框里打字（哪怕没发送）；
- 粘贴内容；
- 附带图片或文件；
- 引用消息；
- 使用斜杠命令。

此后它就是正式任务：绝不会被自动删除，即使你正在看别的对话，它在侧栏的行也不会消失，切回来时未发送的草稿还在。**发送之后**输入框会清空——插件不保留已发送的文本（DeepSeek Harness 本身按会话持久化未发送草稿，插件只读取、从不写入）。

删除只会针对本插件创建的目录（以 `.dsh-independent-task.json` 标记校验），并且绝不会删除日志里已经有真实用户消息的会话。

### 配置

任务目录优先级（从高到低）：

1. 创建请求里显式携带的 `parentPath`（▾ 菜单选完目录后就是这条）；
2. ▾ 菜单记住的目录（`/api/dsh-independent-task/config`，持久化到 `~/.dsh/dsh-independent-task.json`）；
3. **设置 → 独立任务 → 父路径**（同一个值，可用文本方式编辑）；
4. 留空 → 在当前工作区旁边新建。

相对路径按 Harness 进程的工作目录解析。

### 实现要点

- 会话的 `header.cwd` 由 Host 依据 `workspace.path` 设置，插件不改写、也不重命名磁盘目录。
- `Workspace.path` 不可变，所以标题同步只走 `setTitle()`，仅改显示标题。
- 只会删除本插件自己创建的目录（时间戳目录名 + 标记文件内容双重校验），绝不改名、也绝不影响你自己建的工作区。

### 健壮性

- **同一秒连点**：不加 `_2/_3`，而是等到下一秒重新取时间戳，名字始终干净；5 秒上限防止时钟异常导致挂起。
- **失败回滚**：注册工作区或创建会话失败时，自动删除刚建的目录与半注册的工作区。
- **标题快路径**：本实例创建的工作区 id 缓存在内存，其它会话的标题事件不触发任何文件系统访问。
- **信任围栏**：Host 自己的连接服务是**唯一**权威——它拒绝时这些路由也一律拒绝。该服务不可用时，插件自带的围栏要求同源 `Origin`、只接受回环 socket + 精确回环 `Host`，并拒绝 `sec-fetch-site: cross-site`。这些路由会删目录，围栏一律朝「拒绝」方向失败。
- **清理双重保护**：Client 只在判定「无意图」时请求删除；Host 端还会用 `sessionQuery.readSurface()` 独立复查会话表面再动手。因此另一个窗口里过期的待跟踪列表，绝不可能删掉你正在用的对话——**读不到会话表面时按「有内容」处理**，不按「空」处理。
- **先删目录再注销**：只有目录真的删掉了才注销工作区，删除失败时你看到的是仍然可用的侧栏行，而不是一个「行没了、目录还在、UI 里点不到」的孤儿目录。
- **所有权是证明出来的**：目录名必须是本插件可能生成的时间戳、标记文件里记录的名字必须与目录一致、工作区必须指向同一真实路径并且确实拥有该会话。把标记文件复制到别的目录并不能让它变成可删。
- **清理重试**：瞬时失败（Host 重启、目录被系统短暂占用）最多重试三次；显式拒绝（`session-has-messages`、`not-plugin-owned`、`workspace-mismatch`、`session-mismatch`、`missing-path`）不重试，因为重试只会再问一次同样的问题。
- **无周期性轮询**：检查由 store 事件驱动，外加一个只在有任务被跟踪时运行的自终止看门狗；一切落定后插件不做任何后台工作。
- **对宿主状态只读**：唯一的宿主写入是 Harness 自己在接受提示词时做的三件事（`engagedSessions`、`recordMutation({kind:'engaged'})`、`handleBlank(false)`），每会话最多一次。DSH 的草稿存储（`dsh.conversation.*`）只读——唯一的例外是删掉插件自己刚清除的那个会话的条目。
- **干净卸载**：命令、路由、监听、槽位注册、定时器全部经 `ctx.effect` / `ctx.slots.inject` 注册，禁用插件即全部回收。

### 故障排查

| 现象 | 排查 |
|---|---|
| 看不到按钮 | 侧栏可能折叠成图标栏，展开后即出现在「新会话」下方。 |
| 点击无反应 | 打开 DevTools 控制台；路由失败会返回 `403 forbidden`（非回环）或 `500` 并附原因。 |
| 只有文件夹没会话 | Client 名册同步可能延迟；插件最多等 3 秒后仍会尝试打开，可把控制台里的 session id 反馈出来。 |
| 小三角按键盘没反应 | 它位于宿主的装饰性图标槽内，属于鼠标操作；在文件夹图标上**右键**同样能打开该菜单，也可用「设置 → 独立任务 → 父路径」改同一个值。 |
| 发送后草稿又冒回来 | 1.2.0 里不会复现：插件不写草稿存储。从旧版升级后请刷新一次页面（`Ctrl+R`）让新 Client 模块生效；若仍出现，那是 Harness 自身的草稿问题，值得向上游反馈。 |
| 空任务目录没被删掉 | 控制台警告会给出原因：`cleanup refused: session-has-messages` 表示会话已有真实对话，`not-plugin-owned` 表示无法证明目录归插件所有，`workspace-mismatch` / `session-mismatch` 表示记录与工作区已对不上，`cleanup deferred` 表示会重试。 |
| 想留的任务被删了 | 打字、粘贴、附件、命令都算意图，会保住它；但完全没动过的任务按设计就是一次性的。需要的话用按钮重开一个即可。 |

### 许可

MIT。第三方 vendored 许可见 `vendor/LICENSE.schemastery` 与 `vendor/LICENSE.cosmokit`。
