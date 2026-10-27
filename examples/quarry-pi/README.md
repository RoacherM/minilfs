# quarry-minilfs-test：Quarry on Pi + Native `minilfs`（LayerFS v1.1.0，纯沙箱）

用 Quarry 多 Agent SQL 数据库构建实验，在 **Pi + `pi-subagents` + 本地 `minilfs` checkout** 上做端到端测试。
`SPEC.md`、`HANDOFF.md`、`AGENTS.md`、`scripts/env.sh` 与 DSH 版（`layerfs-dsh-test-2`，`4b37305`）一致，
只改了"怎么启动 worker"（Pi：`subagent({ agent, task, async: true })` + `bg_wait`）和 Pi 的工具名；
另外（2026-10-27 那轮的教训）每个 agent 用自己的 `CARGO_TARGET_DIR`（APFS 克隆共享 seed），lead 每次 apply 后 `seed_target`。

## 生成测试目录（一次）

```bash
~/Projects/sides/minilfs/examples/quarry-pi/new.sh --bundle-from /private/tmp/minilfs-bundle-v110
# 默认生成 ~/Projects/sides/quarry-minilfs-test：拷模板、git init + 一个 setup commit（同 DSH 版）、拷 bundle、预检
# 另一个目录：new.sh ~/Projects/sides/quarry-minilfs-test-2 --bundle-from ...
```

## 启动

在**普通终端**里（不要在 agent 的 bash 里，minilfs 要挂 NFS）：

```bash
cd ~/Projects/sides/quarry-minilfs-test
scripts/run.sh --check                                                 # 预检（bundle、minilfs、rustc、pi-subagents、NFS）
scripts/run.sh                                                         # 交互式，HANDOFF.md 作为第一条消息
scripts/run.sh -p                                                      # 无人值守，日志在 runs/<时间>/lead.log
QUARRY_MODEL=magpie/grok/grok-4.7:high scripts/run.sh                  # 换模型
```

## 与日常环境隔离

| 项 | 本实验 | 日常 |
| --- | --- | --- |
| Pi agent 目录 | `.quarry-agent/`（`PI_CODING_AGENT_DIR`） | `~/.pi/agent`、`~/.epi` |
| minilfs 代码 | `QUARRY_MINILFS_SRC`（默认 `~/Projects/sides/minilfs`） | epi.json 里的 GitHub 版 |
| minilfs 状态 / Store / 挂载 / cargo 缓存 | `~/.cache/minilfs-quarry` | `~/.cache/minilfs` |
| daemon / Sandbox 名 | `minilfs-q-…` | `minilfs-…` |
| bundle | `~/.cache/minilfs-quarry/bundle-<commit7>` | `~/.cache/minilfs/bundle-native` |

## 观察与清理

```bash
node scripts/metrics.mjs                 # tokens、工具调用、merge/conflict/apply 次数
cat runs/<时间>/setup.txt                 # 本轮用的模型、minilfs 版本、LayerFS commit
git log --oneline --all                  # 沙箱里 agent 的 git commit 经 apply 回到这里
scripts/run.sh --clean                   # 停 daemon、卸载、清状态（保留 bundle），目录回到初始 commit
```

## 这轮重点看（新 minilfs 的改动）

- `.git` 在分支里：worker 的 `git commit` 能否正常；lead `merge` 两个都 commit 过的分支后，结果里有 `Git:` 一行，`git fsck` 干净。
- `minilfs_apply` 后在本目录 `git log` / `git status` / `git fsck` 正常；`.git/config`、`.git/hooks` 没被改。
- `node_modules`/`target` 不会进 Store（cargo 产物在 `~/.cache/minilfs-quarry/scratch/...`）。
- 遇到问题：记下 `runs/<时间>/`、`PROGRESS.md` 的轮次和工具输出，以及
  `pgrep -fl "layerfs-daemon --config $HOME/.cache/minilfs-quarry"`、`mount | grep minilfs-quarry`。
