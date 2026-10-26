# minilfs v0.5 设计：目录即主干，分支只给子 agent

状态：**草案 r2**（已按 Argon 评审修订，见 §10），实现前
替代：v0.4 的"主会话也在分支里" + 本轮加的 host mode / host policy
参考：LayerFS × DSH（`layerfs/dsh/`）、`docs/EPI-INTEGRATION.md` 第 3 阶段

---

## 0. 一句话

**项目目录就是主干（trunk），只属于主 agent；每个子 agent 在自己的 LayerFS 分支上工作；子 agent 的成果只能由主 agent 用一个动作 `land` 合进目录。**

没有模式，没有切换，没有授权策略。一个 agent 是什么角色，由运行环境在它启动时决定，之后不变。

---

## 1. 为什么要改

### 1.1 现状（v0.4 + 本轮补丁）

主会话也在 minilfs 分支里工作。这带来一串问题，本轮都碰到了：

| 问题 | 根因 |
|---|---|
| `/resume` 卡在 `minilfs starting…`，大仓库首次导入 60 秒超时 | 主会话启动就要导入整个目录 |
| 主 agent 不能 `git commit`、不能写 `.git`、不能跑 `ps`、不能挂载、不能嵌套沙箱，minilfs 不能在 minilfs 里测试自己 | 主 agent 的 bash 也在 Seatbelt 里 |
| "未 apply"标记过期（用户 `git pull` 后仍提示有改动） | 主会话的改动有两份真相：分支和目录 |
| 为了解决上面的问题，加了 host mode、4 种 host policy、切换前的一致性检查、`restartFromMain`、过期标记检测 | 给不该进笼子的人开门，门越开越多 |

### 1.2 参考设计怎么做

| 设计 | 谁在主干上 | 子 agent | 成果怎么回到主干 |
|---|---|---|---|
| **LayerFS × DSH** | LayerFS 的 `main`（只读）；主 agent 也开分支 | 每个 agent 一个分支，每次调用一个 Workspace | "Only the main agent publishes to main"；子 agent 报告分支，主 agent 合并后 `publish` |
| **git worktree 式**（多数多 agent 工具） | 主工作区 | 每个 worker 一个 worktree | 主 agent 合并 worker 分支 |
| **本设计** | **用户的项目目录** | 每个子 agent 一个 LayerFS 分支 | 主 agent `land`：三方合并进目录 |

LayerFS × DSH 的核心规则我们全部保留：**一个 agent 一个分支、只有主 agent 写主干、子 agent 结束时报告分支**。唯一的区别是主干的位置：DSH 把主干放在 LayerFS 里，用户要在 LayerFS 里看历史；我们的用户在自己的目录和 git 里工作，所以**主干就是目录本身**。LayerFS 的 `main` 只是目录的镜像，用来给子 agent 分叉。

---

## 2. 模型

### 2.1 三个角色，一张图

```
                    ┌────────────────────────────────────────────┐
  主 agent ─────────▶│ 项目目录 = 主干（trunk）                      │◀── 用户、git、编辑器
  原生工具，最高权限  └───────▲───────────────────────┬────────────┘
                            │ land（三方合并）          │ 同步（分叉前）
                            │ 只有主 agent 能做         ▼
                    ┌───────┴──────────────────────────────────────┐
                    │ LayerFS Store：main（目录的镜像）              │
                    │   ├─ task-<jobId>   子 agent A 的分支         │
                    │   ├─ task-<jobId>   子 agent B 的分支         │
                    │   └─ sub-<agentId>  DSH 子 agent 的分支       │
                    └───────▲──────────────────────────────────────┘
                            │ 读写、bash（Seatbelt 沙箱）
  子 agent ─────────────────┘ 只能改自己的分支；不能 land
```

| 角色 | 在哪里工作 | 工具 | 能做 | 不能做 |
|---|---|---|---|---|
| **主 agent**（顶层会话） | 项目目录 | 运行环境的原生工具，minilfs 不接管 | 一切；外加 `minilfs` 工具查看、合并子分支 | — |
| **子 agent**（Epi task、Pi subagent、DSH subagent） | 自己的分支 | minilfs 接管的 read/write/edit/ls/find/grep/bash | 改自己的分支；`sync` 把最新主干合进来 | 写目录、land、看到别的子 agent 未合并的改动 |
| **外部 agent**（Claude Code、Codex 通过 MCP/CLI） | `--branch <名字>` 指定的分支 | `minilfs exec` / MCP 工具 | 同子 agent | 同子 agent |

