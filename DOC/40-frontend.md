# 前端详细设计：设备/会话选择与窗口内操作（ui/src）

> 工作流：**前端** = `ui/src/**`（React+TS，三套皮肤：desktop `/`、mobile `/m`、beauty `/b`）。
> **状态（2026-10 换成新界面之后）**：三套皮肤已经换成一套新界面（`ui/src/pi` + `ui/src/components/pi`），按宽度自动选桌面 / 手机布局。`/m`、`/b` 不再是单独的皮肤：relay 对没有扩展名的路径回退到 `index.html`，打开的也是新界面。
> 本文 §1、§2、§4、§5、§9、§10 写的是 useRelay、relay/devices.ts、relay/presence.ts 的状态与文案，这些都保留了，仍然有效；
> §3、§6、§7 里的组件和文件落位是旧界面的，见 §6 末尾的对照表。现行界面说明见 `ui/README.md`。
> 共同契约：`DOC/50-protocol-delta.md`（帧/命令/错误码以它为准，先读）。
> 阶段归属：步 2（设备/会话选择 UI）+ 步 3（启用/新建的中间态与超时）。步 0/1 前端零改动。

## 1. 状态模型扩展（`useRelay.ts`）

| 状态 | 类型 | 来源 |
|---|---|---|
| `devices` | `Device[]` | `room_list.devices[]`（含未连接） |
| `selectedDeviceId` | `string \| null` | UI 选择；默认=第一个 `online`，否则名册第一个 |
| `sessionsByDevice` | `Record<deviceId, SessionEntry[]>` | `session_list` 应答 |
| `sessionsLoading` | `boolean` | `get_sessions` 在飞 |
| `pendingStarts` | `Record<deviceId, {kind:"cwd"\|"session", key:string, at:number}>` | 启用/新建的启动中间态 |
| `deviceNotice` | 现有 `notice` 机制扩展 | 错误码 → 文案（§5） |

`Device = { id, accountId, name, platform, online, projects, lastAttachAt }`
`SessionEntry = { id, name, cwd, messageCount, sizeBytes, updatedAt, active, online }`

**会话合并规则**（列表 = 活动房间 + 索引清单）：
1. 取 `rooms` 中 `deviceId===选中设备 && online` 的活动会话 → `online:true`，置顶。
2. 取 `sessionsByDevice[deviceId]` → 非活动项，按 `updatedAt` 倒序。
3. 去重：`room.id === sessionId`（契约恒等式）——同名 id 以活动房间为准。
4. 设备未连接 → 只渲染第 2 步（索引），全部禁用操作。

## 2. `useRelay`改动点

1. **`room_list` 处理**：解析 `devices[]`（新字段）；`rooms[]` 读 `accountId/deviceId`；未登记设备合成 `{id:"未登记设备", online:false}`。
2. **`get_sessions` 请求/应答**：`sendQuery({type:"get_sessions", id, deviceId})` → 10s 超时 → 失败 notice；`sessionsByDevice[deviceId]` 写入；`truncated:true` 时列表脚注"仅显示最近 200 个"。
3. **触发时机**：`selectedDeviceId` 变化 / `room_list` 里该设备 `online` 由 false→true（窗口刚开，拉一次最新清单）。
4. **命令发送（设备级）**：`runDeviceCommand(deviceId, command, args)`：
   - 超时分档：`harness_start` **10s 且不自动重发**（加入既有 noRetry 档）；其它设备级命令总等 **35s** 不重发（不小于 relay 侧分档：会话操作 30s、`get_state`/`get_sessions` 15s，避免前端先超时报"结果未知"诱发重复执行）。
   - id 生成/匹配沿用 `runCommand` 机制。
5. **启用流程（sessionId 形态）**：
   ```
   runDeviceCommand(dev,"harness_start",{sessionId})
     → ok{started}        → pendingStarts[dev]={kind:"session",key:sessionId,at:now}
     → ok{already_running,roomId} → 直接 selectRoom(roomId)
     → error{code}        → notice（§5 文案），pending 清除
   观察：room_list 出现 room.id===sessionId && online → 清除 pending + 自动订阅选中
   超时：60s（sessionOnlineWatchMs）未见房间 → notice"本机没有把这个会话拉起来，请到电脑上看终端" + 清除 pending
   ```
