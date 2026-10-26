# minilfs v0.5 设计：人人在分支，主 agent 可单条提权

状态：**草案 r4**（已按 Argon r3 评审修订，见 §9），实现前。r1/r2 的方向（"目录即主干"）已放弃，原因见 §1.3。
替代：v0.4 的 host mode / host policy（本轮加入，未正式发布）
参考：LayerFS × DSH（`layerfs/dsh/`）、DSH bash 工具的单条提权（`deepseek-harness/packages/shell/tool-bash/src/index.ts:478-483`）、`docs/EPI-INTEGRATION.md` 第 3 阶段

---

## 0. 一句话

**每个 agent 都在自己的 LayerFS 分支上工作，主 agent 也不例外；主 agent 的任意一条 `bash` 可以提权到真实机器上执行，默认不需要确认；子 agent 永不提权；改动通过 apply 回到项目目录。**

没有模式。提权是**某一条命令**的属性，不是会话的状态。

---

## 1. 为什么这样设计

### 1.1 主 agent 留在分支里的收益

| 收益 | 说明 |
|---|---|
| 每次工具调用一个存档点 | `/tree`、`/fork`、`/resume` 能连文件一起回退，比 git 细 |
| 先审再写 | 目录只在 apply 时改变，`/minilfs diff` 可随时看 |
| 整合在 LayerFS 里完成 | 主 agent 用原生 merge 合并子 agent 分支，有历史；与 LayerFS × DSH 一致（"Every agent gets its own Branch"） |
| 主 agent 的 bash 默认也有沙箱 | 防误操作的围栏；需要时再单条提权。**在默认 `auto` 下它不是安全边界**（§3.4） |

### 1.2 主 agent 留在分支里的代价，以及怎么解决

| 代价 | 解决 |
|---|---|
| 首次导入慢、`/resume` 卡住 | 已修：按 `.gitignore` 导入、超限预检、按目录加锁、并发扫描（本轮已合入） |
| 沙箱里做不了的事：`git commit/push`、Docker、挂载、`ps`、测试 minilfs 自己 | **单条提权**（§3） |
| 目录和分支两份内容 | 提权那一步自动收敛（§3.2）；其余时候靠 apply |

### 1.3 放弃过的方案

| 方案 | 为什么放弃 |
|---|---|
| host mode（本轮实现过） | 是**模式**：要存状态、resume 恢复、切换前后做一致性检查，还出了"未 apply 标记过期"的问题。复杂度来自模式本身 |
| r1/r2"目录即主干，主 agent 不进 minilfs" | 丢掉存档点、先审再写、LayerFS 内整合这三样，只换来"主 agent 有完整权限"；而单条提权能给出同样的权限 |

### 1.4 用户习惯

用户很少手动操作，习惯给主 agent 最高权限。所以**提权默认自动**（策略 `auto`），不弹确认；需要更严格时再改策略。

---

## 2. 角色

| 角色 | 工作在哪里 | 文件工具 | bash | 回到目录 |
|---|---|---|---|---|
| **主 agent**（顶层会话） | 自己的分支 | 分支 | 默认分支沙箱；可单条提权到目录 | `minilfs_apply`；提权时自动 apply |
| **子 agent**（Epi task、Pi subagent、DSH subagent） | `task-<jobId>` / `sub-<id>` 分支 | 分支 | 只在分支沙箱 | 不能；由主 agent merge |
| **外部 agent**（MCP/CLI，`--branch`） | 指定分支 | 分支 | 只在分支沙箱 | 不能 |
| **用户** | — | — | `!cmd` 按提权执行（用户就是最高权限） | 同主 agent |

角色由运行环境在启动时决定，之后不变（§5）。

---

## 3. 单条提权

### 3.1 怎么用

主 agent 的 `bash` 工具多两个参数：

```
bash { command: "git commit -am 'x' && git push", elevated: true, reason: "commit and push the applied work" }
```