### 2.2 一条规则决定角色

> 一个 agent 是子 agent，当且仅当运行环境说它是。否则它是主 agent，minilfs 不碰它的工具。

| 运行环境 | 怎么判断子 agent | 分支名 |
|---|---|---|
| Epi task | 见 §5.1（今天靠会话文件路径；向 Epi 提 issue 要正式的环境变量） | `task-<jobId>` |
| Pi + pi-subagents | `PI_SUBAGENT_CHILD=1` | `sub-<sessionId 前 8 位>` |
| DSH | `exec.agent.session.header.origin === "subagent"`（或 `parentSession` / `delegationDepth > 0`） | `sub-<agentId 前 8 位>` |
| MCP / CLI | 显式 `--branch <名字>` | 给定的名字 |
| 任何环境，强制 | `MINILFS_ROLE=worker` / `MINILFS_ROLE=lead` | — |

**分支的名字用运行环境已经给出的任务 id**，主 agent 派任务时就拿到了，不需要子 agent 报告分支名。

名字分两层（现有引擎就是这样，必须保留）：

| 层 | 例子 | 说明 |
|---|---|---|
| 逻辑名（对外，稳定） | `task-<jobId>` | 主 agent、提示、`land` 都用它 |
| 物理分支（对内，会换） | `task-<jobId 前 8 位>-<seq>` | LayerFS 的 merge 只能写到新分支，所以子 agent 每次 `sync` 都会换一个物理分支（`workspace.ts` 中 `seq++`） |

`resolveBranch(name)` 只做精确解析：逻辑名 → 当前物理分支；任务 id 接受**完整 id 或至少 8 位的唯一前缀**（与 Epi `findJobId` 一致，`task-runtime.js:296-302`；Epi 给模型看的是 8 位短 id，`extensions/task.js:158`）。前缀不唯一时报错并列出候选。删除的是 `lead` 别名和按会话猜测的模糊解析。

---

## 3. 生命周期

### 3.1 子 agent 启动（分叉）

1. 第一次有子 agent 时才创建 Project Store（**主会话启动时什么都不做**，`/resume` 不再等待）。
2. 把目录同步进 `main`：按 `.gitignore` 扫描，只写变化的文件（现有 `syncHostDriftIntoMain`，已并发、只保留需要的字节）。项目锁内完成。若目录里有 `.git/index.lock`（主 agent 正在做 git 操作），等它消失再扫，最多等 10 秒，避免拍到一半的状态。
3. 从 `main` 分叉 `task-<jobId>`，记下**基线** `baseRef` = 本次分叉时的 `main` 快照（land 的三方合并基线，§3.3）。
4. 子 agent 的工具全部作用在这个分支上；bash 在 Seatbelt 里跑。

大仓库首次导入的上限（`MINILFS_MAX_IMPORT_*`）仍然生效，但只会让**派任务**失败并给出可操作的提示，主 agent 不受影响。

### 3.2 子 agent 工作中

- 每次 write/edit/bash 一个 LayerFS Commit（现有逻辑）。
- `minilfs sync`：先同步目录进 `main`，再把 `main` 合进自己的分支，拿到主 agent 期间的改动。**成功后基线 `baseRef` 推进到这次合进来的 `main` 快照**，否则 land 会把这些主干改动误当成子 agent 的改动（三方合并基线错误）。
- 子 agent 不做版本操作：提示词写明"不要在分支里 `git commit/checkout/reset/rebase`；提交由主 agent 在 land 后做"。`.git/` 永远不会被 land。
- 需要主机能力（Docker、挂载、`git push`、长期运行的服务）时，子 agent 停下并在结果里请主 agent 做（与 DSH 一致：子 agent 不提权）。
- 结束时不需要报告分支名；运行环境的任务 id 就是分支名。

### 3.3 主 agent 合并（land）

`minilfs land <jobId|branch> [--ours|--theirs] [--dry-run]`

对子分支相对**基线 `baseRef`** 改过的每个文件，比较三方（base = `baseRef` 里的版本，ours = 目录现状，theirs = 子分支版本）：

| 目录现状 | 结果 |
|---|---|
| 等于 base（主 agent 没动过） | 写入子分支版本 |
| 等于子分支版本 | 跳过（已一致） |
| 都不同，文本文件 | `git merge-file` 三方合并；干净则写入，否则冲突 |
| 都不同，二进制 / 符号链接 / 权限位冲突 | 冲突 |