6. **新建流程（cwd 形态）**：
   ```
   runDeviceCommand(dev,"harness_start",{cwd})
     → ok{started}       → pendingStarts[dev]={kind:"cwd",key:cwd,at:now}
   观察：room_list 出现"该 deviceId+cwd 的新房间"（请求时刻之后首次出现的、此前不在列表里的房间）
         → 清除 pending + 自动订阅选中
   超时：60s → 同上 notice
   ```
7. **`snapshot.snapshotPending`**：为 true 时渲染"正在从本机拉取会话…"占位（收到 `snapshot` 自然替换）。
8. **降级**：只对 `auth_result` 没带 `proto` 的旧 relay：`get_sessions` 报 `unknown_type`/无应答 → 设备面板隐藏，仅房间列表。v4 relay 按 `caps` 开关界面，单个请求被拒只让它自己失败（见 §9）。

## 3. 组件与交互（旧界面；三皮肤共用一套数据）

```
左侧/顶部（自上而下）
├─ DeviceRow[]            名字 · 平台图标 · 已连接(绿)/未连接(灰) · "未连接"角标
│    └─ 选中态；未连接也可选中（只读清单）
├─ [已连接] 操作区
│    ├─ 「新建会话」按钮 → 下拉只能选 device.projects（无自由输入）
│    └─ 「启用会话」按钮 → 下拉 sessionsByDevice（非活动项）
├─ SessionList
│    ├─ 活动会话（online:true）→ 点击=订阅（现状 RoomButton 行为）
│    ├─ 未活动会话（索引）→ 行内"启用"按钮；pending 中显示 spinner+"启动中…"
│    └─ 折叠区分组（按 cwd）；只读设备整组禁用
└─ 状态横幅
     ├─ 设备未连接："这台设备未连接——在电脑上执行 pi-remote attach 后可操作"
     ├─ pendingStart：剩余观察时间（进度条或"启动中… 58s"）
     └─ truncated："仅显示最近 200 个会话"
```

- 手机页：设备选择横条放在会话列表上方（同一数据源，不另做接口）。
- beauty 页：同一组件树 + 主题化（SlotTint 既有机制）。
- 输入框（Composer）：未连接设备/无活动会话时禁用 + 提示；有活动会话时现状不变。

## 4. 关键交互状态机

```
[选设备]
  online? ──yes──▶ [拉清单 get_sessions] ──▶ [列表：活动+索引]
     │                                        │
     no                                       ├─ 点活动会话 ──▶ subscribe（现状）
     │                                        ├─ 点"启用"(sessionId) ──▶ pendingStart
     ▼                                        │     ├─ already_running ─▶ selectRoom(roomId)
  [展示索引清单(只读)]                          │     └─ started ─▶ 等 room_list(room.id===sessionId)｜60s 超时
     + 横幅"未连接"                             └─ 点"新建"(cwd) ──▶ pendingStart
                                                      └─ started ─▶ 等 room_list(deviceId+cwd 新房间)｜60s 超时
```

- pending 期间同设备**只允许一个**在飞（按钮禁用），避免并发双开。
- 任何一步失败都落 `notice`（tone=bad）+ 可重试（重新点按钮，不自动）。

## 5. 文案与错误码映射（统一出口）

| code | 横幅/notice 文案 |
|---|---|
| `device_offline` | 设备未连接：在电脑上执行 `pi-remote attach` |
| `device_no_active_session` | 这台设备没有在跑的会话，先启用或新建一个 |
| `session_not_found` | 这台设备上没有这个会话（可能已删除） |
| `cwd_not_allowed` | 该目录不在这台设备的允许列表里 |
| `spawn_failed` | 本机启动失败：{error 原文} |
| `no_device` | 这台设备从未连接过 |
| （请求超时 10s） | 本机没有回应，请重试 |
| （观察超时 60s） | 已通知本机启动，但会话还没上线——请到电脑上看终端 |

口径统一：出现「未连接」不写「离线」；出现「会话」不写「房间」（面向用户）；「启用」= 打开一个未活动会话。

## 6. 组件落位（文件级改动清单）

| 文件 | 改动 |
|---|---|
| `ui/src/relay/useRelay.ts` | §2 全部（状态、帧、命令、流程） |
| `ui/src/chat/parts.tsx` | 侧栏新增 `DeviceList`/`SessionList`/操作区；`RoomGroups` 保持（活动会话分组沿用）；横幅区接 `deviceNotice` |
| `ui/src/style/faces.tsx` | 三皮肤的 `Composer` 禁用态/提示；新组件在各皮肤的渲染变体（沿用 SlotTint） |
| `ui/src/chat/slash.tsx` | `/model` 等面板保持；设备/会话操作**不走 slash**（快步入口保留 `/resume` 兼容旧行为） |
| `ui/src/pages/DesktopPage.tsx` / `MobilePage.tsx` / `BeautyPage.tsx` | 头部 meta 增加设备名与连接态（`cwd · 设备 · 已连接/未连接`） |
| `ui/src/components/ui/*` | 复用；`listbox` ARIA 语义沿用 slash 面板既有模式给设备下拉用 |