- `elevated: true`：这一条命令在真实项目目录执行，**不套 minilfs 沙箱**，用主机的环境、PATH、权限。执行器复用运行环境自己的 bash 实现（Pi：`createBashTool(hostCwd)`，带进程树回收、输出截断、timeout；DSH：宿主 shell），不用 `HostWorkspace.exec` 这种简化版。
- `reason`：**`elevated: true` 时必填**（与 DSH `validateEscalationArgs` 一致），任何策略下都要填；记进存档点和状态栏，`ask` 下显示在确认框里。
- 文件工具（read/write/edit/ls/find/grep）**永远在分支里**，不需要提权。

工具说明和系统提示写明什么时候该提权：沙箱拦截（`Operation not permitted`）、需要写 `.git`（commit/push/checkout）、Docker、挂载、setuid 工具、要一直运行的服务、测试 minilfs 自己。沙箱拦截时，minilfs 在输出末尾补一行：`[minilfs] 被沙箱拦截；如需在真实目录执行，用 elevated: true 重试`。

### 3.2 一次提权调用做什么

| 步 | 动作 | 持有的锁 | 失败时 |
|---|---|---|---|
| 1 | **收敛**：分支上有未 apply 的改动，先三方 apply 进目录（现有 `applyLocked`：TOCTOU 检查；密钥、忽略、branch-only、`.git` 不写） | 会话锁 + 项目锁（apply 内部短暂持有） | 冲突或 WouldRevert：本次提权失败，列出原因，**不执行命令** |
| 2 | **执行**：在目录里跑命令 | **只有会话锁**；项目锁释放，子 agent 可以照常 sync、新任务可以分叉 | 非零退出、abort、timeout：照常返回，**第 3 步仍执行**（进程树回收完之后），因为命令可能已改了目录 |
| 3 | **同步回来**：(a) 目录同步进 `main`；(b) `baseBranch` 重新从新 `main` 分叉（`baseRef` 前移）；(c) 把新 `main` **合并进当前工作分支**，`main` 一侧优先（目录是刚执行完命令的权威结果）；(d) 在工作分支上产生一个 commit，记存档点 `host: <reason>` | 会话锁 + 项目锁（sync 内部短暂持有） | 同步超限或失败：标记 `mainStale`，提示原因；分支保持第 1 步后的状态 |

为什么第 3 步是"合并进当前分支"而不是"从 main 重开分支"：apply 和 sync 都跳过 branch-only/忽略路径，分支里的构建产物（如 `dist/`、`target/`）只存在于分支；从 main 重开会丢掉它们，而且不产生 commit，`/tree` 无处定位。合并保留它们，并给 `/tree` 一个真实节点。

**锁的粒度**：会话锁（`this.mutex`）包住三步，保证同一会话的工具调用不交错；内部调用不加锁的私有方法（`applyLocked`、sync 的内部版本），避免不可重入的互斥锁自死锁。跨进程的项目锁**绝不包住第 2 步**：长命令（`docker build`、测试、dev server）期间若持有项目锁，子 agent 的 `sync` 会在 60 秒后超时。

**第 3 步的体积上限**：现在的 `syncHostDriftIntoMain` 没有大小检查，提权命令若在目录里生成大量未忽略文件（解压数据集、`git checkout` 到别的分支）会把它们全部读进内存。第 3 步对新增/修改文件套用与首次导入相同的上限（`MINILFS_MAX_IMPORT_*`）；超限时不写 Store、标记 `mainStale`，提示把目录加进 `.gitignore` 或 `.minilfsignore`。

结果：提权调用正常结束时，**分支的已跟踪内容 = 目录 = main**，分支独有的产物保留，没有"未 apply"残留。

说明：
- 第 1 步的 apply 在 `auto` 下不再单独询问。这意味着在 `auto` 下"先审再写"只在两次提权之间成立；存档点和 `/tree` 仍然可用。
- `/tree` 回到某次提权之前：分支可以回去，但提权命令对目录造成的影响（commit、push、安装的东西）回不去。之后若再 apply，`baseBranch` 已包含提权命令的改动（比如 lockfile），回退后的快照不含它们，会触发 WouldRevert，需要 `--revert` 才写目录。这是正确的保护：继续 apply 会把提权命令的结果撤掉。提示里要说清楚原因。
- 子 agent 运行期间主 agent 提权：第 3 步更新 `main`，子 agent 下次 `sync` 拿到。

### 3.3 策略