- **有任何冲突就一个都不写**，列出冲突文件；`--theirs` / `--ours` 整体取一边，或 `resolve: { "<path>": "ours" | "theirs" }` 按文件取（复用 `fallbackMergeBranch` 现有的 `resolve`）。
- 被忽略、branch-only、密钥、`.git/`、`.lww` 的路径永远不写（与现在 apply 一致）。
- 写入是逐文件原子替换（临时文件 + rename），写前再查一次目录没变（现有 TOCTOU 检查）。
- 成功后同步目录进 `main`，**基线推进到刚 land 的子分支快照**，并记录"已 land 到 <commit>"。所以同一个子分支可以**多次增量 land**：Epi 能用 `task({ jobId, task })` 续跑同一个任务（`task-runtime.js:353`），续跑后再 land 只合新改动。
- 结果里若有会被执行的文件（`package.json`、`Makefile`、`*.sh`、`Cargo.toml`/`build.rs`、CI 配置、`.epi/`、`.husky/` 等），附一行提醒：这些改动来自子 agent，主 agent 运行前应先看 diff。主 agent 不在沙箱里，这是子 agent 代码影响主机的唯一路径。

`land` 就是现在 `apply` 的冲突逻辑，加上一步文本三方合并（复用 `fallbackMergeBranch` 里已有的 `threeWayMerge`）。

### 3.4 任务结束的提示（Epi）

主 agent 的扩展**只读地**观察 Epi 的 `task_stop`（`pi.events` 频道 `epi/hooks/task/v1`，载荷 `{ event: { type, job }, context }`）。

- **绝不设置 `request.run`**：那是 `epi:hooks` 的唯一决策位，`emitTaskHook` 只调用一个 `run`，返回非 `continue` 会让任务收尾抛错（`hook-events.js:2-8`，`extensions/task.js:424-427`）。监听器包在 try/catch 里，只记下 jobId，不做任何耗时操作。
- 提示的投递放在之后：在主 agent 下一次 `before_agent_start` 时，把"已结束、有改动、未 land 的子分支"附进系统提示；交互界面同时 `ctx.ui.notify` 一次。不抢 Epi 自己的任务通知。
- 提示内容：`task <短id> 改了 N 个文件（其中 x.ts、y.ts 主干期间也改过，land 时会三方合并）；minilfs diff <短id> 查看，minilfs land <短id> 合并`。"双方都改了"用目录索引和基线快照对比算出，毫秒级。
- **不自动 land**：合并是主 agent 的决定，和 DSH 一致。

---

## 4. 工具面

### 4.1 主 agent 看到的

运行环境原生的 read/write/edit/bash（不接管），加一个工具。

主 agent **没有 `LayerfsSession`**（没有自己的分支）。这些动作由一个项目级控制器 `ProjectTrunk` 执行：按目录查 `bindings`；还没有 Store 时 `branches` 直接返回空，不创建任何东西；有 Store 时才连接，操作子分支和 `main`。`LayerfsSession` 只给子 agent 用。

| `minilfs` action | 作用 |
|---|---|
| `branches` | 列出子分支：任务 id、状态（运行中/已结束/已合并）、改动文件数 |
| `diff <id>` | 子分支相对分叉点的改动 |
| `show <id> <path>` / `ls <id> [path]` | 读子分支里的文件或目录 |
| `land <id> [--ours\|--theirs] [--dry-run]` | 三方合并进目录（§3.3） |
| `discard <id>` | 删除子分支 |

用户命令：`/minilfs branches | diff | land | discard`。

### 4.2 子 agent 看到的

read/write/edit/ls/find/grep/bash（作用于分支），加：

| `minilfs` action | 作用 |
|---|---|
| `status` | 我的分支、改动数 |
| `diff` | 我改了什么 |
| `sync` | 把最新主干合进我的分支 |

| `merge <子分支>` | 只在**嵌套**时用：自己派生的孙 agent 的分支合进自己的分支 |

没有 `land`、没有 apply、没有模式切换。嵌套规则：孙 agent 也是子 agent，从 `main` 分叉；它的成果由派它的子 agent `merge` 进自己的分支，最终由主 agent 一次 land。

---

## 5. 各运行环境的接入

### 5.1 Epi