换成新界面之后的对应位置（上表的文件都已删除；路径相对 `ui/src`）：

| 旧 | 新 |
|---|---|
| `chat/parts.tsx` 侧栏 DeviceList / SessionList | `pi/containers/SidebarContainer.tsx` + `components/pi/shared/PiSidebar.tsx`（设备筛选在 `components/pi/composer/PiDisplayOptions.tsx`） |
| `style/faces.tsx` 的 Composer 禁用态 | `pi/containers/ComposerContainer.tsx` + `components/pi/composer/PiComposerDock.tsx`；不能发送的原因在 `pi/model/composerReason.ts` |
| `chat/slash.tsx` | `components/pi/composer/PiComposerMenu.tsx`（PiSlashMenu）+ `pi/model/slashMenu.ts` |
| `pages/*Page.tsx` 头部 meta | `components/pi/shared/PiTopBar.tsx`；会话信息卡 `components/pi/shell/PiSessionInfoCard.tsx` |
| `components/ui/*` | `components/kit/*`（菜单在 `kit/menu/`），Pi 部件在 `components/pi/*` |

## 7. 验收（前端）

**对接 E2E（假 relay 帧脚本）**：
1. `room_list.devices` 三态（在线/未连接/未登记）渲染正确。
2. `session_list`：活动+索引合并去重；truncated 脚注；`no_device` 横幅。
3. 启用流程：`already_running` 直连；`started`→房间出现→自动订阅；60s 超时文案。
4. 新建流程：`cwd` 启动→`deviceId+cwd` 新房间关联→自动订阅。
5. 错误码 6 种全部有对应文案且不重试。
6. 旧 relay 降级：只有房间列表，无设备面板，不报错。

**浏览器 checklist（真机）**：
7. 三皮肤（`/`、`/m`、`/b`）设备/会话布局一致，移动端可点区域 ≥44px。（旧界面的验收；新界面按桌面 / 手机两种布局验收，44px 点击区的检查见 `ui/README.md` 对图一节的 ui-a11y）
8. 未连接设备：灰、只读清单、输入框禁用、文案正确。
9. 启用旧会话：按钮→"启动中…"→自动跳到该会话并能发消息。
10. 新建会话：选目录→"启动中…"→新会话上线并自动进入。
11. 断开/重连：设备上下线时列表实时变化，无残留 pending。
12. a11y：设备下拉 listbox 键盘可达；状态变化有 `aria-live` 播报。

## 8. 明确不做（前端）

- 账户概念 UI（本期恒 admin，不展示）。
- 「断开此设备」按钮（D6，帧预留）。
- 会话删除/重命名入口（维持本机操作）。
- 图片发送附件（契约已支持 `images`，但本期不做 UI，留待后续）。

## 9. 协议 v4（网页侧）

契约见 DOC/71；网页侧的常量与纯逻辑在 `ui/src/relay/protocol.ts`。