| 策略 | 行为 |
|---|---|
| `auto`（**默认**） | 主 agent 自己决定何时提权，不确认 |
| `ask` | 每次提权弹确认框（列出命令、理由、第 1 步要写的文件）；可选"本会话总是允许以 `<前缀>` 开头的命令"；无界面时拒绝 |
| `never` | 不能提权；遇到沙箱拦截就停下告诉用户 |

- 设置：启动参数 `--minilfs-elevate <策略>`、环境变量 `MINILFS_ELEVATE`、运行中 `/minilfs elevate <策略>`；存进对话，resume 恢复。
- `MINILFS_ELEVATE_ALLOW="git *,docker *"`：`ask` 下匹配的命令直接通过。
- **子 agent 永不提权**，与 DSH 一致（"children inherit the parent's sandbox mode and cannot ask for approval"）：
  - Pi/Epi：每个进程按 `resolveRole()` 注册自己的 `bash`。主 agent 的 schema 在 Pi 的 `bashSchema`（只有 `command`、`timeout`）上扩展 `elevated`、`reason`；子 agent 用原 schema，看不到这两个参数。
  - DSH：工具 schema 全局共享（插件只注册一次），做不到对子 agent 隐藏。参数说明里写"仅主 agent 可用"，`execute` 里按 `isChildAgent(exec)` 拒绝。
  - 两处都在 `execute` 里再校验一次：子 agent 传了 `elevated` 就拒绝，并提示"把需要主机执行的步骤写进结果，交给主 agent"。
- 用户的 `!cmd`：按提权执行（走 §3.2 同样三步），不受策略限制。

### 3.4 安全边界（诚实说明）

- 默认 `auto` 下，主 agent 的沙箱是**防误操作的围栏，不是安全边界**。被提示注入的主 agent（读了恶意 issue、网页、第三方仓库文件）可以一条 `elevated` 命令读取 `~/.ssh`、发出网络请求、写 `.git/hooks`，不会有确认。这与用户"给主 agent 最高权限"的选择一致，必须写进 README。
- 要防提示注入：用 `ask`（配合前缀白名单减少打扰）或 `never`。
- 子 agent 不受影响：它们永不提权，沙箱对它们是真正的边界（宿主目录只写拒绝、minilfs 状态目录不可读、密钥不可读）。
- 子 agent 的代码进入主机的唯一路径是"主 agent merge → apply → 运行"。merge 结果里若有会被执行的文件（`package.json`、`Makefile`、`*.sh`、`build.rs`、CI 配置、`.husky/`、`.epi/`），附一行提醒。

---

## 4. 子 agent

（r2 经评审定下的内容，保留）

### 4.1 分支与名字

| 层 | 例子 | 说明 |
|---|---|---|
| 逻辑名（对外，稳定） | `task-<jobId>` | 主 agent、提示、merge 都用它；主 agent 派任务时就知道 |
| 物理分支（对内，会换） | `task-<jobId 前 8 位>-<seq>` | LayerFS merge 只能写新分支，子 agent 每次 `sync` 会换（`workspace.ts` 中 `seq++`） |

`resolveBranch(name)`：逻辑名 → 当前物理分支；任务 id 接受完整 id 或 **≥8 位唯一前缀**（与 Epi `findJobId` 一致，`epi/dist/task-runtime.js:296-302`）；不唯一时报错并列出候选。

### 4.2 生命周期

1. **分叉**：先把目录同步进 `main`（目录有 `.git/index.lock` 时最多等 10 秒），再从 `main` 分叉；基线 `baseRef` = 分叉时的 main。
2. **工作**：每次 write/edit/bash 一个 Commit。`sync` 把最新 `main` 合进来，**成功后基线前移**。不做版本操作（提示词写明不 `git commit/checkout/reset`）；需要主机能力就停下报告。
3. **嵌套**：孙 agent 也从 `main` 分叉；派它的子 agent 用 `merge` 合进自己的分支。
4. **整合**：主 agent 用 `minilfs merge task-<id>`（LayerFS 原生 merge，失败时按路径兜底，`--ours/--theirs`、按文件 `resolve`）合进自己的分支，再 apply（或在下一次提权时自动 apply）。
5. **清理**：merge 后保留 7 天，`/minilfs gc` 清理；未 merge 的分支永不自动删除，只在 `branches` 里标"陈旧"；`discard` 立即删除。

