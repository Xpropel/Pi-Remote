# 76 · 设置写桥 `settings_set`（扩展侧，additive）

> **状态**：已实现（2026-10-28，分支 `ui`，未提交）。只改扩展 + 测试/文档；设置页 UI 仍由另一工作流验收，未改。
> **pi 基线**：`@earendil-works/pi-coding-agent` **1.3.0**（本机全局安装；`settings.schema.json` / `settings-manager.d.ts` 与本文一致）。
> **一句话**：新增 `settings_set` 命令，把**白名单内的 pi 设置**原子写入全局 `~/.pi/agent/settings.json`；写入后运行中的 pi 不会热更新，命令诚实返回 `restartRequired:true`。
> **协议性质**：**additive**——不新增帧名、不升 `proto`、不新增能力位、不改 relay；旧 relay 原样转发命令，旧扩展回 `unknown_command`。UI 不依赖能力位，按命令结果/错误码决定是否展示可写。

## 1. 结论（先看这五条）

1. 新命令：`settings_set`；旧命令 `get_settings` 保持只读、脱敏、行为不变。
2. 只写**全局** agentDir 的 `settings.json`（`PI_CODING_AGENT_DIR` 优先，否则 `~/.pi/agent`）；**不写**项目本地 `.pi/settings.json`。
3. 只接受 14 个白名单键（13 组表项；`defaultModel`/`defaultProvider` 是一组两键）；未知字段 / 类型错 / 范围错 / `defaultModel` 与 `defaultProvider` 不成对 → `bad_args`，**不碰原文件**。
4. 原子写：同目录 `.tmp`（`wx`, 0600）→ `fsync` → `chmod 0600` → `rename`；任一环节失败清理 tmp，原文件逐字不变。写入后文件权限固定 0600。
5. **运行中的 pi 不会立即生效**：pi 1.3 扩展 API 只有 `pi.getSettings()`，没有 setter/reload；命令返回 `restartRequired:true`。在本机 TUI 执行 `/reload` 可带上一部分设置，但**重启 pi 是唯一保证全部生效的方式**。

## 2. 命令契约

### 2.1 请求

```jsonc
// local 通道（relay 原样转发到扩展）
{ "type": "command", "id": "c-1", "command": "settings_set",
  "args": { "settings": {
    "steeringMode": "all",
    "compaction": { "enabled": true, "reserveTokens": 16384 }
  } } }
```

- **推荐** `args.settings` 对象（与 `get_settings` 的 `{settings}` 回包对称）。
- 兼容 `args.patch`；也兼容把白名单字段**直接平铺**在 `args` 上（如 `{"steeringMode":"all"}`）。
- `settings` 与 `patch` 同时出现 → `bad_args`（避免歧义）。
- 嵌套对象（`compaction` / `images`）与点号扁平键（`"compaction.enabled"`）都收；同一个字段两种写法同时出现 → `bad_args`（重复）。
- 一次最多 32 个键；空补丁 → `bad_args`。

### 2.2 白名单（按 pi 1.3 `settings.schema.json` 校验）

| 字段（`applied` 里的键） | 类型 / 范围 | pi 默认 | 备注 |
|---|---|---|---|
| `steeringMode` | `"one-at-a-time" \| "all"` | `one-at-a-time` | 当前会话的 steer 投递模式 |
| `followUpMode` | `"one-at-a-time" \| "all"` | `one-at-a-time` | 当前会话的 follow-up 投递模式 |
| `compaction.enabled` | boolean | `true` | 自动压缩开关 |
| `compaction.reserveTokens` | 非负安全整数（≤ `2^53-1`） | `16384` | schema 的 `integer` + `minimum:0` |
| `compaction.keepRecentTokens` | 非负安全整数 | `20000` | 同上 |
| `hideThinkingBlock` | boolean | `false` | 折叠思考块 |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `ask` | 新项目默认信任 |
| `enableInstallTelemetry` | boolean | `true`（`PI_TELEMETRY` env 可覆盖） | 匿名安装统计 |
| `enableSkillCommands` | boolean | `true` | 技能斜杠命令总闸（顶层字段，不写旧版 `skills` 对象） |
| `images.blockImages` | boolean | `false` | 禁止发送图片 |
| `images.autoResize` | boolean | `true` | 发送前自动缩小 |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | 未设置（按模型/pi 兜底） | 只影响新会话默认档 |
| `defaultModel` + `defaultProvider` | 字符串（去首尾空白、1–200 字符、禁控制字符） | 无 | **必须成对**；只给一个 → `bad_args` |

