// Harness-Agnostic LayerFS Core Engine
// Zero dependencies on @earendil-works/pi-coding-agent so any agent harness
// (Pi, Epi, Claude Code, Codex, Cursor, DSH, MCP servers, CLI) can use it directly.

export {
  assertInsideWorkspace,
  expandBraces,
  isExcludedPath,
  isOutsideSecret,
  LayerfsError,
  LayerfsSession,
  LWW_DEFAULT,
  matchesToolGlob,
  rsyncExcludeArgs,
  stopNativeDaemons,
  type ApplyResult,
  type Checkpoint,
  type MergeOptions,
  type MergeResult,
  type OpenOptions,
  type UserBranch,
  type Workspace,
} from "../workspace.ts";

export {
  allocateRescueRef,
  decideGitPath,
  expectedType,
  gitChangeSummary,
  gitPathKind,
  isValidGitRefName,
  resolveGitPath,
  scanGitLayout,
  type GitLayout,
  type RescueAllocation,
  type ResolvedGitPath,
  gitSig,
  indexEntries,
  parseIndexEntries,
  isProtectedPath,
  MERGE_UNITS,
  type GitPathKind,
  type IndexEntry,
} from "../gitpaths.ts";

export {
  DEFAULT_EXCLUDES,
  resolveConfig,
  type LayerfsConfig,
} from "../config.ts";

export {
  BindingStore,
  nameFromFolder,
  type HostEntry,
  type HostIndex,
  type ProjectRecord,
  type SessionBinding,
} from "../bindings.ts";

export {
  formatHistory,
  hiddenPath,
  loadHistory,
  parseMessage,
  type HistoryFile,
  type HistoryRow,
  type HistoryView,
} from "../history.ts";

export {
  bothSpellings,
  buildSeatbeltProfile,
  globToSbplRegex,
  type SeatbeltOptions,
} from "../seatbelt.ts";

export {
  acquireLock,
  acquireLockSync,
  type LockHandle,
} from "../lock.ts";

export {
  createProjectClient,
  ensureNativeDirs,
  initProjectClient,
  layerfsEnv,
  loadSdk,
  storePathOf,
  type NativeSpec,
  type ProjectClient,
} from "./client.ts";

export {
  buildNativeShellPrelude,
  LocalNativeDriver,
  registerExecutionDriver,
  resolveExecutionDriver,
  type DriverExecContext,
  type DriverExecOptions,
  type ExecutionDriver,
} from "./driver.ts";

export {
  run,
  type RunResult,
} from "./exec-helper.ts";

export {
  cleanRelPath,
  createHarnessOperations,
  executeLayerfsAction,
  executeLayerfsApply,
  LAYERFS_APPLY_TOOL_DESCRIPTION,
  LAYERFS_APPLY_TOOL_SCHEMA,
  LAYERFS_TOOL_DESCRIPTION,
  LAYERFS_TOOL_SCHEMA,
  ONLY_LEAD,
  type LayerfsActionHooks,
  type LayerfsActionParams,
} from "./tools.ts";

export {
  resolveRole,
  type Role,
  type RoleInfo,
} from "./role.ts";

export { IgnoreRules } from "../ignore.ts";

