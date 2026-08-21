# Code Context

针对已核验的 `@earendil-works/pi-coding-agent` 0.84.2（`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json:1-6`），以下均来自已安装 dist 的 `.d.ts` 与 `.js`；本次没有修改项目源文件。

## Files Retrieved
1. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:1-22` - 公共导出；确认 `SessionManager`、`SessionEntry`、`SessionHeader`、`SessionInfo`、`ExtensionAPI` 等从包根可导入。
2. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:4-16,17-140` - session header、所有 `SessionEntry` 变体、`SessionInfo`、只读 manager 类型。
3. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:184-355` - `SessionManager` 的构造可见性、实例方法、静态工厂/列表 API；明确 append-only 与无 delete/rename。
4. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:238-252,395-407` - 默认 workspace/session 目录编码、最近 session 的 `.jsonl` 扫描和 cwd 过滤。
5. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:584-724` - JS 实际内部构造参数、cwd/sessionDir 归一化、session filename 生成和 getter。
6. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1171-1305` - 静态工厂、open/continue/fork/list/listAll 的实际归属逻辑和 fork 文件命名。
7. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:210-285,820-867` - `ExtensionContext`/`ExtensionCommandContext` 的 session manager 类型和命令上下文。
8. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:867-961` - `ExtensionAPI`、`RegisteredCommand`、`registerCommand`/`getCommands`/session 写入辅助 API。
9. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:202-240,295-308` - `registerCommand` 写入 extension command registry；`getCommands` 委托 runtime。
10. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:402-444,460-568` - 命令解析为 slash invocation name，以及 context getter 返回 session manager、命令上下文控制方法。
11. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.d.ts:1-58`、`dist/cli/args.js:228-251` - CLI 参数形状及帮助中全部顶层命令；没有 `sessions`。
12. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js:448-475` - auth/package/config 子命令先于普通 `parseArgs` 处理；扩展命令没有顶层 CLI dispatch 接口。
13. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:10-55` - SDK 可注入 `sessionManager?: SessionManager`，默认 `SessionManager.create(cwd)`。
14. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/commands.ts:13-32` - 官方示例展示注册 slash command 的精确用法和 handler context。
15. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/11-sessions.ts:7-52` - 官方示例展示 `inMemory/create/continueRecent/list/open` 调用。

## Key Code

### 1. 公共 API 与数据结构

`dist/index.d.ts:19` 将这些符号从 `@earendil-works/pi-coding-agent` 根导出：`SessionManager`、`SessionEntry`、`SessionHeader`、`SessionInfo`、`SessionEntryBase`、各 entry 类型、`NewSessionOptions`、`SessionTreeNode` 等（其中 `getDefaultSessionDir` 等底层 helper 未在该行根导出，直接底层路径可见）。

`dist/core/session-manager.d.ts:5-12`：
```ts
interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}
```
当前常量 `CURRENT_SESSION_VERSION = 3`（line 4）。`parentSession` 是 fork 源 session 文件路径，而不是 session ID。

`dist/core/session-manager.d.ts:17-22` 的公共 entry 基类字段：`type: string`, `id: string`, `parentId: string | null`, `timestamp: string`。

`SessionEntry` 联合类型（lines 23-105）由以下精确变体构成：
- `SessionMessageEntry`: `type: "message"`, `message: AgentMessage`。
- `ThinkingLevelChangeEntry`: `type: "thinking_level_change"`, `thinkingLevel: string`。
- `ModelChangeEntry`: `type: "model_change"`, `provider: string`, `modelId: string`。
- `CompactionEntry<T>`: `summary`, `firstKeptEntryId`, `tokensBefore`, 可选 `details`, `usage`, `fromHook`。
- `BranchSummaryEntry<T>`: `fromId`, `summary`，可选 `details`, `usage`, `fromHook`。
- `CustomEntry<T>`: `type: "custom"`, `customType`, 可选 `data`；不进入 LLM context。
- `CustomMessageEntry<T>`: `type: "custom_message"`, `customType`, `content`, `details?`, `display`；进入 LLM context。
- `LabelEntry`: `targetId`, `label: string | undefined`。
- `SessionInfoEntry`: `name?: string`（用来显示 session name）。

`SessionInfo`（lines 125-138）字段精确为：`path`, `id`, `cwd`, `name?`, `parentSessionPath?`, `created: Date`, `modified: Date`, `messageCount`, `firstMessage`, `allMessagesText`。旧 session 没有 cwd 时，`cwd` 返回空字符串。

### 2. SessionManager 构造参数与实例方法

`.d.ts:184-200` 声明 `private constructor()`：**外部不能 `new SessionManager(...)`**，只能使用静态工厂。JS 内部实际 constructor 是六参数（`.js:596-608`）：
```ts
constructor(
  cwd,
  sessionDir,
  sessionFile,
  persist,
  newSessionOptions,
  preloadedFileEntries,
)
```
其中 `cwd` 会 `resolvePath`，`sessionDir` 会 `normalizePath`，`persist` 决定是否落盘；该六参数不是公共可调用签名。

实例公共方法（`.d.ts:197-312`）：
- `setSessionFile(sessionFile: string): void`；`newSession(options?: NewSessionOptions): string | undefined`。
- `isPersisted(): boolean`；`getCwd(): string`；`getSessionDir(): string`；`usesDefaultSessionDir(): boolean`；`getSessionId(): string`；`getSessionFile(): string | undefined`。
- append：`appendMessage(message: Message | CustomMessage | BashExecutionMessage): string`、`appendThinkingLevelChange(thinkingLevel: string): string`、`appendModelChange(provider: string, modelId: string): string`、`appendCompaction<T>(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, usage?): string`、`appendCustomEntry(customType, data?): string`、`appendSessionInfo(name: string): string`、`appendCustomMessageEntry<T>(customType, content, display, details?): string`、`appendLabelChange(targetId, label): string`。
- 查询/上下文：`getSessionName(): string | undefined`、`getLeafId(): string | null`、`getLeafEntry(): SessionEntry | undefined`、`getEntry(id): SessionEntry | undefined`、`getChildren(parentId): SessionEntry[]`、`getLabel(id): string | undefined`、`getBranch(fromId?): SessionEntry[]`、`buildContextEntries(): SessionEntry[]`、`buildSessionContext(): SessionContext`、`getHeader(): SessionHeader | null`、`getEntries(): SessionEntry[]`、`getTree(): SessionTreeNode[]`。
- 分支：`branch(branchFromId): void`、`resetLeaf(): void`、`branchWithSummary(branchFromId: string | null, summary, details?, fromHook?, usage?): string`、`createBranchedSession(leafId): string | undefined`。

**没有公开 `rename`、`delete`、`remove`、`unlink` session API。** `.d.ts:277-280` 直接写明 session 是 append-only，entries “cannot be modified or deleted”；`.js:975-981` 同样如此。现有 `appendSessionInfo(name)` 是追加 metadata entry，不是文件/session rename；`branch` 也不会删除历史（`.d.ts:289-294`）。若要删物理 `.jsonl`，只能自行文件系统操作（不属于本 API）。

静态工厂/列表（`.d.ts:314-355`）：
```ts
SessionManager.create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager
SessionManager.open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager
SessionManager.continueRecent(cwd: string, sessionDir?: string): SessionManager
SessionManager.inMemory(cwd?: string, options?: NewSessionOptions): SessionManager
SessionManager.forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager
SessionManager.list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>
SessionManager.listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>
SessionManager.listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>
```
`listAll` 的 `.d.ts` 是两个 overload；JS 实现用 `typeof` 区分 string/function（`.js:1289-1295`）。

### 3. session 文件名、workspace/cwd 归属

默认目录实现位于 `.js:242-246`：先 resolve cwd 和 agentDir，再生成：
```ts
safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-" )}--`;
join(resolvedAgentDir, "sessions", safePath)
```
因此默认是 `~/.pi/agent/sessions/--<absolute-cwd-with-slash-backslash-colon-as-dash>--/`（实际 agentDir 可由配置/env 改写）。`getDefaultSessionDir()` 会在不存在时 mkdir（`.js:248-253`）。

新文件由 `.js:645-669` 生成：header 的 ISO timestamp 中 `:` 和 `.` 替换成 `-`，文件名精确为：
```text
<timestamp-with-colons-and-dots-replaced>_<sessionId>.jsonl
```
header 写入 `version: 3`, `id`, `timestamp`, `cwd: this.cwd`，以及可选 `parentSession`（`.js:651-658`）。`forkFrom` 同样用 `<timestamp>_<newSessionId>.jsonl`，但 header 的 `cwd` 是 resolved targetCwd、`parentSession` 是 source path，并复制源非-header entries（`.js:1249-1273`）。

归属规则：
- `SessionManager.create(cwd, sessionDir?)`：header cwd 是 resolved cwd；默认 sessionDir 是 cwd 编码目录（`.js:1176-1178`）。
- `open(path, sessionDir?, cwdOverride?)`：没有 override 时从 header.cwd 取得 cwd；没有 sessionDir 时从 session 文件父目录推导；有 override 时强制使用 override（`.js:1186-1207`）。
- `continueRecent(cwd, sessionDir?)`：先在给定/默认目录找 mtime 最新合法 `.jsonl`；只有显式 custom sessionDir 且它不是 cwd 的默认编码目录时，才额外按 header cwd 匹配（`.js:1214-1221`、`.js:395-407`）。
- `list(cwd, sessionDir?)`：默认目录直接列该 cwd 编码目录；显式 custom directory 且不等于 cwd 默认目录时，按 `resolvePath(session.cwd) === resolvePath(cwd)` 过滤（`.js:1281-1287`）。返回按 `modified` 降序。
- `listAll()`：扫描 `getSessionsDir()` 下的项目 session 子目录；`listAll(customDir)` 只扫给定目录，不做 cwd 过滤（`.js:1289-1305`）。
- `SessionInfo` 是从首个合法 session header 和 entries 扫描得到；name 取最后一个 `session_info` entry，parent path 来自 header.parentSession（`.js:430-500`，尤其 `.js:477-500`）。

### 4. ExtensionAPI slash command 签名及 session manager 访问

`RegisteredCommand`（`types.d.ts:846-860`）为：
```ts
interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?:
    (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
```
注册的精确签名是 `ExtensionAPI.registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void`（`types.d.ts:901-905`）。所以扩展写法：
```ts
pi.registerCommand("sessions", {
  description: "...",
  getArgumentCompletions: (argumentPrefix) => /* ... */,
  handler: async (args, ctx) => { /* ... */ },
});
```
这注册的是 slash command，调用形式是 `/sessions`，不是 `pi sessions` 顶层 argv 子命令。官方示例同样在 `examples/extensions/commands.ts:15-25` 使用 `pi.registerCommand("commands", { ..., handler: async (args, ctx) => ... })`。

实现上 `loader.js:223-230` 只是将 `{name, sourceInfo, ...options}` 存进当前 extension 的 `commands` Map；`runner.js:402-430` 汇总并产生 `ResolvedCommand.invocationName`。同名命令按出现次序变为 `name:1`, `name:2`。`pi.getCommands()`（`types.d.ts:954-955`，实现 `loader.js:303-306`）返回当前可用 slash command 信息。

**如何访问 session manager：**
- `ExtensionContext` 的 `ctx.sessionManager`（`types.d.ts:216-220`）静态类型是 `ReadonlySessionManager`，不是完整可变 `SessionManager`。该只读类型只暴露 `getCwd/getSessionDir/getSessionId/getSessionFile/getLeafId/getLeafEntry/getEntry/getLabel/getBranch/buildContextEntries/getHeader/getEntries/getTree/getSessionName`（`session-manager.d.ts:140`）。
- command handler 的 `ctx` 是 `ExtensionCommandContext extends ExtensionContext`（`types.d.ts:250-285`），因此 `/sessions` handler 内直接用 `ctx.sessionManager.getEntries() / getHeader() / getSessionFile()` 等只读 API。`runner.js:480-483` 显示该 getter 实际返回 runner 当前 manager；但类型契约仍是 read-only。
- 若需要可变 manager，命令 context 提供 `ctx.newSession({ setup?: (sessionManager: SessionManager) => Promise<void>, withSession?: ... })`（`types.d.ts:259-266`）；`setup` 回调拿到真正 `SessionManager`。`ctx.fork`, `ctx.navigateTree`, `ctx.switchSession` 也提供受控 session 控制（`types.d.ts:267-285`）。
- `ExtensionAPI` 本身没有 `sessionManager` 属性（`types.d.ts:867-961`）；但有受控写入辅助 `appendEntry`, `setSessionName`, `setLabel`（lines 938-945），以及 `getSessionName`。不要把 `pi.sessionManager` 当作 0.84.2 类型 API。
- `createAgentSession` 的 SDK 注入入口是 `CreateAgentSessionOptions.sessionManager?: SessionManager`，省略时默认 `SessionManager.create(cwd)`（`core/sdk.d.ts:10-55`）。这适用于宿主/SDK 调用，不是扩展 factory 的 `pi` 对象属性。

### 5. CLI 是否支持扩展注册 `pi sessions` 子命令

结论：**不支持。**

证据：
1. `cli/args.d.ts:6-50` 的 `Args` 只有 flags/messages/fileArgs/unknownFlags 等，没有子命令注册字段；`cli/args.js:228-251` 的帮助 Commands 列表只有 `install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth`，没有 `sessions`。
2. `ExtensionAPI` 仅有 `registerCommand`（slash）和 `registerFlag`（CLI flag），没有 `registerSubcommand`/`registerCliCommand`；精确声明见 `core/extensions/types.d.ts:903-917`。
3. `main.js:448-475` 先处理 auth、package、config，再进入普通 `parseArgs`。扩展 command registry 是 runtime/slash 层，不参与 package/auth/config 顶层 argv 分派。
4. `parseArgs` 对任意不以 `-` 开头的 token 走 messages；因此裸 `pi sessions` 在未被内置 package/config handler 接管时会把 `sessions` 当初始 prompt/message，而不会解析成 extension subcommand。扩展应实现 `/sessions`，或另写外部 wrapper/CLI；0.84.2 没有允许扩展添加 `pi <subcommand>` 的 API。

## Architecture

CLI `main()` 先解析内置一次性命令，再创建 cwd/session-bound `SessionManager`；SDK/runtime 把它传入 `ExtensionRunner`。extension loader 用 `createExtensionAPI()` 把 `registerCommand` 写入 extension registry；runner 再把 registry 解析成 slash invocation。事件/命令 handler 收到的 `ctx` 通过 guarded getter 指向当前 session manager（只读视图），而 session replacement 后旧 context 会被标记 stale；命令中的后续工作应放到 `withSession` 回调。

session 持久化是 cwd 编码目录内的 append-only JSONL：首行 `SessionHeader` 绑定 cwd/id/timestamp/parentSession，随后是带 parentId 的树 entries。文件名只表达创建 timestamp + sessionId，真正 workspace 归属由目录和 header.cwd 双重确定；`list` 在 custom shared dir 下再用 header cwd 过滤。

## Start Here

先看 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:184-355`：它是所有可用 SessionManager 方法/参数和“没有 delete/rename”的最精确类型契约；随后看 `core/extensions/types.d.ts:216-285,846-961` 以实现 `/sessions` slash command 时正确使用 `ctx.sessionManager`（只读）或 `ctx.newSession({setup})`（可变 manager）。

## Review findings

- blocker: none（本次是只读 API 勘察，不涉及代码改动）。
- important: 不要设计 `pi sessions` 作为扩展注册的 CLI 子命令；0.84.2 只有 slash command `/sessions` 注册 API。
- important: `ctx.sessionManager` 在类型上是 `ReadonlySessionManager`；不要在扩展中假设可以调用 `append*`、rename 或 delete。
- important: session display name 是追加 `SessionInfoEntry`（`appendSessionInfo`/`pi.setSessionName`），不是改文件名。

## Residual risks

- `listAll()` 扫描默认 sessions 根目录时会读取所有项目目录；自定义 `sessionDir` 的 overload 是实现支持但不是所有调用文档都显式展示，使用时按 `.d.ts:353-354` 处理。
- 物理删除 `.jsonl`、改名文件或跨 workspace 搬移不是 SessionManager API，若产品需要必须由宿主自行做文件系统操作并自行承担索引/并发/归属一致性风险。
- `open(..., cwdOverride)` 可故意覆盖 header.cwd；这会改变运行时 cwd 视图，但不会重写原 header，故使用 override 时不要把它误读为持久化 workspace 归属变更。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "context.md 给出了 0.84.2 精确 dist 类型/源码路径、行号、SessionManager API、entry/header 字段、文件归属规则、扩展 command/context 契约、CLI 无 sessions 子命令结论及严重性。"
    }
  ],
  "changedFiles": [
    "/Users/marvin/hermes-workspace/pi-workbench/context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "grep/read/nl -ba on /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist and examples",
      "result": "passed",
      "summary": "只读核验了 0.84.2 package、d.ts、dist js 和示例。"
    }
  ],
  "validationOutput": [
    "package.json version is 0.84.2",
    "SessionManager constructor is private in d.ts; static factories are the public construction API",
    "No rename/delete/remove/unlink SessionManager API; append-only contract is explicit",
    "No extension CLI subcommand registration API and help has no sessions command"
  ],
  "residualRisks": [
    "物理文件删除/改名不属于公开 API；自定义 cwdOverride 可能与 header.cwd 产生语义差异。"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅写入要求的只读勘察报告 context.md；未修改项目源代码。",
  "reviewFindings": [
    "blocker: none",
    "important: 扩展可注册 /sessions slash command，但不能注册 pi sessions 顶层 CLI 子命令。",
    "important: command handler 的 ctx.sessionManager 是 ReadonlySessionManager。"
  ],
  "manualNotes": "父 agent 应从 core/session-manager.d.ts 与 core/extensions/types.d.ts 开始；报告已按要求写入指定路径。"
}
```