**明确拒绝**（`bad_args`，含嵌套/点号变体）：`theme`、`transport`、`sessionShareDestination`、`retry.*`、`terminal.*`、`tuiMode`、`fullscreen*`、`packages`、`extensions`、`skills`、`prompts`、`themes`、`enabledModels`、`defaultTools`、`modelThinkingLevels`、`queueMode`（旧字段）、`compaction.modelOverrides` 等。需要时另开白名单，不要放开整包。

### 2.3 成功回包

```jsonc
{ "ok": true,
  "applied": { "steeringMode": "all", "compaction.enabled": true, "compaction.reserveTokens": 16384 },
  "restartRequired": true,
  "restartReason": "运行中的 pi 从内存读取设置（SettingsManager 缓存）；写入 settings.json 不会热更新",
  "reloadHint": "重启 pi 后生效。在本机 TUI 执行 /reload 会重载设置与扩展，但启动期设置（主题/TUI 模式等）仍需重启" }
```

- `applied` 是**点号扁平**的已写字段（只含本次补丁，不是完整设置）。
- **不回传**：设置文件路径、完整 settings、文件里的其他键、任何密钥/凭据；`get_settings` 的脱敏规则不变。
- `restartRequired` 在 pi 1.3 下**恒为 true**（原因见 §4）。UI 应把 `applied` 当作「已落盘、重启后生效」的乐观状态，不要立刻用 `get_settings` 回读旧值去覆盖。

### 2.4 失败码

| 场景 | code | 行为 |
|---|---|---|
| 未知字段 / 类型或范围错 / 空补丁 / 重复 / model-provider 不成对 / 参数不是对象 | `bad_args` | 不读、不写文件 |
| 现有 `settings.json` 坏 JSON / 顶层不是对象 / `compaction`/`images` 不是对象 / 符号链接 / 非普通文件 / 超过 1MB | `internal` | 拒绝写入，原文件保持不变 |
| 磁盘写失败 / rename 失败 / 权限不足 | `internal` | 清理 tmp，原文件保持不变 |
| 旧扩展没有 `settings_set` | `unknown_command` | relay 原样回包；UI 保持只读 |

## 3. 写入语义与安全

### 3.1 路径

- `settingsFilePath()` 与 pi 的 `getAgentDir()` 同口径：
  - `PI_CODING_AGENT_DIR` 非空 → 用它（支持 `~` / `~/…`、`file://` URL，相对路径按当前 cwd 解析）；
  - 否则 `~/.pi/agent`。
- 只写 `<agentDir>/settings.json`；**从不**写 `<cwd>/.pi/settings.json`（项目本地设置需要显式设计，本期不做）。
- 符号链接：`settings.json` 是符号链接时拒绝写入（`internal`），避免 `rename` 把链接替换成普通文件；普通文件/不存在文件正常。

### 3.2 合并而不是整包覆盖

1. 读现有文件（不存在 / 空文件 = `{}`；BOM 会剥掉）。
2. 校验补丁（先校验，非法值不会触达文件）。
3. 只把白名单命中的键合并进现有对象：**保留** `apiKey`、`packages`、`compaction.modelOverrides` 等未命中字段；未知字段不会被删除或“清洗”。
4. 原子写回。

> 若项目本地 `.pi/settings.json` 里覆盖了同一字段，生效值仍以项目层为准（pi 的 global+project 合并规则）；写桥只写全局层，不碰项目层。

示例：现有 `{"compaction":{"reserveTokens":1000,"modelOverrides":{...}}}`，补丁 `{"compaction":{"enabled":false}}` → 写入后 `enabled:false`，`reserveTokens` 与 `modelOverrides` 原样保留。

### 3.3 原子写步骤