1. **握手**：`auth` 带 `proto:4`、`caps:["err.v4","msg.cid"]`、`client:{kind:"viewer",version}`，旧 relay 会忽略这些字段。`auth_result` 的 `proto/caps` 存进 `serverProto/serverCaps`；没带 `proto` 的按 v3 处理，保留旧的猜测逻辑（§2.8）。
2. **错误**：交互一律看 `code`，文案用服务端原文。命令通道自己判的失败也带码：没等到回应或断线后取不回结果记 `result_unknown`（命令可能已执行，切换类命令的预期目标保留），发不出去记 `offline`，页面关闭记 `closed`。`abort` 遇 `unknown_command` 退回 relay 的 `abort` 帧；只有没声明 `err.v4` 的旧 relay 才按「未知命令」文案认。
3. **消息 id**：relay 声明 `msg.cid` 时，网页发 `prompt/steer` 带 `cid`，并立即出「发送中」气泡；`remote_message{cid}` → 已到本机，`remote_message_delivered{cid}` → 已送达，`remote_message_failed{cid}` → 失败（点重试会摘掉原气泡、发一条新的）。命令本身失败时，还在发送中的气泡随草稿退回一起摘掉；已到本机的不动。最终由 pi 的 user `message_end` 取代：同文本多条按先进先出取最早一条，失败的不算。快照里带 `cid` 的远程回显并进同 `cid` 的气泡。relay 没声明 `msg.cid` 时仍按文本对号，受理后才出气泡。
4. **设备管理**：网页声明 `device.token`。relay 也声明时，设备列表下方出现「添加或管理设备」，打开共用的设备管理对话框（新界面里是「设备与配对」对话框，从设置页、新建会话的设备菜单和无设备页打开，桌面、手机布局共用）：
   - 添加：`pair_create` 拿到一次性配对码，显示为 `XXXX-XXXX` 并倒计时；同时给出 Windows（`node deploy\attach.cjs --pair …`）和 macOS / Linux（`deploy/attach.sh --pair …`）两条命令，可一键复制；过期后提示重新生成。配对码只能用一次：生成码之后名册里新出现已配对设备（或原来未配对的设备变成已配对），码区就换成「配对成功：设备名」并提示去那台电脑上重启 pi，另给「再添加一台」。已配对设备重新配对时 `paired` 不变，认不出来，码区留到过期。
   - 撤销：有有效令牌（`paired`）或正用令牌连着（`auth:"token"`）的设备可撤销，两次点击确认后发 `device_revoke`；未登记设备没有身份，不能撤。
   - 名册：每台设备显示平台、连接状态和鉴权状态（已配对 / 未配对 / 旧令牌连接）；侧栏里用旧共享令牌连着的设备标「旧令牌」。
   - relay 没声明 `device.token` 时，入口不出现，名册也不显示鉴权状态（旧 relay 没有这两个字段）。

## 10. 连接与状态的展示（U3）

展示口径的纯逻辑在 `ui/src/relay/presence.ts`（`test/ui-sync.test.mjs` 覆盖），新界面的桌面、手机布局共用。

1. **和服务器断线**：第一次连接用加载条；连上过之后再断开，会话页和手机列表页顶部出横幅「和服务器的连接断了，N 秒后重连」+「立即重连」（没连上过时写「连不上服务器，N 秒后重试」），正在重连时写「正在重新连接服务器…」。退避仍是 1s 起翻倍、最长 20s，但这几种情况不等退避、立刻重连：页面切回前台、网络恢复（`online`）、从往返缓存恢复（`pageshow`）、点「立即重连」。
2. **死连接**：手机切后台、换网络后，连接常常已经断了却收不到 `onclose`。切回前台或网络恢复时如果连接看着还开着，就发一个 `ping`，8s 内什么都没收到就换一条新连接；页面在前台时，上一轮心跳（25s）连 `pong` 都没回也换。建连加鉴权超过 12s 没结果就关掉，走正常的退避重连。换连接时在飞命令照常挂起、重连后凭 dedupeKey 取回结果。
3. **断线期间的输入框**：能继续打字（手机上禁用输入框会把键盘收起），但不能发送，占位文字是「还没连上服务器，连上后再发」。本来就不能发的情况（设备未连接、没有活动会话）照旧禁用输入框。
4. **会话已结束的红条**（本机 pi 没在跑）：只在确实掉线时出现——选中时就不在线，或掉线超过 2.5s（换会话时旧会话先下线、新会话随后上线，这段过渡不出红条、头部也不写「已结束」，输入框照样立即禁用）。同一件事只出一条红条。
5. **三种断开分开叫**：网页和服务器断了叫「服务器已断开」（横幅「和服务器的连接断了」），设备没开 attach 叫「未连接」，会话没在跑叫「已结束」；面向用户不写「离线」。头部状态行是 `状态 · 目录 · 设备 · 模型 · 思考级别 · 用量`，状态放最前，窄屏截断时也看得到；状态取「运行中 / 在线 / 已结束 / 设备未连接 / 服务器已断开 / 连接中」。
6. **标签页标题**：`会话名 · pi`；运行中前面加 `●`；页面在后台时这一轮跑完了加 `✓`，回到页面就消失；连上过又断开时写 `已断开 · 会话名 · pi`。
7. **提示条**：右侧有关闭钮。红条、设备未连接横幅、断线横幅跟着状态走，不能关。
8. **退出登录**：设置页右上角「退出登录」，两次点击确认；清掉这台浏览器保存的 token，断开连接、清空界面回到登录页。