- 已核实（`epi/dist`）：task worker 是独立进程，**默认加载 Manifest 里的第三方扩展**（`worker.js:317` `additionalExtensionPaths`）；子进程的 cwd 就是任务的 cwd；父进程能收到 `task_start` / `task_stop`（`extensions/task.js:424,530,557`）。
- 缺口：Epi **不告诉子进程它是子任务**，也不给 jobId（只设 `PI_CODING_AGENT_DIR`，`task-runtime.js:594`）。
  - 今天：子扩展用会话文件路径判断，`<epiHome>/runtime/task/sessions/<jobId>.jsonl` → 子 agent，jobId 取文件名。这依赖 Epi 的内部路径，**只作为后备**；判断失败时按主 agent 处理（不接管工具），并在状态栏写明，绝不把子 agent 误放到目录里却显示为隔离。
  - Issue（向 Epi 提）：(1) 子进程环境加 `EPI_TASK_JOB_ID`、`EPI_TASK_PARENT_SESSION`；(2) 给扩展一个正式的任务生命周期事件（只读，不经过 hooks 的决策位）。有了 (1) 后优先用它。
- 主 agent：扩展只注册 `minilfs` 工具、`/minilfs` 命令和 `task_stop` 提示；**不注册** read/write/edit/bash 的替身。

### 5.2 Pi（pi-subagents 等）

- 子进程有 `PI_SUBAGENT_CHILD=1` → 子 agent。其余同 Epi。

### 5.3 DSH

- 插件挂载一次，所有 agent 共用（已核实，`child-agent.ts:200`）。按 `exec.agent.id` 分开状态（已修）。
- 主 agent：插件的 read/write/edit/glob/grep/bash 直接作用于目录。原因：DSH 的工具注册是全局的，不能只对子 agent 替换。实现用 `FolderWorkspace`（由现在的 `HostWorkspace` 改来），并修两点：**去掉密钥拦截**（主 agent 有完整权限，和原生工具一致），**补齐插件用到的全部方法**（`access/isDirectory/readdir/mkdir` 等）。
- 主 agent 调 `minilfs` 工具时用 `ProjectTrunk`（§4.1），不能把 `FolderWorkspace` 传给 `executeLayerfsAction`（它要 `session.lfs`，会抛错）。
- 子 agent：工具作用于 `sub-<agentId>` 分支；`minilfs_apply` 删除，换成主 agent 的 `land`。

### 5.4 MCP / CLI

- `minilfs --branch <name> exec|diff|sync`：外部 agent 当子 agent 用。
- `minilfs land <name>`：在目录里执行的人（或主 agent）合并。

---

## 6. 删除、保留、新增

### 6.1 删除

| 删除 | 位置 |
|---|---|
| host mode：`workspace_mode` 工具、`/minilfs mode`、`switchMode`、`MODE_*`、`MINILFS_MODE` | `src/core/mode.ts`、`src/index.ts` |
| host policy：`ask/auto/bypass/never`、`--minilfs-host`、`MINILFS_HOST_POLICY`、`/minilfs policy` | 同上 |
| 过期标记处理：`restartFromMain`、`pendingAlreadyOnHost` | `src/workspace.ts` |
| `minilfs_apply` 换成 `land`；子 agent 的 `apply` 能力 | `src/core/tools.ts` |
| 主会话分支：启动导入、`/tree` `/fork` `/resume` 的文件还原、checkpoint 条目、`resumeLost`、启动阶段显示、`/minilfs retry` 的重启 | `src/index.ts`、`src/workspace.ts` |
| 主 agent 的工具接管（Pi/Epi） | `src/index.ts` |
| `minilfs_apply`、`MINILFS_TEAM`、`lead` 别名、`resolveBranchName` 的别名猜测 | `src/core/tools.ts`、`src/workspace.ts` |
| DSH 补丁里的 mode / policy 部分 | `docs/patches/` |

### 6.2 保留

- 总开关 `MINILFS=0` / `--no-minilfs`：关掉后子 agent 也直接在目录工作（单次调试、超大仓库），不用改 Manifest。
- 分支引擎：Store 直写、按需挂载、Seatbelt、`ps` 替身、按 `.gitignore` 导入、密钥排除与 `!` 放行、导入上限、并发扫描、按目录的初始化锁、路径多种写法。
- 合并：原生 merge + 按路径兜底合并、`--ours/--theirs`、mtime 修正。
- apply 的冲突逻辑（变成 land）。
- DSH 的"每个 agent 一个分支"。

### 6.3 新增

| 新增 | 说明 |
|---|---|
| 角色判断 `resolveRole()` | §2.2 的表，一个函数，各运行环境共用；`MINILFS=0` 时返回 disabled |
| `ProjectTrunk` | 主 agent 的项目级控制器（§4.1），无 Store 时零开销 |
| `resolveBranch()` | 逻辑名 → 物理分支；≥8 位唯一前缀（§2.2） |
| `land` | §3.3；基线是子分支的 `baseRef`（分叉、sync、land 后推进） |
| `task_stop` 提示 | §3.4 |
| `FolderWorkspace`（由 `HostWorkspace` 改名） | 只给 DSH 主 agent 用 |
| Epi issue | `EPI_TASK_JOB_ID`、`EPI_TASK_PARENT_SESSION` |