```text
mkdir agentDir (0700, recursive, 已存在不动)
open  .settings.json.tmp-<pid>-<random>  wx  0600
write JSON (2 空格缩进 + 换行)
fsync(fd)
close(fd)
chmod(tmp, 0600)          // umask 兜底，最终固定 0600
rename(tmp, settings.json) // 同一目录，POSIX/Windows 都原子替换
fsync(dir)                // best-effort；Windows 失败忽略
```

- 任一步失败：关闭 fd、unlink tmp、抛 `internal`；**原文件从未被截断**。
- 目录/文件权限：新建目录 0700；文件最终 0600（已有 0644 也会收紧到 0600）。
- 并发：pi 自己的 `FileSettingsStorage.withLock` 用 `proper-lockfile` + `writeFileSync`（非原子）。写桥**不与它抢同一把锁**，采用「短读-改-原子替换」；极小概率的并发写是 last-writer-wins（不会产生半个 JSON）。写桥不会执行 shell、不会读写其他文件。

### 3.4 安全边界

- 只接受白名单字段；`__proto__` / `constructor` / `prototype` 直接拒绝，归一结果用 null 原型，避免原型污染。
- 不返回值内容之外的设置正文；不返回路径；不返回文件清单。
- 不碰 `auth.json` / `models.json` / `.env` / 密钥；`defaultModel` / `defaultProvider` 不是密钥。
- `defaultProjectTrust` 是安全敏感项：它只影响**以后新项目**的默认信任，不会自动信任当前项目；调用方仍是已鉴权的 viewer。
- 无 shell、无网络、无任意路径参数；路径只由本机 env 决定。

## 4. 为什么 `restartRequired` 恒为 true（研究证据）

### 4.1 扩展 API 只有只读 getSettings

在 pi 1.3.0 的 `dist/core/extensions/types.d.ts`：

- `ExtensionAPI` / `ExtensionContext` 上只有 `getSettings(): Settings`（“Get a copy of the effective settings”），**没有** `setSettings`。
- `ExtensionContext`（事件 ctx，本扩展的 `this.ctx`）字段只有 `ui / mode / hasUI / cwd / sessionManager / modelRegistry / model / scopedModels / ...`，**没有** `settingsManager`，也没有 `reload`。
- `reload(): Promise<void>` 只出现在 `ExtensionCommandContext`（扩展斜杠命令的 ctx），不在事件 ctx 上。
- `dist/core/extensions/loader.js` 的运行时只把 `runtime.getSettings` 接到宿主 action；没有 setter action。

### 4.2 运行中的 SettingsManager 是内存缓存

- `SettingsManager.getSettings()` 返回 `structuredClone(this.settings)`；改返回值没有任何效果。
- 设置写入/重读的宿主入口是 `SettingsManager.reload()`（`dist/core/settings-manager.js`），它把文件重新读进 `this.settings`。
- 触发 `SettingsManager.reload()` 的路径：
  - `AgentSession.reload()`（`dist/core/agent-session.js`）→ `await this.settingsManager.reload()` + `syncQueueModesFromSettings()` + 资源重载；
  - 该 `AgentSession.reload()` 由 **命令 ctx 的 `reload()`** 或 **RPC 模式的 `reload` 命令**（`dist/modes/rpc/rpc-mode.js`）调用；
  - 本扩展是事件驱动桥，没有命令 ctx；`pi.sendUserMessage("/reload", {expandPromptTemplates:true})` 之类的“自我调用”会让扩展运行时 `invalidate()`（旧桥 socket/命令回包一起失效），属于危险 hack，未采用。
- 因此写桥只能保证**文件已写**，不能保证**当前进程已重读**；如实返回 `restartRequired:true`。

### 4.3 SettingsManager 能否从扩展内 import？

- `SettingsManager` 是 pi 的**公开导出**（`dist/index.js` 有 `export { SettingsManager }`），也有 `create()` / 各 setter / `reload()`。
- 普通 Node 的 `createRequire("~/.pi/agent/extensions/…")` 解析不到包（全局安装不在扩展的 node_modules 链上，`MODULE_NOT_FOUND`）。
- 但 pi 加载扩展时用的是 jiti，并给了 `@earendil-works/pi-coding-agent` 别名/虚拟模块（`dist/core/extensions/loader.js` 的
  `getAliases()`；`virtual-modules.js` 的注释明确写 “Extensions can therefore import from @earendil-works/pi-coding-agent”）。
  所以**扩展内 import 这个包本身是可行的**；用 jiti alias 实测 `const { SettingsManager } = require("@earendil-works/pi-coding-agent")` 返回 `function`。