### 4.3 任务结束提示（Epi）

- 只读观察 `task_stop`（`pi.events` 频道 `epi/hooks/task/v1`）：**绝不设置 `request.run`**（`hook-events.js:2-8`，返回非 `continue` 会让任务收尾抛错，`extensions/task.js:424-427`），try/catch 包裹，只记 jobId。
- 主 agent 下一次 `before_agent_start` 时附上"已结束、有改动、未 merge 的子分支"；界面上 `notify` 一次。
- 提示内容：`task <短id> 改了 N 个文件（其中 x.ts 你的分支也改过）；minilfs diff <短id> 查看，minilfs merge <短id> 合并`。
- 不自动 merge。

---

## 5. 运行环境接入

### 5.1 角色判断 `resolveRole()`

| 运行环境 | 子 agent 的判断 | 分支逻辑名 |
|---|---|---|
| Epi task | 后备：会话文件在 `<epiHome>/runtime/task/sessions/<jobId>.jsonl`；Epi 支持后改用 `EPI_TASK_JOB_ID` | `task-<jobId>` |
| Pi + pi-subagents | `PI_SUBAGENT_CHILD=1` | `sub-<sessionId 前 8 位>` |
| DSH | `exec.agent.session.header.origin === "subagent"`（或 `parentSession`、`delegationDepth > 0`） | `sub-<agentId 前 8 位>` |
| MCP / CLI | `--branch <名字>` | 给定 |
| 强制 | `MINILFS_ROLE=lead\|worker` | — |
| 关闭 | `MINILFS=0` / `--no-minilfs`：所有 agent 直接在目录工作 | — |

默认是**主 agent**：顶层会话没有任何子 agent 线索，必须能 apply 和提权。只有**发现了子 agent 线索但解析不出任务 id**（例如会话文件在 Epi 的 `runtime/` 下但不在已知的 `task/sessions/` 位置）时，才按子 agent 处理，并在状态栏写明。

### 5.2 Epi

- 已核实：task worker 默认加载 Manifest 的第三方扩展（`worker.js:317`），cwd 就是任务 cwd，父进程有 `task_start/task_stop`。
- 给 Epi 提 issue：(1) 子进程加 `EPI_TASK_JOB_ID`、`EPI_TASK_PARENT_SESSION`；(2) 给扩展一个正式的只读任务生命周期事件。

### 5.3 DSH

- 插件挂载一次，所有 agent 共用，按 `exec.agent.id` 分开会话（已修）。
- 主 agent 的 `bash` 有 `elevated` 参数；`ask` 走 DSH 的审批服务 `ctx.approval.request(...)`，无应答时拒绝（与 DSH 自己的 bash 提权同一机制）。
- 子 agent：`elevated` 拒绝；`minilfs_apply` 拒绝（已修）。

---

## 6. 删除、保留、新增

### 6.1 删除

| 删除 | 位置 |
|---|---|
| `workspace_mode` 工具、`/minilfs mode`、模式状态（`MODE_ENTRY` 的 mode 字段）、`switchMode`、`initialMode`、`MINILFS_MODE` | `src/core/mode.ts`、`src/index.ts` |
| `HostWorkspace` 的文件操作（只保留主机执行，给提权和 DSH 用） | `src/core/host.ts` |
| host policy 的 `bypass` 档（单条提权下等同 `auto`）；名字改为 elevate | 同上 |
| `MINILFS_TEAM` 开关：主 agent 总有 `minilfs` 和 `minilfs_apply`，子 agent 总有 `minilfs`（无 apply） | `src/index.ts` |
| `resolveBranchName` 的模糊猜测（保留精确解析，§4.1） | `src/workspace.ts` |
| DSH 补丁里的 `workspace_mode` 部分 | `docs/patches/` |

### 6.2 保留