---

## 7. 迁移

- 现有 Store、分支不删。旧的 `s-*` 会话分支在 `minilfs branches` 里显示为"旧会话分支"，可以 `land` 或 `discard`。
- 主会话以前在分支里没 apply 的改动：升级后第一次启动时提示一次，给出 `minilfs land <旧分支>`。
- 配置项删除后若仍设置（`MINILFS_TEAM`、`MINILFS_MODE` 等），启动时警告一次，不报错。

---

## 8. 测试

| 测试 | 内容 |
|---|---|
| 角色 | 各运行环境的判断表；强制 `MINILFS_ROLE` |
| 主 agent 不受影响 | Epi/Pi 主会话：工具是原生的；启动不创建 Store；`git commit`、`ps`、嵌套沙箱可用 |
| 分叉 | 首个子 agent 才建 Store；分叉前同步目录；分叉点记录正确 |
| 隔离 | 两个子 agent 互相看不到；子 agent 写不到目录；子 agent 不能 land |
| land | 四种三方情况；文本合并；冲突时一个不写；`--ours/--theirs` 和按文件 `resolve`；`--dry-run`；忽略/密钥/`.git` 不写；land 后 main 同步、基线推进；**子 agent `sync` 后再 land，主干期间的改动不被误判**；同一分支两次增量 land；会执行文件的提醒 |
| 名字 | sync 后物理分支换了，`land task-<id>` 仍命中最新；8 位前缀；前缀不唯一报错 |
| 嵌套 | 子 agent 派孙 agent → 子 agent merge 孙分支 → 主 agent 一次 land |
| Epi 钩子 | `task_stop` 监听器不设 `run`、抛错不影响任务收尾 |
| Epi 端到端 | 主 agent 派 2 个 task 改不同文件 → 各自分支 → `task_stop` 提示 → land 两个 → 目录里都有 |
| DSH | 主 agent 在目录；子 agent 在分支；主 agent land |
| 现有 | native-seatbelt、backend、scale 等去掉主会话部分后保留 |

---

## 9. 已决定（r2）

1. **land 冲突**：一个都不写；支持整体 `--ours/--theirs` 和按文件 `resolve`。
2. **分支保留**：land 后保留 7 天，`/minilfs gc` 清理；**未 land 的分支永不自动删除**，只在 `branches` 里标"陈旧"；discard 立即删。
3. **双方都改了的文件**：在 `task_stop` 提示和 `diff` 里预先标出。
4. **子 agent 需要主机能力**：不提权，报告给主 agent（与 DSH 一致；这是删除 host mode 的前提）。

## 10. 评审记录

r1 由 Gemini 4 Argon 评审（结论：有条件通过）。逐条核对源码后全部采纳：

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| 1 | 阻断 | sync 会换物理分支名（`seq++`），删掉解析会让 `land task-<id>` 找不到最新分支 | §2.2 两层名字，保留精确解析 |
| 2 | 阻断 | sync 后基线不推进，land 把主干改动误当子 agent 改动 | §3.2 sync 推进基线；§3.3 land 后推进，支持增量 land |
| 3 | 阻断 | Epi 给模型的是 8 位短 id | §2.2 ≥8 位唯一前缀 |
| 4 | 重要 | DSH `FolderWorkspace` 拦密钥、缺方法；`minilfs` 工具不能传它 | §5.3 |
| 5 | 重要 | 主 agent 没有会话时，`branches/diff/land` 怎么跑没定义 | §4.1 `ProjectTrunk` |
| 6 | 重要 | `task_stop` 设 `run` 会破坏任务收尾 | §3.4 只读观察，提示延后投递 |
| 7 | 重要 | 主 agent 做 git 时同步拍到半状态；子 agent 在分支里做 git | §3.1 等 `index.lock`；§3.2 不做版本操作 |
| 8 | 重要 | 嵌套子 agent 无法汇总 | §4.2 子 agent 保留 `merge`；§3.2 嵌套规则 |
| 9 | 重要 | 主 agent 不在沙箱，子 agent 的构建脚本 land 后会以主机权限运行 | §3.3 会执行文件的提醒 |
| 10 | 次要 | 删掉 `MINILFS=0` 太激进 | §6.2 保留总开关 |