- 关键限制：import 到的只是 `SettingsManager` **类**，不是宿主正在用的那个实例。`ExtensionContext` / `ExtensionAPI` 都不暴露 `settingsManager`，
  也没有静态注册表；`SettingsManager.create(cwd, agentDir)` 是**第二个实例**，`reload()` 只重读它自己。
- 实测第二个实例：`setSteeringMode("all")` + `flush()` 会经 `proper-lockfile` 写文件（**非原子**，实测新文件 0644），
  另一个新建实例能读到新值，但宿主进程的 `getSettings()` 不变。
- 因此：**可以 import，但不能借此热更新，也不拿它替代写桥**。写桥继续用自实现原子写（0600、失败不破坏原文件），
  import 只保留为“研究结论”，不引入对 pi 内部实现/打包形态的运行时依赖。

### 4.4 `/reload` 能带上哪些

pi TUI 的 `/reload` 是用户主动执行：`AgentSession.reload()` 会 `settingsManager.reload()`、同步 steering/followUp、重载资源，随后 `InteractiveMode` 走 `applyRuntimeSettings()`（重读 `hideThinkingBlock` 等）。所以 `/reload` 能带上一部分设置，但：

- 写桥**无法触发** `/reload`；
- 启动期/一次性读取的设置（如安装统计、部分终端/TUI 选项）仍需重启；
- `defaultModel` / `defaultProvider` 只影响**新会话**，当前会话不会换模型。

命令回包因此统一要求重启；`/reload` 只作为 `reloadHint` 里的次选提示，不作为成功保证。

## 5. 生效矩阵（写后）

| 设置 | 当前进程 | `/reload` 后 | 重启后 |
|---|---|---|---|
| `steeringMode` / `followUpMode` | 不变 | `syncQueueModesFromSettings()` 生效 | 生效 |
| `compaction.enabled` / `reserveTokens` / `keepRecentTokens` | 不变 | 下一次压缩读到新值 | 生效 |
| `hideThinkingBlock` | 不变 | `applyRuntimeSettings()` 重读（TUI） | 生效 |
| `images.autoResize` | 不变 | 下一次构建/运行工具时读到新值 | 生效 |
| `enableSkillCommands` | 不变 | 资源重载后可能重新注册技能命令 | 生效 |
| `defaultThinkingLevel` | 不变 | 新会话默认档 | 生效 |
| `defaultModel` / `defaultProvider` | 不变（当前会话模型不动） | 新会话默认模型 | 生效 |
| `defaultProjectTrust` | 不变 | 视信任判定时机 | 生效 |
| `images.blockImages` | 不变（当前 UI/session 已构建） | 不保证 | 生效 |
| `enableInstallTelemetry` | 不变 | 不保证（启动期读取） | 生效 |

> **保证口径**：只有「重启 pi」是全部字段的保证；`/reload` 是部分字段的便利路径。UI 文案应写“保存后需重启 pi 生效”，不要写“已立即生效”。
> 环境变量覆盖优先于 settings（例如 `PI_TELEMETRY` 覆盖 `enableInstallTelemetry`）；写桥只写文件、不碰 env，这类情况下重启也不会改变最终开关。

## 6. 测试

新增 `test/extension-settings-write.test.mjs`（已注册进 `npm test`），17 条全过：

```bash
node --test test/extension-settings-write.test.mjs
# 17 pass / 0 fail
```

覆盖：

- 路径解析（env / `~` / 默认）与只写全局文件；
- 全部白名单字段（嵌套 + 点号）与七档 `defaultThinkingLevel`；
- 未知字段、嵌套未知、原型键、空补丁、重复、model/provider 不成对；
- 枚举/布尔/非负安全整数/字符串长度与控制字符；
- 合法写：合并保留未知键、0600、目录/文件权限、BOM/空文件、临时文件清理；
- 不泄露路径/完整设置/密钥；`get_settings` 脱敏不变；写入不伪装热更新；
- 坏 JSON、顶层非对象、嵌套非对象、超大文件、符号链接：拒绝且原文件逐字不变；
- 原子性：rename/fsync/chmod/半写失败 → 原文件不变、tmp 清理；真实只读目录失败；
- 写入顺序 open(`wx`,0600) → write → fsync → close → chmod → rename；
- `set_steering_mode` / `set_follow_up_mode` / `set_auto_compaction` 的 unsupported 文案指向 `settings_set`，`set_auto_retry` 仍明确未开放。