- 分支引擎全部：Store 直写、按需挂载、Seatbelt、`ps` 替身、按 `.gitignore` 导入、密钥排除与 `!` 放行、导入上限、并发扫描、按目录加锁、路径多种写法。
- 存档点、`/tree` `/fork` `/resume` 文件回退、apply、merge 及兜底。
- `pendingAlreadyOnHost`（过期标记检测）。`restartFromMain` 删除：第 3 步改为合并进当前分支（§3.2）。
- 策略机制（改名 elevate，三档）。

### 6.3 新增

| 新增 | 说明 |
|---|---|
| `bash` 的 `elevated` / `reason` 参数与 §3.2 三步流程 | 核心 |
| 沙箱拦截提示 | §3.1 |
| `resolveRole()`、`resolveBranch()` | §5.1、§4.1 |
| 子分支基线前移、嵌套 merge、`gc` | §4.2 |
| Epi `task_stop` 只读观察与延后提示 | §4.3 |

---

## 7. 测试

| 测试 | 内容 |
|---|---|
| 提权 | 有未 apply 改动 → 先 apply 再执行 → 结束后已跟踪内容分支=目录=main；apply 冲突或 WouldRevert 时不执行；非零退出、abort、timeout 后仍同步；**分支里的 branch-only 产物（`dist/`）提权后仍在**；提权后产生 `host:` 存档点且 `/tree` 能定位；`reason` 缺失时拒绝 |
| 锁 | 提权命令运行 90 秒期间，子 agent 的 `sync` 成功（项目锁未被占用）；同会话的第二个工具调用排队 |
| 体积 | 提权命令生成超限的未忽略文件 → 第 3 步不写 Store、标记 `mainStale`、提示 |
| 提权能力 | 提权命令里 `git commit`、写 `.git`、`/bin/ps`、嵌套 `sandbox-exec`、挂载可用 |
| 策略 | `auto` 不问；`ask` 确认/拒绝/无界面/前缀白名单；`never` 拒绝；子 agent 永远拒绝；用户 `!cmd` 不受策略限制 |
| 角色 | 顶层会话无线索 → 主 agent；Epi 会话路径在 `task/sessions/` → 子 agent；有线索但无法解析 → 子 agent |
| schema | Pi/Epi 主 agent 的 bash 有 `elevated`/`reason`，子 agent 没有；DSH 共享 schema、子 agent 调用被拒 |
| 沙箱拦截提示 | 输出含 `Operation not permitted` 时补提示 |
| 子 agent | 名字两层、8 位前缀、sync 后基线前移、嵌套 merge、主 agent merge 后 apply |
| Epi | 主 agent 派 2 个 task → `task_stop` 提示 → merge → apply；监听器不设 `run` |
| 回归 | 现有 native-seatbelt、backend、review-fixes、pi、cli、rpc、scale 去掉 mode 相关后保留 |

---

## 8. 已决定（r4）

1. **提权前的 apply 在 `auto` 下不问**：接受；冲突或 WouldRevert 时中止，不执行命令（Argon r3 同意）。
2. **提权命令的改动**（lockfile、`npm install` 等）：第 3 步同步进 main 并合并进分支；受体积上限保护（§3.2）。

---

## 9. 评审记录

| 轮 | 评审 | 结论 | 处理 |
|---|---|---|---|
| r1 | Gemini 4 Argon | 有条件通过，10 条 | r2 全部采纳。其中子 agent 相关的（两层名字、8 位前缀、基线前移、嵌套 merge、`task_stop` 只读、`MINILFS=0` 保留）在 r3 继续有效；`ProjectTrunk`、`FolderWorkspace`、land 进目录三条随方向改变而不再需要 |
| r3 | Gemini 4 Argon | 有条件通过，6 条（2 阻断） | r4 全部采纳，逐条核对源码确认：(1) 阻断：`restartFromMain` 丢 branch-only 产物且无 commit → 第 3 步改为合并进当前分支并产生 `host:` 存档点；(2) 阻断：锁粒度 → 会话锁包三步、项目锁不包命令执行、abort 后仍同步；(3) Pi 按角色注册 bash schema，DSH 共享 schema 靠 execute 拒绝；(4) `auto` 不是安全边界，写明；`reason` 必填；复用运行环境的 bash 执行器；(5) 角色默认主 agent，有线索无法解析才按子 agent；(6) 第 3 步加体积上限 |
| r4 | 待用户确认 | — | — |
