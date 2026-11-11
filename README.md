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
  renamed, so the plugin cannot touch workspaces you created yourself.

### Robustness details

- **Same-second clicks**: instead of appending `_2`/`_3`, the plugin waits for
  the clock to advance and re-stamps, so names stay clean. A 5 s deadline
  prevents a frozen clock from hanging a request.
- **Failure rollback**: if workspace registration or session creation fails, the
  fresh folder and any half-registered workspace are removed.
- **Fast title path**: Workspace ids created by this plugin instance are cached
  in memory, so unrelated `session/title` events cost no filesystem access.
- **Trust fence**: the HTTP route accepts only loopback sockets with an exact
  loopback `Host`, refuses `sec-fetch-site: cross-site`, and defers to the
  Host's own connection authority when present.
- **Clean unload**: command, route, listener and timers are all registered
  through `ctx.effect`, so disabling the plugin removes everything.

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
- 只重命名带 `.dsh-independent-task.json` 标记的目录，绝不会影响你自己建的工作区。

### 健壮性

- **同一秒连点**：不加 `_2/_3`，而是等到下一秒重新取时间戳，名字始终干净；5 秒上限防止时钟异常导致挂起。
- **失败回滚**：注册工作区或创建会话失败时，自动删除刚建的目录与半注册的工作区。
- **标题快路径**：本实例创建的工作区 id 缓存在内存，其它会话的标题事件不触发任何文件系统访问。
- **信任围栏**：HTTP 路由只接受回环 socket + 精确回环 `Host`，拒绝 `sec-fetch-site: cross-site`，存在 Host 连接服务时以其为准。
- **干净卸载**：命令、路由、监听、定时器全部经 `ctx.effect` 注册，禁用插件即全部回收。

### 故障排查

| 现象 | 排查 |
|---|---|
| 看不到按钮 | 侧栏可能折叠成图标栏，展开后即出现在「新会话」下方。 |
| 点击无反应 | 打开 DevTools 控制台；路由失败会返回 `403 forbidden`（非回环）或 `500` 并附原因。 |
| 只有文件夹没会话 | Client 名册同步可能延迟；插件最多等 3 秒后仍会尝试打开，可把控制台里的 session id 反馈出来。 |
| 小三角按键盘没反应 | 它位于宿主的装饰性图标槽内，属于鼠标操作；在文件夹图标上**右键**同样能打开该菜单，也可用「设置 → 独立任务 → 父路径」改同一个值。 |

### 许可

MIT。第三方 vendored 许可见 `vendor/LICENSE.schemastery` 与 `vendor/LICENSE.cosmokit`。