## 7. 仍不可写 / 明确不做

- **不在白名单**：主题（`theme`）、传输（`transport`）、分享目的地、重试（`retry.*`）、终端与 TUI（`terminal.*`、`tuiMode`、fullscreen*）、包/扩展/技能/提示词/主题路径、`enabledModels`、`defaultTools`、`modelThinkingLevels`、`compaction.modelOverrides`。
- **不做**：项目本地设置写入（需要产品明确“写项目”的信任语义）、`auth.json`/密钥写入、任意路径写入、shell 执行、MCP/包安装写入。
- **不假装**：不把文件写成功说成运行中已生效；不返回路径/完整设置；不在写失败时返回部分成功。

## 8. 涉及文件

- `extension/pi-remote-sync.ts`：白名单/校验/合并/原子写/`cmdSettingsSet`/命令分发/`RPC_UNSUPPORTED` 文案/导出。
- `test/extension-settings-write.test.mjs`：新增测试。
- `package.json`：`npm test` 注册测试文件。
- `DOC/71-protocol-v4.md` §9.4：additive 说明与链接。
- `DOC/60-ui-enhancement.md` §5.6：旧只读设置块的追加说明。
- `readyUI/data-interface.md` §4.11.2 B：`settings_set` 行。
- 本文档。

## 附录 A：本机探针（2026-10-28，pi 1.3.0）

普通 Node 从扩展路径解析（失败）：

```text
$ node -e "const r=require('module').createRequire(process.env.HOME+'/.pi/agent/extensions/pi-remote-sync.ts'); ..."
@earendil-works/pi-coding-agent -> MODULE_NOT_FOUND
@earendil-works/pi-coding-agent/dist/core/settings-manager.js -> MODULE_NOT_FOUND
```

pi 的 jiti alias 下（成功，但只是类）：

```text
$ # 用 loader.js 同样的 alias 加载一个临时扩展：
$ const { SettingsManager } = require("@earendil-works/pi-coding-agent"); export default typeof SettingsManager
import via alias: { default: 'function' }
```

第二个实例（不是宿主实例）：

```text
$ node --input-type=module -e "const {SettingsManager}=await import('file://<pi-package>/dist/index.js'); ..."
second instance settings keys 0 steering one-at-a-time
has reload function has setter function
# setSteeringMode('all') + flush() 后：
file: { "steeringMode": "all" }
mode: 644
lock exists: false
new instance reads: all
```

说明：jiti alias 下**可以** import 到公开的 `SettingsManager`，但拿到的只是类；`create()`/setter 写的是文件
（实测 0644、`proper-lockfile`、非原子），新建的另一个实例能读到新值，而宿主 `AgentSession.settingsManager`
的 `getSettings()` 不变。这个探针没有修改真实设置文件（临时 agentDir）。

源码依据（pi 1.3.0）：

- `dist/core/extensions/types.d.ts`：`ExtensionContext` 无 `settingsManager` / `reload`；`ExtensionAPI.getSettings()` 只读；
  `ExtensionCommandContext.reload()` 才是命令 ctx 的 reload。
- `dist/core/extensions/loader.js`：extension runtime 只有 `getSettings` action。
- `dist/core/settings-manager.js`：`getSettings()` 返回 `structuredClone(this.settings)`；`reload()` 才重新读文件。
- `dist/core/agent-session.js`：`AgentSession.reload()` → `settingsManager.reload()` + `syncQueueModesFromSettings()`。
- `dist/modes/rpc/rpc-mode.js`：RPC 模式有 `reload` 命令（`session.reload()`）；本扩展不在 RPC 模式，也没有命令 ctx。
- `dist/modes/interactive/interactive-mode.js`：TUI `/reload` 后走 `applyRuntimeSettings()` 重读 `hideThinkingBlock` 等；
  但 `/reload` 由用户在本机触发，写桥无法触发它。
