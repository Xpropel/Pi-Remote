/**
 * pi-remote-sync —— 跑在本机 pi 进程内的多端同步扩展。
 *
 * 做三件事：
 *   1. 读：把当前会话的生命周期/消息事件实时转发给 relay（→ 手机/其他浏览器）
 *   2. 写：把 relay 转来的远程消息用 pi.sendUserMessage() 注入当前会话
 *      （忙碌时自动降级 steer，与 TUI 行为一致；模型作为普通 user message 处理）
 *   3. 快照：新订阅方接入时下发 getBranch() 全量消息
 *   4. 遥控：命令面与 pi 官方 RPC（docs/rpc-commands.md）对齐——状态/模型/思考级别/
 *      压缩/队列/会话操作全套；pi 有接口的直连，没有进程内接口的明确报不支持
 *
 * 配置（环境变量）：
 *   PI_REMOTE_RELAY         relay 的 WS 地址，如 ws://127.0.0.1:7001
 *   PI_REMOTE_TOKEN         local 通道共享 token（与 relay 的 localToken 一致）
 *   PI_REMOTE_LABEL         可选，本机显示名（默认取 cwd）
 *   PI_REMOTE_ACCOUNT       账户，缺省 admin
 *   PI_REMOTE_DEVICE_ID     本机设备编号（uuid，attach --init 写入）。缺省则房间归「未登记设备」，
 *                           且连接窗口匹配不上，扩展不会连接
 *   PI_REMOTE_DEVICE_TOKEN  配对换来的设备令牌（attach --pair 写入）。与 DEVICE_ID 配套时，
 *                           只有它、没有共享 TOKEN 也能连
 *   PI_REMOTE_DEVICE_NAME   设备显示名，缺省按平台：Windows / Mac / Linux
 *   PI_REMOTE_PROJECTS      会话清单要扫描的项目目录，分号分隔
 *   PI_REMOTE_ATTACH_FILE   可选，连接窗口状态文件路径（默认 ~/.pi/agent/remote-attach.json）
 *   PI_REMOTE_ALWAYS_ONLINE 设为 1 时跳过连接窗口门控，总是连接（过渡用，不推荐长期）
 *
 * 安全边界：只出站连接 RELAY，无入站监听、无文件传输接口。
 * 任何异常只记录不抛出让 pi 崩掉。
 */
/** 默认值指向本机 relay；token 默认空 = 不连接（只打一次日志）。
 *  注意：设了 PI_REMOTE_RELAY / PI_REMOTE_TOKEN 并不等于“启用同步”。是否连接由连接窗口决定：
 *   - 运行 deploy/attach.cjs（Windows：deploy\attach.cmd；macOS / Linux：deploy/attach.sh）打开窗口，
 *     它会把 ~/.pi/agent/remote-attach.json 写成 {pid, deviceId, expiresAt, ...}；扩展只在窗口开着、
 *     deviceId 与 PI_REMOTE_DEVICE_ID 一致、且窗口进程还活着时连接。窗口关闭/到期/状态文件被删除
 *     立即断开，窗口外不重连（文件出现或到期由 fs.watch/定时器重新判断）。
 *   - 设备身份来自 .env：attach --init 生成 PI_REMOTE_DEVICE_ID；attach --pair <配对码> 换取
 *     PI_REMOTE_DEVICE_TOKEN 并写入 .env（两者都会把 .env 收紧到 0600）。扩展本身不参与配对。
 *   - 只有旧式 PI_REMOTE_RELAY/PI_REMOTE_TOKEN、没有 PI_REMOTE_DEVICE_ID 的配置匹配不上窗口，默认
 *     不连接；过渡期可设 PI_REMOTE_ALWAYS_ONLINE=1 跳过窗口门控（不推荐长期使用）。
 *  启动脚本只负责把 .env 读进 pi 进程环境：Windows 跑 deploy\start-pi.cmd，macOS / Linux 跑 deploy/start-pi.sh。 */
const DEFAULT_RELAY = "ws://127.0.0.1:7001";
const DEFAULT_TOKEN = "";
const RELAY_URL = process.env.PI_REMOTE_RELAY || DEFAULT_RELAY;
const TOKEN = process.env.PI_REMOTE_TOKEN || DEFAULT_TOKEN;
/** 配对后拿到的设备令牌（v4）。只有它、没有共享 TOKEN 也能连 */
const HAS_DEVICE_TOKEN = !!(String(process.env.PI_REMOTE_DEVICE_TOKEN || "").trim() && String(process.env.PI_REMOTE_DEVICE_ID || "").trim());
const LABEL = process.env.PI_REMOTE_LABEL || "";
/** 调试开关：转发 provider_stream_event 原始流（每个 provider chunk 一帧，UI 不消费，默认不转） */
const FORWARD_RAW = process.env.PI_REMOTE_FORWARD_RAW === "1";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");
const { spawnSync } = require("node:child_process");
// @@PROTOCOL_BEGIN（由 protocol/sync.cjs 生成，勿手改）
const PROTOCOL = {
  "proto": 4,
  "minProto": 3,
  "caps": {
    "err.v4": "所有失败都带 code：ack.code / error.code / command_result.code 必填",
    "msg.cid": "远程消息带客户端 id（cid）：回显、送达、失败按 cid 对号",
    "device.token": "设备令牌：配对码换 deviceToken，local 通道按设备鉴权",
    "room.label": "local 通道支持 room_label 轻量改名帧",
    "room.attention": "注意力恢复通道（R3-1）：relay 按房维护回合摘要 lastTurnEnd{kind:done|error,at}（成败归一与页面外通知编排器同源：agent_settled 落定、看落定前最后助手终态；aborted 不记；新回合活动信号到达即清）；room_list 房间条目带 lastTurnEnd（无未读落定时为 null）；摘要变化时向设备级 viewer 连接广播 room_attention{room,lastTurnEnd|null}（字段白名单：只有 room 与 kind/at，不带任何正文/标题）；任一 viewer 订阅进房即清该房摘要并广播 null（单用户多设备口径：一端看过即全端已读）。UI 侧 RoomTurnTracker 仍是实时边沿引擎，本通道只作刷新/重连恢复种子，与 tracker 既有记录按房合并去重（先到为准）",
    "prefs.sync": "主题偏好跨设备同步（R4-1）：同步范围只取通用外观五字段 {theme, chrome, font, size, mono}（faces/color 是皮肤内部细节、completionSound/queueSend 是本设备行为，都不入）。帧：prefs_set{subset, baseRev}（viewer→relay）/ prefs_saved{rev, updatedAt}（relay→发送端回执）/ prefs_changed{subset, rev, updatedAt}（relay→同账户其他 viewer 广播，发送端不收）；auth_result 增 prefs{subset, rev, updatedAt} | null 快照字段。冲突口径 LWW：relay 维护 per-account 单调 rev、以到达顺序裁决（不信客户端时钟），发送端 baseRev 落后不拒绝、但必须以回带 rev 对齐本地。relay per-account 存储（内存态 + 小文件落盘，落盘失败降级纯内存态）。未声明 prefs.sync 的 viewer 不收 prefs_changed、auth_result 不带 prefs 字段（只剥新面）",
    "sync.v3": "local 通道支持 room_registered / sync / snapshot{mode:append} 对齐",
    "health": "viewer 端口提供 GET /healthz",
    "dialog.respond": "对话框应答（O2，接管语义）：开关 dialogRemoteAnswer 开 AND 房间有 viewer 在线才接管（任一假落回 O1 透传本机弹窗，fail-open）。帧：dialog_open{…,answerable:true}（接管时带）/ dialog_answer{dialogId,action:allow|submit|deny,value?,note?}（viewer→relay→桥，先答广播：首达 resolve、迟到回 dialog_gone）/ dialog_close{dialogId,outcome,reason:answered|denied|timeout|aborted,note?}（裁决后全端广播收回）/ dialog_gate{hasViewers}（relay→桥：房间 viewer 订阅数 0↔>0 推送，桥重连补发当前值）/ dialog_answer_switch{enabled}（UI→relay→桥：开关下达，桥仅内存持有、重启回默认关，桥重连由 relay 按存值重下达）/ dialog_answer_result{aid,dialogId,ok,code?}（桥→relay→答题 viewer 的回执通道）/ dialog_claim{dialogId}（可选意向提示：仅供他端显示正在作答，不承载应答权，一期未实现流程）。Deny 理由只随帧广播供 UI 呈现，不回传模型（resolve 值域装不下）",
    "dialog.observe": "对话框观察帧（O1）：dialog_open{dialogId,kind,title,options,message,placeholder,prefill,timeout,startedAt} / dialog_close{dialogId,outcome}；扩展 UI 状态帧 ext_status{statuses,widgets,title,working,tap} 与 ext_notify{message,level}。截断口径见 limits 的 dialog*/extNotify*/widget*/status* 项",
    "room.dialogs": "房间等待摘要（P9 A）：room_list 的房间条目（含 auth_result.rooms、list_rooms 回包）给声明了本能力的连接多带 waiting[] 与 waitingPrompt；waiting 只含 dialogId/kind/title/startedAt/timeout/answerable（不带 options/message/prefill），离线房间恒为空；waitingPrompt 是旧的单槽 ui_prompt 兜底信号，只在 waiting 为空时有意义；摘要变化时向设备级 viewer 连接广播 room_waiting{room,waiting,waitingPrompt}（每帧全量，不按订阅过滤，与 room_attention 的对象相同）",
    "session.purge": "删除后清理服务器副本（P9 B）：设备确认删除成功后，relay 清掉该会话的全部副本（名册里的离线房间、正文内存与落盘文件、会话库正文、索引里的旧行只留最小墓碑），并向所有在线 viewer 广播 session_removed{deviceId,ids}（只发给声明了本能力的连接）",
    "session.files": "设备级会话文件命令（P9 B，attach 声明）：attach 能按 sessionId 在设备的整个会话根目录里执行 delete_session，成功回 data{status:deleted|already_deleted,method:trash|unlink|null}",
    "fs.browse": "设备文件夹浏览（P9 C，attach 声明）：attach 能执行 list_dirs{path?,showHidden?}，只返回允许根目录内的目录名（不返回文件、不传文件内容），成功回 data{root,path,parent,entries,truncated}",
    "agent.state": "agent_state 全量快照事件能力位（子智能体胶囊预留：协议/通道先行，当前无生产者）",
    "usage.activity.v1": "使用活动聚合（P10）：extension 只读本机 pi 会话 jsonl，聚合每日 tokens/messages/sessions、模型分布、活跃/连续天数、峰值（本地时区分天、role=user 口径、不含 cost），经本地通道上报 usage_snapshot{deviceId,requestId,snapshot}；relay 校验并按 account+device 缓存，向 viewer 提供 usage_get{deviceId,requestId,force} → usage_snapshot{available,reason?,snapshot?,receivedAt?,stale?}；快照只含聚合计数（无正文/标题/cwd/金额）。旧端兼容：无此 cap 的 relay 收到 usage_get 回 unknown_type（UI 空态），旧 extension 收到 usage_refresh 忽略/unknown_type（relay 降级 unsupported/timeout），新 relay 不向未声明 cap 的 viewer 主动发 usage 帧"
  },
  "errors": {
    "auth_failed": {
      "message": "鉴权失败",
      "retryable": false
    },
    "auth_timeout": {
      "message": "鉴权超时",
      "retryable": true
    },
    "bad_json": {
      "message": "不是合法的 JSON",
      "retryable": false
    },
    "bad_args": {
      "message": "参数错误",
      "retryable": false
    },
    "binary_not_allowed": {
      "message": "只接受 JSON 文本帧",
      "retryable": false
    },
    "payload_too_large": {
      "message": "单帧太大",
      "retryable": false
    },
    "rate_limited": {
      "message": "请求太频繁，稍后再试",
      "retryable": true
    },
    "unknown_type": {
      "message": "不认识的帧类型",
      "retryable": false
    },
    "unknown_command": {
      "message": "不认识的命令",
      "retryable": false
    },
    "unsupported": {
      "message": "当前版本不支持这个操作",
      "retryable": false
    },
    "no_room": {
      "message": "会话不存在",
      "retryable": false
    },
    "room_full": {
      "message": "该会话观看人数已满",
      "retryable": true
    },
    "room_offline": {
      "message": "本机 pi 未连接",
      "retryable": true
    },
    "session_switched": {
      "message": "目标会话已切换，操作未执行",
      "retryable": false
    },
    "busy": {
      "message": "会话正忙",
      "retryable": true
    },
    "compacting": {
      "message": "pi 正在压缩上下文",
      "retryable": true
    },
    "no_model": {
      "message": "pi 未选择模型",
      "retryable": false
    },
    "not_ready": {
      "message": "本机还没准备好",
      "retryable": true
    },
    "queue_timeout": {
      "message": "排队超时，命令未执行",
      "retryable": true
    },
    "queue_locked": {
      "message": "这条消息已注入 pi，不能修改或取消",
      "retryable": false
    },
    "queue_conflict": {
      "message": "这条待发消息已被其他端修改，请重新加载全文后再编辑",
      "retryable": true
    },
    "dialog_claimed": {
      "message": "弹窗已被处理，这次应答没有生效",
      "retryable": false
    },
    "dialog_gone": {
      "message": "弹窗已关闭或等待超时",
      "retryable": false
    },
    "timeout": {
      "message": "超时",
      "retryable": true
    },
    "not_found": {
      "message": "找不到目标",
      "retryable": false
    },
    "no_device": {
      "message": "这台设备从未连接过",
      "retryable": false
    },
    "device_offline": {
      "message": "设备未连接：先在电脑上打开 attach 窗口",
      "retryable": true
    },
    "device_no_active_session": {
      "message": "这台设备没有在跑的会话，先启用/新建一个",
      "retryable": false
    },
    "session_not_found": {
      "message": "这台设备上没有这个会话",
      "retryable": false
    },
    "cwd_not_allowed": {
      "message": "该目录不在这台设备的允许列表里",
      "retryable": false
    },
    "spawn_failed": {
      "message": "本机启动失败",
      "retryable": true
    },
    "harness_busy": {
      "message": "正在启动另一个会话，请稍候",
      "retryable": true
    },
    "pair_invalid": {
      "message": "配对码无效",
      "retryable": false
    },
    "pair_expired": {
      "message": "配对码已过期，请重新生成",
      "retryable": false
    },
    "device_revoked": {
      "message": "这台设备已被撤销，请重新配对",
      "retryable": false
    },
    "device_mismatch": {
      "message": "设备身份与令牌不符",
      "retryable": false
    },
    "offline": {
      "message": "连接已断开",
      "retryable": true
    },
    "result_unknown": {
      "message": "连接中断，命令结果未知，请确认后再操作",
      "retryable": false
    },
    "session_running": {
      "message": "会话正在运行，不能删除",
      "retryable": false
    },
    "session_outside_root": {
      "message": "这个会话不在设备的会话目录里，请在 pi 里删除",
      "retryable": false
    },
    "device_update_required": {
      "message": "这台设备的连接窗口（attach）需要更新",
      "retryable": false
    },
    "fs_outside_root": {
      "message": "不在允许浏览的范围内",
      "retryable": false
    },
    "fs_not_found": {
      "message": "文件夹不存在",
      "retryable": false
    },
    "fs_not_dir": {
      "message": "这不是文件夹",
      "retryable": false
    },
    "fs_denied": {
      "message": "没有权限读取这个文件夹",
      "retryable": false
    },
    "browse_disabled": {
      "message": "这台设备没有开启文件夹浏览",
      "retryable": false
    },
    "internal": {
      "message": "内部错误",
      "retryable": true
    },
    "server_error": {
      "message": "服务端出错",
      "retryable": true
    }
  },
  "limits": {
    "cidMax": 64,
    "deviceNameMax": 64,
    "projectsMax": 64,
    "projectPathMax": 1024,
    "pairCodeLength": 8,
    "pairCodeAlphabet": "23456789ABCDEFGHJKLMNPQRSTUVWXYZ",
    "pairCodeTtlMs": 600000,
    "deviceTokenBytes": 32,
    "dialogOptionsMax": 20,
    "dialogOptionChars": 80,
    "dialogTextMax": 500,
    "dialogTitleMax": 120,
    "dialogSlotsMax": 8,
    "dialogNoteMax": 500,
    "dialogAnswerTimeoutMs": 120000,
    "extNotifyMax": 2000,
    "widgetLinesMax": 50,
    "widgetLineChars": 200,
    "statusTextMax": 200,
    "prefsSubsetMaxBytes": 2048,
    "bodySearchQueryMin": 2,
    "bodySearchQueryMax": 100,
    "bodySearchFilesMax": 200,
    "bodySearchBytesMax": 67108864,
    "bodySearchDeadlineMs": 20000,
    "bodySearchEntryTextMax": 32768,
    "bodySearchMatchesPerSession": 50,
    "bodySearchSnippetsPerSession": 3,
    "bodySearchSnippetChars": 160,
    "bodySearchResultsMax": 20,
    "bodySearchLineMaxBytes": 4194304,
    "dirListMax": 500,
    "dirNameMax": 255,
    "browseRootsMax": 8,
    "usageDaysMax": 400,
    "usageModelsMax": 8,
    "usageSnapshotMaxBytes": 262144,
    "usageRequestTimeoutMs": 8000
  }
} as const;
// @@PROTOCOL_END
const EXT_VERSION = "4.0.0";
/** 本扩展声明的能力（protocol/v4.json 的 caps 键）。
 *  dialog.observe：O1 观察帧已真实生产（dialog_open/close、ext_status、ext_notify）才声明；
 *  dialog.respond：O2 接管应答已落地（beginDialog/noteDialogAnswer，定版说明第一部分 §2）才声明。 */
const CLIENT_CAPS = ["err.v4", "msg.cid", "device.token", "room.label", "sync.v3", "dialog.observe", "dialog.respond", "usage.activity.v1"];

/** 远程命令/注入的失败：code 取自协议错误码表，不认识的一律记 internal */
class RemoteError extends Error {
  code: string;
  /** 已经通过 remote_message_failed 报给观众了，调用方别再报一次 */
  reported = false;
  constructor(code: string, message?: string) {
    const known = Object.prototype.hasOwnProperty.call(PROTOCOL.errors, code);
    super(message || (known ? (PROTOCOL.errors as any)[code].message : code));
    this.code = known ? code : "internal";
  }
}

function remoteErrorCode(e: any): string {
  const code = e && typeof e.code === "string" ? e.code : "";
  return code && Object.prototype.hasOwnProperty.call(PROTOCOL.errors, code) ? code : "internal";
}

/** 网页生成的消息 id：不合法就当没有，退回按文本对号 */
function validCid(v: any): string | undefined {
  return typeof v === "string" && v.length <= PROTOCOL.limits.cidMax && /^[A-Za-z0-9_-]+$/.test(v) ? v : undefined;
}

/** local 通道鉴权帧：有设备令牌就带上（v4 relay 按设备鉴权）；共享 token 照带，旧 relay 只认它 */
function authFrame(env: any = process.env, platform: string = process.platform) {
  const frame: any = {
    type: "auth",
    role: "local",
    proto: PROTOCOL.proto,
    caps: CLIENT_CAPS,
    client: { kind: "extension", version: EXT_VERSION, platform: platformId(platform) },
  };
  const deviceId = String((env && env.PI_REMOTE_DEVICE_ID) || "").trim();
  const deviceToken = String((env && env.PI_REMOTE_DEVICE_TOKEN) || "").trim();
  if (deviceId && deviceToken) {
    frame.deviceId = deviceId;
    frame.deviceToken = deviceToken;
  }
  const token = String((env && env.PI_REMOTE_TOKEN) || "").trim();
  if (token) frame.token = token;
  return frame;
}
/** 清单单帧最多这么多条（按 updatedAt 倒序）；回合结束上报至少间隔这么久 */
const MAX_MANIFEST_BATCH = 200;
/** 清单里的 firstMessage 只留预览。SessionManager.list 给的是首条用户消息全文，不能整段写进帧。 */
const FIRST_MESSAGE_MAX = 200;
const MANIFEST_THROTTLE_MS = 60000;
const MANIFEST_COALESCE_MS = 40;

/** 当前持有连接的 Bridge 登记在 globalThis 上：会话替换后 pi 可能重新求值本模块，
 *  模块级变量会被重置，旧 Bridge 的 socket 就再也关不掉（每次换会话泄漏一条连接）。 */
const BRIDGE_KEY = Symbol.for("pi-remote-sync.bridge");

const SESSION_OPS = new Set(["new_session", "switch_session", "fork", "navigate_tree", "clone"]);
const NAME_SCAN_FILES = 20; // resolveSession 名字回退最多扫这么多个最近会话（限额读，防同步读爆 TUI）
/** 可丢弃的事件（流式 delta / 工具中间输出）：背压时可以丢，message_end / tool_execution_end 会给权威全量。
 *  反过来判定：**其余一律关键**（收尾/元数据/错误丢一个，远端就永久缺状态）。 */
const DROPPABLE_FORWARD = new Set(["message_update", "tool_execution_update", "bash_execution_update", "provider_stream_event"]);

/** 只读命令：不进串行队列，立即执行（读不会和 set_model/compact 交错出问题；排在一条 30s 的 bash 后面才是问题）。
 *  abort / abort_bash 同样必须插队——排在被中断的那条命令后面就永远中断不了。 */
const IMMEDIATE_COMMANDS = new Set([
  "get_state", "get_messages", "get_entries", "get_all_tools", "get_available_models", "get_models",
  "get_available_thinking_levels", "get_thinking_levels", "get_provider_auth", "get_settings", "get_active_tools",
  "get_mcp_servers", "get_system_prompt", "get_entry", "get_labels", "get_children", "get_routing", "get_flags",
  "export_session", "get_scoped_models", "get_last_assistant_text", "get_context_usage", "list_sessions",
  "search_session_bodies",
  "get_commands", "get_fork_messages", "get_tree", "get_git_branch", "get_projection", "get_session_stats",
  "get_file", "get_image", "get_host_diag", "queue_get", "queue_edit", "queue_cancel", "queue_send",
  "rename_session_file", "export_session_file", "fork_session_file",
  "abort", "abort_bash",
]);

/** 单帧上限：relay local 通道 16MB，超限会被顶下线 → 重连 → 再推 → 再被踢。留 4MB 余量 */
const FRAME_MAX_BYTES = 12 * 1024 * 1024;
/** 流式草稿（text/thinking delta）在扩展内合并时的字符上限。message_end 会补权威全文，
 *  这里只防单条超大 delta / 合并窗口迟迟不触发时把进程内存撑爆。 */
const STREAM_DELTA_MAX_CHARS = 256 * 1024;
/** 图片降级阈值：base64 > 128KB 换成结构化占位 {type:"image", mimeType, data:"", omitted:true, omittedBytes} */
const IMAGE_MAX_CHARS = 128 * 1024;
/** get_image 单帧回图上限：base64 字符数。超过就退化为压缩占位（compressed:true、data:""），
 *  不把原图硬塞过单帧上限。留 4MB 给 JSON 外壳和其它字段。 */
const IMAGE_RETURN_MAX_CHARS = FRAME_MAX_BYTES - 4 * 1024 * 1024;
/** 事件投影：非消息类事件里单个字段序列化超过它就换成摘要（turn_end.context 之类 O(会话) 的载荷） */
const HEAVY_FIELD_CHARS = 16 * 1024;
/** 工具中间输出（partialResult 是累积全量）只转尾部这么多字符，权威全量在 tool_execution_end */
const PARTIAL_TAIL_CHARS = 32 * 1024;
/** 流式 delta 合并窗口 / 工具中间输出合并窗口 */
const DELTA_COALESCE_MS = 25;
const TOOL_UPDATE_COALESCE_MS = 120;

/**
 * 转发给远端的 pi 事件全表 —— 契约：**本地终端出现什么，服务器就同时收到什么**（1:1，不聚合、不延迟）。
 *
 * 清单来源 = pi 官方文档的权威事件集合，不是自制筛选：
 *   - docs/json.md 的七张事件表（Agent and turn / Message / Tool execution / Queue and state /
 *     Compaction / Retry / RPC-only）——JSON 与 RPC 两种模式共用的官方 wire 事件集
 *   - docs/extensions.md 生命周期补充：before_agent_start、agent_before_settle、provider_stream_event、
 *     context、context_with_system、user_bash、cache_warming_decision、mcp_servers_change、tool_call、tool_result
 * 早期版本用自制白名单（23 条）：漏登记的事件远端永远看不到，违背“完整镜像”契约，已废止。
 *
 * 纪律：事件**一个不少、顺序不变**，但载荷做投影（projectEvent）：
 *   - message_update 剥掉 partial（与 pi 自己的 JSON/RPC wire 输出一致，json.md §Reconstruct streaming messages）；
 *     连续同类 delta 在 25ms 窗口内拼接成一帧（累加还原结果逐字相同，帧数降一个量级）
 *   - turn_end / agent_before_settle 的 context、context / context_with_system 的 messages、
 *     before_agent_start 的 systemPrompt 都是 O(会话) 的载荷（实测 19 条消息的会话每轮 >150KB），
 *     换成计数摘要；要全量走 get_projection / get_system_prompt 命令
 *   - tool_execution_update 的 partialResult 是累积全量：按 toolCallId 合并（120ms）且只转尾部
 *   - 所有图片 > 128KB 换成结构化占位；system 消息只转元数据
 *   - provider_stream_event 默认不转（UI 不消费，PI_REMOTE_FORWARD_RAW=1 打开）
 * 保护是 send() 的背压：socket 积压超 4MB 才丢可丢帧（流式 delta / 工具中间输出）；
 * 关键帧（快照/状态/回包）也不无限硬塞，积压 + 本帧超过 16MB 就断开重连。
 * 观察型 handler 返回 undefined 即直通——pi 官方示例 debug-provider.ts 就是这个用法。
 */
const FORWARD_EVENTS = [
  // —— 运行周期（json.md §Agent and turn events；extensions.md 补 before_agent_start / agent_before_settle）——
  "before_agent_start",
  "agent_start", "agent_end", "agent_before_settle", "agent_settled",
  "turn_start", "turn_end",
  // —— 消息（json.md §Message events；message_update 是 delta，message_end 是权威完整体）——
  "message_start", "message_update", "message_end",
  // —— 工具（json.md §Tool execution events + extensions.md 的 tool_call / tool_result 钩子）——
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "tool_call", "tool_result",
  // —— provider 原始流 / 提示词与上下文变换（extensions.md；只读转发，返回 undefined 不影响本机行为）——
  "provider_stream_event",
  "context", "context_with_system",
  "user_bash",
  "cache_warming_decision",
  // input 不在此列：它能改写用户要发的正文。原始 input（含图片）不上线，文件末尾单独注册。
  // —— 队列/状态（json.md §Queue and state events + extensions.md）——
  "queue_update", "entry_appended", "session_info_changed", "thinking_level_changed",
  "mcp_servers_change",
  // —— 压缩（json.md §Compaction events；threshold/overflow 自动压缩也在内）——
  "compaction_start", "compaction_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
  // —— 重试（json.md §Retry events）——
  "auto_retry_start", "auto_retry_end",
  // —— RPC/扩展级（json.md §RPC-only events + extensions.md）——
  "bash_execution_update", "extension_error",
  // —— 通知型钩子（extensions.md）：pi 对模型切换/分支跳转**没有对应 wire 事件**，
  //  只读透传补上对称（handler 返回 undefined 无副作用，[探针 probe11] 实测）——
  "model_select", "session_tree", "session_compact_failed",
  // pi 1.0.2：compaction_start / compaction_end 只进会话总线。扩展运行时实际收到的是这两条，
  // forward 里翻译成网页已在听的那两帧。处理函数返回 undefined，不取消压缩、不替换摘要。
  "session_before_compact", "session_compact",
  // —— 其余通知型钩子（[运行时代码] 实证存在）——
  //  thinking_level_select：与 wire thinking_level_changed 同帧双发，多带 previousLevel
  "thinking_level_select",
  //  ui_prompt_start/end：镜像 UI 唯一可观测的跨扩展面（任意扩展开 dialog 时 emit；
  //  只转 kind/title，无内容无响应权——白名单投影在 _forwardNow）
  "ui_prompt_start", "ui_prompt_end",
  //  after_provider_response：provider 健康/限流诊断；headers 白名单投影（防 API key 外泄）
  "after_provider_response",
];

/**
 * 本地生命周期事件：只供扩展自身维护房间（绑房/收尾/项目信任判定），**不转发**——
 * 载荷是活的 ctx / 配置对象，且房间状态本就由扩展自己管理。注册见文件末尾的专用处理器。
 */
const INTERNAL_EVENTS = new Set(["session_start", "session_shutdown", "project_trust"]);

/**
 * pi 官方 RPC 命令别名（docs/rpc-commands.md）：旧名 → 官方名。
 * 远端命令面与 pi 官方 RPC 命令面对齐（v2.5）；旧名保留为别名，前端可平滑迁移。
 */
const RPC_ALIAS: Record<string, string> = {
  get_models: "get_available_models",
  get_thinking_levels: "get_available_thinking_levels",
};

/**
 * pi 官方 RPC 有、但进程内扩展接口没有对应能力的命令：**明确报不支持**。
 * 不自作聪明替 pi 实现：cycle_* 的循环逻辑在 AgentSession（RPC server 只是转发调用它），
 * settings 的实时 setter / 清队列同样只在 RPC server 侧——扩展面确实没有实时接口。
 * 设置文件本身另由 settings_set 白名单写入（additive，重启后生效），不改变这些命令的“不支持热更新”结论。
 */
const RPC_UNSUPPORTED: Record<string, string> = {
  clear_queue: "pi 未提供清空 steer/followUp 队列的进程内接口（队列内容可从 queue_update 事件读）",
  cycle_model: "进程内扩展面无 cycleModel（循环逻辑在 AgentSession，RPC server 只是转发）；请用 get_available_models.available + set_model 自循环",
  cycle_thinking_level: "进程内扩展面无 cycleThinkingLevel（同上）；请用 get_available_thinking_levels + set_thinking_level 自循环",
  set_steering_mode: "进程内扩展面没有实时 setter；可改用 settings_set 写 steeringMode（重启/重载后生效）",
  set_follow_up_mode: "进程内扩展面没有实时 setter；可改用 settings_set 写 followUpMode（重启/重载后生效）",
  set_auto_compaction: "进程内扩展面没有 setter；可改用 settings_set 写 compaction.enabled（重启/重载后生效）",
  set_auto_retry: "自动重试开关是 pi 设置项，扩展面无 setter；settings_set 当前未开放 retry.enabled",
  abort_retry: "扩展面无中断重试的接口",
  export_html: "扩展面无 HTML 导出接口（RPC 模式专有）",
};

/** pi Model 对象的官方线上形态（rpc-commands.md §Model object）+ modelId 别名字段
 *  （本通道既有契约为 {provider, modelId, name}，别名保证两种读法都能用）。 */
function toModel(m: any): any {
  if (!m) return null;
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    provider: m.provider,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: m.input,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
    type: m.type,
    modelId: m.modelId || m.id,
  };
}

/** 没有当前模型时回退的基础档（不含需显式开通的 xhigh/max）。 */
const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
/** pi 思考档全表。xhigh/max 只有 thinkingLevelMap 给出非 undefined 值才保留。 */
const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 当前模型可用的思考级别。
 *  非空 thinkingLevels 原样返回，不看 map；没有当前模型时回退基础五档。
 *  有模型但没有这份数组：reasoning 为假只给 off；否则按 thinkingLevelMap 过滤
 *  （值为 null 的档丢掉；xhigh/max 必须该键的值不是 undefined 才保留）。 */
function availableThinkingLevels(model: any): string[] {
  if (model && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length) return model.thinkingLevels;
  if (!model) return BASE_THINKING_LEVELS.slice();
  if (model.reasoning === false) return ["off"];
  const map = model.thinkingLevelMap;
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

const BUSY_ON = new Set(["agent_start", "turn_start", "message_start"]);
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 20000;
/** 合盖睡眠、换 Wi‑Fi 后 socket 成了半开连接：relay 早判离线了，这边却不会收到任何 close。
 *  全局 WebSocket 没有 ping API，只能自己看：定时器晚到 WAKE_GAP_MS 以上 = 机器刚睡醒，直接重连；
 *  空闲 IDLE_PROBE_MS 没收到 relay 任何帧就发一次 sync，PROBE_DEAD_MS 内还没动静 = 连接已死。 */
const LIVENESS_TICK_MS = 10000;
const WAKE_GAP_MS = 30000;
const IDLE_PROBE_MS = 60000;
const PROBE_DEAD_MS = 20000;

/** 日志写文件，不写 stdout：TUI 模式下 console.log 会打花界面，rpc/json 模式下 stdout 是协议通道，
 *  混进一行日志客户端就解析失败。PI_REMOTE_DEBUG=1 时另抄一份到 stderr。 */
const LOG_FILE = process.env.PI_REMOTE_LOG || require("node:path").join(require("node:os").homedir(), ".pi", "agent", "pi-remote-sync.log");
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LOG_CHECK_EVERY = 200;
let logCalls = 0;

/* ---------------- 诊断（get_host_diag）：最近错误环 + 日志尾部脱敏 ---------------- */
/** get_host_diag 最多回多少条最近错误；只留内存，不落盘 */
const DIAG_ERROR_MAX = 20;
/** get_host_diag.logTail 最多回多少行；只读扩展自己的日志（含轮转出的 .old） */
const LOG_TAIL_LINES = 100;
/** 从日志尾部最多读这么多字节再按行切，避免大日志整文件读进内存 */
const LOG_TAIL_MAX_BYTES = 256 * 1024;
/** 最近错误环形缓冲（进程内）。日志出错点与命令失败回包都会写这里。 */
const diagRecentErrors: Array<{ at: number; message: string; code?: string }> = [];

/**
 * 日志文本脱敏：只给 get_host_diag 用。绝不把 relay token / 设备令牌 / Admin token
 * 原样带回网页；JSON/命令行里的 key=value 与 Bearer/JWT/sk- 形态也一并打码。
 * 宁可多打码，不可漏 token。
 */
function redactDiagText(input: any): string {
  let s = String(input == null ? "" : input);
  // 当前进程拿到的真实密钥值先整段替换（最长优先，避免短 token 是长 token 的前缀时漏尾巴）
  const secrets = [process.env.PI_REMOTE_TOKEN, process.env.PI_REMOTE_DEVICE_TOKEN, process.env.PI_REMOTE_ADMIN_TOKEN]
    .map((v) => String(v || ""))
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) s = s.split(secret).join("***");
  // key=value / key: value / JSON 字段：token/secret/password/apiKey/authorization 等
  s = s.replace(
    /\b(token|secret|password|passwd|api[_-]?key|api[_-]?secret|authorization|auth[_-]?token|device[_-]?token|local[_-]?token|admin[_-]?token|relay[_-]?token|viewer[_-]?token|refresh[_-]?token|access[_-]?token)\b(\s*["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi,
    "$1$2***",
  );
  // URL 查询串里的 token
  s = s.replace(/([?&](?:token|access[_-]?token|device[_-]?token)=)[^&\s#]+/gi, "$1***");
  // HTTP Authorization / 常见供应商密钥
  s = s.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1***");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "***");
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "***");
  return s;
}

/** 记一条诊断错误。message 先脱敏再截断；code 可选（命令失败时带协议码）。 */
function recordDiagError(message: any, code?: string): void {
  try {
    const text = redactDiagText(message).slice(0, 500);
    if (!text) return;
    const entry: { at: number; message: string; code?: string } = { at: Date.now(), message: text };
    if (code) entry.code = String(code);
    diagRecentErrors.push(entry);
    if (diagRecentErrors.length > DIAG_ERROR_MAX) diagRecentErrors.splice(0, diagRecentErrors.length - DIAG_ERROR_MAX);
  } catch {}
}

/** 既有日志点接入：含失败/异常/超时的日志自动进最近错误环。
 *  只做分类，不改变日志格式；真正的命令失败由 sendResult 带 code 单独记一条。 */
const DIAG_ERROR_RE = /(?:失败|异常|错误|超时|拒绝|越权|越界|崩溃|不可用|error|fail(?:ed|ure)?|exception|denied|refused)/i;

function log(...args: any[]) {
  try {
    const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ");
    // 诊断环必须写在 append 之前：日志文件写失败（磁盘满/权限）也要能被告知
    if (DIAG_ERROR_RE.test(text)) {
      let code: string | undefined;
      for (const a of args) {
        if (a && typeof a === "object" && typeof (a as any).code === "string" && Object.prototype.hasOwnProperty.call(PROTOCOL.errors, (a as any).code)) {
          code = (a as any).code;
          break;
        }
      }
      recordDiagError(text, code);
    }
    const line = `${new Date().toISOString()} [pi-remote] ${text}\n`;
    if (process.env.PI_REMOTE_DEBUG === "1") process.stderr.write(line);
    // 每 200 行查一次体积（不是每个进程只查一次）：超过 5MB 轮转成 .old，避免无限增长
    if (++logCalls % LOG_CHECK_EVERY === 0) {
      try {
        if (fs.statSync(LOG_FILE).size > LOG_ROTATE_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + ".old");
      } catch {}
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

/** 只读扩展自己的日志：默认 LOG_FILE，调用方可传 .old；任何异常都回空数组。 */
function tailLogFile(file: string, limit: number): string[] {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= 0) return [];
    const len = Math.min(st.size, LOG_TAIL_MAX_BYTES);
    const start = st.size - len;
    const fd = fs.openSync(file, "r");
    let buf: Buffer;
    try {
      let off = 0;
      const raw = Buffer.alloc(len);
      while (off < len) {
        const n = fs.readSync(fd, raw, off, len - off, start + off);
        if (!n) break;
        off += n;
      }
      buf = off === len ? raw : raw.subarray(0, off);
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    let text = buf.toString("utf8");
    // 从文件中段开始时第一行可能被截断：丢掉这半行，只回完整行
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-Math.max(0, limit)).map((line) => redactDiagText(line).slice(0, 2000));
  } catch {
    return [];
  }
}

/** 日志尾部：当前日志不足 limit 行时，从 .old 尾部补足；合计最多 limit 行。 */
function readLogTail(file: string = LOG_FILE, limit: number = LOG_TAIL_LINES): string[] {
  const cap = Math.max(0, Math.min(1000, Number(limit) || 0));
  if (!cap) return [];
  const current = tailLogFile(file, cap);
  if (current.length >= cap) return current;
  const older = tailLogFile(file + ".old", cap - current.length);
  return older.concat(current).slice(-cap);
}

/** Windows 与 macOS（APFS 默认）路径不分大小写：pi 给 D:\Users\...，调用方可能传 d:\users\...；Linux 区分 */
function caseInsensitivePaths(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** 设备平台标识（room_register.platform，与 attach 的 device_register 一致）：win32→windows、darwin→macos，其余照 Node 的叫法 */
function platformId(platform: string = process.platform): string {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return String(platform || "unknown");
}

function defaultDeviceName(platform: string = process.platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platformId(platform);
}

function pathApiFor(platform: string = process.platform): any {
  return platform === "win32" ? path.win32 : path.posix;
}

/** 绝对路径；本机 POSIX 上再解开符号链接（pi 的 cwd 来自 getcwd()，macOS 的 /tmp 是 /private/tmp） */
function realDir(p: any, platform: string = process.platform): string {
  let resolved = pathApiFor(platform).resolve(String(p));
  if (platform === process.platform && platform !== "win32") {
    try { resolved = fs.realpathSync.native(resolved); } catch {}
  }
  return resolved;
}

function samePath(a: any, b: any, platform: string = process.platform): boolean {
  const x = String(a == null ? "" : a).replace(/\\/g, "/");
  const y = String(b == null ? "" : b).replace(/\\/g, "/");
  if (!x || !y) return false;
  return caseInsensitivePaths(platform) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** PATH 里第一个可执行的 trash 的完整路径（Windows 也找 trash.exe / trash.cmd / trash.bat）；没有返回 ""。 */
function findTrashCommand(platform: string = process.platform, environ: any = process.env): string {
  const raw = String((environ && (environ.PATH || environ.Path || environ.path)) || "");
  if (!raw) return "";
  const dirs = raw.split(platform === "win32" ? ";" : path.delimiter);
  const names = platform === "win32" ? ["trash.exe", "trash.cmd", "trash.bat", "trash"] : ["trash"];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = pathApiFor(platform).join(dir, name);
      if (!fs.existsSync(candidate)) continue;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return "";
}

/** 与 deploy/attach.cjs 同逻辑：Windows 的 trash.cmd 批处理 shim 必须经 cmd.exe，目标走环境变量避免 % 展开。 */
function hasTrashCommand(platform: string = process.platform, environ: any = process.env): boolean {
  return findTrashCommand(platform, environ) !== "";
}

function runTrash(trash: string, target: string, platform: string, environ: any): any {
  const args = target.startsWith("-") ? ["--", target] : [target];
  const opts: any = { encoding: "utf8", timeout: 10000, env: environ };
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(trash)) return spawnSync(trash, args, opts);
  const env = { ...(environ || process.env), PI_REMOTE_TRASH_TARGET: target };
  const comspec = String((environ && environ.ComSpec) || process.env.ComSpec || "cmd.exe");
  const quote = (s: any) => '"' + String(s).replace(/"/g, '""') + '"';
  const line = quote(trash) + (target.startsWith("-") ? " --" : "") + ' "%PI_REMOTE_TRASH_TARGET%"';
  return spawnSync(comspec, ["/d", "/s", "/c", `"${line}"`], { ...opts, env, windowsVerbatimArguments: true });
}

/**
 * 和 pi 删除会话文件一样的动作（P9 §4.2；deploy/attach.cjs 里有一份同逻辑的）：
 * 有 trash 就先移进废纸篓（文件名以 - 开头时按 pi 的写法补 --），失败或已经不在了再 unlink。
 */
function deleteLikePi(
  file: string,
  platform: string = process.platform,
  environ: any = process.env,
): { ok: boolean; method?: "trash" | "unlink"; error?: string } {
  const target = String(file || "");
  const trash = findTrashCommand(platform, environ);
  if (trash) {
    let r: any = null;
    try {
      r = runTrash(trash, target, platform, environ);
    } catch (e: any) {
      r = { error: e };
    }
    if (r && !r.error && (r.status === 0 || !fs.existsSync(target))) return { ok: true, method: "trash" };
  }
  try {
    fs.unlinkSync(target);
    return { ok: true, method: "unlink" };
  } catch (e: any) {
    const code = e && e.code;
    return {
      ok: false,
      error: code === "EACCES" || code === "EPERM" ? "没有权限删除这个文件" : "删除失败：" + (e && e.message ? e.message : e),
    };
  }
}

/**
 * message_update 瘦身：SDK 事件带累积 message 快照 + assistantMessageEvent.partial，
 * wire 上只保留 {type, usage, assistantMessageEvent(无 partial)}（与官方 JSON 流一致，省流量）。
 */
/** 通知钩子载荷白名单投影（_forwardNow 用）：只放行安全字段。 */
const SAFE_RESP_HEADERS = /^(x-ratelimit|x-rate-limit|retry-after|x-request-id|x-should-retry|anthropic-ratelimit|openai-processing|cf-ray|server-timing)/i;
const NOTIFY_PROJECTED = new Set(["after_provider_response", "session_before_compact", "ui_prompt_start", "ui_prompt_end"]);
function projectNotifyEvent(event: any): any {
  try {
    if (event.type === "after_provider_response") {
      const out: any = { type: event.type, status: event.status ?? null };
      const h = event.headers;
      if (h && typeof h === "object") {
        const keep: any = {};
        for (const [k, v] of Object.entries(h)) {
          if (SAFE_RESP_HEADERS.test(k)) keep[k] = typeof v === "string" ? v.slice(0, 200) : v;
        }
        if (Object.keys(keep).length) out.headers = keep;
      }
      return out;
    }
    if (event.type === "session_before_compact") {
      // 不上线 signal、branchEntries、整份 preparation（不可序列化 / 大体积 / 敏感）。
      // 只留计数和生效阈值（settings 是终端 /compact 面板里那套生效值）。
      const p: any = event.preparation || {};
      const out: any = { type: event.type, reason: event.reason ?? null, willRetry: !!event.willRetry };
      if (p.firstKeptEntryId) out.firstKeptEntryId = String(p.firstKeptEntryId);
      if (typeof p.isSplitTurn === "boolean") out.isSplitTurn = p.isSplitTurn;
      if (typeof p.tokensBefore === "number") out.tokensBefore = p.tokensBefore;
      if (p.settings && typeof p.settings === "object") {
        out.settings = { enabled: p.settings.enabled ?? null, reserveTokens: p.settings.reserveTokens ?? null, keepRecentTokens: p.settings.keepRecentTokens ?? null };
      }
      if (p.fileOps && typeof p.fileOps === "object") {
        out.fileOps = { readFiles: Array.isArray(p.fileOps.readFiles) ? p.fileOps.readFiles.length : 0, modifiedFiles: Array.isArray(p.fileOps.modifiedFiles) ? p.fileOps.modifiedFiles.length : 0 };
      }
      if (Array.isArray(p.messagesToSummarize)) out.messagesToSummarize = p.messagesToSummarize.length;
      if (event.customInstructions) out.customInstructions = String(event.customInstructions).slice(0, 500);
      return out;
    }
    if (event.type === "ui_prompt_start" || event.type === "ui_prompt_end") {
      return { type: event.type, reason: event.reason ?? "ui_prompt", kind: event.kind ?? null, title: dialogText(event.title, PROTOCOL.limits.dialogTitleMax) };
    }
  } catch {}
  return null;
}

/* ---------------- 对话框观察（O1：dialog_open/close、ext_status、ext_notify） ----------------
 * 机制（pi 源码查实，审查 TUI 章 §三 N2）：全部扩展共用同一个 uiContext 对象，
 * ctx.ui 是返回它的 getter，方法在调用时按属性查找——把该对象上的 dialog 与
 * fire-and-forget 方法 wrap 一层（捕获入参 → 原样透传原方法），即可被动观测。
 * 这依赖 pi 的实现细节而非文档 API，因此三件纪律是硬验收（定版说明第一部分 §1）：
 *  ①自检：ui_prompt_start 到达而 tap 未捕获到对应调用 → 判失效、回退信号模式（UI 只剩
 *    ui_prompt 等待条，即今天的行为）、Host 诊断 tap 字段可见；
 *  ②fail-open：捕获逻辑全包 try，绝不影响原方法的调用、返回值与抛出；
 *  ③本机零感知：不延迟、不改返回值、不改本机任何呈现。
 * wrap 只做一次并打标记（TAP_TAG）：模块重求值/换会话时新 Bridge 通过 tapSink 接管
 * 已 wrap 的方法，不叠第二层。宿主重设 context（ui 对象换了）时在 ui_prompt_start
 * 的自检路径里自愈重装。
 * 截断口径全部取 PROTOCOL.limits（协议登记值），不在代码里另立数字。 */

/** tap 出口：永远指向当前活跃的 Bridge。已 wrap 方法的闭包只认它，不绑旧实例。 */
const tapSink: { bridge: Bridge | null } = { bridge: null };
const TAP_TAG = "__piRemoteTapV1";
const DIALOG_KINDS = new Set(["select", "confirm", "input", "editor"]);

function dialogText(value: any, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

/** select 选项封顶：最多 dialogOptionsMax 项、每项 dialogOptionChars 字；被截时带 optionsTotal 总数。 */
function capDialogOptions(value: any): { options: string[]; optionsTotal?: number } {
  if (!Array.isArray(value)) return { options: [] };
  const all = value.map((v) => String(v ?? "").slice(0, PROTOCOL.limits.dialogOptionChars));
  const out: { options: string[]; optionsTotal?: number } = { options: all.slice(0, PROTOCOL.limits.dialogOptionsMax) };
  if (all.length > out.options.length) out.optionsTotal = all.length;
  return out;
}

/** 四种 dialog 的入参 → dialog_open 帧（观察形态）。字段口径见 protocol/v4.json 的 dialog.observe。 */
function buildDialogOpen(kind: string, args: any[], dialogId: string, startedAt: number): any {
  const ev: any = { type: "dialog_open", dialogId, kind, startedAt };
  const title = dialogText(args[0], PROTOCOL.limits.dialogTitleMax);
  if (title !== undefined) ev.title = title;
  if (kind !== "editor") {
    const opts = args[2];
    const timeout = opts && typeof opts === "object" ? opts.timeout : undefined;
    if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) ev.timeout = timeout;
  }
  if (kind === "select") Object.assign(ev, capDialogOptions(args[1]));
  else if (kind === "confirm") {
    const message = dialogText(args[1], PROTOCOL.limits.dialogTextMax);
    if (message !== undefined) ev.message = message;
  } else if (kind === "input") {
    const placeholder = dialogText(args[1], PROTOCOL.limits.dialogTextMax);
    if (placeholder !== undefined) ev.placeholder = placeholder;
  } else if (kind === "editor") {
    const prefill = dialogText(args[1], PROTOCOL.limits.dialogTextMax);
    if (prefill !== undefined) ev.prefill = prefill;
  }
  return ev;
}

/** dialog 方法的 wrap：O2 接管判定 → 命中则桥持 promise 等远程裁决；否则 O1 观察路径
 * （捕获 → 原样透传 → settle 时发 dialog_close，原 promise 本体返回，不换对象）。
 * 接管判定全包 try：任何异常都落回透传（fail-open 红线，定版说明第一部分 §2）。 */
function makeDialogMethod(ui: any, orig: any, kind: string): any {
  const wrapped: any = function (...args: any[]) {
    const bridge = tapSink.bridge;
    if (bridge) {
      try {
        const held = bridge.beginDialog(kind, args, () => orig.apply(ui, args));
        if (held) return held;
      } catch {}
    }
    let dialogId: string | null = null;
    try { dialogId = tapSink.bridge ? tapSink.bridge.noteDialogCapture(kind, args) : null; } catch {}
    let result: any;
    try {
      result = orig.apply(ui, args);
    } catch (e) {
      try { if (dialogId && tapSink.bridge) tapSink.bridge.noteDialogClosed(dialogId, "error"); } catch {}
      throw e;
    }
    try {
      if (result && typeof result.then === "function") {
        result.then(
          () => { try { if (dialogId && tapSink.bridge) tapSink.bridge.noteDialogClosed(dialogId, "resolved"); } catch {} },
          () => { try { if (dialogId && tapSink.bridge) tapSink.bridge.noteDialogClosed(dialogId, "rejected"); } catch {} },
        );
      } else if (dialogId && tapSink.bridge) {
        tapSink.bridge.noteDialogClosed(dialogId, "resolved");
      }
    } catch {}
    return result;
  };
  wrapped[TAP_TAG] = kind;
  return wrapped;
}

/** fire-and-forget 方法的 wrap：先捕获、再原样透传，返回值不动。 */
function makeObserveMethod(ui: any, orig: any, name: string): any {
  const wrapped: any = function (...args: any[]) {
    try { if (tapSink.bridge) tapSink.bridge.noteUiObserve(name, args); } catch {}
    return orig.apply(ui, args);
  };
  wrapped[TAP_TAG] = name;
  return wrapped;
}

function stripPartial(event: any): any {
  if (!event || event.type !== "message_update" || !event.assistantMessageEvent) return event;
  const ame = event.assistantMessageEvent;
  const cleanAme: any = {};
  for (const k of Object.keys(ame)) {
    if (k !== "partial") cleanAme[k] = ame[k];
  }
  return { type: "message_update", usage: event.usage, assistantMessageEvent: cleanAme };
}
/** 从 getBranch() 的 entries 里取出消息：条目形如 {type:"message", message:AgentMessage} */
function extractMessages(branch: any[]): any[] {
  if (!Array.isArray(branch)) return [];
  const out: any[] = [];
  for (const e of branch) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "message" && e.message && typeof e.message.role === "string") out.push(e.message);
    else if (typeof e.role === "string") out.push(e); // 兜底：有的路径直接给 message
  }
  return out;
}

function entryTime(t: any): number {
  const n = typeof t === "number" ? t : new Date(t).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** 镜像用的消息序列 = 当前分支路径上的全部条目，按 pi 的 sessionEntryToContextMessages 规则转成消息：
 *  message 原样；custom_message → role:"custom"；branch_summary → branchSummary；compaction → compactionSummary。
 *  只取 type:"message" 会丢掉自定义消息（远程 bash 输出）和压缩/分支摘要——而这些实时 message_end 是会到的，
 *  于是 relay 存储与快照条数对不上，每次重连都整库 reset 重灌。system 消息不进镜像。 */
function mirrorMessages(branch: any[]): any[] {
  if (!Array.isArray(branch)) return [];
  const out: any[] = [];
  for (const e of branch) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "message") {
      const m = e.message;
      if (m && typeof m.role === "string" && m.role !== "system") out.push(addressMirroredMessage(m, e));
    } else if (e.type === "custom_message") {
      const m = { role: "custom", customType: e.customType, content: e.content ?? [], display: e.display, details: e.details, timestamp: entryTime(e.timestamp) };
      out.push(addressMirroredMessage(m, e));
    } else if (e.type === "branch_summary" && e.summary) {
      out.push({ role: "branchSummary", summary: e.summary, fromId: e.fromId, timestamp: entryTime(e.timestamp) });
    } else if (e.type === "compaction") {
      out.push({ role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: entryTime(e.timestamp) });
    } else if (!e.type && typeof e.role === "string" && e.role !== "system") {
      out.push(addressMirroredMessage(e, e));
    }
  }
  return out;
}

/* ---------------- 任务清单（task_list_state） ----------------
 * 事件契约（与网页共用，字段不可增删）：
 *   { type:"task_list_state", tasks:[{ id, content, status:"pending"|"in_progress"|"completed", activeForm? }],
 *     source?:"todo"|"plan", at? }
 * 状态只有两个来源：todo 工具结果的 details、plan-mode 扩展的 custom entry。这里只归一化，
 * 认不出就返回 null（调用方不发），不伪造内容；空数组是合法的“清空”。 */
type TaskStatus = "pending" | "in_progress" | "completed";
type TaskSource = "todo" | "plan";
interface TaskItem {
  id: string;
  content: string;
  status: TaskStatus;
  activeForm?: string;
}

/** pi 的 todo 示例扩展叫 todo；兼容常见别名，不做模糊匹配防误伤其他工具。 */
const TODO_TOOL_NAMES = new Set(["todo", "todos", "todowrite", "todo_write"]);

function isTodoToolName(name: any): boolean {
  return typeof name === "string" && TODO_TOOL_NAMES.has(name.trim().toLowerCase());
}

function normalizeTaskStatus(value: any): TaskStatus | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "in_progress" || s === "inprogress" || s === "running" || s === "active") return "in_progress";
  if (s === "completed" || s === "complete" || s === "done") return "completed";
  if (s === "pending" || s === "todo" || s === "open" || s === "not_started") return "pending";
  return null;
}

function normalizeTaskItem(raw: any, index: number): TaskItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const content =
    typeof raw.content === "string" ? raw.content
    : typeof raw.text === "string" ? raw.text
    : typeof raw.title === "string" ? raw.title
    : "";
  if (!content.trim()) return null;
  let id = "";
  if (typeof raw.id === "string" && raw.id) id = raw.id;
  else if (typeof raw.id === "number" && Number.isFinite(raw.id)) id = String(raw.id);
  else if (typeof raw.step === "number" && Number.isFinite(raw.step)) id = String(raw.step);
  if (!id) id = String(index + 1);
  let status = normalizeTaskStatus(raw.status);
  if (!status) {
    if (typeof raw.done === "boolean") status = raw.done ? "completed" : "pending";
    else if (typeof raw.completed === "boolean") status = raw.completed ? "completed" : "pending";
    else status = "pending";
  }
  const item: TaskItem = { id, content, status };
  if (typeof raw.activeForm === "string" && raw.activeForm.trim()) item.activeForm = raw.activeForm;
  return item;
}

/** 空数组保持空（清空）；非空数组一条都认不出时返回 null，避免坏帧把远端清单清空。 */
function normalizeTaskItems(list: any): TaskItem[] | null {
  if (!Array.isArray(list)) return null;
  const out: TaskItem[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = normalizeTaskItem(list[i], i);
    if (item) out.push(item);
  }
  return list.length && !out.length ? null : out;
}

/** todo 工具结果 details：优先 tasks（Claude 风格），其次 todos（pi todo 示例）。 */
export function taskListFromDetails(details: any): TaskItem[] | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  if (Array.isArray(details.tasks)) return normalizeTaskItems(details.tasks);
  if (Array.isArray(details.todos)) return normalizeTaskItems(details.todos);
  return null;
}

function isPlanModeType(value: any): boolean {
  return typeof value === "string" && value.trim().toLowerCase().replace(/_/g, "-") === "plan-mode";
}

/** plan-mode 扩展 appendEntry("plan-mode", { enabled, executing, todos:[{step,text,completed}] })。 */
export function taskListFromPlanEntry(entry: any): { tasks: TaskItem[]; at?: number } | null {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "custom" && entry.type !== "custom_message") return null;
  if (!isPlanModeType(entry.customType)) return null;
  const data = entry.data && typeof entry.data === "object" ? entry.data : entry.details;
  if (!data || typeof data !== "object" || !Array.isArray(data.todos)) return null;
  const tasks = normalizeTaskItems(data.todos);
  if (!tasks) return null;
  const out: { tasks: TaskItem[]; at?: number } = { tasks };
  const at = entryTime(entry.timestamp);
  if (at) out.at = at;
  return out;
}

/** 当前分支最后一份 todo 工具结果 / plan-mode 条目：按分支顺序，后出现的覆盖先出现的。
 *  两者都没有返回 null（调用方据此不发空帧）。 */
export function taskListFromBranch(branch: any[]): any | null {
  if (!Array.isArray(branch)) return null;
  let found: any = null;
  for (const e of branch) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "message" && e.message && e.message.role === "toolResult" && isTodoToolName(e.message.toolName)) {
      const tasks = taskListFromDetails(e.message.details);
      if (!tasks) continue;
      found = { type: "task_list_state", tasks, source: "todo" as TaskSource };
      const at = entryTime(e.message.timestamp);
      if (at) found.at = at;
    } else if (e.customType) {
      const plan = taskListFromPlanEntry(e);
      if (!plan) continue;
      found = { type: "task_list_state", tasks: plan.tasks, source: "plan" as TaskSource };
      if (plan.at) found.at = plan.at;
    }
  }
  return found;
}

/** 与 relay/store.js 的 contentText/hashOf **逐字一致**：append 模式靠它判断 relay 存储是不是本机分支的前缀 */
function contentTextForHash(m: any): string {
  const c = m && m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (b && b.type === "text" ? b.text || "" : b && b.type === "toolCall" ? `[tool:${b.name}]` : "")).join("");
  if (m && typeof m.summary === "string") return m.summary;
  if (m && typeof m.output === "string") return `${m.command || ""}\n${m.output}`;
  return "";
}
/** 只有这些角色的 timestamp 在实时 message_end 与会话条目里是同一个值；
 *  custom_message / 摘要条目的时间戳是落盘时另取的，参与 hash 就永远对不齐 */
const STAMPED_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);
/** 只取文本前 2048 字符：超大消息过线时会被截断（oversizeFallback 保留头部），hash 必须不受影响 */
function hashOf(m: any): string {
  if (!m || typeof m !== "object") return "";
  const ts = STAMPED_ROLES.has(m.role) ? m.timestamp || "" : "";
  const raw = `${m.role}|${ts}|${contentTextForHash(m).slice(0, 2048)}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

/** 深度降级图片（不改原对象）：没命中返回原引用；命中则只复制命中路径上的容器。
 *  **必须不可变**：输入是会话条目/事件的活引用，就地改写会把 base64 永久换掉——后续模型请求、落盘全被污染。 */
function shrinkDeep(v: any, depth = 0): any {
  if (!v || typeof v !== "object" || depth > 12) return v;
  if (Array.isArray(v)) {
    let out: any[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      const y = shrinkDeep(x, depth + 1);
      if (y !== x) {
        if (!out) out = v.slice();
        out[i] = y;
      }
    }
    return out || v;
  }
  if (v.type === "image" && typeof v.data === "string" && v.data.length > IMAGE_MAX_CHARS) {
    return { ...v, data: "", omitted: true, omittedBytes: Math.floor((v.data.length * 3) / 4) };
  }
  let out: any = null;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (!x || typeof x !== "object") continue;
    const y = shrinkDeep(x, depth + 1);
    if (y !== x) {
      if (!out) out = { ...v };
      out[k] = y;
    }
  }
  return out || v;
}

/** 条目里 get_image 能按 blockIndex 读到的内容块数组；与 cmdGetImage 的 entryContentBlocks 同口径。
 *  没有数组就不返回（不猜位置），调用方也就不写可寻址字段。 */
function entryAddressableBlocks(entry: any): any[] | null {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "message" && entry.message && Array.isArray(entry.message.content)) return entry.message.content;
  if (Array.isArray(entry.content)) return entry.content;
  return null;
}

/** 给内容块里的 image 补 entryId/blockIndex（不改原数组/原块）。blockIndex 必须是条目原始 content
 *  的下标——get_image 按这个下标读原图，投影后数组的下标不能拿来顶替。 */
function addressImageBlocks(blocks: any[], entryId: string): any[] {
  let out: any[] | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block !== "object" || block.type !== "image") continue;
    // 空 data 的图片块没有可补拉的原图（get_image 会报 not_found），不提供假的可点位置。
    if (typeof block.data !== "string" || !block.data) continue;
    if (block.entryId === entryId && block.blockIndex === i) continue;
    if (!out) out = blocks.slice();
    out[i] = { ...block, entryId, blockIndex: i };
  }
  return out || blocks;
}

/** 给消息的顶层图片块补可寻址字段。调用方必须保证 message.content 与条目原始 content 同序。 */
function addressMessageImages(message: any, entryId: string): any {
  if (!message || typeof message !== "object" || !entryId) return message;
  if (!Array.isArray(message.content)) return message;
  const content = addressImageBlocks(message.content, entryId);
  return content === message.content ? message : { ...message, content };
}

/** 会话条目 → 带图片可寻址字段的副本。只在 entry.id 是字符串且 content 能定位时添加。 */
function addressEntryImages(entry: any): any {
  if (!entry || typeof entry !== "object") return entry;
  const entryId = typeof entry.id === "string" ? entry.id : "";
  if (!entryId) return entry;
  if (entry.type === "message" && entry.message && Array.isArray(entry.message.content)) {
    const message = addressMessageImages(entry.message, entryId);
    return message === entry.message ? entry : { ...entry, message };
  }
  if (Array.isArray(entry.content)) {
    const content = addressImageBlocks(entry.content, entryId);
    return content === entry.content ? entry : { ...entry, content };
  }
  return entry;
}

/** 镜像消息 → 只有当 message.content 就是条目原始 content（同一引用）时才补地址：
 *  context_edit / 合成消息的 content 是新数组，blockIndex 对不上 get_image 的原始下标，不能写。 */
function addressMirroredMessage(message: any, entry: any): any {
  const entryId = entry && typeof entry.id === "string" ? entry.id : "";
  if (!entryId || !message || typeof message !== "object" || !Array.isArray(message.content)) return message;
  const raw = entryAddressableBlocks(entry);
  if (!raw || message.content !== raw) return message;
  return addressMessageImages(message, entryId);
}

/** 投影后的消息里有没有因超限被换成占位的图片块（data 已清空、omitted=true）。 */
function projectedHasOmittedImage(message: any): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some((b: any) => b && b.type === "image" && b.omitted === true);
}

/** 原始消息里有没有可补拉的真实图片数据。 */
function rawHasAddressableImage(message: any): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some((b: any) => b && b.type === "image" && typeof b.data === "string" && b.data.length > 0);
}

/** 把原始 content 的真实下标写到**投影后**的图片块上（message_end 投影发生在持久化之前）。
 *  shrinkDeep 对数组逐位映射，所以两边长度与块类型必须完全对齐才写；任何一位对不上就整体不写，
 *  绝不拿投影数组的下标去猜 get_image 的原始下标。 */
function addressProjectedMessage(message: any, rawContent: any[], entryId: string): any {
  if (!entryId || !message || typeof message !== "object" || !Array.isArray(message.content)) return message;
  if (!Array.isArray(rawContent) || rawContent.length !== message.content.length) return message;
  let out: any[] | null = null;
  for (let i = 0; i < message.content.length; i += 1) {
    const shown = message.content[i];
    const raw = rawContent[i];
    if (!shown || typeof shown !== "object" || shown.type !== "image") {
      // 投影只在原块结构上做同类替换；这一位不是图片就要求原位也不是图片，否则说明错位了。
      if (raw && typeof raw === "object" && raw.type === "image") return message;
      continue;
    }
    if (!raw || typeof raw !== "object" || raw.type !== "image") return message;
    if (typeof raw.data !== "string" || !raw.data) continue;
    if (shown.entryId === entryId && shown.blockIndex === i) continue;
    if (!out) out = message.content.slice();
    out[i] = { ...shown, entryId, blockIndex: i };
  }
  return out ? { ...message, content: out } : message;
}

/** 给 message_end 帧补图片地址；只处理带 message 字段的帧。 */
function addressProjectedFrame(frame: any, rawContent: any[], entryId: string): any {
  if (!frame || frame.type !== "message_end" || !frame.message) return frame;
  const message = addressProjectedMessage(frame.message, rawContent, entryId);
  return message === frame.message ? frame : { ...frame, message };
}

/** 原始条目：先补可寻址字段再走图片降级（shrinkDeep 的展开会保留这些字段）。 */
function shrinkEntryDeep(entry: any): any {
  return shrinkDeep(addressEntryImages(entry));
}

/** 大字段摘要：{omitted:true, kind, length?, chars} */
function summarizeField(v: any, chars: number): any {
  return { omitted: true, kind: Array.isArray(v) ? "array" : typeof v, length: Array.isArray(v) ? v.length : undefined, chars };
}

function safeLen(v: any): number {
  try {
    const s = JSON.stringify(v);
    return s ? s.length : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** bash / powershell 的结束文本后缀：超时与中断。只在文本末尾命中时写 termStatus。 */
const TERM_TIMEOUT_SUFFIX = /Command timed out after \d+(?:\.\d+)? seconds\s*$/;
const TERM_ABORTED_SUFFIX = /Command aborted\s*$/;

/** tool_execution_end 的 result.content 文本：数组只拼 text 块；旧形态直接是字符串时照收。 */
function toolResultText(result: any): string {
  if (typeof result === "string") return result;
  const content = result && typeof result === "object" ? result.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/** structuredContent 在 bash 的 tool result 上（tool_execution_end.result.structuredContent）；
 *  兼容未来把同源字段挂到事件顶层的形态。没有就返回 null，不伪造。 */
function toolStructuredContent(event: any): any {
  const result = event && typeof event === "object" ? event.result : null;
  if (result && typeof result === "object" && result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    return result.structuredContent;
  }
  if (event && event.structuredContent && typeof event.structuredContent === "object" && !Array.isArray(event.structuredContent)) {
    return event.structuredContent;
  }
  return null;
}

/** end 帧的自有字段：退出码/墙钟从 structuredContent 抄出，超时/中断从文本后缀识别成枚举。
 *  pi 的 toolResult 落盘历史不带 structuredContent，end 帧是这些信息唯一能带走的时机；
 *  只在命中时写字段，UI 不解析文本。 */
function toolEndFields(event: any): any {
  const extra: any = {};
  const structured = toolStructuredContent(event);
  if (structured) {
    if (typeof structured.exit_code === "number" && Number.isFinite(structured.exit_code)) extra.exit_code = structured.exit_code;
    if (typeof structured.wall_time_seconds === "number" && Number.isFinite(structured.wall_time_seconds)) {
      extra.wall_time_seconds = structured.wall_time_seconds;
    }
  }
  const text = toolResultText(event && event.result);
  // 只有失败的 end 才认后缀：成功命令的普通输出也可能以 "Command aborted" 结尾，
  // 若写进 termStatus 会被 UI 的状态映射（termStatus 优先）误判成已取消。
  if (event && event.isError === true) {
    if (TERM_TIMEOUT_SUFFIX.test(text)) extra.termStatus = "timeout";
    else if (TERM_ABORTED_SUFFIX.test(text)) extra.termStatus = "aborted";
  }
  return extra;
}

/** 文本内容只留尾部（工具中间输出是累积全量，实时预览只需要末尾） */
function tailContent(content: any, max: number): { content: any; cut: boolean } {
  if (!Array.isArray(content)) return { content, cut: false };
  let cut = false;
  const out = content.map((b: any) => {
    if (b && b.type === "text" && typeof b.text === "string" && b.text.length > max) {
      cut = true;
      return { ...b, text: b.text.slice(-max) };
    }
    return b;
  });
  return { content: out, cut };
}

/**
 * 事件载荷投影（见 FORWARD_EVENTS 注释）。返回 null = 不转发。
 * 只换掉 UI 不消费、且体积随会话线性增长的字段；事件本身一个不少。
 */
function projectEvent(event: any): any {
  if (!event || typeof event !== "object") return event;
  const t = event.type;
  switch (t) {
    case "message_update":
      return stripPartial(event);
    case "message_start":
    case "message_end": {
      const m = event.message;
      if (m && m.role === "system") {
        const chars = typeof m.content === "string" ? m.content.length : safeLen(m.content);
        return { type: t, message: { role: "system", timestamp: m.timestamp, chars, omitted: true } };
      }
      const sm = shrinkDeep(m);
      return sm === m ? event : { ...event, message: sm };
    }
    case "entry_appended": {
      // 这条事件自带条目 id：图片块能真实定位，补 entryId/blockIndex 后再降级。
      const entry = event.entry ? addressEntryImages(event.entry) : event.entry;
      const out = entry === event.entry ? event : { ...event, entry };
      return capHeavyFields(shrinkDeep(out), []);
    }
    case "turn_end": {
      const out: any = { type: t };
      for (const k of Object.keys(event)) {
        if (k === "type") continue;
        const v = event[k];
        if (k === "context") out.context = summarizeContext(v);
        else if (k === "entries" && Array.isArray(v)) out.entries = { omitted: true, kind: "array", length: v.length };
        else if (k === "message" || k === "toolResults") out[k] = shrinkDeep(v);
        else out[k] = v;
      }
      return capHeavyFields(out, ["message", "toolResults"]);
    }
    case "agent_before_settle": {
      const out: any = { ...event };
      if ("context" in out) out.context = summarizeContext(out.context);
      if (Array.isArray(out.entries)) out.entries = { omitted: true, kind: "array", length: out.entries.length };
      return capHeavyFields(out, []);
    }
    case "agent_end": {
      const out: any = { ...event };
      if (Array.isArray(out.messages)) {
        out.messageCount = out.messages.length;
        delete out.messages;
      }
      return capHeavyFields(out, []);
    }
    case "context":
    case "context_with_system":
      return { type: t, messageCount: Array.isArray(event.messages) ? event.messages.length : 0 };
    case "before_agent_start": {
      const out: any = { type: t };
      if (typeof event.prompt === "string") out.prompt = event.prompt;
      if (Array.isArray(event.images)) out.images = shrinkDeep(event.images);
      if (typeof event.systemPrompt === "string") out.systemPromptChars = event.systemPrompt.length;
      const o = event.systemPromptOptions;
      if (o && typeof o === "object") {
        out.systemPromptOptions = {
          selectedTools: Array.isArray(o.selectedTools) ? o.selectedTools : undefined,
          contextFiles: Array.isArray(o.contextFiles) ? o.contextFiles.length : undefined,
          skills: Array.isArray(o.skills) ? o.skills.length : undefined,
        };
      }
      return out;
    }
    case "tool_execution_update": {
      const pr = event.partialResult;
      if (pr && typeof pr === "object" && Array.isArray(pr.content)) {
        const { content, cut } = tailContent(pr.content, PARTIAL_TAIL_CHARS);
        const npr: any = { ...pr, content: shrinkDeep(content) };
        if (cut) npr.truncatedHead = true;
        if ("details" in npr && safeLen(npr.details) > HEAVY_FIELD_CHARS) npr.details = summarizeField(npr.details, safeLen(npr.details));
        return { ...event, partialResult: npr };
      }
      return capHeavyFields(event, []);
    }
    case "tool_execution_end": {
      const out = capHeavyFields(shrinkDeep(event), ["result", "args"]);
      const extra = toolEndFields(event);
      // 有字段才复制一层：绝不改写 pi 的活事件对象（会话条目引用同一份）
      return Object.keys(extra).length ? { ...out, ...extra } : out;
    }
    case "tool_execution_start":
      return capHeavyFields(shrinkDeep(event), ["result", "args"]);
    case "tool_result": {
      // 与随后的 toolResult message_end 重复：只留身份与错误位
      const out: any = { type: t };
      for (const k of ["toolCallId", "toolName", "isError"]) if (k in event) out[k] = event[k];
      return out;
    }
    case "provider_stream_event":
      if (!FORWARD_RAW) return null;
      return capHeavyFields(event, []);
    case "queue_update":
      // 自己记的待发队列：两侧都原样留下。不走大字段摘要，8000 字以内的正文要到网页。
      return {
        type: "queue_update",
        steering: Array.isArray(event.steering) ? event.steering : [],
        followUp: Array.isArray(event.followUp) ? event.followUp : [],
      };
    case "remote_queue_state":
      // 扩展自管待发缓冲：item 已在 publish 前做过投影（正文截断、图片只留元数据）。
      return {
        type: "remote_queue_state",
        rev: Number.isFinite(event.rev) && event.rev >= 0 ? Math.floor(event.rev) : 0,
        items: Array.isArray(event.items) ? event.items.slice(0, 120) : [],
      };
    default:
      return capHeavyFields(shrinkDeep(event), []);
  }
}

function summarizeContext(c: any): any {
  if (!c || typeof c !== "object") return c;
  const out: any = { omitted: true };
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (Array.isArray(v)) out[k] = v.length;
    else if (typeof v === "boolean" || typeof v === "number" || v === null) out[k] = v;
  }
  return out;
}

/** 兜底：除 keep 外，任何超过 HEAVY_FIELD_CHARS 的顶层字段换成摘要（防未来新事件带 O(会话) 载荷） */
function capHeavyFields(ev: any, keep: string[]): any {
  if (!ev || typeof ev !== "object") return ev;
  let out: any = null;
  for (const k of Object.keys(ev)) {
    if (k === "type" || keep.includes(k)) continue;
    const v = ev[k];
    if (!v || typeof v !== "object") {
      if (typeof v === "string" && v.length > HEAVY_FIELD_CHARS) {
        if (!out) out = { ...ev };
        out[k] = v.slice(0, HEAVY_FIELD_CHARS);
        out[k + "Truncated"] = v.length;
      }
      continue;
    }
    const n = safeLen(v);
    if (n > HEAVY_FIELD_CHARS) {
      if (!out) out = { ...ev };
      out[k] = summarizeField(v, n);
    }
  }
  return out || ev;
}

/** 可合并的流式 delta：同类型、同 contentIndex、只有 type/contentIndex/delta 三个字段 */
const MERGEABLE_DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
function mergeableDelta(ev: any): boolean {
  const a = ev && ev.type === "message_update" ? ev.assistantMessageEvent : null;
  if (!a || !MERGEABLE_DELTAS.has(a.type) || typeof a.delta !== "string") return false;
  for (const k of Object.keys(a)) if (k !== "type" && k !== "contentIndex" && k !== "delta") return false;
  return true;
}

/** 单条消息过线上限：超长字符串保留头部 + 截断标记（头部保留 ⇒ hashOf 不变） */
const OVERSIZE_STRING_KEEP = 256 * 1024;
function truncateStringsDeep(v: any, max: number, depth = 0): any {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + `\n…[远端镜像已截断 ${v.length - max} 字符]` : v;
  if (!v || typeof v !== "object" || depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => truncateStringsDeep(x, max, depth + 1));
  const o: any = {};
  for (const k of Object.keys(v)) o[k] = truncateStringsDeep(v[k], max, depth + 1);
  return o;
}

/** 超过单帧上限时的降级帧：消息截断长字符串；命令结果改报错；其余事件只留类型 */
function oversizeFallback(obj: any, bytes: number): any {
  if (!obj || typeof obj !== "object") return null;
  const mb = (bytes / 1048576).toFixed(1);
  if (obj.type === "command_result") {
    return { type: "command_result", room: obj.room, id: obj.id, ok: false, code: "payload_too_large", error: `结果过大（${mb}MB，超过单帧上限 ${FRAME_MAX_BYTES / 1048576}MB）；请缩小范围后重试（如 get_entries 的 limit）` };
  }
  if (obj.type === "event" && obj.event && typeof obj.event === "object") {
    const ev = obj.event;
    if (ev.message) return { ...obj, event: { ...ev, message: { ...truncateStringsDeep(ev.message, OVERSIZE_STRING_KEEP), truncated: true } } };
    // 工具卡的身份字段必须留下：丢了 toolCallId，UI 上的卡片永远停在"运行中"。
    // 终端胶囊的退出码/超时枚举同样很小，降级时不能跟着丢掉。
    const keep: any = { type: ev.type, omitted: true, bytes };
    for (const k of ["toolCallId", "toolName", "isError", "exit_code", "wall_time_seconds", "termStatus"]) if (k in ev) keep[k] = ev[k];
    return { ...obj, event: keep };
  }
  return null;
}

/** 发给网页的 queue_update 正文上限。待发镜像留全文，发出去再截到前 8000 字。 */
const QUEUE_BODY_MAX = 8000;
/** 无正文只有图片时的队列占位。pi 1.0.2 正文为空时不从待发数组删除，不能靠 hasPendingMessages() 清掉。 */
const IMAGE_QUEUE_BODY = "（附图）";

/** 待发镜像正文：有 text 留全文，停止交回才能和输入框里的完整排队对上。
 *  没有正文但有图片记「（附图）」；都没有则不记。网页那一帧另截到 QUEUE_BODY_MAX。 */
function queueBody(text: any, images: any): string | null {
  if (typeof text === "string" && text.length > 0) return text;
  if (Array.isArray(images) && images.length > 0) return IMAGE_QUEUE_BODY;
  return null;
}

/** queue_update 上的一条正文。超过上限只留开头，镜像里的全文不动。 */
function clipQueueBody(body: string): string {
  return body.length > QUEUE_BODY_MAX ? body.slice(0, QUEUE_BODY_MAX) : body;
}

/* ---------- 远程自管待发缓冲（P1 §6） ----------
 * 只缓冲远程消息，不碰 pi 原生 steer/followUp 队列（那两套仍由上面的 queue_update 镜像）。
 * 状态机：pending → injected（交给 pi，终态，不可改）/ failed（注入失败，终态）。
 * 编辑/取消只对 pending 生效；位置由数组下标固定，编辑不移动。
 */
type RemoteQueueSegment = "steer" | "follow_up";
type RemoteQueueStatus = "pending" | "injected" | "failed";
type RemoteQueueItem = {
  id: string;
  segment: RemoteQueueSegment;
  source: string;
  text: string;
  /** pi 的图片块（完整 base64）；上线投影只给 mimeType/bytes，不搬图片本体 */
  images: any[];
  status: RemoteQueueStatus;
  cid: string | null;
  at: number;
  updatedAt?: number;
  injectedAt?: number;
  error?: string;
  code?: string;
  /** 用户取消（内部终态标记）：队列里已经移除，但可能还有 cmdQueueSend 的打断等待
   *  持有这条引用——它必须能认出「已取消」，绝不把取消了的消息再注入。 */
  canceled?: boolean;
};

/** 单房间同时待发的远程消息上限；超过就拒绝新消息，不无限吃 TUI 进程内存。 */
const REMOTE_QUEUE_PENDING_MAX = 20;
/** 终态（已注入/失败）只留最近这么多条，给网页标记用；待发条目永不因修剪丢失。 */
const REMOTE_QUEUE_TERMINAL_MAX = 10;
const REMOTE_QUEUE_SOURCE = "web";
/** 单条上线正文上限：20 条 pending + 10 条终态 × 4000 仍能装进 relay 256KB 的补发预算。
 *  注入与扩展内存仍保留全文；只有状态帧/queue_get 快照会截。截断必须带 truncated/textLen
 *  标记（R3-3 第 1 项）：UI 拿截断文本当编辑初值保存会静默丢全文，编辑前须按 id 拉全文。 */
const REMOTE_QUEUE_WIRE_TEXT_MAX = 4000;
/** 单条全文回包（queue_get 的 {id, full:true} 模式）字节上限：一次性命令回包不进状态帧与
 *  relay 补发缓存，但仍须装进单帧（扩展侧帧上限 12MB）。1MB 远超手打长文（网页编辑框上限
 *  10 万字），超过即明确报 payload_too_large，不许再截了假装全文（R3-3 第 1 项定版）。 */
const REMOTE_QUEUE_FULL_TEXT_MAX_BYTES = 1024 * 1024;

function newRemoteQueueId(): string {
  return "rq_" + crypto.randomBytes(6).toString("hex");
}

/** 图片只上报元数据：排队区要显示张数，但 128KB+ 的 base64 不该每帧重发。 */
function remoteQueueImageMeta(images: any[]): { mimeType: string; bytes: number }[] {
  const out: { mimeType: string; bytes: number }[] = [];
  for (const img of Array.isArray(images) ? images : []) {
    if (!img || typeof img !== "object" || typeof img.data !== "string") continue;
    const mimeType = typeof img.mimeType === "string" && img.mimeType ? img.mimeType : "image/png";
    out.push({ mimeType, bytes: Math.floor((img.data.length * 3) / 4) });
  }
  return out;
}

/** 待发正文的版本指纹（FNV-1a 32 位，对全文逐字计算）：queue_edit 乐观并发的基线。
 *  必须对全文算——投影里的截断文本算出的指纹没有比对意义。UI 从状态帧/queue_get
 *  回包拿到它、编辑保存时以 baseHash 回带，扩展比对不符即 queue_conflict，
 *  不许拿旧稿无声覆盖他端的修改（第 3 轮代码审 C-8）。 */
function remoteQueueTextHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 网页/命令看到的单条形状。正文截到 REMOTE_QUEUE_WIRE_TEXT_MAX；图片只带元数据。
 *  截断时必带 truncated:true + textLen（全文长度）——无标记的截断曾让 UI 以截断文本
 *  为编辑初值、保存即丢全文（R3-3 第 1 项）；全文只许经 queue_get 的 full 模式按需拉。
 *  textHash 恒带（全文指纹，与正文是否截断无关），供编辑基线比对与 UI 缓存失效判定。 */
function projectRemoteQueueItem(item: RemoteQueueItem): any {
  const truncated = item.text.length > REMOTE_QUEUE_WIRE_TEXT_MAX;
  const out: any = {
    id: item.id,
    segment: item.segment,
    source: item.source,
    text: truncated ? item.text.slice(0, REMOTE_QUEUE_WIRE_TEXT_MAX) : item.text,
    textHash: remoteQueueTextHash(item.text),
    images: remoteQueueImageMeta(item.images),
    status: item.status,
    at: item.at,
  };
  if (truncated) {
    out.truncated = true;
    out.textLen = item.text.length;
  }
  if (item.cid) out.cid = item.cid;
  if (typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)) out.updatedAt = item.updatedAt;
  if (typeof item.injectedAt === "number" && Number.isFinite(item.injectedAt)) out.injectedAt = item.injectedAt;
  if (typeof item.error === "string" && item.error) out.error = item.error;
  if (typeof item.code === "string" && item.code) out.code = item.code;
  return out;
}

/** 远程消息送达确认用的文本指纹（空白归一 + 截前 500 字） */
function deliveryKey(s: string): string {
  return String(s || "").trim().replace(/\s+/g, " ").slice(0, 500);
}
/** 已归一的指纹是否是同一条消息。pi 会在文本后追加 "\\n\\n[Image ...]"（缩放/转码提示），
 *  空白归一后是 " [Image"。不能用裸 startsWith：短消息 "ok" 会把 "ok, 我来处理" 误认成送达。 */
function deliveryMatches(pendingKey: string, seenKey: string): boolean {
  if (!pendingKey || !seenKey) return false;
  if (seenKey === pendingKey) return true;
  const prefix = pendingKey + " ";
  if (!seenKey.startsWith(prefix)) return false;
  return seenKey.slice(prefix.length).startsWith("[Image");
}
/** 远程消息送达确认窗口：pi 空闲且这么久都没出现这条 user 消息 → 报失败 */
const DELIVERY_TIMEOUT_MS = 15000;
/** 已空闲后仍未被消费的确认窗口。忙时只续等、不按墙钟杀长回合：排队消息可能等一小时以上的工具，
 *  只有 pi 已经空闲、且从登记起超过这个时长仍未出现这条 user 消息，才判送达失败。 */
const DELIVERY_MAX_WAIT_MS = 10 * 60 * 1000;
/** 远程 bash：命令长度上限 / 结果回包保留的输出尾部 / 进模型上下文的输出尾部 */
const BASH_COMMAND_MAX_CHARS = 16000;
const BASH_RESULT_MAX_CHARS = 1024 * 1024;
const BASH_CONTEXT_MAX_CHARS = 100 * 1024;

function normalizeImages(list: any): any[] {
  if (!Array.isArray(list)) return [];
  const out: any[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object" || typeof x.data !== "string" || !x.data) continue;
    out.push({ type: "image", data: x.data, mimeType: typeof x.mimeType === "string" && x.mimeType ? x.mimeType : "image/png" });
  }
  return out;
}

/** 取消息纯文本（string content 或 text 块数组） */
function msgText(m: any): string {
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b && b.type === "text").map((b: any) => String(b.text || "")).join("\n");
  return "";
}
/** content 里有没有图片块。纯附图的 user message_start 正文为空，图片在这里。 */
function contentHasImage(message: any): boolean {
  const c = message && message.content;
  if (!Array.isArray(c)) return false;
  for (const block of c) {
    if (block && block.type === "image") return true;
  }
  return false;
}
/** 敏感键脱敏（键名命中即打码，值递归处理）——get_settings 用。
 *  命中即打码，**不限于 string**：数值型 token/id、布尔开关同样可能泄密。
 *  `token$` 而不是 `token`：maxTokens / reserveTokens / keepRecentTokens 这类**计数**设置
 *  不能被打成 "***"（压缩阈值面板会全变星号）；accessToken / github_token / token 仍命中。 */
const SENSITIVE_KEY = /api[-_]?key|access[-_]?key|signing[-_]?key|private[-_]?key|session[-_]?key|client[-_]?secret|refresh[-_]?token|auth[-_]?token|jwt|passphrase|authorization|secret|password|passwd|credential|bearer|cookie|token$/i;
function redactDeep(v: any): any {
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, val] of Object.entries(v)) {
      // 命中敏感键 → 只把**这一个值**换成占位符并继续循环。
      // 绝不整个 return：否则 get_settings 会返回 {settings:"***"}，整个设置对象丢失。
      if (SENSITIVE_KEY.test(k) && val !== null && val !== undefined) {
        o[k] = "***";
        continue;
      }
      o[k] = redactDeep(val);
    }
    return o;
  }
  return v;
}

/* ================= 设置写桥（settings_set） =================
 *
 * pi 1.3 的扩展 API 只有只读 `pi.getSettings()`；运行中的 SettingsManager 把设置缓存在内存里，
 * 扩展拿不到它的 setter，也没有事件上下文的 reload。即便经 pi 的 jiti alias import 到公开的
 * SettingsManager 类，也只能 create 出第二个实例（改不到宿主实例）。所以写桥只做两件事：
 *   1. 把**白名单字段**合并进 `~/.pi/agent/settings.json`（或 PI_CODING_AGENT_DIR 指定的 agentDir）；
 *   2. 诚实返回 restartRequired——运行中的进程不会热更新。
 * 研究证据、白名单、写后生效条件见 DOC/76-settings-write-bridge.md。
 *
 * 纪律：只写全局 agentDir，不碰项目本地 `.pi/settings.json`；不返回路径、完整设置或任何密钥；
 * 只接受白名单字段（未知字段 bad_args）；现有 JSON 解析失败/顶层不是对象/嵌套容器不是对象时
 * 一律拒绝，绝不覆盖原文件。原子写：同目录 .tmp → fsync → chmod 0600 → rename。 */
const SETTINGS_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SETTINGS_DEFAULT_PROJECT_TRUST = ["ask", "always", "never"];
const SETTINGS_DELIVERY_MODES = ["one-at-a-time", "all"];
const SETTINGS_TOP_LEVEL_FIELDS = new Set([
  "steeringMode", "followUpMode", "hideThinkingBlock", "defaultProjectTrust",
  "enableInstallTelemetry", "enableSkillCommands", "defaultThinkingLevel", "defaultModel", "defaultProvider",
]);
const SETTINGS_NESTED_FIELDS: Record<string, Set<string>> = {
  compaction: new Set(["enabled", "reserveTokens", "keepRecentTokens"]),
  images: new Set(["blockImages", "autoResize"]),
};
const SETTINGS_PATCH_MAX_FIELDS = 32;
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;
const SETTINGS_STRING_MAX = 200;
const SETTINGS_FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function settingsIsObject(v: any): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 全局设置文件路径。与 pi 的 getAgentDir() 同口径：PI_CODING_AGENT_DIR 优先，否则 ~/.pi/agent。
 *  home 可注入，测试用；生产传默认值。不读项目本地设置。 */
function settingsFilePath(env: any = process.env, home: string = os.homedir()): string {
  const raw = String((env && env.PI_CODING_AGENT_DIR) || "").trim();
  let dir: string;
  try {
    if (!raw) dir = path.join(home, ".pi", "agent");
    else if (raw === "~") dir = home;
    else if (/^~[\\/]/.test(raw)) dir = path.join(home, raw.slice(2));
    else if (/^file:\/\//i.test(raw)) dir = fileURLToPath(raw);
    else dir = path.resolve(raw);
  } catch {
    // 不把 env 里的路径/URL 回传；调用方只需要知道“目录配置无法解析”
    throw new RemoteError("internal", "无法解析设置目录（检查 PI_CODING_AGENT_DIR）");
  }
  return path.join(dir, "settings.json");
}

/** IO 失败只回错误码，不回 fs 错误里的绝对路径（避免把用户目录带到远端）。 */
function settingsIoFailure(action: string, e: any): never {
  const code = e && typeof e.code === "string" && /^[A-Z0-9_]+$/.test(e.code) ? e.code : "";
  throw new RemoteError("internal", action + (code ? "（" + code + "）" : ""));
}

function settingsBadArg(field: string, detail: string): never {
  throw new RemoteError("bad_args", "设置 " + field + " " + detail);
}

/** 单个白名单字段的类型/范围校验。值与 pi 1.3 settings-schema 对齐。 */
function validateSettingValue(field: string, value: any): any {
  switch (field) {
    case "steeringMode":
    case "followUpMode":
      if (typeof value !== "string" || SETTINGS_DELIVERY_MODES.indexOf(value) < 0) {
        settingsBadArg(field, "只能是 one-at-a-time 或 all");
      }
      return value;
    case "compaction.enabled":
    case "hideThinkingBlock":
    case "enableInstallTelemetry":
    case "enableSkillCommands":
    case "images.blockImages":
    case "images.autoResize":
      if (typeof value !== "boolean") settingsBadArg(field, "必须是布尔值");
      return value;
    case "compaction.reserveTokens":
    case "compaction.keepRecentTokens":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        settingsBadArg(field, "必须是非负安全整数");
      }
      return value;
    case "defaultProjectTrust":
      if (typeof value !== "string" || SETTINGS_DEFAULT_PROJECT_TRUST.indexOf(value) < 0) {
        settingsBadArg(field, "只能是 ask、always 或 never");
      }
      return value;
    case "defaultThinkingLevel":
      if (typeof value !== "string" || SETTINGS_THINKING_LEVELS.indexOf(value) < 0) {
        settingsBadArg(field, "不是 pi 合法档位（" + SETTINGS_THINKING_LEVELS.join("/") + "）");
      }
      return value;
    case "defaultModel":
    case "defaultProvider": {
      if (typeof value !== "string") settingsBadArg(field, "必须是字符串");
      const text = value.trim();
      if (!text) settingsBadArg(field, "不能为空");
      if (text.length > SETTINGS_STRING_MAX) settingsBadArg(field, "过长（上限 " + SETTINGS_STRING_MAX + " 字符）");
      if (/[\u0000-\u001f\u007f]/.test(text)) settingsBadArg(field, "不能包含控制字符");
      return text;
    }
    default:
      return settingsBadArg(field, "不在写桥白名单");
  }
}

/** 校验补丁并归一成「点号扁平键」→ 值。支持嵌套（compaction/images 对象）与点号扁平两种写法；
 *  未知字段、重复字段、空补丁、model/provider 不成对一律 bad_args。 */
function validateSettingsPatch(patch: any): Record<string, any> {
  if (!settingsIsObject(patch)) throw new RemoteError("bad_args", "settings_set 需要 settings 对象");
  const keys = Object.keys(patch);
  if (!keys.length) throw new RemoteError("bad_args", "settings_set 至少要有一个设置项");
  if (keys.length > SETTINGS_PATCH_MAX_FIELDS) {
    throw new RemoteError("bad_args", "settings_set 一次最多 " + SETTINGS_PATCH_MAX_FIELDS + " 个设置项");
  }
  const out: Record<string, any> = Object.create(null);
  const add = (field: string, value: any) => {
    if (Object.prototype.hasOwnProperty.call(out, field)) settingsBadArg(field, "重复出现");
    out[field] = validateSettingValue(field, value);
  };
  for (const key of keys) {
    if (SETTINGS_FORBIDDEN_KEYS.has(key)) settingsBadArg(key, "不是允许的设置名");
    if (Object.prototype.hasOwnProperty.call(SETTINGS_NESTED_FIELDS, key)) {
      const nested = patch[key];
      if (!settingsIsObject(nested)) settingsBadArg(key, "必须是对象");
      const subKeys = Object.keys(nested);
      if (!subKeys.length) settingsBadArg(key, "不能是空对象");
      for (const sub of subKeys) {
        if (SETTINGS_FORBIDDEN_KEYS.has(sub) || !SETTINGS_NESTED_FIELDS[key].has(sub)) {
          settingsBadArg(key + "." + sub, "不在写桥白名单");
        }
        add(key + "." + sub, nested[sub]);
      }
      continue;
    }
    if (key.indexOf(".") >= 0) {
      const parts = key.split(".");
      if (parts.length !== 2 || !Object.prototype.hasOwnProperty.call(SETTINGS_NESTED_FIELDS, parts[0]) ||
          !SETTINGS_NESTED_FIELDS[parts[0]].has(parts[1])) {
        settingsBadArg(key, "不在写桥白名单");
      }
      add(key, patch[key]);
      continue;
    }
    if (!SETTINGS_TOP_LEVEL_FIELDS.has(key)) settingsBadArg(key, "不在写桥白名单");
    add(key, patch[key]);
  }
  const hasModel = Object.prototype.hasOwnProperty.call(out, "defaultModel");
  const hasProvider = Object.prototype.hasOwnProperty.call(out, "defaultProvider");
  if (hasModel !== hasProvider) {
    throw new RemoteError("bad_args", "defaultModel 与 defaultProvider 必须成对提供（只改一个会留下不匹配的默认模型）");
  }
  return out;
}

/** 从命令参数取补丁：优先 args.settings（协议推荐），兼容 args.patch 与直接平铺；
 *  两种 wrapper 同时出现时明确拒绝，避免歧义。 */
function settingsPatchFromArgs(args: any): any {
  if (!settingsIsObject(args)) throw new RemoteError("bad_args", "settings_set 需要 settings 对象");
  const hasSettings = Object.prototype.hasOwnProperty.call(args, "settings");
  const hasPatch = Object.prototype.hasOwnProperty.call(args, "patch");
  if (hasSettings && hasPatch) throw new RemoteError("bad_args", "settings_set 不能同时带 settings 与 patch");
  if (hasSettings) {
    if (!settingsIsObject(args.settings)) throw new RemoteError("bad_args", "settings_set 的 settings 必须是对象");
    return args.settings;
  }
  if (hasPatch) {
    if (!settingsIsObject(args.patch)) throw new RemoteError("bad_args", "settings_set 的 patch 必须是对象");
    return args.patch;
  }
  return args;
}

/** 读取现有全局设置。文件不存在 = {}；空文件 = {}；坏 JSON / 顶层非对象 / 符号链接 / 非普通文件
 *  一律报错拒绝（宁可写不进去，也不能把用户的设置文件冲掉）。 */
function settingsReadFile(filePath: string, fsImpl: any = fs): { settings: any; existed: boolean } {
  let st: any;
  try {
    st = fsImpl.lstatSync(filePath);
  } catch (e: any) {
    if (e && e.code === "ENOENT") return { settings: {}, existed: false };
    settingsIoFailure("读取设置文件失败", e);
  }
  if (typeof st.isSymbolicLink === "function" && st.isSymbolicLink()) {
    throw new RemoteError("internal", "settings.json 是符号链接；为不替换链接，写桥本次不写入（可改为普通文件或手动修改）");
  }
  if (!st.isFile()) throw new RemoteError("internal", "settings.json 不是普通文件；写桥本次不写入");
  if (Number(st.size) > SETTINGS_FILE_MAX_BYTES) {
    throw new RemoteError("internal", "settings.json 过大（" + st.size + " 字节）；写桥本次不写入");
  }
  let text: string;
  try {
    text = fsImpl.readFileSync(filePath, "utf8");
  } catch (e: any) {
    settingsIoFailure("读取设置文件失败", e);
  }
  const body = String(text || "").replace(/^\uFEFF/, "");
  if (!body.trim()) return { settings: {}, existed: true };
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RemoteError("internal", "现有 settings.json 不是合法 JSON；为不破坏原文件，本次未写入");
  }
  if (!settingsIsObject(parsed)) {
    throw new RemoteError("internal", "现有 settings.json 顶层不是对象；为不破坏原文件，本次未写入");
  }
  return { settings: parsed, existed: true };
}

/** 把扁平补丁合并进现有设置：保留文件里其它键和未知嵌套键（如 modelOverrides），只改白名单命中项。 */
function settingsApplyPatch(base: any, patch: Record<string, any>): any {
  const next: any = { ...(settingsIsObject(base) ? base : {}) };
  for (const field of Object.keys(patch)) {
    const value = patch[field];
    const dot = field.indexOf(".");
    if (dot < 0) {
      next[field] = value;
      continue;
    }
    const parent = field.slice(0, dot);
    const child = field.slice(dot + 1);
    const current = next[parent];
    if (current === undefined) next[parent] = { [child]: value };
    else if (settingsIsObject(current)) next[parent] = { ...current, [child]: value };
    else throw new RemoteError("internal", "现有 settings.json 的 " + parent + " 不是对象；为不破坏原文件，本次未写入");
  }
  return next;
}

/** 原子写：同目录随机 .tmp（wx、0600）→ write → fsync → close → chmod 0600 → rename。
 *  任一环节失败都清理 tmp、原文件保持不变。最后 best-effort fsync 目录（Windows 上忽略失败）。 */
function settingsAtomicWrite(filePath: string, settings: any, fsImpl: any = fs): { bytes: number } {
  const dir = path.dirname(filePath);
  const json = JSON.stringify(settings, null, 2) + "\n";
  try {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    settingsIoFailure("创建设置目录失败", e);
  }
  const tmp = path.join(dir, "." + path.basename(filePath) + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
  let fd: any = null;
  try {
    fd = fsImpl.openSync(tmp, "wx", 0o600);
    fsImpl.writeFileSync(fd, json, "utf8");
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    // umask 可能把 openSync 的 0600 改掉；chmod 保证最终就是 0600（比 pi 自己的 writeFileSync 更严）。
    fsImpl.chmodSync(tmp, 0o600);
    fsImpl.renameSync(tmp, filePath);
  } catch (e: any) {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch {}
    }
    try { fsImpl.unlinkSync(tmp); } catch {}
    if (e instanceof RemoteError) throw e;
    settingsIoFailure("写入设置失败，原文件未改动", e);
  }
  try {
    const dfd = fsImpl.openSync(dir, "r");
    try { fsImpl.fsyncSync(dfd); } finally { fsImpl.closeSync(dfd); }
  } catch {}
  return { bytes: Buffer.byteLength(json, "utf8") };
}

/** 读 → 校验 → 合并 → 原子写。返回 applied（点号扁平）供命令回包；不返回路径/完整设置。 */
function settingsWritePatch(filePath: string, rawPatch: any, options: { fs?: any } = {}): { applied: Record<string, any>; existed: boolean; bytes: number } {
  const fsImpl = options.fs || fs;
  const patch = validateSettingsPatch(rawPatch);
  const current = settingsReadFile(filePath, fsImpl);
  const next = settingsApplyPatch(current.settings, patch);
  const info = settingsAtomicWrite(filePath, next, fsImpl);
  const applied: Record<string, any> = {};
  for (const key of Object.keys(patch)) applied[key] = patch[key];
  return { applied, existed: current.existed, bytes: info.bytes };
}

/** 设备身份。account 缺省 admin；deviceId 为空时 room_register 不带该字段（服务端归未登记）。 */
function deviceIdentity(env: any = process.env, platform: string = process.platform) {
  const accountId = String((env && env.PI_REMOTE_ACCOUNT) || "admin").trim() || "admin";
  const deviceId = String((env && env.PI_REMOTE_DEVICE_ID) || "").trim();
  const fallbackName = defaultDeviceName(platform);
  const deviceName = String((env && env.PI_REMOTE_DEVICE_NAME) || fallbackName).trim() || fallbackName;
  return { accountId, deviceId, deviceName, platform: platformId(platform) };
}

function attachStatePath(env: any = process.env) {
  const override = env && env.PI_REMOTE_ATTACH_FILE;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), ".pi", "agent", "remote-attach.json");
}

/**
 * 窗口是否允许连接。raw 为状态文件正文；null/空 = 文件不存在。
 * PI_REMOTE_ALWAYS_ONLINE=1 时直接放行。expiresAt < now、JSON 损坏、deviceId 与 .env 不一致都关闭。
 */
/** 进程是否还活着：signal 0 只探测不发信号。EPERM = 存在但无权限，也算活着。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return !!(e && e.code === "EPERM");
  }
}

function evaluateAttachWindow(raw: any, env: any, now: number, alive: (pid: number) => boolean = pidAlive) {
  const environ = env || process.env;
  if (String(environ.PI_REMOTE_ALWAYS_ONLINE || "") === "1") return { ok: true, reason: "always" };
  if (raw == null || raw === "") return { ok: false, reason: "missing" };
  let state: any;
  try {
    state = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) return { ok: false, reason: "parse" };
  const exp = Number(state.expiresAt);
  if (!Number.isFinite(exp) || exp < now) return { ok: false, reason: "expired" };
  const want = String(environ.PI_REMOTE_DEVICE_ID || "").trim();
  const got = String(state.deviceId || "").trim();
  if (!want || got !== want) return { ok: false, reason: "device" };
  // 窗口进程被强杀（任务管理器结束、断电）时来不及删状态文件：pid 已不存在就按窗口已关处理，
  // 不能一直放行到 expiresAt。没有 pid 字段的旧状态文件保持原行为。
  if (state.pid != null && state.pid !== "" && !alive(Number(state.pid))) return { ok: false, reason: "dead" };
  return { ok: true, reason: "open", state };
}

function clipFirstMessage(value: any) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (!text) return null;
  return text.length > FIRST_MESSAGE_MAX ? text.slice(0, FIRST_MESSAGE_MAX) : text;
}

function readAttachWindow(file: string, env: any, now: number) {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = null;
  }
  return evaluateAttachWindow(raw, env, now);
}

function attachWindowOpen(file: string, env: any, now: number) {
  return readAttachWindow(file, env, now).ok;
}

/**
 * get_host_diag 的 attach 段：沿用 evaluateAttachWindow 的同一套窗口判定，
 * 但即使窗口已过期/设备不符也把文件里可读的 expiresAt / deviceId 带上，方便诊断。
 * 只读连接窗口自己的状态文件，不碰 cwd 之外的其它文件。
 */
function attachDiagState(env: any = process.env, now: number = Date.now()) {
  const file = attachStatePath(env);
  let state: any = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
  } catch {}
  let active = false;
  try { active = readAttachWindow(file, env, now).ok; } catch {}
  const out: any = { active };
  if (state) {
    const exp = Number(state.expiresAt);
    if (Number.isFinite(exp)) out.expiresAt = exp;
    const deviceId = String(state.deviceId || "").trim();
    if (deviceId) out.deviceId = deviceId;
  }
  return out;
}

/* ---------------- get_file：当前会话 cwd 内的只读文件 ---------------- */
/** 单个文件上限 5MB：文本可截断，图片不截断（截断的 base64 不是有效图片）。 */
const FILE_MAX_BYTES = 5 * 1024 * 1024;
const FILE_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const FILE_TEXT_MIME: Record<string, string> = {
  txt: "text/plain", text: "text/plain", log: "text/plain", ini: "text/plain", conf: "text/plain", toml: "text/plain",
  md: "text/markdown", markdown: "text/markdown",
  json: "application/json", jsonl: "application/x-ndjson",
  js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", jsx: "text/plain", ts: "text/plain", tsx: "text/plain",
  css: "text/css", html: "text/html", htm: "text/html", xml: "application/xml", svg: "image/svg+xml",
  yml: "application/yaml", yaml: "application/yaml", csv: "text/csv",
  sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript",
  py: "text/x-python", go: "text/plain", rs: "text/plain", java: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain", hpp: "text/plain",
  sql: "text/plain", env: "text/plain",
};

/** 按扩展名分类：png/jpeg/gif/webp 走 base64，其余按 UTF-8 文本读（未知扩展再按内容嗅探二进制）。 */
function mimeForFile(name: any): { kind: "image" | "text"; mimeType: string } {
  const base = String(name || "");
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (Object.prototype.hasOwnProperty.call(FILE_IMAGE_MIME, ext)) return { kind: "image", mimeType: FILE_IMAGE_MIME[ext] };
  if (Object.prototype.hasOwnProperty.call(FILE_TEXT_MIME, ext)) return { kind: "text", mimeType: FILE_TEXT_MIME[ext] };
  return { kind: "text", mimeType: "text/plain" };
}

/** target 是否在 root 之内（含 root 本身）；path.relative 同时处理 `..` 与绝对路径越界。 */
function pathWithin(root: string, target: string, platform: string = process.platform): boolean {
  const pa = pathApiFor(platform);
  // Windows 长路径 realpath 可能带 \\?\ 前缀：两侧去掉再比，避免同一个目录因前缀不同被判越界
  const clean = (value: string) => platform === "win32" ? String(value).replace(/^\\\\\?\\/, "") : String(value);
  const rel = pa.relative(clean(root), clean(target));
  if (!rel) return true;
  return rel !== ".." && !rel.startsWith(".." + pa.sep) && !pa.isAbsolute(rel);
}

function fileAccessError(e: any): RemoteError {
  const c = e && e.code;
  if (c === "ENOENT" || c === "ENOTDIR") return new RemoteError("not_found", "找不到这个文件");
  if (c === "EACCES" || c === "EPERM") return new RemoteError("unsupported", "没有权限读取这个文件");
  if (c === "ELOOP") return new RemoteError("unsupported", "符号链接循环，无法读取这个文件");
  return new RemoteError("internal", "读取文件失败：" + String((e && e.message) || e));
}

/**
 * 路径监狱：相对路径按 root（当前会话 cwd）解析，绝对路径也必须落在 root 内。
 * 先用字面路径挡 `..`，再 realpath 挡符号链接逃逸；返回真实路径供后续 open。
 */
function resolveFileInRoot(root: any, requested: any, platform: string = process.platform): string {
  if (typeof requested !== "string" || !requested.trim()) throw new RemoteError("bad_args", "get_file 需要 path");
  if (requested.indexOf("\0") >= 0) throw new RemoteError("bad_args", "path 含非法字符");
  if (requested.length > 4096) throw new RemoteError("bad_args", "path 过长");
  const wantRoot = String(root || "");
  if (!wantRoot.trim()) throw new RemoteError("not_ready", "当前会话没有 cwd，无法限定文件范围");
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(wantRoot);
  } catch {
    rootReal = realDir(wantRoot, platform);
  }
  const pa = pathApiFor(platform);
  const candidate = pa.isAbsolute(requested) ? pa.resolve(requested) : pa.resolve(rootReal, requested);
  // 字面包含只在 realpath 失败时用于区分「越界」与「不存在」：
  // macOS 的 /tmp、/var 本身是符号链接，绝对路径按字面比会被误判成越界。
  const lexicalInside = pathWithin(rootReal, candidate, platform);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch (e: any) {
    if (!lexicalInside) throw new RemoteError("cwd_not_allowed", "路径越界：只能读取当前会话目录内的文件");
    throw fileAccessError(e);
  }
  if (!pathWithin(rootReal, real, platform)) throw new RemoteError("cwd_not_allowed", "路径越界：符号链接指向当前会话目录之外");
  return real;
}

/** 从 fd 读最多 max 字节（不把整个大文件读进内存）。 */
function readFdBytes(fd: number, max: number): Buffer {
  const len = Math.max(0, Math.min(Number(max) || 0, FILE_MAX_BYTES));
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, off);
    if (!n) break;
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
}

/** 严格 UTF-8 解码；截断读只允许裁掉末尾不完整的最多 3 个字节。 */
function decodeUtf8Prefix(buf: Buffer, cutTail: boolean): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    if (!cutTail) return null;
    for (let cut = 1; cut <= 3 && cut < buf.length; cut++) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, buf.length - cut));
      } catch {}
    }
    return null;
  }
}

/**
 * 读取 root 内一个普通文件，返回 get_file 契约：
 *   { name, mimeType, size, encoding:"utf8"|"base64", data, truncated }
 * 安全边界：只读普通文件（目录/管道/设备拒绝）、路径与符号链接都不能逃出 root。
 * 文本超过 5MB 返回前 5MB 并 truncated:true；图片超过 5MB 明确拒绝（半张 base64 无法渲染）。
 */
function readFileInRoot(root: any, requested: any, platform: string = process.platform) {
  const real = resolveFileInRoot(root, requested, platform);
  let fd: number;
  try {
    fd = fs.openSync(real, "r");
  } catch (e: any) {
    throw fileAccessError(e);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new RemoteError("unsupported", "只能读取普通文件（目录、管道、设备文件不支持）");
    const size = Number(st.size);
    if (!Number.isFinite(size) || size < 0) throw new RemoteError("internal", "文件大小读不出来");
    const name = path.basename(real);
    const info = mimeForFile(name);
    if (info.kind === "image") {
      if (size > FILE_MAX_BYTES) {
        throw new RemoteError("payload_too_large", `图片过大（${size} 字节，上限 ${FILE_MAX_BYTES} 字节），不返回截断的图片`);
      }
      const buf = readFdBytes(fd, size);
      return { name, mimeType: info.mimeType, size: buf.length, encoding: "base64", data: buf.toString("base64"), truncated: false };
    }
    const buf = readFdBytes(fd, Math.min(size, FILE_MAX_BYTES));
    // 二进制嗅探：NUL 或非法 UTF-8 都明确报不支持，不把乱码当文本回给网页
    if (buf.includes(0)) throw new RemoteError("unsupported", "二进制文件不支持预览（只支持 UTF-8 文本与 png/jpeg/gif/webp 图片）");
    const truncated = size > buf.length;
    const data = decodeUtf8Prefix(buf, truncated);
    if (data == null) throw new RemoteError("unsupported", "不是 UTF-8 文本文件，二进制不支持预览");
    return { name, mimeType: info.mimeType, size, encoding: "utf8", data, truncated };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/* ---------------- get_host_diag：pi 版本只读 ---------------- */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * 从 pi 包自己的 package.json 读版本（不执行外部命令、不依赖 PATH）。
 * 查找起点：显式参数 → process.argv[1]（pi 的 cli.js）→ require.main；逐级向上找
 * name === "@earendil-works/pi-coding-agent" 的 package.json。找不到回 null。
 */
function readPiVersion(start?: any): string | null {
  const starts: string[] = [];
  const seen = new Set<string>();
  const push = (value: any) => {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return;
    let real = raw;
    try { real = fs.realpathSync(raw); } catch {}
    if (seen.has(real)) return;
    seen.add(real);
    starts.push(real);
  };
  push(start);
  push(process.argv[1]);
  try { push(require.main && require.main.filename); } catch {}
  try { push(require.resolve(PI_PACKAGE_NAME)); } catch {}
  for (const startPath of starts) {
    let dir = startPath;
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
    } catch {
      dir = path.dirname(dir);
    }
    for (let depth = 0; depth < 12 && dir; depth++) {
      const pkgFile = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
        if (pkg && pkg.name === PI_PACKAGE_NAME && typeof pkg.version === "string" && pkg.version.trim()) {
          return pkg.version.trim();
        }
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** 连接窗口关闭时给老式配置的醒目提示。老配置只有 PI_REMOTE_RELAY/PI_REMOTE_TOKEN，
 *  没有 PI_REMOTE_DEVICE_ID 时窗口文件永远匹配不上——以前这里静默不连接，用户只会以为扩展坏了。
 *  只返回文案，不改启用逻辑（PI_REMOTE_ALWAYS_ONLINE=1 仍然直接放行）。 */
function attachGateHint(verdict: any, env: any, file: string) {
  const reason = verdict && verdict.reason;
  const windowFile = String(file || "");
  const deviceId = String((env && env.PI_REMOTE_DEVICE_ID) || "").trim();
  if (reason === "missing") {
    return "警告：连接窗口文件不存在（" + windowFile + "），relay 未连接。"
      + (deviceId ? "" : "当前没有 PI_REMOTE_DEVICE_ID，老式 PI_REMOTE_RELAY/PI_REMOTE_TOKEN 配置不会连接；")
      + "请在网页上打开 attach 窗口（并确保 PI_REMOTE_DEVICE_ID 已配置），或临时设 PI_REMOTE_ALWAYS_ONLINE=1。";
  }
  if (reason === "device") {
    return deviceId
      ? "警告：attach 窗口的 deviceId 与本机 PI_REMOTE_DEVICE_ID（" + deviceId + "）不一致（" + windowFile + "），relay 未连接；请重新打开 attach 窗口。"
      : "警告：缺少 PI_REMOTE_DEVICE_ID，attach 窗口（" + windowFile + "）无法匹配，relay 不会连接；请配置设备编号后重新打开 attach 窗口，或临时设 PI_REMOTE_ALWAYS_ONLINE=1。";
  }
  if (reason === "parse") return "警告：连接窗口文件损坏（" + windowFile + "），relay 未连接；请重新打开 attach 窗口。";
  if (reason === "dead") return "警告：连接窗口所属进程已退出（" + windowFile + "），relay 未连接；请重新打开 attach 窗口。";
  return null; // expired 是正常轮换，不刷日志
}

/** 公网 ws:// 的醒目提示：不拒绝连接（避免当前部署直接失联），只把明文传输风险写进日志。 */
function insecureRelayWarning(relayUrl: any) {
  let u: URL;
  try {
    u = new URL(String(relayUrl || ""));
  } catch {
    return null;
  }
  if (u.protocol !== "ws:") return null;
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const loopback = host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  if (loopback) return null;
  return "警告：relay 地址 " + relayUrl + " 使用明文 ws:// 且不是本机回环地址，token 与消息会在网络上明文传输；建议改用 wss:// 或 SSH 隧道。";
}

function toEpoch(v: any): number {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  // SessionManager.list 的 created/modified 是 Date 对象，不是字符串：
  // 以前只认 number/string，清单里所有会话的 updatedAt 都变成 0，排序和“最近会话”全失效。
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof v === "string" && v) {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
    const asNum = Number(v);
    if (Number.isFinite(asNum)) return asNum < 1e12 ? Math.round(asNum * 1000) : Math.round(asNum);
  }
  return 0;
}

/** 当前 cwd 加上 PI_REMOTE_PROJECTS，去重。清单以这些目录的 SessionManager.list 为准。 */
function manifestProjectDirs(cwd: any, env: any = process.env, platform: string = process.platform) {
  const parts = String((env && env.PI_REMOTE_PROJECTS) || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (cwd) parts.push(String(cwd));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    let resolved = p;
    try {
      // 符号链接要解开：pi 按真实路径给会话目录起名，白名单写链接时 SessionManager.list 会扑空
      resolved = realDir(p, platform);
    } catch {}
    const key = caseInsensitivePaths(platform) ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/** 父会话路径归一：SessionInfo 叫 parentSessionPath、文件头/清单行叫 parentSession，两口径同值。 */
function sessionParentPathOf(raw: any): string | null {
  const value = raw && (raw.parentSession ?? raw.parentSessionPath);
  return typeof value === "string" && value ? value.replace(/\\/g, "/") : null;
}

function normalizeSessionEntry(raw: any, cwd: any) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const filePath = raw.path ? String(raw.path) : "";
  let sizeBytes = Number(raw.sizeBytes ?? raw.size);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    sizeBytes = 0;
    if (filePath) {
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {}
    }
  }
  const messageCount = Number(raw.messageCount);
  return {
    id,
    path: filePath.replace(/\\/g, "/"),
    name: raw.name ? String(raw.name) : null,
    cwd: String(raw.cwd || cwd || "").replace(/\\/g, "/"),
    firstMessage: clipFirstMessage(raw.firstMessage),
    messageCount: Number.isFinite(messageCount) ? messageCount : 0,
    sizeBytes,
    createdAt: toEpoch(raw.createdAt ?? raw.created),
    updatedAt: toEpoch(raw.updatedAt ?? raw.modified ?? raw.updated),
    // fork 谱系（R3-3 第 3 项）：父会话文件路径。数据源已核实——pi 的 SessionHeader.parentSession
    // 与 SessionManager.list 的 SessionInfo.parentSessionPath 同值同义，都是 fork 时写下的父路径。
    parentSession: sessionParentPathOf(raw),
  };
}

/** 全量或增量清单帧。超过 maxBatch 时只留 updatedAt 最新的一批，并标 truncated。 */
function buildSessionManifest(opts: any) {
  const now = Number(opts && opts.now) || Date.now();
  const activeId = opts && opts.activeId != null ? String(opts.activeId) : "";
  const maxBatch = Number(opts && opts.maxBatch) > 0 ? Number(opts.maxBatch) : MAX_MANIFEST_BATCH;
  const rows = (opts && Array.isArray(opts.sessions) ? opts.sessions : []).map((s: any) => ({
    id: String(s.id),
    path: s.path ? String(s.path) : "",
    name: s.name ? String(s.name) : null,
    cwd: s.cwd ? String(s.cwd) : "",
    firstMessage: clipFirstMessage(s.firstMessage),
    messageCount: Number(s.messageCount) || 0,
    sizeBytes: Number(s.sizeBytes) || 0,
    createdAt: Number(s.createdAt) || 0,
    updatedAt: Number(s.updatedAt) || 0,
    parentSession: sessionParentPathOf(s),
    active: !!activeId && String(s.id) === activeId,
  }));
  rows.sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)));
  let sessions = rows;
  let truncated = false;
  if (rows.length > maxBatch) {
    sessions = rows.slice(0, maxBatch);
    truncated = true;
    // 截断也要保住活动会话那一行：否则 >200 会话时全量帧里可能一个 active 都没有，
    // 手机端「现在开着哪个」直接丢（用末尾位置换，不要打乱 updatedAt 倒序）
    const active = activeId ? rows.find((r: any) => r.id === activeId) : null;
    if (active && !sessions.some((r: any) => r.id === active.id)) {
      sessions = [...sessions.slice(0, Math.max(0, maxBatch - 1)), active];
    }
  }
  const frame: any = {
    type: "session_manifest",
    accountId: (opts && opts.accountId) || "admin",
    deviceId: (opts && opts.deviceId) || "",
    full: !!(opts && opts.full),
    updatedAt: now,
    sessions,
    removed: opts && Array.isArray(opts.removed) ? opts.removed.map((id: any) => String(id)).filter(Boolean) : [],
  };
  if (!frame.deviceId) delete frame.deviceId;
  if (truncated) frame.truncated = true;
  return frame;
}

function sessionIdFromPath(p: any) {
  const base = path.basename(String(p || "")).replace(/\.jsonl$/i, "");
  const i = base.lastIndexOf("_");
  if (i >= 0 && i < base.length - 1) return base.slice(i + 1);
  return base;
}

/** 只读会话文件第一行头，取出 session id。读失败则退回文件名。 */
function sessionIdFromFile(p: string) {
  let fd: any = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    const line = buf.slice(0, n).toString("utf8").split(/\r?\n/, 1)[0];
    const header = JSON.parse(line);
    if (header && header.type === "session" && header.id) return String(header.id);
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return sessionIdFromPath(p);
}

async function defaultSessionLister(cwd: string) {
  const pkg: any = await import("@earendil-works/pi-coding-agent");
  const SM = pkg && (pkg.SessionManager || (pkg.default && pkg.default.SessionManager));
  if (!SM || typeof SM.list !== "function") return [];
  return (await SM.list(cwd)) || [];
}

/** ================= 未载入会话的文件级操作（不需要活动房间） =================
 *  改名/导出/冷 fork 都只碰目标 .jsonl：路径先过 jailSessionPath，再按文件自身解析。
 *  改名与冷 fork 是**纯文件实现**，不依赖 pi 包；大文件逐块流式扫描/写出，内存上限是
 *  “单行字节数”，不会把整份会话读进内存。损坏行、越界路径、权限错误仍然明确报错。 */
const SESSION_FILE_EXPORT_DEFAULT_BYTES = 512 * 1024;
const SESSION_FILE_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_FILE_TEXT_READ_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_FILE_SCAN_CHUNK = 256 * 1024;
/** 单行上限：一行可能含 base64 图片，允许远大于 8MB，但不能无界。 */
const SESSION_FILE_LINE_MAX_BYTES = 64 * 1024 * 1024;
const SESSION_INFO_NAME_MAX = 200;

function formatBytes(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1) + " MB";
  if (v >= 1024) return Math.round(v / 1024) + " KB";
  return v + " B";
}

/** fs 错误 → 带真实原因的 RemoteError。没有权限不能伪装成“文件不存在”。 */
function sessionFileError(e: any, action: string): RemoteError {
  if (e instanceof RemoteError) return e;
  const code = e && typeof e.code === "string" ? e.code : "";
  const detail = String((e && e.message) || e || "未知错误");
  if (code === "ENOENT") return new RemoteError("not_found", action + "失败：文件不存在（" + detail + "）");
  if (code === "EACCES" || code === "EPERM") return new RemoteError("internal", action + "失败：没有权限（" + detail + "）");
  if (code === "EISDIR") return new RemoteError("bad_args", action + "失败：目标是目录");
  return new RemoteError("internal", action + "失败：" + detail);
}

/** 严格读取会话文件：每条非空行都必须是 JSON 对象，且要有合法 session 头。
 *  与 pi 的宽容加载不同：改名/冷 fork 写回时不能把损坏行留在新文件里，所以这里先明确报错。 */
function readSessionFileStrict(p: string, action: string): { text: string; header: any; entries: any[] } {
  let st: any;
  try { st = fs.statSync(p); } catch (e: any) { throw sessionFileError(e, action); }
  if (!st.isFile()) throw new RemoteError("bad_args", action + "失败：不是普通文件");
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch (e: any) { throw sessionFileError(e, action); }
  const lines = text.split(/\r?\n/);
  const parsed: any[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    let entry: any;
    try { entry = JSON.parse(lines[i]); } catch { throw new RemoteError("internal", action + "失败：会话文件第 " + (i + 1) + " 行不是合法 JSON（文件可能损坏）"); }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RemoteError("internal", action + "失败：会话文件第 " + (i + 1) + " 行不是 pi 会话条目（文件可能损坏）");
    }
    parsed.push(entry);
  }
  // pi 会话文件的第一条非空行必须是 session 头；后面再出现“session”条目按普通损坏数据拒绝。
  const header = parsed.length ? parsed[0] : null;
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw new RemoteError("internal", action + "失败：不是有效的 pi 会话文件（缺少 session 头）");
  }
  return { text, header, entries: parsed.slice(1) };
}

/** 流式扫描得到的条目元数据。只保留定位/链信息，不缓存正文；大文件的内存与正文大小无关。 */
type SessionEntryMeta = {
  id: string;
  parentId: string | null;
  type: string;
  role: string;
  offset: number;
  length: number;
  firstKeptEntryId?: string;
};

type SessionFileScan = {
  header: any;
  size: number;
  entryCount: number;
  messageCount: number;
  lastId: string | null;
  latestSessionName: string;
  endsWithNewline: boolean;
  byId: Map<string, SessionEntryMeta> | null;
  labels: Map<string, { label: string; timestamp?: string }> | null;
};

/** 严格流式扫描会话文件：逐块读、逐行 JSON 解析，不把整份文件读进内存。
 *  - 每条非空行必须是 JSON 对象；第一行必须是合法 session 头；后面的 session 头视为损坏。
 *  - entries=true 时额外建 id→元数据 索引与 label 表（冷 fork 用），正文仍不驻留。
 *  - 损坏/超长行/IO 错误都明确报 error；调用方不会拿到半份结果去写文件。 */
function scanSessionFile(p: string, action: string, opts: { entries?: boolean } = {}): SessionFileScan {
  let st: any;
  try { st = fs.statSync(p); } catch (e: any) { throw sessionFileError(e, action); }
  if (!st.isFile()) throw new RemoteError("bad_args", action + "失败：不是普通文件");
  const byId = opts.entries ? new Map<string, SessionEntryMeta>() : null;
  const labels = opts.entries ? new Map<string, { label: string; timestamp?: string }>() : null;
  let header: any = null;
  let entryCount = 0;
  let messageCount = 0;
  let lastId: string | null = null;
  let latestSessionName = "";
  let lineNo = 0;

  const lineTooLarge = (n: number) => new RemoteError(
    "internal",
    action + "失败：会话文件第 " + n + " 行超过单行上限 " + formatBytes(SESSION_FILE_LINE_MAX_BYTES) + "（文件可能损坏）",
  );
  const handleLine = (buf: Buffer, offset: number, length: number) => {
    lineNo += 1;
    if (length > SESSION_FILE_LINE_MAX_BYTES) throw lineTooLarge(lineNo);
    let text = buf.toString("utf8");
    if (lineNo === 1) text = text.replace(/^\uFEFF/, "");
    if (!text.trim()) return; // 空行不影响行号/头校验
    let entry: any;
    try { entry = JSON.parse(text); } catch {
      throw new RemoteError("internal", action + "失败：会话文件第 " + lineNo + " 行不是合法 JSON（文件可能损坏）");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RemoteError("internal", action + "失败：会话文件第 " + lineNo + " 行不是 pi 会话条目（文件可能损坏）");
    }
    if (!header) {
      if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id) {
        throw new RemoteError("internal", action + "失败：不是有效的 pi 会话文件（缺少 session 头）");
      }
      header = entry;
      return;
    }
    if (entry.type === "session") {
      throw new RemoteError("internal", action + "失败：会话文件第 " + lineNo + " 行重复出现 session 头（文件可能损坏）");
    }
    entryCount += 1;
    if (entry.type === "message") messageCount += 1;
    else if (entry.type === "session_info") latestSessionName = entry.name == null ? "" : String(entry.name).trim();
    else if (entry.type === "label" && labels && typeof entry.targetId === "string") {
      if (entry.label == null || entry.label === "") labels.delete(entry.targetId);
      else labels.set(entry.targetId, {
        label: String(entry.label),
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      });
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id) lastId = id;
    else lastId = null;
    if (byId) {
      if (id) {
        const meta: SessionEntryMeta = {
          id,
          parentId: typeof entry.parentId === "string" ? entry.parentId : null,
          type: typeof entry.type === "string" ? entry.type : "",
          role: entry.type === "message" && entry.message ? String(entry.message.role || "") : "",
          offset,
          length,
        };
        if (entry.type === "compaction" && typeof entry.firstKeptEntryId === "string") meta.firstKeptEntryId = entry.firstKeptEntryId;
        byId.set(id, meta);
      }
    }
  };

  let fd: any = null;
  let lastByte = -1;
  try {
    try { fd = fs.openSync(p, "r"); } catch (e: any) { throw sessionFileError(e, action); }
    const chunk = Buffer.allocUnsafe(SESSION_FILE_SCAN_CHUNK);
    let readPos = 0;
    let carry: Buffer[] = [];
    let carryLen = 0;
    let carryOffset = 0;
    for (;;) {
      let n = 0;
      try { n = fs.readSync(fd, chunk, 0, chunk.length, null); } catch (e: any) { throw sessionFileError(e, action); }
      if (!n) break;
      lastByte = chunk[n - 1];
      let start = 0;
      for (let i = 0; i < n; i += 1) {
        if (chunk[i] !== 0x0a) continue;
        const part = chunk.subarray(start, i);
        const lineOffset = carry.length ? carryOffset : readPos + start;
        let lineBuf: Buffer;
        let lineLength = part.length;
        if (carry.length) {
          carry.push(part);
          lineLength += carryLen;
          lineBuf = Buffer.concat(carry, lineLength);
          carry = [];
          carryLen = 0;
        } else {
          lineBuf = part;
        }
        handleLine(lineBuf, lineOffset, lineLength);
        start = i + 1;
      }
      if (start < n) {
        const rest = Buffer.from(chunk.subarray(start, n));
        if (!carry.length) carryOffset = readPos + start;
        carry.push(rest);
        carryLen += rest.length;
        if (carryLen > SESSION_FILE_LINE_MAX_BYTES) throw lineTooLarge(lineNo + 1);
      }
      readPos += n;
    }
    if (carry.length) {
      const lineBuf = Buffer.concat(carry, carryLen);
      handleLine(lineBuf, carryOffset, carryLen);
    }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  if (!header) throw new RemoteError("internal", action + "失败：不是有效的 pi 会话文件（缺少 session 头）");
  return {
    header,
    size: st.size,
    entryCount,
    messageCount,
    lastId,
    latestSessionName,
    endsWithNewline: st.size > 0 && lastByte === 0x0a,
    byId,
    labels,
  };
}

/** 大文件写入：Node 的 writeSync 可能短写，必须循环到写满；按 UTF-8 Buffer 写，避免重复编码。 */
function writeAllSync(fd: any, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!n) throw new Error("写入返回 0 字节");
    off += n;
  }
}

/** 按偏移读满一行；源文件在读的过程中被截断时返回 false（调用方按“已变化”报错）。 */
function readAllSync(fd: any, length: number, position: number): Buffer | null {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (!n) return null;
    off += n;
  }
  return buf;
}

/** 只读会话文件第一行（session 头），用于校验刚写出的 fork 结果；不读整份文件。 */
function readSessionHeaderLine(p: string, action: string): any {
  let fd: any = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (!n) throw new RemoteError("internal", action + "失败：新会话文件为空");
    const nl = buf.subarray(0, n).indexOf(0x0a);
    const line = buf.subarray(0, nl >= 0 ? nl : n).toString("utf8").replace(/^\uFEFF/, "");
    let header: any;
    try { header = JSON.parse(line); } catch {
      throw new RemoteError("internal", action + "失败：新会话文件头不是合法 JSON");
    }
    if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) {
      throw new RemoteError("internal", action + "失败：新会话文件缺少 session 头");
    }
    return header;
  } catch (e: any) {
    throw sessionFileError(e, action);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/** 流式索引里的活动叶路径（root → leaf）；坏 parent 链只保留能走到的部分。 */
function activeSessionPathFromScan(scan: SessionFileScan): SessionEntryMeta[] {
  const byId = scan.byId;
  if (!byId || !scan.lastId) return [];
  let cur: string | null = scan.lastId;
  const out: SessionEntryMeta[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const meta = byId.get(cur);
    if (!meta) break;
    out.push(meta);
    cur = meta.parentId;
  }
  return out.reverse();
}

/** 当前活动叶路径（root → leaf）；坏 parent 链只保留能走到的部分。 */
function activeSessionPath(entries: any[]): any[] {
  const byId = new Map<string, any>();
  for (const e of entries) if (e && typeof e.id === "string") byId.set(e.id, e);
  let cur: any = entries.length ? entries[entries.length - 1] : null;
  const out: any[] = [];
  const seen = new Set<string>();
  while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? byId.get(String(cur.parentId)) : null;
  }
  return out.reverse();
}

function contentTextOf(message: any): string {
  const c = message && message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b: any) => b && b.type === "text").map((b: any) => String(b.text || "")).join("\n");
}

/** 没有 pi 包时的文本导出兜底：格式与 pi 的 serializeConversation 接近，只用于旧环境/测试。 */
function fallbackConversationText(entries: any[]): string {
  const parts: string[] = [];
  for (const entry of activeSessionPath(entries)) {
    if (entry.type === "message" && entry.message) {
      const message = entry.message;
      const role = message.role;
      if (role === "user") {
        const text = contentTextOf(message);
        if (text) parts.push("[User]: " + text);
      } else if (role === "assistant") {
        const text = contentTextOf(message);
        if (text) parts.push("[Assistant]: " + text);
        const calls = Array.isArray(message.content)
          ? message.content.filter((b: any) => b && b.type === "toolCall").map((b: any) => {
            const args = b.arguments && typeof b.arguments === "object"
              ? Object.entries(b.arguments).map(([k, v]) => k + "=" + JSON.stringify(v)).join(", ")
              : "";
            return String(b.name || "tool") + "(" + args + ")";
          })
          : [];
        if (calls.length) parts.push("[Assistant tool calls]: " + calls.join("; "));
      } else if (role === "toolResult") {
        const text = contentTextOf(message);
        if (text) parts.push("[Tool result]: " + text);
      }
    } else if (entry.type === "branch_summary" && entry.summary) {
      parts.push("[Branch summary]: " + String(entry.summary));
    } else if (entry.type === "compaction" && entry.summary) {
      parts.push("[Compaction summary]: " + String(entry.summary));
    }
  }
  return parts.join("\n\n");
}

class Bridge {
  /** 路径规则与上报的平台标识按它来；测试可改成别的平台 */
  platform: string = process.platform;
  ws: any = null;
  connected = false;
  authed = false;
  backoff = RECONNECT_MIN;
  reconnectTimer: any = null;
  closing = false;
  livenessTimer: any = null;
  lastTick = 0;
  /** 本条连接最后一次收到 relay 帧的时刻；探活帧发出的时刻（0 = 没有在等回应） */
  lastInbound = 0;
  probeSentAt = 0;
  /** 本条连接上 relay 回过 room_registered 的房间：没确认归属前 sync 会被 relay 静默丢弃，不能拿来探活 */
  confirmedRoom: string | null = null;

  roomId: string | null = null;
  sessionName: string | null = null;
  /** 仅本机刚改名时才用 sessionName 覆盖清单，避免把旧名字反复写回 */
  nameDirty = false;
  sentStamp = new Map<string, { at: number; name: any; messageCount: number; path: string; active: boolean; cwd: string }>();
  roomLabel: string | null = null;
  cwd: string | null = null;
  busy = false;
  /** 命令串行队列：会改状态的远端命令逐个执行，避免 set_model/compact 等交错（只读命令不排队） */
  cmdQueue: Promise<any> = Promise.resolve();
  pi: any = null;
  ctx: any = null;
  started = false;
  /** 连接窗口监视：文件出现立刻连，消失或过期立刻断，窗口外不重连 */
  attachWatcher: any = null;
  watchRetry: any = null;
  expiryTimer: any = null;
  exactExpiry: any = null;
  manifestTimer: any = null;
  pendingManifest: any = null;
  manifestArmed = false;
  lastActivityManifestAt = 0;
  indexCache = new Map<string, any>();
  /** 测试可替换。缺省走 SessionManager.list(cwd) */
  sessionLister: any = null;
  _unknownLogged = false;
  /** P10：usage 刷新串行队列（relay 的 usage_refresh 合并执行，避免并发扫描） */
  usageQueue: Promise<any> = Promise.resolve();
  /** relay 回过 unknown_type(room_label)：旧版 relay，改名走 room_register */
  noRoomLabel = false;
  _manifestSkipLogged = false;
  /** 已打过日志的连接窗口关闭原因（避免 5 秒轮询/文件事件反复刷同一行） */
  _gateHintKey = "";
  /** 流式草稿被截断的累计字符数（诊断用；只增计数，不留原文） */
  streamTruncatedChars = 0;
  /* ---------------- 对话框观察 tap 的状态（机制与纪律见 buildDialogOpen 上方注释） ---------------- */
  /** 已 wrap 的 ui 对象（身份比对：宿主重设 context 换了对象就重装） */
  tapUi: any = null;
  /** 方法名 → 原函数：会话关闭时还原，只在仍是 tapSink 属主时做 */
  tapOriginals = new Map<string, any>();
  /** off=未装 / ok=捕获中 / failed=自检判失效（已回退信号模式，仍会自愈重试） */
  tapState: "off" | "ok" | "failed" = "off";
  tapCaptures = 0;
  /** 连续未命中的 ui_prompt_start 计数（dialog 类），命中捕获即清零 */
  tapMissed = 0;
  tapLastCaptureAt = 0;
  tapLastInstallTryAt = 0;
  tapSeq = 0;
  /** 已捕获未关闭的 dialog：dialogId → startedAt */
  tapOpenDialogs = new Map<string, number>();
  /* ---------------- 对话框应答接管（O2，定版说明第一部分 §2） ----------------
   * 开关 dialogRemoteAnswer 经 relay 命令帧下达、仅内存持有（重启回默认关，桥不读本地文件）；
   * 门控 = 开关开 AND relay 推送的 viewer 在线状态（dialog_gate 帧）为真，两条同真才接管。 */
  dialogAnswerEnabled = false;
  dialogGateHasViewers = false;
  /** 接管持留的 dialog：dialogId → HeldDialog（含排队中的）。同一时刻只一个 active。 */
  dialogHeld = new Map<string, any>();
  dialogHeldQueue: string[] = [];
  dialogActiveId: string | null = null;
  /** 已交回本机、仍在本机开着的 dialog：dialogId → { kind, args, startedAt }（发现 A-5）。
   *  断线时 relay 清槽并广播 gone，桥重连 sync 完成后按此表重发观察形态 dialog_open，
   *  否则等待卡 / 注意力对这些 dialog 断粮；startedAt 沿用原值，时限不重算。 */
  localOpenDialogs = new Map<string, any>();
  /** 交回本机的串行链（发现 A-4）：等待交回的 entry 与在飞标记——前一个在本机落定
   *  后才调起下一个的原方法，与本机单焦点对齐。 */
  dialogLocalReleaseQueue: any[] = [];
  dialogLocalReleaseBusy = false;
  /** setStatus 自建状态表：key → text（text 空即删 key，等价本机 footer 的状态行） */
  extStatusByKey = new Map<string, string>();
  /** setWidget 自建表：key → { key, lines?, placement?, factory? } */
  extWidgets = new Map<string, any>();
  extTitle: string | null = null;
  /** setWorking* 原文：{ message?, visible?, indicatorFrames?, hiddenThinkingLabel? } */
  extWorking: any = null;
  private _streamTruncatedLoggedAt = 0;

  /** 连接只在 session_start 里建立（pi 文档：不要在扩展工厂里开 socket——
   *  `pi --list-models` 之类不进会话的调用也会执行工厂，会凭空注册一个幽灵房间） */
  start() {
    if (this.started) return;
    this.started = true;
    this.closing = false;
    // 被更新的 Bridge 取代时，旧 socket 已无人使用（它的 ws._room 仍指向旧房间）：关掉它。
    const g: any = globalThis as any;
    const old = g[BRIDGE_KEY];
    if (old && old !== this) {
      old.closing = true;
      try { old.abandonDeliveries("扩展已重载，消息未确认送达"); } catch {}
      old.clearTimers();
      try { old.suspendConnection(); } catch {}
      log("关闭已被取代的旧连接");
    }
    g[BRIDGE_KEY] = this;
    tapSink.bridge = this;
    if (!RELAY_URL || (!TOKEN && !HAS_DEVICE_TOKEN)) {
      log("PI_REMOTE_RELAY 为空，或 PI_REMOTE_TOKEN 与设备令牌都没配，扩展不连接");
      return;
    }
    const insecure = insecureRelayWarning(RELAY_URL);
    if (insecure) log(insecure);
    this.armAttachWatch();
    this.armLiveness();
    this.evaluateGate("start");
  }

  /** 会话关闭：声明房间离线并断线，清掉所有定时器（否则旧 runtime 的定时器还会往新 socket 上发东西） */
  stop() {
    try { this.uninstallDialogTap(); } catch {}
    try {
      if (this.pendingImageAddress) this.finishImageAddress(null);
      this.flushPending();
      this.abandonDeliveries("本机会话已关闭，消息未注入");
      this.resetRemoteQueueForSession("本机会话已关闭，待发消息未注入", "session_switched");
      if (this.roomId) this.send({ type: "room_closed", room: this.roomId }, { essential: true });
    } catch {}
    this.closing = true;
    this.started = false;
    this.clearTimers();
    const g: any = globalThis as any;
    if (g[BRIDGE_KEY] === this) g[BRIDGE_KEY] = null;
    const ws = this.ws;
    this.ws = null;
    this.detachSocket(ws);
    setTimeout(() => { try { ws && ws.close(); } catch {} }, 150);
  }

  clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
    if (this.coalesceTimer) { clearTimeout(this.coalesceTimer); this.coalesceTimer = null; }
    if (this.manifestTimer) { clearTimeout(this.manifestTimer); this.manifestTimer = null; }
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
    this.pendingManifest = null;
    this.releaseAttachWatch();
    for (const p of this.pendingDeliveries) clearTimeout(p.timer);
    this.pendingDeliveries = [];
  }

  gateOpen() {
    return attachWindowOpen(attachStatePath(), process.env, Date.now());
  }

  /** 窗口开着且还没连上 → 立刻连（退避清零）。窗口关着或已过期 → 断开并停止重连。 */
  evaluateGate(reason: string) {
    if (this.closing) return;
    const open = this.gateOpen();
    // 窗口原因单独算一次：gateOpen() 在测试里可被替换，日志只用于解释真实关闭原因
    const verdict = readAttachWindow(attachStatePath(), process.env, Date.now());
    if (!open) {
      this.clearExactExpiry();
      const key = String((verdict && verdict.reason) || "closed");
      if (key !== this._gateHintKey) {
        this._gateHintKey = key;
        const hint = attachGateHint(verdict, process.env, attachStatePath());
        if (hint) log(hint);
      }
      if (this.connected || this.ws || this.reconnectTimer) {
        log("连接窗口关闭，断开 relay（", reason, "）");
        this.suspendConnection();
      }
      return;
    }
    this._gateHintKey = "";
    if (verdict.ok) this.armExactExpiry(verdict.state);
    else this.clearExactExpiry();
    if (this.connected || this.ws) return;
    if (this.authFailed) return; // 鉴权失败：窗口开着也不重连（原来这里每 5 秒连一次）
    // 已有重连计时器 = 正在按退避等待。5 秒窗口轮询不能把它清掉重来，
    // 否则 onopen 前就被断开的对端会永远以 1s 间隔狂连（退避形同虚设）。
    if (this.reconnectTimer) return;
    this.backoff = RECONNECT_MIN;
    log("连接窗口已开，连接 relay（", reason, "）");
    this.connect();
  }

  /** 到 expiresAt 就重评，不等 5 秒轮询。文件内容不变时 fs.watch 不会响。 */
  armExactExpiry(state: any) {
    this.clearExactExpiry();
    const exp = state && Number(state.expiresAt);
    if (!Number.isFinite(exp)) return;
    const wait = exp - Date.now();
    const delay = Math.min(Math.max(wait, 1), 0x7fffffff);
    this.exactExpiry = setTimeout(() => {
      this.exactExpiry = null;
      this.evaluateGate("expiresAt");
    }, delay);
    if (this.exactExpiry.unref) this.exactExpiry.unref();
  }

  clearExactExpiry() {
    if (!this.exactExpiry) return;
    clearTimeout(this.exactExpiry);
    this.exactExpiry = null;
  }

  /** 摘掉一条旧 socket 的全部回调。关窗/被顶替后，即使底层仍投递在途帧，也进不了 handle()。 */
  detachSocket(ws: any) {
    if (!ws) return;
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
    } catch {}
  }

  suspendConnection() {
    this.clearExactExpiry();
    if (this.manifestTimer) { clearTimeout(this.manifestTimer); this.manifestTimer = null; }
    this.pendingManifest = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.authed = false;
    // 先摘回调再关：close 事件不该再触发重连，在途 message/command 也不该再执行
    this.detachSocket(ws);
    if (ws) {
      try { ws.close(); } catch {}
    }
  }

  armAttachWatch() {
    if (String(process.env.PI_REMOTE_ALWAYS_ONLINE || "") === "1") return;
    if (this.attachWatcher || this.watchRetry || this.expiryTimer) return;
    const file = attachStatePath();
    const dir = path.dirname(file);
    const base = path.basename(file);
    const arm = () => {
      if (this.closing) return;
      this.watchRetry = null;
      try {
        if (!fs.existsSync(dir)) {
          this.watchRetry = setTimeout(arm, 1000);
          if (this.watchRetry.unref) this.watchRetry.unref();
          return;
        }
        this.attachWatcher = fs.watch(dir, (_event: any, filename: any) => {
          // 原子写会先出现 remote-attach.json.<pid>.tmp，再改名为正式文件。日志文件在同一目录，不能跟着每次 append 重评。
          if (filename && !String(filename).startsWith(base)) return;
          this.evaluateGate("watch");
        });
        if (this.attachWatcher && typeof this.attachWatcher.unref === "function") this.attachWatcher.unref();
        if (this.attachWatcher && typeof this.attachWatcher.on === "function") {
          this.attachWatcher.on("error", () => {
            try { this.attachWatcher.close(); } catch {}
            this.attachWatcher = null;
            if (this.closing) return;
            this.watchRetry = setTimeout(arm, 1000);
            if (this.watchRetry.unref) this.watchRetry.unref();
          });
        }
      } catch {
        this.watchRetry = setTimeout(arm, 1000);
        if (this.watchRetry && this.watchRetry.unref) this.watchRetry.unref();
      }
    };
    arm();
    this.expiryTimer = setInterval(() => this.evaluateGate("expiry"), 5000);
    if (this.expiryTimer.unref) this.expiryTimer.unref();
  }

  releaseAttachWatch() {
    if (this.watchRetry) { clearTimeout(this.watchRetry); this.watchRetry = null; }
    this.clearExactExpiry();
    if (this.expiryTimer) { clearInterval(this.expiryTimer); this.expiryTimer = null; }
    if (this.attachWatcher) {
      try { this.attachWatcher.close(); } catch {}
      this.attachWatcher = null;
    }
  }

  connect() {
    // 鉴权失败后任何路径都不再连（onclose、5 秒窗口轮询 evaluateGate、scheduleReconnect）：
    // token 只在 pi 启动时读取，不重启 pi 重连也只会再失败一次
    if (this.closing || this.authFailed || !this.gateOpen()) return;
    try {
      const ws = new WebSocket(RELAY_URL);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        if (!this.gateOpen()) {
          log("连接完成时窗口已关，放弃");
          this.suspendConnection();
          return;
        }
        this.connected = true;
        // 退避只在 auth_result.ok 之后清零：对端“握手成功但立刻断开、不回 auth”时，
        // 在这里清零会让退避永远停在 1s，变成无限快连。
        this.lastInbound = Date.now();
        this.probeSentAt = 0;
        this.confirmedRoom = null;
        log("已连接 relay:", RELAY_URL);
        this.send(authFrame(process.env, this.platform));
        // 重连后补注册 + 对齐镜像，并重发当前忙闲与用量。两者都只在变化时推送，
        // relay 重启后它缓存的值没了，不重发的话新订阅者一直拿不到。
        // 必须走 room_register：新连接在 relay 侧还没绑定房间（relay 可能刚重启），轻量 sync 会被直接忽略。
        this.relayV3 = false;
        this.relayCaps = null;
        this.relayAuth = null;
        if (this.roomId) {
          this.requestSync("reconnect", true);
          this.send({ type: "state", room: this.roomId, busy: this.busy });
          this._lastUsagePayload = "";
          this.pushUsage("reconnect");
          this.manifestArmed = true;
          this.enqueueManifest({ full: true });
        }
      };

      ws.onmessage = (ev: any) => {
        // 归属守卫：suspendConnection / 关窗 / 被新连接取代后，这条 socket 上已在途的帧一律不执行。
        // 只挡记账不够——handle() 会真的注入消息、执行命令，与“窗口关闭立即断开”的承诺对不上。
        if (this.ws !== ws) return;
        this.lastInbound = Date.now();
        this.probeSentAt = 0;
        let msg: any;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        this.handle(msg);
      };

      ws.onclose = () => {
        if (this.ws !== ws) return; // 已被更新的连接取代（重连竞态）：旧 socket 的 close 不能把新连接标成断开
        this.socketGone();
        if (this.closing) return;
        if (this.authFailed) {
          log("鉴权失败，不重连（修正 .env 的 PI_REMOTE_TOKEN 后重启 pi）");
          return;
        }
        if (!this.gateOpen()) {
          log("窗口未开，不重连");
          return;
        }
        log("relay 连接断开，安排重连");
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    } catch (e: any) {
      log("连接失败:", e?.message);
      this.scheduleReconnect();
    }
  }

  /** 当前连接没了（收到 close，或被判定为半开连接主动丢弃）：清掉只属于这条连接的状态 */
  socketGone() {
    this.connected = false;
    this.authed = false;
    this.ws = null;
    this.confirmedRoom = null;
    this.probeSentAt = 0;
    // 接管门控随连接作废（重连后 relay 补发当前值）；持留 dialog 交回本机弹窗——
    // 答案通道已断，继续持留只会让调用方干等到超时（fail-open 红线）
    this.dialogGateHasViewers = false;
    try { this.releaseAllHeldDialogs("local"); } catch {}
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    this.pendingDelta = null;
    this.pendingTools.clear();
    // 这条连接上的等待窗作废；重连后由快照/对齐补齐，不能把旧队列发到新 socket。
    this.dropPendingImageAddress();
  }

  armLiveness() {
    if (this.livenessTimer) return;
    this.lastTick = Date.now();
    this.livenessTimer = setInterval(() => this.checkLiveness(), LIVENESS_TICK_MS);
    if (this.livenessTimer.unref) this.livenessTimer.unref();
  }

  /** 每 LIVENESS_TICK_MS 跑一次；返回判定结果给测试看 */
  checkLiveness(now: number = Date.now()): string {
    const prev = this.lastTick || now;
    this.lastTick = now;
    if (this.closing || !this.ws || !this.connected) return "idle";
    if (now - prev > LIVENESS_TICK_MS + WAKE_GAP_MS) {
      this.reviveConnection(`定时器晚了 ${Math.round((now - prev) / 1000)}s，像是刚从睡眠中醒来`);
      return "wake";
    }
    if (this.probeSentAt) {
      if (now - this.probeSentAt < PROBE_DEAD_MS) return "probing";
      this.reviveConnection(`探活 ${Math.round((now - this.probeSentAt) / 1000)}s 没有回应`);
      return "dead";
    }
    // 只在空闲、且 relay 已确认本连接拥有这个房间时探：sync 对不属于本连接的房间不回包；忙时补尾部会和在途事件抢先后
    if (!this.authed || !this.relayV3 || this.busy || !this.roomId || this.confirmedRoom !== this.roomId) return "ok";
    if (now - this.lastInbound < IDLE_PROBE_MS) return "ok";
    this.flushPending();
    if (!this.send({ type: "sync", room: this.roomId }, { essential: true })) return "ok";
    this.probeSentAt = now;
    return "probe";
  }

  /** 丢掉疑似半开的连接，立刻另起一条。旧 socket 摘掉回调再关：半开时 close 握手可能永远等不到回音 */
  reviveConnection(why: string) {
    const ws = this.ws;
    if (!ws) return;
    log("relay 连接疑似已断（", why, "），丢弃旧连接立刻重连");
    this.socketGone();
    this.detachSocket(ws);
    try { ws.close(); } catch {}
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.backoff = RECONNECT_MIN;
    this.connect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closing || this.authFailed) return;
    if (!this.gateOpen()) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  /** 压缩中标记：由 compaction_start/compaction_end 事件维护，供 get_state.isCompacting（官方字段） */
  /** 鉴权失败后停止重连：token 错时每秒重连一次只会把日志和流量刷爆 */
  private authFailed = false;
  private compacting = false;
  /** 正在执行的远程 bash（id -> AbortController）：abort_bash 命令取消用。
   *  探针实测（probe8）：pi.exec 认 signal，abort 后返回 killed:true。 */
  private runningBash = new Map<string, AbortController>();
  /** 上次推送的用量帧 payload（去重：没变就不发） */
  private _lastUsagePayload = "";
  /** 忙时待发正文。pi 1.0.2 的 queue_update 只进会话总线，扩展收不到，只能从 input 自己记。 */
  private steeringQueue: string[] = [];
  private followUpQueue: string[] = [];
  /** 上次发出的两侧正文。一开始就是空：空队列上的 message_start 不再多发一帧。 */
  private queueSig = "[]\n[]";
  /** 远程自管待发缓冲：只放远程消息，按入队顺序保存；pending 可编辑/取消。 */
  private remoteQueue: RemoteQueueItem[] = [];
  /** 状态帧版本号：每次入队/编辑/取消/状态变化 +1，网页只按整帧替换。 */
  private remoteQueueRev = 0;
  /** 注入入口防重入：deliverText 可能同步触发 message_start → forward → 再次 refresh。 */
  private remoteQueueFlushing = false;
  /** 立即发送先 abort 当前 run，期间禁止 agent_settled 把其他 pending 批量注入。 */
  private remoteQueueInterrupting = false;
  /** 实时 message_end 的图片地址等待窗：pi 先发扩展事件、后 appendMessage，此刻拿不到 entryId。
   *  只对“投影里有 omit 图片”的消息挂起；持久化后回读 branch 拿到真实条目再随同一帧下发地址。
   *  等待期间后面的事件全部排队，保证远端看到的事件顺序不变。拿不到就原样发出，绝不猜。 */
  private pendingImageAddress: {
    roomId: string;
    frame: any;
    message: any;
    queue: any[];
    attempts: number;
    afterUsage: boolean;
  } | null = null;

  /** 发送缓冲上限：可丢帧超过它就丢；关键帧（快照/状态/回包）另有一个硬上限。 */
  static readonly SEND_BACKLOG_BYTES = 4 * 1024 * 1024;
  /** 关键帧硬上限：一帧最大 12MB + 4MB 软上限。超过说明网络长时间跟不上，
   *  再硬发只会让 bufferedAmount（TUI 进程内存）无界增长；断开重连让 relay 侧重新对齐。 */
  static readonly SEND_BACKLOG_MAX_BYTES = FRAME_MAX_BYTES + Bridge.SEND_BACKLOG_BYTES;

  send(obj: any, opts?: { essential?: boolean }): boolean {
    if (!this.ws || !this.connected) return false;
    let payload: string;
    try {
      payload = JSON.stringify(obj);
    } catch (e: any) {
      // 循环引用/超深结构：必须留痕，否则远端只看到"命令超时"
      log("发送序列化失败:", obj && obj.type, e?.message);
      if (obj && obj.type === "command_result") return this.send({ type: "command_result", room: obj.room, id: obj.id, ok: false, code: "internal", error: "结果无法序列化：" + (e?.message || e) }, opts);
      return false;
    }
    // 超过 relay local 通道单帧上限的帧会让 relay 直接断开连接（1009）→ 重连 → 再发 → 再断。
    // 字符数 ×3 ≥ 字节数：绝大多数帧不用真的去算字节
    if (payload.length * 3 > FRAME_MAX_BYTES && Buffer.byteLength(payload, "utf8") > FRAME_MAX_BYTES) {
      const smaller = oversizeFallback(obj, Buffer.byteLength(payload, "utf8"));
      log("帧超过单帧上限，已降级:", obj && obj.type, (obj && obj.event && obj.event.type) || "", Math.round(payload.length / 1048576) + "MB");
      if (!smaller) return false;
      try {
        payload = JSON.stringify(smaller);
      } catch {
        return false;
      }
    }
    return this.sendRaw(payload, opts, obj && obj.type);
  }

  private _backlogLogged = 0;
  private _backlogHardLogged = 0;

  /** 关键帧把发送缓冲顶过硬上限：断开重连（不清退避；认证成功后会从 1s 重新开始）。
   *  不能在这里继续 send：bufferedAmount 只增不减会把 TUI 进程内存拖爆。 */
  private reconnectForBacklog(what: string, buffered: number, bytes: number) {
    if (!this._backlogHardLogged || Date.now() - this._backlogHardLogged > 5000) {
      this._backlogHardLogged = Date.now();
      log("发送背压超过硬上限，断开重连:", what || "raw", "buffered=", Math.round(buffered / 1048576) + "MB", "frame=", Math.round(bytes / 1048576) + "MB");
    }
    const ws = this.ws;
    this.socketGone();
    this.detachSocket(ws);
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (!this.closing && !this.authFailed && this.gateOpen()) this.scheduleReconnect();
  }

  /** 发送已序列化好的字符串（快照等大帧：避免 stringify → parse → stringify 的双倍 CPU） */
  sendRaw(payload: string, opts?: { essential?: boolean }, what?: string): boolean {
    if (!this.ws || !this.connected) return false;
    const essential = !!(opts && opts.essential);
    const buffered = Number(this.ws.bufferedAmount) || 0;
    // 背压：慢网络下 bufferedAmount 无人理会会让 TUI 进程内存持续膨胀
    if (!essential && buffered > Bridge.SEND_BACKLOG_BYTES) {
      if (!this._backlogLogged || Date.now() - this._backlogLogged > 5000) {
        this._backlogLogged = Date.now();
        log("发送背压：丢弃可丢帧", what || "", "buffered=", buffered);
      }
      return false;
    }
    if (essential && buffered > 0) {
      const bytes = Buffer.byteLength(payload, "utf8");
      if (buffered > Bridge.SEND_BACKLOG_MAX_BYTES || buffered + bytes > Bridge.SEND_BACKLOG_MAX_BYTES) {
        this.reconnectForBacklog(what, buffered, bytes);
        return false;
      }
    }
    try {
      this.ws.send(payload);
      return true;
    } catch (e: any) {
      log("发送失败:", what || "raw", e?.message);
      return false;
    }
  }

  /* ---------- 事件合并（保序）：流式 delta 拼接、工具中间输出按 toolCallId 取最新 ---------- */
  private pendingDelta: any = null;
  private pendingTools = new Map<string, any>();
  private coalesceTimer: any = null;

  private armCoalesce(ms: number) {
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.flushPending();
    }, ms);
  }

  /** 把挂起的合并帧按到达顺序发出。任何非合并事件发送前都必须先调用它，保证远端看到的顺序与本机一致 */
  flushPending() {
    if (this.coalesceTimer) { clearTimeout(this.coalesceTimer); this.coalesceTimer = null; }
    if (this.pendingDelta) {
      const d = this.pendingDelta;
      this.pendingDelta = null;
      this.sendEvent(d, false);
    }
    if (this.pendingTools.size) {
      const list = [...this.pendingTools.values()];
      this.pendingTools.clear();
      for (const ev of list) this.sendEvent(ev, false);
    }
  }

  private sendEvent(ev: any, essential: boolean) {
    if (!this.roomId) return;
    this.send({ type: "event", room: this.roomId, event: ev }, { essential });
  }

  /** 流式草稿截断记录：累计字符数只做诊断；5 秒内最多写一行日志，避免每帧刷盘。 */
  private noteStreamTruncated(type: string, dropped: number) {
    if (dropped <= 0) return;
    this.streamTruncatedChars += dropped;
    const now = Date.now();
    if (!this._streamTruncatedLoggedAt || now - this._streamTruncatedLoggedAt > 5000) {
      this._streamTruncatedLoggedAt = now;
      log("流式草稿超过上限，已截断:", type, "丢弃", dropped, "字符，累计", this.streamTruncatedChars);
    }
  }

  /** text/thinking delta 入口先封顶：单条超大 delta 也不进 pendingDelta。 */
  private capDeltaEvent(ev: any) {
    const a = ev && ev.type === "message_update" ? ev.assistantMessageEvent : null;
    if (!a || (a.type !== "text_delta" && a.type !== "thinking_delta") || typeof a.delta !== "string") return ev;
    if (a.delta.length <= STREAM_DELTA_MAX_CHARS) return ev;
    this.noteStreamTruncated(a.type, a.delta.length - STREAM_DELTA_MAX_CHARS);
    return { ...ev, assistantMessageEvent: { ...a, delta: a.delta.slice(0, STREAM_DELTA_MAX_CHARS) } };
  }

  /** 合并时只保留剩余额度，超出部分计数后丢弃（message_end 会补权威全文）。 */
  private appendDelta(pending: any, a: any) {
    const cur = pending.assistantMessageEvent.delta;
    if (cur.length >= STREAM_DELTA_MAX_CHARS) {
      this.noteStreamTruncated(a.type, a.delta.length);
      return;
    }
    const room = STREAM_DELTA_MAX_CHARS - cur.length;
    if (a.delta.length <= room) {
      pending.assistantMessageEvent.delta = cur + a.delta;
      return;
    }
    pending.assistantMessageEvent.delta = cur + a.delta.slice(0, room);
    this.noteStreamTruncated(a.type, a.delta.length - room);
  }

  /** 已投影的事件入口：有 message_end 在等图片地址时先排队，保证顺序不变 */
  emitEvent(ev: any) {
    if (!ev || !this.roomId) return;
    if (this.pendingImageAddress) {
      this.pendingImageAddress.queue.push(ev);
      return;
    }
    this.emitEventNow(ev);
  }

  /** 真正进入合并/发送队列；等待图片地址的 message_end 补完地址后也从这里发出。 */
  private emitEventNow(ev: any) {
    if (!ev || !this.roomId) return;
    ev = this.capDeltaEvent(ev);
    if (mergeableDelta(ev)) {
      const p = this.pendingDelta;
      const a = ev.assistantMessageEvent;
      if (p && p.assistantMessageEvent.type === a.type && p.assistantMessageEvent.contentIndex === a.contentIndex) {
        this.appendDelta(p, a);
        if (ev.usage !== undefined) p.usage = ev.usage;
        return;
      }
      if (this.pendingTools.size || p) this.flushPending();
      this.pendingDelta = { ...ev, assistantMessageEvent: { ...a } };
      this.armCoalesce(DELTA_COALESCE_MS);
      return;
    }
    if (ev.type === "tool_execution_update" && ev.toolCallId) {
      if (this.pendingDelta) this.flushPending();
      // partialResult 是累积全量：同一工具只需要最新一帧
      this.pendingTools.delete(String(ev.toolCallId));
      this.pendingTools.set(String(ev.toolCallId), ev);
      this.armCoalesce(TOOL_UPDATE_COALESCE_MS);
      return;
    }
    if (ev.type === "tool_execution_end" && ev.toolCallId) this.pendingTools.delete(String(ev.toolCallId));
    this.flushPending();
    this.sendEvent(ev, !DROPPABLE_FORWARD.has(ev.type));
  }

  /** 从当前分支里找回“这条 message 对应的持久化条目”。只认对象同一性（pi 的
   *  SessionManager.appendMessage(event.message) 存的就是同一个对象），不做内容相似匹配。 */
  private persistedMessageEntry(message: any): { entryId: string; raw: any[] } | null {
    if (!message) return null;
    let sm: any = null;
    try { sm = this.ctx && this.ctx.sessionManager; } catch { return null; }
    if (!sm) return null;
    const match = (e: any) => {
      if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id) return null;
      const same = e.type === "message"
        ? e.message === message
        : e.type === "custom_message" && message.role === "custom" && e.content === message.content;
      if (!same) return null;
      const raw = entryAddressableBlocks(e);
      return raw && rawHasAddressableImage({ content: raw }) ? { entryId: e.id, raw } : null;
    };
    let entries: any = null;
    try {
      if (typeof sm.getBranch === "function") entries = sm.getBranch();
      else if (typeof sm.getEntries === "function") entries = sm.getEntries();
    } catch {
      entries = null;
    }
    if (Array.isArray(entries)) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const hit = match(entries[i]);
        if (hit) return hit;
      }
    }
    // 有的 runtime/测试只暴露 leaf：回读 leaf 同样只认对象同一性，内容像不算。
    try {
      if (typeof sm.getLeafId === "function" && typeof sm.getEntry === "function") {
        const leafId = sm.getLeafId();
        if (leafId) {
          const hit = match(sm.getEntry(leafId));
          if (hit) return hit;
        }
      }
    } catch {}
    return null;
  }

  /** message_end 先挂起（只有投影里出现 omit 图片才挂）：pi 已经持久化时这里第一时间补地址；
   *  还没持久化就微任务/下一拍再回读，最多几十次；拿不到就原样发出，不猜。 */
  private beginImageAddressWait(event: any, frame: any): boolean {
    if (!event || event.type !== "message_end" || !frame || frame.type !== "message_end") return false;
    if (!rawHasAddressableImage(event.message) || !projectedHasOmittedImage(frame.message)) return false;
    let sm: any = null;
    try { sm = this.ctx && this.ctx.sessionManager; } catch { return false; }
    const canLookup = sm && (typeof sm.getBranch === "function" || typeof sm.getEntries === "function" ||
      (typeof sm.getLeafId === "function" && typeof sm.getEntry === "function"));
    if (!canLookup) return false;
    // 之前若还有一条在等（极端的同步连发），先把它按无地址原样放出去，避免覆盖/乱序。
    if (this.pendingImageAddress) this.finishImageAddress(null);
    if (this.pendingDelta || this.pendingTools.size) this.flushPending();
    // 有的 runtime 会先把消息放进 branch 再发扩展事件：能同步定位就不引入等待。
    const syncHit = this.persistedMessageEntry(event.message);
    if (syncHit) {
      this.emitEvent(addressProjectedFrame(frame, syncHit.raw, syncHit.entryId));
      return true;
    }
    this.pendingImageAddress = {
      roomId: String(this.roomId || ""),
      frame,
      message: event.message,
      queue: [],
      attempts: 0,
      afterUsage: false,
    };
    this.scheduleImageAddressResolve();
    return true;
  }

  private scheduleImageAddressResolve() {
    const p = this.pendingImageAddress;
    if (!p) return;
    if (p.attempts < 12) queueMicrotask(() => this.resolveImageAddress());
    else if (p.attempts < 40) {
      const run = () => this.resolveImageAddress();
      if (typeof setImmediate === "function") setImmediate(run);
      else setTimeout(run, 0);
    } else {
      this.finishImageAddress(null);
    }
  }

  private resolveImageAddress() {
    const p = this.pendingImageAddress;
    if (!p) return;
    if (this.closing || !this.roomId || String(this.roomId) !== p.roomId) {
      this.finishImageAddress(null);
      return;
    }
    p.attempts += 1;
    const hit = this.persistedMessageEntry(p.message);
    if (hit) {
      this.finishImageAddress(hit);
      return;
    }
    this.scheduleImageAddressResolve();
  }

  /** entry_appended 自带真实条目 id：如果正好是挂起的那条，立刻补地址放行。 */
  private tryResolveImageAddress(entry: any): boolean {
    const p = this.pendingImageAddress;
    if (!p || !entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) return false;
    const same = entry.type === "message"
      ? entry.message === p.message
      : entry.type === "custom_message" && p.message.role === "custom" && entry.content === p.message.content;
    if (!same) return false;
    const raw = entryAddressableBlocks(entry);
    if (!raw || !rawHasAddressableImage({ content: raw })) return false;
    this.finishImageAddress({ entryId: entry.id, raw });
    return true;
  }

  /** 放行挂起的 message_end：能定位就补 entryId/blockIndex（原数组下标），然后把等待期间
   *  排队的事件按原顺序发出。拿不到地址时 frame 原样发出，不在消息上伪造任何定位字段。 */
  private finishImageAddress(hit: { entryId: string; raw: any[] } | null) {
    const p = this.pendingImageAddress;
    if (!p) return;
    this.pendingImageAddress = null;
    const frame = hit ? addressProjectedFrame(p.frame, hit.raw, hit.entryId) : p.frame;
    this.emitEventNow(frame);
    if (p.afterUsage) this.pushUsage();
    for (const ev of p.queue) this.emitEventNow(ev);
    p.queue.length = 0;
  }

  private dropPendingImageAddress() {
    this.pendingImageAddress = null;
  }

  /** 当前分支里最近一份任务清单（todo 工具结果 / plan-mode entry）；没有返回 null。 */
  branchTaskList(): any | null {
    try {
      const sm = this.ctx && this.ctx.sessionManager;
      if (!sm || typeof sm.getBranch !== "function") return null;
      return taskListFromBranch(sm.getBranch() || []);
    } catch {
      // sessionManager getter 在 runtime 失效时直接抛（同 bindSession）
      return null;
    }
  }

  /** 对齐/快照之后补发任务清单：分支里有状态才发（空清单只在明确清空时发，不伪造）。
   *  不带 seq/rev，relay 按房间缓存后给新观众补发。 */
  pushTaskList() {
    const state = this.branchTaskList();
    if (state) this.emitEvent(state);
  }

  /** todo 工具执行结束：用本次 result.details 即时发（此刻 toolResult 可能还没进分支）。
   *  嵌套调用（parentToolCallId）不进主分支，非 todo 工具不发。 */
  pushTaskListFromTool(event: any) {
    if (!event || event.parentToolCallId) return;
    if (!isTodoToolName(event.toolName)) return;
    const result = event.result;
    const tasks = taskListFromDetails(result && typeof result === "object" ? result.details : undefined);
    if (!tasks) return;
    this.emitTaskList(tasks, "todo", Date.now());
  }

  /** plan-mode 扩展 appendEntry 的即时推送（会话内状态变化不一定伴随工具执行）。 */
  pushTaskListFromEntry(entry: any) {
    const plan = taskListFromPlanEntry(entry);
    if (!plan) return;
    this.emitTaskList(plan.tasks, "plan", plan.at || Date.now());
  }

  private emitTaskList(tasks: TaskItem[], source: TaskSource, at?: number) {
    if (!this.roomId) return;
    const state: any = { type: "task_list_state", tasks, source };
    if (typeof at === "number" && Number.isFinite(at)) state.at = at;
    this.emitEvent(state);
  }

  /* ---------------- 对话框观察 tap（O1）：安装 / 捕获 / 自检 / 还原 ---------------- */

  /** 在 session_start（bindSession 尾部）与自检自愈路径调用：把当前 ctx.ui 上的
   *  dialog 四方法与 fire-and-forget 全族 wrap 一层。已带 TAP_TAG 的方法直接接管
   *  （wrap 只做一次，闭包经 tapSink 找当前 Bridge）。本机无 UI（hasUI=false）不装。
   *  装不上（赋值不生效等）→ tapState=failed，UI 侧自动回退 ui_prompt 信号模式。 */
  installDialogTap() {
    try {
      const ctx: any = this.ctx;
      if (!ctx) return;
      try { if (ctx.hasUI === false) return; } catch { return; }
      let ui: any;
      try { ui = ctx.ui; } catch { return; }
      if (!ui || typeof ui !== "object") return;
      tapSink.bridge = this;
      const dialogMethods = ["select", "confirm", "input", "editor"];
      const observeMethods = ["notify", "setStatus", "setWidget", "setTitle", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel"];
      for (const name of dialogMethods) {
        const cur = ui[name];
        if (typeof cur !== "function" || (cur as any)[TAP_TAG]) continue;
        const wrapped = makeDialogMethod(ui, cur, name);
        try { ui[name] = wrapped; } catch { continue; }
        if (ui[name] === wrapped && !this.tapOriginals.has(name)) this.tapOriginals.set(name, cur);
      }
      for (const name of observeMethods) {
        const cur = ui[name];
        if (typeof cur !== "function" || (cur as any)[TAP_TAG]) continue;
        const wrapped = makeObserveMethod(ui, cur, name);
        try { ui[name] = wrapped; } catch { continue; }
        if (ui[name] === wrapped && !this.tapOriginals.has(name)) this.tapOriginals.set(name, cur);
      }
      this.tapUi = ui;
      const ready = dialogMethods.every((name) => typeof ui[name] === "function" && !!(ui[name] as any)[TAP_TAG]);
      if (ready) {
        if (this.tapState !== "ok") {
          this.tapState = "ok";
          this.tapMissed = 0;
          log("dialog tap 已安装（观察模式：弹窗内容可见）");
          this.emitExtStatus();
        }
      } else if (this.tapState === "ok") {
        this.tapState = "failed";
        log("dialog tap 安装不完整，已回退信号模式");
        this.emitExtStatus();
      }
    } catch (e: any) {
      log("dialog tap 安装失败（已忽略，本机不受影响）:", e?.message);
    }
  }

  /** 会话关闭时还原被 wrap 的方法（仍是 tapSink 属主才做，避免拆掉新 Bridge 接管的 wrap）。 */
  uninstallDialogTap() {
    // 接管持留的 dialog 先按取消落定：会话正在拆，不调原方法、不留挂起 promise（与属主无关，先于还原）
    try { this.releaseAllHeldDialogs("cancel"); } catch {}
    this.localOpenDialogs.clear(); // 已交回本机的登记随会话关闭一并作废（发现 A-5）
    try {
      if (tapSink.bridge !== this) return;
      tapSink.bridge = null;
      const ui: any = this.tapUi;
      if (ui) {
        for (const [name, orig] of this.tapOriginals) {
          try { if ((ui[name] as any) && (ui[name] as any)[TAP_TAG]) ui[name] = orig; } catch {}
        }
      }
      this.tapOriginals.clear();
      this.tapOpenDialogs.clear();
      this.tapState = "off";
    } catch {}
  }

  /** dialog 方法被调用（wrap 内同步执行）：组 dialog_open 帧并登记在开表。返回 dialogId。 */
  noteDialogCapture(kind: string, args: any[]): string | null {
    try {
      const id = `dlg-${++this.tapSeq}`;
      const startedAt = Date.now();
      this.tapOpenDialogs.set(id, startedAt);
      this.tapCaptures += 1;
      this.tapMissed = 0;
      this.tapLastCaptureAt = startedAt;
      if (this.tapState === "failed") this.tapState = "ok"; // 捕获恢复 = 自愈
      this.emitEvent(buildDialogOpen(kind, args, id, startedAt));
      return id;
    } catch {
      return null;
    }
  }

  /** dialog 的 promise 落定（wrap 内挂的 then 回调）：发 dialog_close 并销账。 */
  noteDialogClosed(dialogId: string, outcome: string) {
    try {
      this.localOpenDialogs.delete(dialogId); // 交回本机的登记同步销账（发现 A-5）
      if (!this.tapOpenDialogs.delete(dialogId)) return;
      this.emitEvent({ type: "dialog_close", dialogId, outcome, at: Date.now() });
    } catch {}
  }

  /* ---------------- 对话框应答接管（O2）：持留 / 裁决 / 落回 ----------------
   * 语义定版（定版说明第一部分 §2）：接管不是竞速——门控（开关 AND viewer 在线）全真时
   * 不调原方法、桥持 promise 等远程裁决；任一不成立走 O1 透传，与今天逐字一致。
   * fail-open 红线：tap 自检失效整体退回透传；连接断开把持留 dialog 交回本机弹窗；
   * 任何路径都不许让调用方的 promise 永久挂起或无声消失。 */

  /** 按 pi 原语义的"取消"返回值：confirm 回 false，其余回 undefined。 */
  private dialogCancelValue(kind: string): any {
    return kind === "confirm" ? false : undefined;
  }

  /** dialog 调用入口（wrap 内同步执行）：门控全真返回桥持的 promise，否则返回 null 落回透传。
   *  接管的 dialog 按调用顺序排队，同一时刻只一个处于可应答态（与本机单焦点对齐）。 */
  beginDialog(kind: string, args: any[], release: () => any): Promise<any> | null {
    if (!this.dialogAnswerEnabled || !this.dialogGateHasViewers) return null;
    if (this.tapState !== "ok") return null; // 自检失效 → O2 整体退回透传
    if (!this.roomId) return null;
    const opts = kind !== "editor" && args[2] && typeof args[2] === "object" ? args[2] : null;
    const signal = opts ? opts.signal : null;
    if (signal && signal.aborted) return null; // 已中止的调用落回原方法，按 pi 原语义处理
    const id = `dlg-${++this.tapSeq}`;
    let resolveFn: (value: any) => void = () => {};
    let rejectFn: (err: any) => void = () => {};
    const promise = new Promise<any>((res, rej) => { resolveFn = res; rejectFn = rej; });
    const entry: any = {
      id, kind, args, release,
      resolve: resolveFn, reject: rejectFn,
      settled: false, active: false, startedAt: 0, timer: null,
      signal: signal && typeof signal.addEventListener === "function" ? signal : null,
      onAbort: null,
    };
    if (entry.signal) {
      entry.onAbort = () => {
        try {
          if (entry.active) this.settleHeldDialog(entry, this.dialogCancelValue(entry.kind), "aborted");
          else this.dropQueuedDialog(entry);
        } catch {}
      };
      try { entry.signal.addEventListener("abort", entry.onAbort, { once: true }); } catch { entry.onAbort = null; }
    }
    this.dialogHeld.set(id, entry);
    if (this.dialogActiveId) this.dialogHeldQueue.push(id);
    else this.activateHeldDialog(entry);
    return promise;
  }

  /** 排队首个 dialog 点亮为可应答态：登记进 tap 在开表（与 O1 捕获同一本账，
   *  自检新鲜度与 Host 诊断 open 数都认它），发带 answerable 的 dialog_open，起裁决计时。 */
  private activateHeldDialog(entry: any) {
    entry.active = true;
    this.dialogActiveId = entry.id;
    entry.startedAt = Date.now();
    this.tapOpenDialogs.set(entry.id, entry.startedAt);
    this.tapCaptures += 1;
    this.tapMissed = 0;
    this.tapLastCaptureAt = entry.startedAt;
    const open = buildDialogOpen(entry.kind, entry.args, entry.id, entry.startedAt);
    open.answerable = true;
    // 超时由桥裁决：opts.timeout 优先（已在 open 帧里），没有就用协议登记的桥侧上限；
    // 兜底值写回帧里——观看端倒计时与重连补发后的剩余时限（startedAt+timeout 重算）同源
    const limit = (PROTOCOL.limits as any).dialogAnswerTimeoutMs;
    const ms = typeof open.timeout === "number" && open.timeout > 0
      ? open.timeout
      : (typeof limit === "number" && limit > 0 ? limit : 120000);
    if (typeof open.timeout !== "number") open.timeout = ms;
    this.emitEvent(open);
    entry.timer = setTimeout(() => {
      try { this.settleHeldDialog(entry, this.dialogCancelValue(entry.kind), "timeout"); } catch {}
    }, ms);
    if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
  }

  private activateNextHeldDialog() {
    if (this.dialogActiveId) return;
    while (this.dialogHeldQueue.length) {
      const id = this.dialogHeldQueue.shift() as string;
      const next = this.dialogHeld.get(id);
      if (!next || next.settled) continue;
      this.activateHeldDialog(next);
      return;
    }
  }

  /** 持留 dialog 的唯一落定出口：resolve + （点亮过的）发 dialog_close{reason,note?} + 点亮下一个。
   *  note 只进 close 帧供广播呈现，绝不进 resolve 值（pi 值域装不下，定版明文）。 */
  private settleHeldDialog(entry: any, value: any, reason: string, note?: string) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch {}
      entry.onAbort = null;
    }
    this.dialogHeld.delete(entry.id);
    const qi = this.dialogHeldQueue.indexOf(entry.id);
    if (qi >= 0) this.dialogHeldQueue.splice(qi, 1);
    const wasActive = this.dialogActiveId === entry.id;
    if (wasActive) this.dialogActiveId = null;
    if (entry.active) {
      this.tapOpenDialogs.delete(entry.id);
      const close: any = { type: "dialog_close", dialogId: entry.id, outcome: "resolved", reason, at: Date.now() };
      if (typeof note === "string" && note) close.note = note.slice(0, (PROTOCOL.limits as any).dialogNoteMax || 500);
      this.emitEvent(close);
    }
    entry.resolve(value);
    if (wasActive) this.activateNextHeldDialog();
  }

  /** 排队中的 dialog 被 abort：从未点亮过，不发任何帧，静默按取消 resolve。 */
  private dropQueuedDialog(entry: any) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch {}
      entry.onAbort = null;
    }
    this.dialogHeld.delete(entry.id);
    const qi = this.dialogHeldQueue.indexOf(entry.id);
    if (qi >= 0) this.dialogHeldQueue.splice(qi, 1);
    entry.resolve(this.dialogCancelValue(entry.kind));
  }

  /** 远程答案 → resolve 值（与 pi 原语义逐字对齐）。形状不合法回 { ok:false }。 */
  private dialogAnswerValue(entry: any, msg: any): { ok: boolean; value?: any } {
    const action = typeof msg.action === "string" ? msg.action : "";
    if (action === "deny") return { ok: true, value: this.dialogCancelValue(entry.kind) };
    if (entry.kind === "confirm") {
      return action === "allow" ? { ok: true, value: true } : { ok: false };
    }
    if (action !== "submit") return { ok: false };
    const value = msg.value;
    if (typeof value !== "string") return { ok: false };
    if (entry.kind === "select") {
      const options = Array.isArray(entry.args[1]) ? entry.args[1].map((v: any) => String(v ?? "")) : [];
      if (!options.includes(value)) return { ok: false };
    }
    return { ok: true, value };
  }

  /** relay 转来的 dialog_answer（先答广播）：只有当前可应答的那一个能被 resolve；
   *  迟到 / 排队中 / 未知 id 一律回 dialog_gone；形状不合法回 bad_args（dialog 仍可答）。
   *  回执统一走 dialog_answer_result 帧（aid 对号）。 */
  noteDialogAnswer(msg: any) {
    const aid = typeof msg.aid === "string" ? msg.aid : "";
    const dialogId = typeof msg.dialogId === "string" ? msg.dialogId : "";
    const reply = (ok: boolean, code?: string) => {
      if (!aid) return;
      const frame: any = { type: "dialog_answer_result", aid, dialogId, ok };
      if (!ok && code) frame.code = code;
      try { this.send(frame); } catch {}
    };
    try {
      const entry = dialogId ? this.dialogHeld.get(dialogId) : null;
      if (!entry || entry.settled || !entry.active || this.dialogActiveId !== dialogId) {
        reply(false, "dialog_gone");
        return;
      }
      const verdict = this.dialogAnswerValue(entry, msg);
      if (!verdict.ok) {
        reply(false, "bad_args");
        return;
      }
      const isDeny = msg.action === "deny";
      const note = isDeny && typeof msg.note === "string" && msg.note
        ? msg.note.slice(0, (PROTOCOL.limits as any).dialogNoteMax || 500)
        : undefined;
      this.settleHeldDialog(entry, verdict.value, isDeny ? "denied" : "answered", note);
      reply(true);
    } catch {
      reply(false, "dialog_gone");
    }
  }

  /** fail-open 落回本机：把一个持留 dialog 交还原方法在本机弹出。
   *  点亮过的先补发一条观察形态 dialog_open（去掉 answerable，卡面转只读）；排队中的从未
   *  点亮，不发 open——但两者都在此登记进 localOpenDialogs 并补进在开表，落定统一走
   *  noteDialogClosed 发 close 销账（发现 A-5：断线重连后靠登记重发 open，close 与之成对）。
   *  onDone 在本机落定后回调一次（串行链推进用，发现 A-4）；已落定的 entry 立即回调。 */
  private releaseHeldDialogToLocal(entry: any, onDone?: () => void) {
    const done = () => { if (onDone) { try { onDone(); } catch {} } };
    if (entry.settled) { done(); return; }
    entry.settled = true;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch {}
      entry.onAbort = null;
    }
    this.dialogHeld.delete(entry.id);
    const qi = this.dialogHeldQueue.indexOf(entry.id);
    if (qi >= 0) this.dialogHeldQueue.splice(qi, 1);
    if (this.dialogActiveId === entry.id) this.dialogActiveId = null;
    const wasActive = entry.active;
    // 登记"已交回本机仍在开"：active 的沿用点亮时的 startedAt（时限不重算）；
    // 排队中的以交回此刻为起点（本机真正弹出在这一刻）。在开表同补——落定发 close、
    // 自检与 Host 诊断的 open 计数都认同一本账，与 O1 捕获的本机 dialog 同口径。
    const localStartedAt = wasActive && entry.startedAt ? entry.startedAt : Date.now();
    this.localOpenDialogs.set(entry.id, { kind: entry.kind, args: entry.args, startedAt: localStartedAt });
    if (!this.tapOpenDialogs.has(entry.id)) this.tapOpenDialogs.set(entry.id, localStartedAt);
    if (wasActive) {
      try { this.emitEvent(buildDialogOpen(entry.kind, entry.args, entry.id, entry.startedAt)); } catch {}
    }
    let result: any;
    try {
      result = entry.release();
    } catch (e) {
      this.noteDialogClosed(entry.id, "error");
      entry.reject(e);
      done();
      return;
    }
    try {
      if (result && typeof result.then === "function") {
        result.then(
          (v: any) => { this.noteDialogClosed(entry.id, "resolved"); entry.resolve(v); done(); },
          (e: any) => { this.noteDialogClosed(entry.id, "rejected"); entry.reject(e); done(); },
        );
      } else {
        this.noteDialogClosed(entry.id, "resolved");
        entry.resolve(result);
        done();
      }
    } catch { entry.resolve(result); done(); }
  }

  /** 交回本机的串行泵（发现 A-4）：同一时刻只调起一个原方法，前一个在本机落定后
   *  才放下一个——避免同 tick 多个本机弹窗并发（远程侧的单焦点语义在本机交回侧同样成立）。
   *  多路触发（断线 / 门控翻假 / 开关关）共用同一条链，后到者只入队不另起并发链。 */
  private pumpLocalReleases() {
    if (this.dialogLocalReleaseBusy) return;
    const entry = this.dialogLocalReleaseQueue.shift();
    if (!entry) return;
    this.dialogLocalReleaseBusy = true;
    try {
      this.releaseHeldDialogToLocal(entry, () => {
        this.dialogLocalReleaseBusy = false;
        this.pumpLocalReleases();
      });
    } catch {
      this.dialogLocalReleaseBusy = false;
      this.pumpLocalReleases();
    }
  }

  /** 全部持留 dialog 的收尾：mode=local 交回本机弹窗（连接断开时用，接管承诺断了的唯一诚实出路）；
   *  mode=cancel 直接按取消 resolve（会话关闭时用，不调原方法、不留挂起 promise）。 */
  releaseAllHeldDialogs(mode: "local" | "cancel") {
    if (mode === "cancel") {
      this.dialogLocalReleaseQueue = [];
      if (!this.dialogHeld.size) return;
      const entries = [...this.dialogHeld.values()];
      this.dialogHeldQueue = [];
      for (const entry of entries) {
        try { this.settleHeldDialog(entry, this.dialogCancelValue(entry.kind), "aborted"); } catch {}
      }
      return;
    }
    if (!this.dialogHeld.size) return;
    const entries = [...this.dialogHeld.values()];
    entries.sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));
    for (const entry of entries) this.dialogLocalReleaseQueue.push(entry);
    this.pumpLocalReleases();
  }

  /** 重连 sync 完成后重发"已交回本机仍在开"的 dialog 的观察形态 dialog_open（发现 A-5）：
   *  断线时 relay 已清槽并广播 gone，不重发则等待卡 / 注意力对这些 dialog 断粮；
   *  startedAt 沿用登记原值，剩余时限由消费端按 startedAt + timeout 重算、不重新计时。
   *  调用点在 room_registered 的 sync 之后——排在快照帧后面发，不被 relay 清槽/对齐冲掉。 */
  private republishLocalDialogs() {
    try {
      if (!this.localOpenDialogs.size) return;
      for (const [id, info] of [...this.localOpenDialogs]) {
        // 在开表里已不在 = 本机其实已落定（close 销账漏网时兜底），不重发幽灵卡
        if (!this.tapOpenDialogs.has(id)) { this.localOpenDialogs.delete(id); continue; }
        try { this.emitEvent(buildDialogOpen(info.kind, info.args, id, info.startedAt)); } catch {}
      }
    } catch {}
  }

  /** fire-and-forget 方法被调用（wrap 内同步执行）：notify 立帧，状态类先更新自建表再发全量快照。 */
  noteUiObserve(name: string, args: any[]) {
    try {
      if (name === "notify") {
        const raw = typeof args[0] === "string" ? args[0] : "";
        const message = raw.slice(0, PROTOCOL.limits.extNotifyMax);
        if (!message) return;
        // 远程消息注入时 TUI 的“📱 远程消息…”只是本机提示，不再镜像成网页右下角 toast。
        if (raw.startsWith("📱 远程消息")) return;
        const level = typeof args[1] === "string" ? args[1] : null;
        this.emitEvent({ type: "ext_notify", message, level, at: Date.now() });
        return;
      }
      if (name === "setStatus") {
        const key = typeof args[0] === "string" ? args[0] : "";
        if (!key) return;
        const text = typeof args[1] === "string" ? args[1].slice(0, PROTOCOL.limits.statusTextMax) : "";
        if (text) this.extStatusByKey.set(key, text);
        else this.extStatusByKey.delete(key);
      } else if (name === "setWidget") {
        const key = typeof args[0] === "string" ? args[0] : "";
        if (!key) return;
        const content = args[1];
        const placement = args[2] && typeof args[2] === "object" && typeof args[2].placement === "string" ? args[2].placement : undefined;
        if (content === undefined || content === null) {
          this.extWidgets.delete(key);
        } else if (Array.isArray(content)) {
          const widget: any = { key, lines: content.slice(0, PROTOCOL.limits.widgetLinesMax).map((line) => String(line ?? "").slice(0, PROTOCOL.limits.widgetLineChars)) };
          if (placement) widget.placement = placement;
          this.extWidgets.set(key, widget);
        } else {
          // 工厂形态不可序列化：只记"被调用/被设置"这一事实（定版口径）
          const widget: any = { key, factory: true };
          if (placement) widget.placement = placement;
          this.extWidgets.set(key, widget);
        }
      } else if (name === "setTitle") {
        this.extTitle = typeof args[0] === "string" ? args[0].slice(0, PROTOCOL.limits.dialogTitleMax) : null;
      } else if (name === "setWorkingMessage") {
        this.extWorking = { ...(this.extWorking || {}), message: typeof args[0] === "string" ? args[0].slice(0, PROTOCOL.limits.statusTextMax) : null };
      } else if (name === "setWorkingVisible") {
        this.extWorking = { ...(this.extWorking || {}), visible: !!args[0] };
      } else if (name === "setWorkingIndicator") {
        const frames = args[0] && Array.isArray(args[0].frames) ? args[0].frames.slice(0, 16).map((f: any) => String(f ?? "").slice(0, 32)) : null;
        this.extWorking = { ...(this.extWorking || {}), indicatorFrames: frames };
      } else if (name === "setHiddenThinkingLabel") {
        this.extWorking = { ...(this.extWorking || {}), hiddenThinkingLabel: typeof args[0] === "string" ? args[0].slice(0, PROTOCOL.limits.statusTextMax) : null };
      } else {
        return;
      }
      this.emitExtStatus();
    } catch {}
  }

  /** ext_status 全量快照（与 task_list_state 同范式：relay 按房间缓存、晚订阅补发）。 */
  emitExtStatus() {
    if (!this.roomId) return;
    const statuses: Record<string, string> = {};
    for (const [key, text] of this.extStatusByKey) statuses[key] = text;
    this.emitEvent({
      type: "ext_status",
      statuses,
      widgets: [...this.extWidgets.values()],
      title: this.extTitle,
      working: this.extWorking,
      tap: { state: this.tapState },
      at: Date.now(),
    });
  }

  /** 自检 + 自愈（forward 收到 ui_prompt_start/end 时调用，入参是原始事件）：
   *  - dialog 类 start 到达而最近 3 秒无捕获、无在开 dialog → 记一次未命中；连续 2 次判失效；
   *  - 宿主重设 context（ui 对象变了）或 tap 不在 ok 态 → 节流重装。
   *  custom 类 start 不捕获是设计内（内容不可序列化），不计未命中。 */
  noteUiPromptSignal(event: any) {
    try {
      if (!event || event.type !== "ui_prompt_start") return;
      const kind = typeof event.kind === "string" ? event.kind : "";
      if (DIALOG_KINDS.has(kind) && this.tapState === "ok") {
        const fresh = this.tapLastCaptureAt > 0 && Date.now() - this.tapLastCaptureAt < 3000;
        if (!fresh && this.tapOpenDialogs.size === 0) {
          this.tapMissed += 1;
          if (this.tapMissed >= 2) {
            this.tapMissed = 0;
            this.tapState = "failed";
            log("dialog tap 自检失败：ui_prompt_start 未被捕获，已回退信号模式");
            try { recordDiagError("dialog tap 自检失败，已回退信号模式（弹窗内容不可见）"); } catch {}
            this.emitExtStatus();
          }
        }
      }
      const now = Date.now();
      if (now - this.tapLastInstallTryAt > 5000) {
        let ui: any = null;
        try { ui = this.ctx && this.ctx.ui; } catch {}
        if (ui) {
          // 自愈只处理真失效形态：context 对象被换掉 / 还没装 / 方法上的 wrap 标记被宿主
          // 替换掉了。同一对象上自检判 failed 不靠重装恢复（重装同样的 wrap 没用、还会把
          // failed 状态抖回 ok）——恢复靠下一次真实捕获（noteDialogCapture 会翻回 ok）。
          const untagged = ["select", "confirm", "input", "editor"].some(
            (name) => typeof ui[name] === "function" && !(ui[name] as any)[TAP_TAG],
          );
          if (ui !== this.tapUi || this.tapState === "off" || untagged) {
            this.tapLastInstallTryAt = now;
            this.installDialogTap();
          }
        }
      }
    } catch {}
  }

  /** 分支世代（epoch）：同一 Bridge 实例里换分支（navigate_tree / 终端 /tree）后 +1。
   *  relay 收到**同一 instance** 的 epoch 变化 → store.reset()，随后的对齐必然走全量 seed，
   *  否则新旧分支消息会在存储里并集。
   *  instance 是本 Bridge 的随机 id：pi 重启 / runtime 重载后 instance 变了，epoch 从 1 重来
   *  不代表换了分支——relay 不清库，由 room_registered 的首尾 hash 判断能否只补尾部。 */
  private static nextGeneration = 1;
  private gen = 1;
  private readonly generation = Bridge.nextGeneration++;
  private readonly instance = crypto.randomBytes(6).toString("hex");

  roomPayload() {
    const idn = deviceIdentity(process.env, this.platform);
    const room: any = {
      id: this.roomId,
      label: this.sessionName || LABEL || (this.cwd ? this.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() : null) || this.roomId,
      cwd: this.cwd,
      epoch: this.gen,
      instance: this.instance,
      generation: this.generation,
      accountId: idn.accountId,
      deviceName: idn.deviceName,
      platform: idn.platform,
    };
    if (idn.deviceId) room.deviceId = idn.deviceId;
    return room;
  }

  /** 分支换代：epoch +1 并重新注册（relay reset 存储 → room_registered 回 0 条 → 推全量 seed）。
   *  必须先 bump 再同步：先推快照会被当成"重连补洞"，得到新旧分支并集。 */
  bumpEpoch(reason: string) {
    this.gen += 1;
    log("会话换代 epoch →", this.gen, "(", reason, ")");
    this.requestSync(reason, true);
  }

  /** session_start / 换会话后调用：绑定当前会话并对齐镜像。任何异常只能吞掉——
   *  这里抛异常会逃逸进 pi 的事件分发，连累整个扩展 runtime */
  bindSession(ctx: any) {
    try {
      this.ctx = ctx;
      const sm = ctx?.sessionManager;
      const id = sm?.sessionId || sm?.sessionFile || null;
      if (!id) {
        log("拿不到 sessionId，跳过绑定");
        return;
      }
      const previousId = this.roomId;
      const changed = id !== this.roomId;
      if (changed) {
        this.flushPending();
        // 还在等送达确认的消息属于旧会话：不在这里结案的话，新会话里一条更长的同前缀消息会把它误判成已送达
        if (this.roomId) this.abandonDeliveries("目标会话已切换，消息未注入");
        // 远程待发缓冲不跨会话：旧房间的 pending 记失败并广播，新会话从空队列开始。
        if (this.roomId) this.resetRemoteQueueForSession("目标会话已切换，待发消息未注入", "session_switched", this.roomId);
        this._lastUsagePayload = "";
      }
      this.roomId = String(id);
      this.cwd = sm?.cwd || ctx?.cwd || null;
      const name = (sm && typeof sm.getSessionName === "function" ? sm.getSessionName() : null) || (this.pi && typeof this.pi.getSessionName === "function" ? this.pi.getSessionName() : null) || null;
      this.sessionName = name ? String(name) : null;
      this.nameDirty = true;
      log("绑定会话:", this.roomId, this.sessionName ? `(${this.sessionName})` : "");
      this.requestSync(changed ? "session_switch" : "bind", true);
      this.pushUsage("bind");
      try { this.noteSessionBound(changed, previousId); } catch (err: any) { log("清单上报调度失败:", err?.message); }
      // dialog tap 在 session_start 后装（宿主此时已 setUIContext）：观察层，本机零感知
      try { this.installDialogTap(); } catch (err: any) { log("dialog tap 安装调度失败:", err?.message); }
    } catch (e: any) {
      // sessionManager getter 在 runtime 失效时直接抛（assertActive）
      log("绑定会话失败（runtime 可能已失效，已忽略）:", e?.message);
    }
  }

  /** 连上后的第一次绑定发全量；之后 session_start / 换会话发增量（旧活动置假）。 */
  noteSessionBound(changed: boolean, previousId: any) {
    if (!deviceIdentity().deviceId) return;
    if (!this.connected || !this.roomId) return;
    if (!this.manifestArmed) {
      this.manifestArmed = true;
      this.enqueueManifest({ full: true });
      return;
    }
    if (changed) this.enqueueManifest({ ids: [previousId, this.roomId].filter(Boolean) });
    else this.enqueueManifest({ ids: [this.roomId] });
  }

  /** agent_settled：当前活动会话的 updatedAt/messageCount，至少间隔 60s。 */
  noteManifestActivity() {
    if (!deviceIdentity().deviceId || !this.connected || !this.roomId) return;
    const now = Date.now();
    if (this.lastActivityManifestAt && now - this.lastActivityManifestAt < MANIFEST_THROTTLE_MS) return;
    this.lastActivityManifestAt = now;
    this.enqueueManifest({ activity: true, ids: [this.roomId] });
  }

  enqueueManifest(partial: any) {
    if (!deviceIdentity().deviceId) return;
    if (!this.connected || this.closing) return;
    const cur = this.pendingManifest || { full: false, ids: new Set<string>(), removed: new Set<string>(), activity: false, rows: [] as any[] };
    if (partial && partial.full) cur.full = true;
    if (partial && partial.activity) cur.activity = true;
    for (const id of (partial && partial.ids) || []) if (id) cur.ids.add(String(id));
    for (const id of (partial && partial.removed) || []) if (id) cur.removed.add(String(id));
    // 文件级操作（改名/冷 fork）不依赖 SessionManager.list 能扫到目标目录：把刚写的行直接带进增量帧。
    for (const row of (partial && partial.rows) || []) if (row && row.id) cur.rows.push(row);
    this.pendingManifest = cur;
    if (this.manifestTimer) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      void this.flushManifest();
    }, MANIFEST_COALESCE_MS);
    if (this.manifestTimer.unref) this.manifestTimer.unref();
  }

  async collectSessions() {
    const dirs = manifestProjectDirs(this.cwd, process.env, this.platform);
    if (!dirs.length) return null;
    const lister = this.sessionLister || defaultSessionLister;
    const merged = new Map<string, any>();
    let ok = false;
    for (const cwd of dirs) {
      try {
        const list = (await lister(cwd)) || [];
        ok = true;
        for (const raw of list) {
          if (!raw || raw.deleted) continue;
          const row = normalizeSessionEntry(raw, cwd);
          if (!row || !row.id) continue;
          const prev = merged.get(row.id);
          if (!prev || (row.updatedAt || 0) >= (prev.updatedAt || 0)) merged.set(row.id, row);
        }
      } catch (e: any) {
        log("SessionManager.list 失败:", cwd, e?.message);
      }
    }
    if (!ok) return null;
    return [...merged.values()];
  }

  liveMessageCount() {
    try {
      const sm = this.ctx && this.ctx.sessionManager;
      if (sm && typeof sm.getBranch === "function") return extractMessages(sm.getBranch() || []).length;
    } catch {}
    return null;
  }

  syntheticSession(id: any) {
    const sid = String(id || "");
    if (!sid) return null;
    const cached = this.indexCache.get(sid);
    if (cached && sid !== String(this.roomId)) return cached;
    // 非活动会话查不到（目录被移出 projects / 文件被删）就**不上报**：
    // 以前的 messageCount:0 假行会靠 updatedAt=now 覆盖 relay 里准确的那一行
    if (sid !== String(this.roomId)) return cached || null;
    let file = "";
    try {
      const sm = this.ctx && this.ctx.sessionManager;
      if (sm && typeof sm.getSessionFile === "function") file = String(sm.getSessionFile() || "");
    } catch {}
    return normalizeSessionEntry({
      id: sid,
      path: file,
      name: this.sessionName,
      cwd: this.cwd,
      messageCount: this.liveMessageCount() || 0,
      updatedAt: Date.now(),
    }, this.cwd || "");
  }

  /** 文件时间是基准。只有名字、条数、路径、活动位变了才把时间拨到现在，避免增量的“现在”把随后的全量文件时间盖掉。 */
  stampSession(row: any) {
    const id = String(row.id);
    const fileAt = Number(row.updatedAt) || 0;
    const prev = this.sentStamp.get(id);
    // active 由调用方按 this.roomId 判定后传入：原来直接比 row.active，而清单行走到这里时还没有
    // active 字段（buildSessionManifest 之后才打），比较永远不成立——换会话时旧活动行不会被重新盖时间。
    const active = !!row.active || String(id) === String(this.roomId);
    const changed = !prev || prev.name !== row.name || prev.messageCount !== row.messageCount || prev.path !== row.path || prev.active !== active || prev.cwd !== row.cwd;
    const updatedAt = changed ? Math.max(fileAt, prev ? prev.at + 1 : fileAt) : Math.max(fileAt, prev ? prev.at : 0);
    this.sentStamp.set(id, { at: updatedAt, name: row.name, messageCount: row.messageCount, path: row.path, active, cwd: row.cwd });
    return { ...row, updatedAt };
  }

  async flushManifest() {
    const job = this.pendingManifest;
    this.pendingManifest = null;
    if (!job || this.closing || !this.connected) return;
    const idn = deviceIdentity();
    if (!idn.deviceId) return;
    try {
      const extra = new Map<string, any>();
      for (const raw of job.rows || []) {
        const row = normalizeSessionEntry(raw, this.cwd);
        if (!row) continue;
        extra.set(row.id, row);
        this.indexCache.set(row.id, row);
      }
      const listed = await this.collectSessions();
      if (listed == null && job.full && !extra.size) {
        if (!this._manifestSkipLogged) {
          this._manifestSkipLogged = true;
          log("会话清单读取失败，跳过全量上报");
        }
        return;
      }
      if (listed) {
        for (const row of listed) this.indexCache.set(row.id, row);
      }
      let sessions: any[] = [];
      if (job.full) {
        sessions = [...(listed || [])];
        const seen = new Set(sessions.map((s: any) => String(s.id)));
        for (const [id, row] of extra) if (!seen.has(id)) sessions.push(row);
      } else {
        for (const id of job.ids) {
          const fromList = (listed || []).find((s: any) => s.id === id);
          const row = fromList || extra.get(id) || this.indexCache.get(id) || this.syntheticSession(id);
          if (row) sessions.push({ ...row });
        }
      }
      if (this.nameDirty && this.roomId) {
        const current = String(this.roomId);
        sessions = sessions.map((s) => (String(s.id) === current ? { ...s, name: this.sessionName } : s));
        this.nameDirty = false;
      }
      sessions = sessions.map((s) => this.stampSession(s));
      const frame = buildSessionManifest({
        accountId: idn.accountId,
        deviceId: idn.deviceId,
        sessions,
        activeId: this.roomId,
        full: !!job.full,
        removed: [...job.removed],
        now: Date.now(),
      });
      this.send(frame, { essential: true });
    } catch (e: any) {
      log("会话清单上报失败:", e?.message);
    }
  }

  /* ---------- 镜像同步：先问 relay 有多少，再决定只补尾部（append）还是推全量 ---------- */
  private syncTimer: any = null;
  private probeTimer: any = null;
  /** relay 回过 room_registered = 支持 v3 对齐协议（sync / append / snapshot_request） */
  private relayV3 = false;
  /** v4 relay 在 auth_result 里声明的能力；旧 relay 不带时为 null，退回按回包猜 */
  relayCaps: Set<string> | null = null;
  /** 这条连接是按设备令牌（token）还是共享令牌（legacy）登录的 */
  relayAuth: string | null = null;

  applyRelayCaps(msg: any) {
    if (!Array.isArray(msg.caps)) {
      this.relayCaps = null;
      this.relayAuth = null;
      return;
    }
    this.relayCaps = new Set(msg.caps.map((c: any) => String(c)));
    this.relayAuth = typeof msg.auth === "string" ? msg.auth : null;
    // 能力明说了就不用再猜：sync.v3 → 直接走轻量 sync；没有 room.label 就一直用整包 room_register 改名
    if (this.relayCaps.has("sync.v3")) this.relayV3 = true;
    this.noRoomLabel = !this.relayCaps.has("room.label");
    if (this.relayAuth === "legacy" && HAS_DEVICE_TOKEN) log("relay 没接受设备令牌，按共享令牌登录了（检查 PI_REMOTE_DEVICE_ID / PI_REMOTE_DEVICE_TOKEN）");
  }

  /** 镜像消息 = 当前分支路径（mirrorMessages）；runtime 失效时 getter 会抛 */
  mirror(): any[] | null {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") return null;
    return mirrorMessages(sm.getBranch() || []);
  }

  /** 发起对齐：register=true 走 room_register（绑定/换代/重连），否则走轻量 sync。
   *  relay 回 room_registered {msgCount, firstHash, lastHash} 后由 syncSnapshot 决定发什么。
   *  旧版 relay 不回：超时兜底推全量。 */
  requestSync(reason: string, register = false) {
    if (!this.roomId || !this.connected) return;
    this.flushPending();
    if (register || !this.relayV3) this.send({ type: "room_register", room: this.roomPayload() }, { essential: true });
    else this.send({ type: "sync", room: this.roomId }, { essential: true });
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      log("relay 未回 room_registered，推全量快照（", reason, "）");
      this.pushSnapshot(reason);
      this.pushTaskList();
      this.publishRemoteQueue();
    }, this.relayV3 ? 5000 : 2500);
  }

  /** 去抖的对齐探测：终端 `!cmd`（bashExecution）、回合结束时冲刷的挂起消息都不走 message_end，
   *  只能事后按 hash 对一次 */
  scheduleProbe(ms: number) {
    if (!this.relayV3 || !this.roomId) return;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      this.requestSync("probe");
    }, ms);
  }

  /** relay 的存储是否是本机镜像 L 的一段连续区间 [j-n+1, j]。
   *  首尾 hash 都要对上；relay 带了 tailHashes（最近若干条）时整段逐条对上。
   *  只看首尾时，同内容的 custom/摘要会把另一段误认成已同步，补尾部会把中间消息再追加一遍。
   *  常见情况 j = n-1（relay 存的就是前 n 条）；relay 用截断快照 seed 过时区间从中间开始。 */
  alignTail(L: any[], info: any): number {
    const n = Number(info.msgCount) || 0;
    if (n <= 0 || L.length < n || !info.lastHash || !info.firstHash) return -1;
    const tail = Array.isArray(info.tailHashes) ? info.tailHashes.filter((h: any) => typeof h === "string" && h) : [];
    const hashes: string[] = new Array(L.length);
    const hAt = (i: number) => (hashes[i] !== undefined ? hashes[i] : (hashes[i] = hashOf(L[i])));
    const fits = (j: number) => {
      if (j - n + 1 < 0 || hAt(j) !== info.lastHash || hAt(j - n + 1) !== info.firstHash) return false;
      if (tail.length && j - tail.length + 1 < 0) return false;
      for (let t = 0; t < tail.length; t++) if (hAt(j - tail.length + 1 + t) !== tail[t]) return false;
      return true;
    };
    if (fits(n - 1)) return n - 1;
    for (let j = L.length - 1; j > n - 1; j--) if (fits(j)) return j;
    return -1;
  }

  syncSnapshot(info: any) {
    try {
      if (!this.roomId) return;
      const L = this.mirror();
      if (!L) return;
      const n = Number(info.msgCount) || 0;
      if (n === 0) {
        if (L.length) this.pushSnapshot("seed", L);
        return;
      }
      const j = this.alignTail(L, info);
      if (j >= 0) {
        const tail = L.slice(j + 1);
        if (!tail.length) return;
        const payload = this.serializeSnapshot(tail.map((m) => shrinkDeep(m)), { mode: "append", base: { count: n, hash: info.lastHash } });
        if (payload) {
          this.sendRaw(payload.json, { essential: true }, "snapshot");
          log("镜像补尾部:", tail.length, "条");
          return;
        }
      }
      log("镜像与 relay 不连续（relay", n, "条，本机", L.length, "条），推全量");
      this.pushSnapshot("realign", L);
    } catch (e: any) {
      log("镜像对齐失败:", e?.message);
    } finally {
      // 对齐结果是“完全一致/只补尾部”时没有快照帧，但 relay 可能刚重启、内存缓存为空：
      // 任务清单与远程待发缓冲仍要补一次，否则新观众看不到当前状态。
      try { this.pushTaskList(); } catch {}
      try { this.publishRemoteQueue(); } catch {}
    }
  }

  /** 逐条序列化一次，从尾部往前装到预算为止（O(n)；旧实现每丢一条就整包重新 stringify，O(n²)）。
   *  单条超过 1/4 预算的消息先截断长字符串（头部保留 ⇒ hash 不变）。
   *  allowDrop=false（append）时装不下直接返回 null，由调用方退回全量。 */
  serializeSnapshot(msgs: any[], extra: any, allowDrop = false, roomId?: string): { json: string; dropped: number } | null {
    const budget = FRAME_MAX_BYTES - 64 * 1024;
    const parts: string[] = new Array(msgs.length);
    const sizes: number[] = new Array(msgs.length);
    for (let i = 0; i < msgs.length; i++) {
      let s: string;
      try {
        s = JSON.stringify(msgs[i]);
      } catch {
        s = JSON.stringify({ role: msgs[i] && msgs[i].role, timestamp: msgs[i] && msgs[i].timestamp, content: [{ type: "text", text: "[消息无法序列化]" }] });
      }
      if (s.length * 3 > budget / 4 && Buffer.byteLength(s, "utf8") > budget / 4) {
        s = JSON.stringify({ ...truncateStringsDeep(msgs[i], OVERSIZE_STRING_KEEP), truncated: true });
      }
      parts[i] = s;
      sizes[i] = Buffer.byteLength(s, "utf8") + 1;
    }
    let start = msgs.length;
    let total = 0;
    while (start > 0 && total + sizes[start - 1] <= budget) total += sizes[--start];
    const dropped = start;
    if (dropped && !allowDrop) return null;
    const head: any = { type: "snapshot", room: roomId || this.roomId, busy: this.busy, ...extra };
    if (dropped) {
      head.truncated = true;
      head.dropped = dropped;
    }
    const h = JSON.stringify(head);
    const json = h.slice(0, -1) + `,"messages":[` + parts.slice(start).join(",") + `]}`;
    return { json, dropped };
  }

  /** 全量快照：relay 用 seedOrMerge 判断续传还是换代。超预算从头部丢最旧消息并标记 truncated。
   *  roomId 缺省用当前房间；resend_snapshot 以帧里的 room 为准。 */
  pushSnapshot(reason: string, pre?: any[], roomId?: string) {
    try {
      const room = roomId || this.roomId;
      if (!room) return;
      const L = pre || this.mirror();
      if (!L) return;
      const out = this.serializeSnapshot(L.map((m) => shrinkDeep(m)), {}, true, room);
      if (!out) return;
      if (out.dropped) log("快照超预算，已从头部丢弃最旧", out.dropped, "条，剩余", L.length - out.dropped, "条");
      this.sendRaw(out.json, { essential: true }, "snapshot");
      log("推全量快照（", reason, "）:", L.length - out.dropped, "条");
    } catch (e: any) {
      // sessionManager getter 在 runtime 失效时直接抛（assertActive）
      log("快照失败:", e?.message);
    }
  }

  /**
   * pi 1.0.2 扩展钩子 → 网页已在听的 compaction_start / compaction_end。
   * 返回 true 表示已处理。不是这三条钩子（还没进入压缩）返回 false，不发这两帧。
   * session_before_compact 的原事件含 branchEntries / signal / preparation，不上线。
   * session_compact 不带 compactionEntry，结束帧仍走 forward 里原来的 requestSync("compaction")。
   */
  private translateCompactionHook(event: any): boolean {
    const t = event.type;
    if (t === "session_before_compact") {
      this.forward({
        type: "compaction_start",
        reason: event.reason ?? null,
        willRetry: !!event.willRetry,
      }, false);
      return true;
    }
    if (t === "session_compact") {
      this.forward({
        type: "compaction_end",
        aborted: false,
        reason: event.reason ?? null,
        willRetry: !!event.willRetry,
      }, false);
      return true;
    }
    if (t === "session_compact_failed") {
      this.forward(event, false);
      this.forward({
        type: "compaction_end",
        aborted: !!event.aborted,
        errorMessage: event.errorMessage ?? null,
        reason: event.reason ?? null,
        willRetry: !!event.willRetry,
      }, false);
      return true;
    }
    return false;
  }

  /** 事件转发：事件一个不少、顺序不变；载荷经 projectEvent 投影、流式 delta 经 emitEvent 合并
   *  （见 FORWARD_EVENTS 注释）。任何异常只记录不抛出——抛进 pi 事件循环会让扩展 runtime 失效。
   *  translate=false 时不再把扩展压缩钩子翻成网页帧（避免 session_compact_failed 递归）。 */
  forward(event: any, translate = true) {
    if (!event || !this.roomId) return;
    // 先于本帧发出队列变化：pi 自己也是先改队列再发 message_start。queue_update 不再进来，避免递归。
    if (event.type !== "queue_update") {
      try { this.syncOutboundQueue(event); } catch (e: any) { log("待发队列更新失败:", event.type, e?.message); }
    }
    if (translate && this.translateCompactionHook(event)) return;
    const t = event.type;
    // dialog tap 自检/自愈：只看原始事件的 kind（投影后字段不够），处理在投影之前
    if (t === "ui_prompt_start") { try { this.noteUiPromptSignal(event); } catch {} }
    // isCompacting 官方字段：压缩期间 get_state 要能反映（rpc-commands.md §get_state）
    // pi 1.0.2 扩展面先把 session_before_compact / session_compact 翻译成这两帧，再走这里。
    if (t === "compaction_start") this.compacting = true;
    else if (t === "compaction_end") this.compacting = false;
    // 本地生命周期事件只服务于扩展自身（绑房/收尾/信任判定），不占远端流量
    if (INTERNAL_EVENTS.has(t)) return;
    this.trackDelivery(event);
    let ev: any;
    try {
      // 通知钩子走白名单投影（不透原始对象，防敏感/不可序列化字段外泄）
      ev = NOTIFY_PROJECTED.has(t) ? projectNotifyEvent(event) : projectEvent(event);
    } catch (e: any) {
      log("事件投影失败（已跳过）:", t, e?.message);
      return;
    }
    // 实时 message_end：投影里的 omit 图片此刻还没有 entryId（pi 尚未 appendMessage）。
    // 先挂起这一帧，等持久化后回读 branch/leaf 拿到真实条目；等待期间的后续事件进入队列。
    const waitingAddress = !!ev && t === "message_end" && this.beginImageAddressWait(event, ev);
    if (ev && !waitingAddress) this.emitEvent(ev);
    // entry_appended 自带真实条目：如果正好是挂起的那条，立刻补地址并放行。
    if (t === "entry_appended") this.tryResolveImageAddress(event.entry);
    // 任务清单是扩展侧派生状态，不在 pi 的 wire 事件里：tool 结束与 plan entry 落盘时各补一帧
    if (t === "tool_execution_end") this.pushTaskListFromTool(event);
    else if (t === "entry_appended") this.pushTaskListFromEntry(event.entry);
    // 压缩（手动/阈值/溢出）只在分支末尾追加一条 compaction 条目：镜像是整条分支，
    // 补上这条 compactionSummary 即可，不需要换代清库
    if (t === "compaction_end" && !event.aborted) this.requestSync("compaction");
    // 终端 /tree 换了活动分支：内容整体换掉，必须换代
    else if (t === "session_tree") this.bumpEpoch("session_tree");
    // 终端 `!cmd` 的 bashExecution 消息不发 message_end，执行完才落盘
    else if (t === "user_bash") this.scheduleProbe(2000);
    else if (t === "bash_execution_update") this.scheduleProbe(1500);
    // 终端 footer 的实时用量：一条回复结束/压缩结束都会改变累计值
    if (t === "compaction_end" || (t === "message_end" && event.message && event.message.role === "assistant")) this.pushUsage();
    if (t === "session_info_changed") {
      this.sessionName = event.name ? String(event.name) : null;
      this.nameDirty = true;
      // 改名只需要更新房间标题：发轻量 room_label，不做整包 room_register（少一次重注册+广播）
      if (this.roomId) {
        if (this.noRoomLabel) this.send({ type: "room_register", room: this.roomPayload() });
        else this.send({ type: "room_label", room: this.roomId, label: this.roomPayload().label });
      }
      if (this.roomId) this.enqueueManifest({ ids: [this.roomId] });
    }
    // 远程缓冲的回合边界：turn_end 放行 steer；agent_settled 再放行 follow_up。
    // 放在事件发出之后注入，sendUserMessage 同步触发的新事件不会插到边界事件前面。
    if (t === "turn_end" || t === "agent_settled") {
      try {
        this.flushRemoteQueue(t === "turn_end" ? "turn_end" : "settled");
      } catch (e: any) {
        log("远程待发注入失败:", e?.message);
      }
    }
  }

  setBusy(b: boolean) {
    if (this.busy === b) return;
    this.busy = b;
    if (this.roomId) {
      this.flushPending();
      this.send({ type: "state", room: this.roomId, busy: b }, { essential: true });
    }
  }

  isIdleNow(): boolean {
    try {
      if (this.ctx && typeof this.ctx.isIdle === "function") return !!this.ctx.isIdle();
    } catch {}
    return !this.busy;
  }

  /** 可重试的鉴权失败：关掉这条 socket，按当前退避另起一条。
   *  只有协议码表/relay 明确标了 retryable 才走这里；设备撤销、token 错等仍永久停连。 */
  private retryAuthLater(code: string, error: any) {
    const wait = this.backoff;
    log("relay 鉴权暂时失败（可重试），按退避重连:", code || "(no code)", error || "", Math.round(wait / 1000) + "s 后");
    const ws = this.ws;
    this.socketGone();
    this.detachSocket(ws);
    if (ws) {
      try { ws.close(4001, "auth retryable"); } catch {}
    }
    this.scheduleReconnect();
  }

  /** P10：执行一次使用活动刷新（串行合并；扫描失败回空快照；只上聚合计数） */
  refreshUsage(msg: any): Promise<any> {
    const requestId = typeof msg?.requestId === "string" ? msg.requestId : "";
    const deviceId = String((process.env.PI_REMOTE_DEVICE_ID || "").trim());
    this.usageQueue = this.usageQueue.then(async () => {
      let snapshot: any = null;
      try {
        const result = await usageScanSnapshot({ deviceId: deviceId || undefined });
        snapshot = result && result.snapshot;
      } catch (e: any) {
        log("usage 刷新失败（回空快照）:", e?.message);
      }
      if (!this.authed || !this.connected) return;
      if (!snapshot) snapshot = usageEmptySnapshot({ deviceId: deviceId || undefined });
      try { this.send({ type: "usage_snapshot", deviceId, requestId, snapshot }); } catch (e: any) { log("usage_snapshot 发送失败:", e?.message); }
    }).catch((e: any) => { log("usage 刷新队列异常:", e?.message); });
    return this.usageQueue;
  }

  handle(msg: any) {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "auth_result") {
      this.authed = !!msg.ok;
      if (!msg.ok) {
        const code = typeof msg.code === "string" ? msg.code : "";
        const known = !!code && Object.prototype.hasOwnProperty.call(PROTOCOL.errors, code);
        // relay 显式带 retryable 时以它为准；旧 relay 只带 code 时查协议码表。
        const retryable = typeof msg.retryable === "boolean"
          ? msg.retryable
          : !!(known && (PROTOCOL.errors as any)[code].retryable);
        if (retryable) {
          this.retryAuthLater(code, msg.error);
          return;
        }
        this.authFailed = true;
        const hint = msg.code === "device_revoked" || msg.code === "device_mismatch"
          ? "（停止重连：在网页上生成配对码，本机运行 attach --pair 重新配对后重启 pi）"
          : "（停止重连：改 .env 的 PI_REMOTE_TOKEN 或重新配对后重启 pi）";
        log("relay 鉴权失败:", msg.code || "", msg.error, hint);
        try { this.ws && this.ws.close(4001, "auth failed"); } catch {}
        return;
      }
      // 认证成功才重置退避：握手成功本身不代表对端可用（可能马上断开）。
      this.authFailed = false;
      this.backoff = RECONNECT_MIN;
      this.applyRelayCaps(msg);
      return;
    }
    if (msg.type === "error") {
      if (msg.code === "device_mismatch") log("relay 拒绝了与设备令牌不符的帧:", msg.message || "");
      // 旧 relay 不认 room_label：退回整包 room_register，改名照样能同步
      if (msg.code === "unknown_type" && /room_label/.test(String(msg.message || ""))) {
        this.noRoomLabel = true;
        if (this.roomId) this.send({ type: "room_register", room: this.roomPayload() });
      }
      if (msg.code === "unknown_type" && !this._unknownLogged) {
        this._unknownLogged = true;
        log("relay 不支持新帧，清单/窗口功能降级:", msg.message || "");
      }
      return;
    }
    if (msg.type === "room_registered") {
      if (!this.roomId || String(msg.room) !== this.roomId) return;
      this.relayV3 = true;
      this.confirmedRoom = this.roomId;
      if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
      this.syncSnapshot(msg);
      // sync 完成后再重发交回本机仍在开的 dialog（发现 A-5）：排在快照帧之后发出，
      // 不会被 relay 的清槽/对齐冲掉，等待卡/注意力的断粮到此补齐
      this.republishLocalDialogs();
      return;
    }
    if (msg.type === "snapshot_request") {
      if (!this.roomId || String(msg.room) !== this.roomId) return;
      log("relay 要求全量快照:", msg.reason || "");
      this.pushSnapshot("snapshot_request");
      this.pushTaskList();
      this.publishRemoteQueue();
      return;
    }
    if (msg.type === "resend_snapshot") {
      const room = msg.room != null && msg.room !== "" ? String(msg.room) : this.roomId;
      if (!room || (this.roomId && String(room) !== String(this.roomId))) {
        log("忽略其他房间的 resend_snapshot:", room);
        return;
      }
      log("relay 要求重推快照");
      this.pushSnapshot("resend_snapshot", undefined, String(room));
      this.pushTaskList();
      this.publishRemoteQueue();
      return;
    }
    if (msg.type === "usage_refresh") {
      // P10：viewer 打开设置页 → relay 转发。增量扫描后回 usage_snapshot（relay 校验/缓存/分发给 viewer）
      this.refreshUsage(msg);
      return;
    }
    if (msg.type === "dialog_gate") {
      // relay 推送的 viewer 在线门控（订阅数 0↔>0 / 桥重连补发）：接管门控第②条的数据来源
      const hasViewers = msg.hasViewers === true;
      const flippedOff = this.dialogGateHasViewers && !hasViewers;
      this.dialogGateHasViewers = hasViewers;
      if (flippedOff) {
        // viewer 全离场：接管中的 dialog 无人能答、本机也不弹窗——立即交回本机，
        // 不许干等超时落定（fail-open 红线，发现 A-1；与 socketGone 同路）
        try { this.releaseAllHeldDialogs("local"); } catch {}
      }
      return;
    }
    if (msg.type === "dialog_answer_switch") {
      // 开关下达（UI→relay→桥）：仅内存持有，重启回默认关；从未下达 = 关
      const enabled = msg.enabled === true;
      if (enabled !== this.dialogAnswerEnabled) {
        this.dialogAnswerEnabled = enabled;
        log("对话框远程应答接管:", enabled ? "开（仍需 viewer 在线才接管）" : "关");
        if (!enabled) {
          // 开关关闭：持留 dialog 立即交回本机弹窗，不等超时（fail-open，发现 A-1）
          try { this.releaseAllHeldDialogs("local"); } catch {}
        }
      }
      return;
    }
    if (msg.type === "dialog_answer") {
      if (msg.room && this.roomId && String(msg.room) !== this.roomId) {
        // 发往别的会话的答案不落本会话：回 gone 让答题端收回
        if (typeof msg.aid === "string" && msg.aid) {
          try { this.send({ type: "dialog_answer_result", aid: msg.aid, dialogId: typeof msg.dialogId === "string" ? msg.dialogId : "", ok: false, code: "dialog_gone" }); } catch {}
        }
        return;
      }
      this.noteDialogAnswer(msg);
      return;
    }
    if (msg.type === "message") {
      const cid = validCid(msg.cid);
      // 会话切换窗口内旧房间仍 online，此时注入会送到已离开的会话：报回原房间（relay 路由给它的观众）
      if (msg.room && this.roomId && String(msg.room) !== this.roomId) {
        log("忽略发往其他会话的注入:", msg.room, "!=", this.roomId);
        this.failRemote(String(msg.text ?? ""), "目标会话已切换，消息未注入", String(msg.room), cid, "session_switched");
        return;
      }
      void this.inject(String(msg.text ?? ""), cid);
      return;
    }
    if (msg.type === "command") {
      this.runCommand(msg);
      return;
    }
    if (msg.type === "abort") {
      if (msg.room && this.roomId && String(msg.room) !== this.roomId) {
        log("忽略发往其他会话的中断:", msg.room, "!=", this.roomId);
        return;
      }
      try {
        if (typeof this.ctx?.abort === "function") {
          const snap = this.captureAbortQueue();
          const after = () => {
            this.handBackAbortedQueue(snap);
            this.failAllPendingRemoteQueue("已停止，待发消息没有送进会话", "aborted");
          };
          const r = this.ctx.abort();
          if (r && typeof r.then === "function") r.then(after, (e: any) => log("abort 异常:", e?.message));
          else after();
          log("已执行 abort");
        } else {
          log("当前 ctx 无 abort 能力");
        }
      } catch (e: any) {
        log("abort 失败:", e?.message);
      }
      return;
    }
  }

  /* ---------- 远程命令：只读命令立即执行，其余串行；超时以 relay 下发的 timeoutMs 为准 ---------- */
  runCommand(msg: any) {
    const id = msg.id;
    const room = msg.room ? String(msg.room) : this.roomId;
    const command = String(msg.command || "");
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    // 会话切换窗口内发往旧房间的命令：在新会话上执行会改错对象
    if (msg.room && this.roomId && String(msg.room) !== this.roomId) {
      this.sendResult(room, id, false, null, "目标会话已切换（当前会话 " + this.roomId + "），命令未执行", "session_switched");
      return;
    }
    // 比 relay 的 waiter 早 1.5s 收尾：本机先报"超时"，viewer 拿到的是明确原因而不是 relay 的笼统超时
    const budget = Number(msg.timeoutMs) > 0 ? Math.max(1000, Number(msg.timeoutMs) - 1500) : 60000;
    const deadline = Date.now() + budget;
    const run = () => {
      const left = deadline - Date.now();
      if (left <= 0) return Promise.reject(new RemoteError("queue_timeout", "排队超时：前面的命令占用太久，" + command + " 未执行"));
      // 入队时还在原会话，轮到它执行时可能已经切走：在新会话上执行会改错对象，结果还回给旧房间的观众
      if (msg.room && this.roomId && String(msg.room) !== this.roomId) {
        return Promise.reject(new RemoteError("session_switched", "目标会话已切换（当前会话 " + this.roomId + "），命令未执行"));
      }
      return this.withTimeout(Promise.resolve().then(() => this.executeCommand(command, args)), left, command);
    };
    let p: Promise<any>;
    if (IMMEDIATE_COMMANDS.has(RPC_ALIAS[command] || command)) p = run();
    else {
      p = this.cmdQueue.then(run);
      this.cmdQueue = p.catch(() => {});
    }
    p.then(
      (data) => this.sendResult(room, id, true, data),
      (e) => this.sendResult(room, id, false, null, String((e && e.message) || e), remoteErrorCode(e)),
    );
  }

  sendResult(room: any, id: any, ok: boolean, data: any, error?: string, code?: string) {
    const frame = ok
      ? { type: "command_result", room, id, ok: true, data: data === undefined ? null : data }
      : { type: "command_result", room, id, ok: false, error: error || "执行失败", code: code || "internal" };
    // 诊断环接入命令失败点：带协议码，get_host_diag 能直接看到最近失败原因
    if (!ok) recordDiagError(frame.error, frame.code);
    // 失败回包同样是关键帧：背压时丢掉它，viewer 只能干等超时
    this.send(frame, { essential: true });
  }

  /** Promise 超时兜底：单条命令卡死不能拖死整条命令通道（定时器随结果清掉，不留悬挂句柄） */
  withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: any = null;
    return Promise.race([
      p,
      new Promise<T>((_r, rej) => {
        timer = setTimeout(() => rej(new RemoteError("timeout", what + " 超时（" + Math.round(ms / 1000) + "s）")), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /* ---------- 远程消息注入 ---------- */
  /** pi 会同步拒绝不了、只能事后发现的情况先拦下（压缩中 prompt 必抛；没模型必抛） */
  cannotPrompt(): RemoteError | null {
    if (!this.pi) return new RemoteError("not_ready", "扩展未就绪");
    if (this.compacting) return new RemoteError("compacting", "pi 正在压缩上下文，消息未注入（压缩结束后重发）");
    try {
      if (this.ctx && "model" in this.ctx && !this.ctx.model) return new RemoteError("no_model", "pi 未选择模型，消息未注入");
    } catch {}
    return null;
  }

  /** get_commands 清单（pi 扩展 API）；读不到返回 null，调用方不得据此拒绝命令。 */
  private commandCatalog(): any[] | null {
    try {
      if (!this.pi || typeof this.pi.getCommands !== "function") return null;
      const list = this.pi.getCommands();
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }

  /** 展开注入时判断是不是已注册的扩展命令：扩展命令在 pi 里先于压缩/模型检查执行。 */
  private isExtensionCommand(text: string): boolean {
    try {
      const name = String(text || "").replace(/^\//, "").split(/\s+/, 1)[0];
      const list = this.commandCatalog();
      if (!name || !list) return false;
      const hit = list.find((c: any) => c && String(c.name) === name);
      return !!hit && String(hit.source || "") === "extension";
    } catch {
      return false;
    }
  }

  /**
   * 注入一条 user 消息。pi 的契约（agent-session prompt()）：
   * - deliverAs 只在 pi 正忙时生效，空闲时被忽略、直接开新回合 → **恒传 steer**，
   *   不再"按 busy 预判 → 状态恰好翻转 → already processing"
   * - 扩展面的 pi.sendUserMessage 是 fire-and-forget：异步错误只进 pi 自己的错误通道，扩展收不到。
   *   所以送达只能观察：watchDelivery 等这条 user 消息真正出现（message_start/before_agent_start）
   * - expandPromptTemplates=true 只用于“明确选中 get_commands 里的资源命令”：pi 会展开模板/技能
   *   并直接派发扩展命令。此时最终出现的 user 消息是展开后的文本（扩展命令甚至不产生 user 消息），
   *   不能拿原文回显/等送达，否则会留下幽灵气泡或误报超时；结果看事件流和命令回包。
   */
  deliverText(text: string, behavior: string, images?: any[], cid?: string, options?: { expandPromptTemplates?: boolean; queueId?: string }) {
    const expand = options?.expandPromptTemplates === true;
    const queueId = options?.queueId;
    const blocked = this.cannotPrompt();
    // 扩展命令不经过模型；模板/技能仍需要模型，压缩中也应拒绝。
    if (blocked && !(expand && this.isExtensionCommand(text))) throw blocked;
    // 先在 TUI 通知区展示（不占用用户输入框、不随打字消失），再注入会话
    this.notifyRemote(text || "（附图）");
    // 回显先于注入发出：relay 存储里 remote 记录必然排在 pi 的 user message_end 之前，后者才能取代它
    if (!expand) this.echoRemote(text, cid);
    // 纯附图不塞空 text 块：content 只带 image 块（与 pi 原生纯附图消息同形）。
    const content = images && images.length ? (text ? [{ type: "text", text }, ...images] : [...images]) : text;
    // 送达观察必须先注册：sendUserMessage 可能同步触发 message_start，注册晚了这条就永远等不到确认。
    // 纯附图没有文本指纹可对（deliveryMatches 对空键恒为 false），注册 watch 只会在超时后误报失败，
    // 故不注册：送达由事件流本身呈现，队列项状态已由 injectRemoteQueueItem 先行标 injected。
    const watch = expand || !text ? null : this.watchDelivery(text, cid, queueId);
    // 队列段位是 snake_case（follow_up）；prompt 路径可能是 camelCase（followUp）。
    const deliverAs = behavior === "followUp" || behavior === "follow_up" ? "followUp" : "steer";
    const sendOptions: any = { deliverAs };
    if (expand) sendOptions.expandPromptTemplates = true;
    try {
      const r = this.pi.sendUserMessage(content, sendOptions);
      if (r && typeof r.catch === "function") {
        r.catch((e: any) => {
          this.markRemoteQueueFailed(queueId, String(e?.message || e), remoteErrorCode(e));
          if (watch && this.dropDeliveryEntry(watch)) this.failRemote(text, String(e?.message || e), null, cid, remoteErrorCode(e));
          // 展开注入没有待确认气泡，失败只能进日志；同步错误仍会从下面的 throw 变成 command_result。
          else if (expand) log("展开命令注入失败:", String(e?.message || e));
        });
      }
    } catch (e: any) {
      if (watch) this.dropDeliveryEntry(watch);
      const m = String(e?.message || e);
      const err = /stale/i.test(m) ? new RemoteError("session_switched", "pi 引用已失效（会话切换/reload），消息未送达") : new RemoteError(remoteErrorCode(e), m);
      // 回显已经发出去了：这里就把它标失败，调用方别再报一次。
      // 展开注入没有回显气泡，让 command_result 直接把错误带回网页。
      this.markRemoteQueueFailed(queueId, err.message, err.code);
      if (!expand) this.failRemote(text, err.message, null, cid, err.code);
      err.reported = true;
      throw err;
    }
  }

  /** 按 watchDelivery 返回的那一条精确移除（同文本多条在飞时不误删别的） */
  dropDeliveryEntry(entry: any): boolean {
    const i = entry ? this.pendingDeliveries.indexOf(entry) : -1;
    if (i < 0) return false;
    clearTimeout(this.pendingDeliveries[i].timer);
    this.pendingDeliveries.splice(i, 1);
    return true;
  }

  dropDelivery(text: string): boolean {
    const k = deliveryKey(text);
    const i = this.pendingDeliveries.findIndex((p) => p.key === k);
    if (i < 0) return false;
    clearTimeout(this.pendingDeliveries[i].timer);
    this.pendingDeliveries.splice(i, 1);
    return true;
  }

  async inject(text: string, cid?: string) {
    if (!text) return;
    try {
      // 旧式 message 帧没有投递方式：忙时按 steer 进远程缓冲，等回合边界再注入。
      if (!this.isIdleNow() || this.remoteQueue.some((item) => item.status === "pending")) {
        const blocked = this.cannotPrompt();
        if (blocked) throw blocked;
        this.enqueueRemoteMessage("steer", text, [], cid);
        if (this.isIdleNow()) this.flushRemoteQueue("idle");
        return;
      }
      this.deliverText(text, "steer", undefined, cid);
    } catch (e: any) {
      if (!e?.reported) this.failRemote(text, String(e?.message || e), null, cid, remoteErrorCode(e));
    }
  }

  private pendingDeliveries: { text: string; key: string; at: number; timer: any; room: string | null; cid: string | null; queueId: string | null }[] = [];

  watchDelivery(text: string, cid?: string, queueId?: string): any {
    const entry: any = { text, key: deliveryKey(text), at: Date.now(), timer: null, room: this.roomId, cid: cid || null, queueId: queueId || null };
    const check = () => {
      if (!this.pendingDeliveries.includes(entry)) return;
      // 还在忙：排队消息要等当前工具/回合结束才被消费，**无条件继续等**。
      // 旧实现用 10 分钟墙钟兜底，pi 跑长回合时会把还没被消费的消息误判失败，
      // 之后消息真被消费也不翻案，网页很容易据此重发一遍。
      if (!this.isIdleNow()) {
        entry.timer = setTimeout(check, DELIVERY_TIMEOUT_MS);
        return;
      }
      // 已空闲：给排队消费留一轮窗口；超过总等待上限仍未出现这条 user 消息才判失败。
      if (Date.now() - entry.at < DELIVERY_MAX_WAIT_MS) {
        entry.timer = setTimeout(check, DELIVERY_TIMEOUT_MS);
        return;
      }
      this.pendingDeliveries.splice(this.pendingDeliveries.indexOf(entry), 1);
      this.markRemoteQueueFailed(entry.queueId, "pi 没有接收这条消息（可能正在压缩、模型/认证不可用，或被其他扩展拦截）", "timeout");
      this.failRemote(text, "pi 没有接收这条消息（可能正在压缩、模型/认证不可用，或被其他扩展拦截）", entry.room, entry.cid, "timeout");
    };
    entry.timer = setTimeout(check, DELIVERY_TIMEOUT_MS);
    this.pendingDeliveries.push(entry);
    if (this.pendingDeliveries.length > 50) {
      const old = this.pendingDeliveries.shift();
      if (old) {
        clearTimeout(old.timer);
        this.markRemoteQueueFailed(old.queueId, "等待送达确认的消息过多，这条未确认", "busy");
        this.failRemote(old.text, "等待送达确认的消息过多，这条未确认", old.room, old.cid, "busy");
      }
    }
    return entry;
  }

  /** 换会话时，旧会话里还没确认送达的远程消息一律记失败（否则新会话的同文本会把它误结案） */
  abandonDeliveries(error: string) {
    const pending = this.pendingDeliveries.splice(0);
    for (const p of pending) {
      clearTimeout(p.timer);
      this.markRemoteQueueFailed(p.queueId, error, "session_switched");
      this.failRemote(p.text, error, p.room, p.cid, "session_switched");
    }
  }

  /** 观察到这条 user 消息进入 pi（开回合 / 消费排队）即确认送达。
   *  pi 的 user 消息不带 cid，只能按文本认；同文本有多条在等时先进先出，确认哪条就回哪条的 cid */
  trackDelivery(event: any) {
    if (!this.pendingDeliveries.length) return;
    const t = event.type;
    let seen: string | null = null;
    if ((t === "message_start" || t === "message_end") && event.message && event.message.role === "user") seen = msgText(event.message);
    else if (t === "before_agent_start" && typeof event.prompt === "string") seen = event.prompt;
    if (seen === null) return;
    const k = deliveryKey(seen);
    const i = this.pendingDeliveries.findIndex((p) => (p.room == null || p.room === this.roomId) && deliveryMatches(p.key, k));
    if (i < 0) return;
    const hit = this.pendingDeliveries[i];
    clearTimeout(hit.timer);
    this.pendingDeliveries.splice(i, 1);
    if (hit.cid && this.roomId) {
      this.flushPending();
      this.sendEvent({ type: "remote_message_delivered", cid: hit.cid, at: Date.now() }, true);
    }
  }

  /**
   * 忙时 input：streamingBehavior 为 steer / followUp 才入队。空闲 prompt 不带这个字段，不记。
   * 不改 event.text。调用方必须 return undefined，避免把用户输入当成已处理。
   */
  noteQueuedInput(event: any) {
    if (!event || typeof event !== "object") return;
    const behavior = event.streamingBehavior;
    if (behavior !== "steer" && behavior !== "followUp") return;
    const body = queueBody(event.text, event.images);
    if (body == null) return;
    (behavior === "steer" ? this.steeringQueue : this.followUpQueue).push(body);
    this.publishQueue();
  }

  /** user 的 message_start 对上就移出（先 steering 后 followUp）。message_end 不移。
   *  这次 message_start 之后，以及 agent_settled：pi 说没有待发就把两侧清掉（对歪的也清）。
   *  纯附图不能靠这一步：pi 1.0.2 正文为空时不从待发数组删除，hasPendingMessages() 一直为真。 */
  private syncOutboundQueue(event: any) {
    const t = event && event.type;
    if (t !== "message_start" && t !== "agent_settled") return;
    if (t === "message_start" && event.message && event.message.role === "user") {
      this.consumeQueuedUser(event.message);
    }
    this.clearQueueIfIdle();
    this.publishQueue();
  }

  /** 纯附图（正文为空且 content 含 image）移出队首占位。有正文的仍只对队首用 deliveryKey/deliveryMatches。
   *  队首是「（附图）」时，跳过连续占位，后面的文字项逐条对上再移出。 */
  private consumeQueuedUser(message: any) {
    const seen = msgText(message);
    if (!seen && contentHasImage(message)) {
      if (this.shiftPlaceholderHead(this.steeringQueue)) return;
      this.shiftPlaceholderHead(this.followUpQueue);
      return;
    }
    const seenKey = deliveryKey(seen);
    if (this.shiftDeliveredText(this.steeringQueue, seenKey)) return;
    this.shiftDeliveredText(this.followUpQueue, seenKey);
  }

  /** 队首是「（附图）」就移出一格。有正文的队首留给文字匹配。 */
  private shiftPlaceholderHead(queue: string[]): boolean {
    if (queue[0] !== IMAGE_QUEUE_BODY) return false;
    queue.shift();
    return true;
  }

  /** 有正文的项只认队首。队首是「（附图）」且对不上时，跳过连续占位，对上下一条文字就移出那一条。 */
  private shiftDeliveredText(queue: string[], seenKey: string): boolean {
    if (!seenKey || !queue.length) return false;
    if (deliveryMatches(deliveryKey(queue[0]), seenKey)) {
      queue.shift();
      return true;
    }
    if (queue[0] !== IMAGE_QUEUE_BODY) return false;
    let i = 1;
    while (i < queue.length && queue[i] === IMAGE_QUEUE_BODY) i++;
    if (i >= queue.length) return false;
    if (!deliveryMatches(deliveryKey(queue[i]), seenKey)) return false;
    queue.splice(i, 1);
    return true;
  }

  private clearQueueIfIdle() {
    let pending = true;
    try {
      const fn = this.ctx && this.ctx.hasPendingMessages;
      if (typeof fn !== "function") return;
      pending = !!fn.call(this.ctx);
    } catch {
      return;
    }
    if (pending) return;
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
  }

  /** 两侧都带上，每项 {role, content}。内容没变不发；从有到无发空数组。
   *  镜像里是全文；这一帧每条 content 只留前 8000 字。 */
  private publishQueue() {
    if (!this.roomId) return;
    const sig = JSON.stringify(this.steeringQueue) + "\n" + JSON.stringify(this.followUpQueue);
    if (sig === this.queueSig) return;
    this.queueSig = sig;
    const steering = this.steeringQueue.map((content) => ({ role: "user", content: clipQueueBody(content) }));
    const followUp = this.followUpQueue.map((content) => ({ role: "user", content: clipQueueBody(content) }));
    this.forward({ type: "queue_update", steering, followUp }, false);
  }

  /* ---------- 远程自管待发缓冲 ---------- */

  /** queue_get / remote_queue_state 共用的快照形状。 */
  remoteQueueSnapshot(): { rev: number; items: any[] } {
    return { rev: this.remoteQueueRev, items: this.remoteQueue.map(projectRemoteQueueItem) };
  }

  /** 广播整份状态（不增量）。relay 按房间缓存，新 viewer 订阅时补发。 */
  publishRemoteQueue() {
    if (!this.roomId) return;
    try {
      this.forward({ type: "remote_queue_state", rev: this.remoteQueueRev, items: this.remoteQueue.map(projectRemoteQueueItem) }, false);
    } catch (e: any) {
      log("远程待发状态广播失败:", e?.message);
    }
  }

  /** 终态只留最近若干条：pending 永远保留，已注入/失败从最旧开始修剪。 */
  private trimRemoteQueue() {
    const terminal = this.remoteQueue.reduce((n, item) => n + (item.status === "pending" ? 0 : 1), 0);
    let excess = terminal - REMOTE_QUEUE_TERMINAL_MAX;
    if (excess <= 0) return;
    this.remoteQueue = this.remoteQueue.filter((item) => {
      if (excess > 0 && item.status !== "pending") {
        excess -= 1;
        return false;
      }
      return true;
    });
  }

  /** 入队后版本 +1 并广播。所有状态变化都走这里，网页只需整帧替换。 */
  private touchRemoteQueue() {
    this.trimRemoteQueue();
    this.remoteQueueRev += 1;
    this.publishRemoteQueue();
  }

  /** 忙时远程消息进入扩展缓冲；返回完整条目供命令回包带 queueId。 */
  private enqueueRemoteMessage(segment: RemoteQueueSegment, text: string, images: any[], cid?: string | null): RemoteQueueItem {
    const pending = this.remoteQueue.reduce((n, item) => n + (item.status === "pending" ? 1 : 0), 0);
    if (pending >= REMOTE_QUEUE_PENDING_MAX) {
      throw new RemoteError("busy", `远程待发消息已有 ${pending} 条，等前面的消息注入后再试`);
    }
    const item: RemoteQueueItem = {
      id: newRemoteQueueId(),
      segment,
      source: REMOTE_QUEUE_SOURCE,
      text,
      images: Array.isArray(images) ? images.slice() : [],
      status: "pending",
      cid: cid || null,
      at: Date.now(),
    };
    this.remoteQueue.push(item);
    this.touchRemoteQueue();
    return item;
  }

  private findRemoteQueueItem(id: string): RemoteQueueItem | undefined {
    return this.remoteQueue.find((item) => item.id === id);
  }

  /** 注入失败/取消/切会话：只改 pending/injected 为 failed（终态），已 failed 不重复写。 */
  private markRemoteQueueFailed(queueId: string | null | undefined, error: string, code?: string) {
    if (!queueId) return;
    const item = this.findRemoteQueueItem(queueId);
    if (!item || item.status === "failed") return;
    item.status = "failed";
    item.error = error;
    item.code = code || "internal";
    item.updatedAt = Date.now();
    this.touchRemoteQueue();
  }

  /** 当前房间的待发消息整批失败（停止/切会话）。有 cid 的补一条失败帧，网页乐观气泡能落成失败。 */
  private failAllPendingRemoteQueue(error: string, code: string, room?: string | null) {
    const pending = this.remoteQueue.filter((item) => item.status === "pending");
    if (!pending.length) return;
    const at = Date.now();
    for (const item of pending) {
      item.status = "failed";
      item.error = error;
      item.code = code;
      item.updatedAt = at;
    }
    this.touchRemoteQueue();
    for (const item of pending) {
      if (item.cid) this.failRemote(item.text, error, room || this.roomId, item.cid, code);
    }
  }

  /** 队列状态（命令 queue_get）：无 id → 整份快照（投影形，正文可能带 truncated 标记）；
   *  带 id → 单条投影；带 id 且 full=true → 单条带全文（R3-3 第 1 项：编辑截断条目时
   *  按需拉取，只走命令回包一次性通道，不进状态帧/relay 补发缓存）。全文超过
   *  REMOTE_QUEUE_FULL_TEXT_MAX_BYTES 时明确报 payload_too_large，不截断冒充全文。 */
  cmdQueueGet(args?: any) {
    const id = typeof args?.id === "string" ? args.id : "";
    if (!id) return this.remoteQueueSnapshot();
    const item = this.findRemoteQueueItem(id);
    if (!item) throw new RemoteError("not_found", "待发消息不存在或已被移除：" + id);
    const projected = projectRemoteQueueItem(item);
    if (args?.full !== true) return { ok: true, rev: this.remoteQueueRev, item: projected };
    const bytes = Buffer.byteLength(item.text, "utf8");
    if (bytes > REMOTE_QUEUE_FULL_TEXT_MAX_BYTES) {
      throw new RemoteError("payload_too_large", "这条待发消息全文约 " + formatBytes(bytes) + "，超过单条全文拉取上限 " + formatBytes(REMOTE_QUEUE_FULL_TEXT_MAX_BYTES) + "；请在本机查看全文");
    }
    return { ok: true, rev: this.remoteQueueRev, item: { ...projected, text: item.text, truncated: false, textLen: item.text.length } };
  }

  /** queue_edit：只改 pending 的正文，id、段位、来源、图片、数组位置都不动。
   *  乐观并发（C-8）：args.baseHash 是编辑方开始编辑时拿到的全文指纹，带了就必须
   *  与现值一致——他端在此期间改过即明确报 queue_conflict，让 UI 提示重拉，
   *  不许旧稿无声覆盖。不带 baseHash 的老客户端不校验（兼容口径，与 A-6 同路）。 */
  cmdQueueEdit(args: any) {
    const id = typeof args?.id === "string" ? args.id : "";
    if (!id) throw new RemoteError("bad_args", "queue_edit 需要 id");
    const text = typeof args?.text === "string" ? args.text : "";
    if (!text.trim()) throw new RemoteError("bad_args", "queue_edit 需要非空 text");
    const item = this.findRemoteQueueItem(id);
    if (!item) throw new RemoteError("not_found", "待发消息不存在或已被移除：" + id);
    if (item.status !== "pending") throw new RemoteError("queue_locked", "这条消息已注入 pi，不能修改或取消");
    const baseHash = typeof args?.baseHash === "string" ? args.baseHash : "";
    if (baseHash && baseHash !== remoteQueueTextHash(item.text)) {
      throw new RemoteError("queue_conflict", "这条待发消息已被其他端修改，请重新加载全文后再编辑");
    }
    item.text = text;
    item.updatedAt = Date.now();
    this.touchRemoteQueue();
    return { ok: true, rev: this.remoteQueueRev, item: projectRemoteQueueItem(item) };
  }

  /** queue_cancel：只删除 pending；已注入/失败明确拒绝，不伪装成功。
   *  删除前先把对象置为取消终态：cmdQueueSend 在打断 pi 的等待窗口里持有同一条引用，
   *  取消后它必须能看到「已取消」，不能再按 pending 注入。 */
  cmdQueueCancel(args: any) {
    const id = typeof args?.id === "string" ? args.id : "";
    if (!id) throw new RemoteError("bad_args", "queue_cancel 需要 id");
    const index = this.remoteQueue.findIndex((item) => item.id === id);
    if (index < 0) throw new RemoteError("not_found", "待发消息不存在或已被移除：" + id);
    const item = this.remoteQueue[index];
    if (item.status !== "pending") throw new RemoteError("queue_locked", "这条消息已注入 pi，不能修改或取消");
    item.status = "failed";
    item.canceled = true;
    item.error = "这条待发消息已被取消";
    item.code = "aborted";
    item.updatedAt = Date.now();
    this.remoteQueue.splice(index, 1);
    this.touchRemoteQueue();
    return { ok: true, rev: this.remoteQueueRev, id };
  }

  /** 把一条 pending 交给 pi；先落 injected 再注入，成功后不可再编辑。
   *  注入失败由 deliverText 的同步/异步路径按 queueId 标 failed。 */
  private injectRemoteQueueItem(item: RemoteQueueItem, forceSteer = false) {
    // 注入前复查：条目必须仍在队列且仍是 pending。打断等待期间被取消/被清空的条目，
    // 即使调用方还握着旧引用，也绝不注入（取消了的消息发出去是最伤信任的竞态）。
    if (item.status !== "pending" || item.canceled || !this.remoteQueue.includes(item)) return;
    const blocked = this.cannotPrompt();
    if (blocked) {
      this.markRemoteQueueFailed(item.id, blocked.message, blocked.code);
      return;
    }
    item.status = "injected";
    item.injectedAt = Date.now();
    item.updatedAt = item.injectedAt;
    this.touchRemoteQueue();
    try {
      this.deliverText(item.text, forceSteer ? "steer" : item.segment, item.images, item.cid || undefined, { queueId: item.id });
    } catch (e: any) {
      // deliverText 同步失败时已经发过 remote_message_failed；这里只补队列状态。
      this.markRemoteQueueFailed(item.id, String(e?.message || e), remoteErrorCode(e));
    }
  }

  /** queue_send：用户明确点“立即发送”，先打断当前 run，再把这条消息作为新 prompt 送达。
   *  pi 的 steer 只是在当前 assistant turn 的工具结束后插入，不会中断正在跑的工具；
   *  真正的“立即”必须先 abort，等会话空闲后再发送。 */
  async cmdQueueSend(args: any) {
    const id = typeof args?.id === "string" ? args.id : "";
    if (!id) throw new RemoteError("bad_args", "queue_send 需要 id");
    const item = this.findRemoteQueueItem(id);
    if (!item) throw new RemoteError("not_found", "待发消息不存在或已被移除：" + id);
    if (item.status !== "pending") throw new RemoteError("queue_locked", "这条消息已注入 pi，不能修改或取消");
    const interrupt = args?.interrupt !== false;
    if (interrupt && !this.isIdleNow()) {
      if (!this.ctx || typeof this.ctx.abort !== "function") {
        throw new RemoteError("unsupported", "当前上下文不支持中断，无法立即发送");
      }
      this.remoteQueueInterrupting = true;
      try {
        const r = this.ctx.abort();
        if (r && typeof r.then === "function") await r;
        const t0 = Date.now();
        let idle = false;
        while (Date.now() - t0 < 10000) {
          try { idle = typeof this.ctx.isIdle === "function" ? this.ctx.isIdle() : true; } catch { idle = true; }
          if (idle) break;
          await new Promise((res) => setTimeout(res, 150));
        }
        if (!idle) throw new RemoteError("busy", "中断当前操作超时，消息仍在待发中；请稍后重试");
      } finally {
        this.remoteQueueInterrupting = false;
      }
    }
    // abort 等待期间条目可能被取消（queue_cancel 是插队命令）或被停止/切会话标失败：
    // 先复查再注入，绝不把用户已取消的消息发出去。
    if (item.canceled || (item.status === "pending" && !this.remoteQueue.includes(item))) {
      // 取消是用户意图，不是发送失败：按取消成功收尾，别给网页弹一条误导性的错误。
      return { ok: true, canceled: true, rev: this.remoteQueueRev, id: item.id };
    }
    // 并发的另一条 queue_send 已经把它发出去：保持旧行为，按已注入成功返回。
    if (item.status === "injected") return { ok: true, rev: this.remoteQueueRev, item: projectRemoteQueueItem(item) };
    if (item.status !== "pending") throw new RemoteError(item.code || "internal", item.error || "注入失败");
    // 复查通过：abort 完成后标记 injected 并发送，失败会落 failed。
    this.injectRemoteQueueItem(item, true);
    if (item.status === "failed") throw new RemoteError(item.code || "internal", item.error || "注入失败");
    return { ok: true, rev: this.remoteQueueRev, item: projectRemoteQueueItem(item) };
  }

  /** 回合边界注入：turn_end 只放行 steer；agent_settled/空闲时按数组顺序放行全部。
   *  第一条还没到可注入段位就停住，绝不跳过它去注入后面的消息（保序）。 */
  flushRemoteQueue(kind: "turn_end" | "settled" | "idle" = "idle") {
    if (this.remoteQueueFlushing || this.remoteQueueInterrupting || !this.roomId) return;
    const allowFollowUp = kind !== "turn_end";
    const batch: RemoteQueueItem[] = [];
    for (const item of this.remoteQueue) {
      if (item.status !== "pending") continue;
      if (item.segment === "follow_up" && !allowFollowUp) break;
      batch.push(item);
    }
    if (!batch.length) return;
    this.remoteQueueFlushing = true;
    try {
      for (const item of batch) {
        if (item.status !== "pending") continue;
        this.injectRemoteQueueItem(item);
      }
    } finally {
      this.remoteQueueFlushing = false;
    }
  }

  /** 会话结束/换代：缓冲不跨会话。旧房间的 pending 记失败，有 cid 的补失败帧。 */
  resetRemoteQueueForSession(error: string, code: string, room?: string | null) {
    this.failAllPendingRemoteQueue(error, code, room);
    if (this.remoteQueue.length) {
      this.remoteQueue = [];
      this.remoteQueueRev += 1;
    }
    this.publishRemoteQueue();
  }

  /** 注入失败回报：UI 把对应气泡标记为失败（否则双方静默分叉）。
   *  目标房间已不是当前房间（会话切换窗口）→ 顶层帧，relay 按 room 路由给原房间的观众 */
  failRemote(text: string, error: string, room?: string | null, cid?: string | null, code?: string) {
    log("注入失败:", error);
    const target = room || this.roomId;
    if (!target) return;
    const extra: any = { code: code || "internal" };
    if (cid) extra.cid = cid;
    if (target !== this.roomId) {
      this.send({ type: "remote_message_failed", room: target, text, error, ...extra }, { essential: true });
      return;
    }
    this.flushPending();
    this.sendEvent({ type: "remote_message_failed", text, error, at: Date.now(), ...extra }, true);
  }

  /** 远程消息回显：发送方以外的观众立刻看到"谁发了什么"；pi 随后的同文本 user message_end 会取代它 */
  echoRemote(text: string, cid?: string) {
    if (!this.roomId) return;
    this.flushPending();
    const ev: any = { type: "remote_message", text, at: Date.now() };
    if (cid) ev.cid = cid;
    this.sendEvent(ev, true);
  }

  /** set_model：**必须传模型对象**——[探针 probe11] 实测 `pi.setModel(provider, modelId)`
   *  两参形式返回 false 且是 no-op（早期实现因此从未真正切过模型，E2E 也只断言了自定义 ok）。
   *  正确做法：先把 provider+modelId 解析成 modelRegistry 里的模型对象再 setModel(obj)。 */
  async cmdSetModel(args: any) {
    const mr = this.ctx && this.ctx.modelRegistry;
    let target: any = null;
    // 官方解析路径：modelRegistry.find(provider, modelId)（preset.ts:134）；
    // find 不可用时回退 getAll() 线性查找。
    try {
      if (mr && typeof mr.find === "function") target = mr.find(String(args.provider), String(args.modelId));
    } catch {}
    if (!target) {
      try {
        for (const m of (mr && typeof mr.getAll === "function" ? mr.getAll() || [] : [])) {
          if (m && String(m.provider) === String(args.provider) && String(m.modelId || m.id) === String(args.modelId)) { target = m; break; }
        }
      } catch {}
    }
    if (!target) throw new RemoteError("not_found", "找不到模型：" + args.provider + "/" + args.modelId + "（用 get_available_models 拿可用清单）");
    // **必须 await**：pi.setModel 是异步的（preset.ts:136 `await pi.setModel(model)`）——
    // 早期实现没 await，读到的是切换前的 ctx.model，且 model_select 事件还没发出来。
    const ok = await this.pi.setModel(target);
    if (ok === false) throw new RemoteError("internal", "模型切换被拒绝（pi.setModel 返回 false）");
    // 官方 set_model 返回完整 Model 对象（rpc-commands.md §set_model）
    return { ok: true, switched: true, model: toModel(this.ctx ? this.ctx.model : null) };
  }

  /** pi 官方 RPC 的 prompt / steer / follow_up（rpc-commands.md §Prompting）：
   *  同一注入通道（pi.sendUserMessage），deliverAs 即官方 streamingBehavior。
   *  忙而未指定行为 = 官方错误语义（报错让调用方选 steer/followUp，不擅自默认）。 */
  async cmdSendLike(kind: string, args: any) {
    const text = String((args && (args.message ?? args.text)) ?? "").trim();
    // pi.sendUserMessage 的图片走 content 数组（[{type:"text"}, {type:"image",data,mimeType}]），没有 options.images
    const images = normalizeImages(args && args.images);
    // P3-2：纯图片可发送——正文为空但带图片时放行；无图无文仍按旧口径报错。
    if (!text && !images.length) throw new RemoteError("bad_args", kind + " 需要 message");
    let behavior = String((args && args.streamingBehavior) || "").trim();
    if (kind === "steer") behavior = "steer";
    if (kind === "follow_up") behavior = "followUp";
    // 只有 prompt 能派发扩展命令（官方 rpc-commands.md §Prompting）；
    // 且只有网页明确选中 get_commands 里的命令时才打开展开，普通以 / 开头的正文永远不展开。
    const expandPromptTemplates = kind === "prompt" && !!args && args.expandPromptTemplates === true;
    if (expandPromptTemplates) {
      const catalog = this.commandCatalog();
      if (catalog) {
        const name = text.replace(/^\//, "").split(/\s+/, 1)[0];
        if (!name || !catalog.some((c: any) => c && String(c.name) === name)) {
          throw new RemoteError("not_found", "本机没有可执行的命令：" + text.split(/\s+/, 1)[0] + "（用 get_commands 刷新清单）");
        }
      }
    }
    const idle = this.isIdleNow();
    if (!idle && behavior !== "steer" && behavior !== "followUp") {
      throw new RemoteError("busy", "会话正忙：请指定 streamingBehavior（steer=当前回合后插入 / followUp=等结束后）");
    }
    const cid = validCid(args && args.cid);
    const hasPending = this.remoteQueue.some((item) => item.status === "pending");
    // 忙时远程 steer / follow_up 不再交给 pi 原生队列，而是进扩展自管缓冲：可编辑、可取消、可重放。
    // expandPromptTemplates 是命令/模板派发，不进缓冲。
    if (!idle && !expandPromptTemplates && (behavior === "steer" || behavior === "followUp")) {
      const blocked = this.cannotPrompt();
      if (blocked) throw blocked;
      const item = this.enqueueRemoteMessage(behavior === "followUp" ? "follow_up" : "steer", text, images, cid);
      return { disposition: "queued", queueId: item.id, queue: this.remoteQueueSnapshot() };
    }
    // 空闲但仍有未注入的远程待发：先按序放行，避免新 prompt 抢到它们前面。
    if (idle && hasPending) this.flushRemoteQueue("idle");
    this.deliverText(text, behavior || "steer", images, cid, { expandPromptTemplates });
    return expandPromptTemplates ? { disposition: idle ? "started" : "queued", expanded: true } : { disposition: idle ? "started" : "queued" };
  }

  /** 中断前有没有待发。读不到就当没有，避免误发 queue_update / remote_message_failed。 */
  private pendingMessagesNow(): boolean | null {
    try {
      const fn = this.ctx && this.ctx.hasPendingMessages;
      if (typeof fn !== "function") return null;
      return !!fn.call(this.ctx);
    } catch {
      return null;
    }
  }

  /** 终端输入框。没有 UI，或读不到字符串正文时返回 null，调用方不得 setEditorText。 */
  private editorTextApi(): { get: () => string | null; set: (text: string) => void } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      if (ctx.hasUI === false) return null;
    } catch {
      return null;
    }
    let ui: any;
    try { ui = ctx.ui; } catch { return null; }
    if (!ui || typeof ui.getEditorText !== "function" || typeof ui.setEditorText !== "function") return null;
    return {
      get: () => {
        try {
          const text = ui.getEditorText();
          return typeof text === "string" ? text : null;
        } catch {
          return null;
        }
      },
      set: (text: string) => { ui.setEditorText(text); },
    };
  }

  /** pi TUI restoreQueuedMessagesToEditor：排队在前、原输入在后，整段 trim 为空则丢掉，中间空一行。 */
  private tuiJoinedQueue(queued: string[], currentText: string): string {
    const queuedText = queued.join("\n\n");
    return [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
  }

  /** abort 会改待发和输入框，先留下队列副本和中断前的草稿。 */
  private captureAbortQueue(): { pending: boolean | null; queued: string[]; beforeText: string | null; editor: { get: () => string | null; set: (text: string) => void } | null } {
    const editor = this.editorTextApi();
    return {
      pending: this.pendingMessagesNow(),
      queued: this.steeringQueue.concat(this.followUpQueue),
      beforeText: editor ? editor.get() : null,
      editor,
    };
  }

  /** 队列副本每一条都要独占一条待确认的远程送达。对不上就整批放弃。 */
  private matchQueueDeliveries(queued: string[]): any[] | null {
    const used = new Set<any>();
    const hits: any[] = [];
    for (const body of queued) {
      const seenKey = deliveryKey(body);
      const hit = this.pendingDeliveries.find((p) => !used.has(p) && (p.room == null || p.room === this.roomId) && deliveryMatches(p.key, seenKey));
      if (!hit) return null;
      used.add(hit);
      hits.push(hit);
    }
    return hits;
  }

  /**
   * 网页停止后，TUI 把 steer/followUp 拼进终端输入框并清掉待发。
   * 仅当中断前有待发、返回后没有，且副本全能对上远程送达、输入框等于这份拼接时：
   * 把输入框恢复成中断前的草稿，这些送达记为已停止，再清空扩展队列镜像。
   * 副本是完整正文：输入框里是全文时不能拿发给网页的前 8000 字去对。
   * 中断后仍有待发、没有 UI、或对不上输入框时不改输入框。没有待发时不发队列或失败帧。
   */
  private handBackAbortedQueue(snap: { pending: boolean | null; queued: string[]; beforeText: string | null; editor: { get: () => string | null; set: (text: string) => void } | null }): void {
    try {
      if (snap.pending !== true) return;
      if (this.pendingMessagesNow() !== false) return;
      const editor = snap.editor;
      if (!editor || snap.beforeText === null) return;
      const hits = this.matchQueueDeliveries(snap.queued);
      if (!hits) return;
      const afterText = editor.get();
      if (afterText === null || afterText !== this.tuiJoinedQueue(snap.queued, snap.beforeText)) return;
      editor.set(snap.beforeText);
      for (const hit of hits) {
        this.dropDeliveryEntry(hit);
        this.failRemote(hit.text, "已停止，这条排队消息没有送进会话", hit.room, hit.cid, "aborted");
      }
      this.steeringQueue.length = 0;
      this.followUpQueue.length = 0;
      this.publishQueue();
    } catch (e: any) {
      log("交回远程排队失败:", e?.message);
    }
  }

  /** pi 官方 RPC abort（rpc-commands.md §abort）：abort 并等会话空闲。
   *  abort 不进串行队列（IMMEDIATE_COMMANDS）：排在被中断的命令后面就永远中断不了。
   *  等待有 10s 上限（relay 给 abort 的超时是 20s）。
   *  TUI 的 abort 会把待发拼进输入框；远程排队要在 abort 返回后交回。 */
  async cmdAbort() {
    if (!this.ctx || typeof this.ctx.abort !== "function") throw new RemoteError("unsupported", "当前上下文不支持 abort");
    const snap = this.captureAbortQueue();
    const r = this.ctx.abort();
    if (r && typeof r.then === "function") await r;
    this.handBackAbortedQueue(snap);
    // 用户按了停止：待发缓冲不再自动注入，否则 agent_settled 会立刻把它们又送进去。
    this.failAllPendingRemoteQueue("已停止，待发消息没有送进会话", "aborted");
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      let idle = true;
      try { idle = typeof this.ctx.isIdle === "function" ? this.ctx.isIdle() : true; } catch { idle = true; }
      if (idle) break;
      await new Promise((res) => setTimeout(res, 150));
    }
    return { ok: true };
  }

  /**
   * TUI 通知区展示远程消息（ctx.ui.notify）。pi 的 TUI 会把 steer 入队的消息
   * 临时显示在输入框区域、用户一打字就被覆盖——通知区是独立常驻区域，不受影响。
   * 无 UI 的模式（RPC/print）自动跳过。
   */
  /** ================= 远程命令执行器（pi 能力接口） ================= */
  /** 命令面与 pi 官方 RPC（docs/rpc-commands.md，共 33 个命令）对齐：
   *  - 旧名经 RPC_ALIAS 解析成官方名（get_models→get_available_models 等）
   *  - pi 有进程内接口的逐个直连；没有的（RPC_UNSUPPORTED）明确报错，不自作聪明实现
   *  - 另有 8 个扩展自有命令（pi 的 RPC 面没有、但扩展面有真实接口）：
   *    get_settings / settings_set / get_active_tools / set_active_tools / get_context_usage /
   *    regenerate / list_sessions / navigate_tree
   *    （settings_set 是白名单文件写，运行中进程不热更新：见 DOC/76-settings-write-bridge.md） */
  async executeCommand(command: string, args: any): Promise<any> {
    const name = RPC_ALIAS[command] || command;
    if (RPC_UNSUPPORTED[name]) throw new RemoteError("unsupported", "本模式不支持 " + name + "：" + RPC_UNSUPPORTED[name]);
    switch (name) {
      case "get_state": return this.cmdGetState();
      case "get_messages": return this.cmdGetMessages(args);
      case "get_entries": return this.cmdGetEntries(args);
      case "get_all_tools": return this.cmdGetAllTools();
      case "get_available_models": return this.cmdGetModels();
      case "set_model":
        if (!args.provider || !args.modelId) throw new RemoteError("bad_args", "set_model 需要 provider 和 modelId");
        return await this.cmdSetModel(args);
      case "get_available_thinking_levels":
        return { levels: availableThinkingLevels(this.ctx ? this.ctx.model : null) };
      case "get_provider_auth": return this.cmdGetProviderAuth();
      case "set_thinking_level":
        if (!args.level) throw new RemoteError("bad_args", "set_thinking_level 需要 level");
        await this.pi.setThinkingLevel(args.level);
        return { ok: true, level: this.pi.getThinkingLevel ? this.pi.getThinkingLevel() : args.level };
      case "set_session_name":
        if (args.name === undefined || args.name === null || args.name === "") throw new RemoteError("bad_args", "set_session_name 需要 name");
        await this.pi.setSessionName(String(args.name));
        // label 来自 sessionName，relay 只在 room_register 时更新：不重发 room_list 会一直显示旧名
        this.sessionName = String(args.name);
        this.nameDirty = true;
        if (this.roomId) this.send({ type: "room_register", room: this.roomPayload() });
        if (this.roomId) this.enqueueManifest({ ids: [this.roomId] });
        return { ok: true };
      case "get_settings": return this.cmdGetSettings();
      case "settings_set": return this.cmdSettingsSet(args);
      case "get_active_tools":
        return { tools: this.pi.getActiveTools ? this.pi.getActiveTools() : [] };
      case "set_active_tools":
        if (!Array.isArray(args.tools)) throw new RemoteError("bad_args", "set_active_tools 需要 tools 数组");
        await this.pi.setActiveTools(args.tools);
        return { ok: true, tools: this.pi.getActiveTools ? this.pi.getActiveTools() : [] };
      case "get_mcp_servers": return this.cmdGetMcpServers();
      case "get_system_prompt": return this.cmdGetSystemPrompt();
      case "get_entry": return this.cmdGetEntry(args);
      case "get_labels": return this.cmdGetLabels();
      case "get_children": return this.cmdGetChildren(args);
      case "get_routing": return this.cmdGetRouting();
      case "get_flags": return this.cmdGetFlags(args);
      case "export_session": return await this.cmdExportSession(args);
      case "get_scoped_models": return this.cmdGetScopedModels();
      case "get_last_assistant_text": return this.cmdGetLastAssistantText();
      case "get_context_usage":
        return this.ctx && typeof this.ctx.getContextUsage === "function" ? this.ctx.getContextUsage() : null;
      case "prompt": return this.cmdSendLike("prompt", args);
      case "steer": return this.cmdSendLike("steer", args);
      case "follow_up": return this.cmdSendLike("follow_up", args);
      case "queue_get": return this.cmdQueueGet(args);
      case "queue_edit": return this.cmdQueueEdit(args);
      case "queue_cancel": return this.cmdQueueCancel(args);
      case "queue_send": return this.cmdQueueSend(args);
      case "abort": return this.cmdAbort();
      case "abort_bash": return this.cmdAbortBash();
      case "compact": return this.cmdCompact(args);
      case "regenerate":
        // 忙时拒绝：否则会以 steer 追加，真实再烧一次模型调用（连点防护）
        if (!this.isIdleNow()) throw new RemoteError("busy", "会话正忙（模型还在跑），请等当前回合结束再重新生成");
        return this.cmdRegenerate(args);
      case "bash": return this.cmdBash(args);
      case "delete_session": return this.cmdDeleteSession(args);
      // 未载入会话的文件级操作：目标由 sessionPath 指定，不要求活动房间
      case "rename_session_file": return this.cmdRenameSessionFile(args);
      case "export_session_file": return await this.cmdExportSessionFile(args);
      case "fork_session_file": return await this.cmdForkSessionFile(args);
      case "list_sessions": return this.cmdListSessions(args);
      case "search_session_bodies": return this.cmdSearchSessionBodies(args);
      case "get_commands":
        return {
          commands: (this.pi && typeof this.pi.getCommands === "function" ? this.pi.getCommands() : []).map((c: any) => ({
            name: c.name,
            description: c.description || null,
            source: c.source,
            sourceInfo: c.sourceInfo ?? null,
          })),
        };
      case "get_fork_messages": return this.cmdGetForkMessages();
      case "get_tree": return this.cmdGetTree(args);
      case "get_git_branch": return this.cmdGetGitBranch();
      case "get_projection": return this.cmdGetProjection();
      case "get_session_stats": return this.cmdGetSessionStats();
      case "get_file": return this.cmdGetFile(args);
      case "get_image": return this.cmdGetImage(args);
      case "get_host_diag": return this.cmdGetHostDiag();
      case "new_session": return this.runSessionOp("new_session", {});
      case "switch_session": return this.runSessionOp("switch_session", args);
      case "fork": return this.runSessionOp("fork", args);
      case "clone": return this.runSessionOp("clone", {});
      case "navigate_tree": return this.runSessionOp("navigate_tree", args);
      default:
        throw new RemoteError("unknown_command", "未知命令：" + name + "（可用命令见 readyUI/data-interface.md）");
    }
  }

  cmdGetState() {
    const sm = this.ctx && this.ctx.sessionManager;
    const model = this.ctx ? this.ctx.model : null;
    const thinking = this.pi && typeof this.pi.getThinkingLevel === "function" ? this.pi.getThinkingLevel() : null;
    const idle = this.ctx && typeof this.ctx.isIdle === "function" ? this.ctx.isIdle() : !this.busy;
    // messageCount / pendingMessageCount：官方 get_state 字段（rpc-commands.md §get_state）
    let messageCount: number | null = null;
    try {
      if (sm && typeof sm.getBranch === "function") messageCount = extractMessages(sm.getBranch() || []).length;
    } catch {}
    let pendingMessageCount: number | null = null;
    try {
      if (this.ctx && typeof this.ctx.hasPendingMessages === "function") pendingMessageCount = this.ctx.hasPendingMessages() ? 1 : 0;
    } catch {}
    return {
      sessionId: sm && typeof sm.getSessionId === "function" ? sm.getSessionId() : null,
      sessionName: this.sessionName || (this.pi && typeof this.pi.getSessionName === "function" ? this.pi.getSessionName() : null) || null,
      entryCount: sm && typeof sm.getEntryCount === "function" ? sm.getEntryCount() : null,
      sessionFile: sm && typeof sm.getSessionFile === "function" ? sm.getSessionFile() : null,
      cwd: sm && typeof sm.getCwd === "function" ? sm.getCwd() : this.cwd,
      // 官方 Model 对象（+ modelId 别名）；扩展侧另留 busy/online/isIdle
      model: toModel(model),
      thinkingLevel: thinking,
      // —— 官方 get_state 字段（rpc-commands.md §get_state）：运行形态 + 队列/压缩开关 ——
      mode: this.ctx && this.ctx.mode ? this.ctx.mode : null,
      hasUI: !!(this.ctx && this.ctx.hasUI),
      projectTrusted: this.ctx && typeof this.ctx.isProjectTrusted === "function" ? !!this.ctx.isProjectTrusted() : null,
      steeringMode: this._settingOr("steeringMode", "one-at-a-time"),
      followUpMode: this._settingOr("followUpMode", "one-at-a-time"),
      autoCompactionEnabled: this._settingOr("compaction.enabled", true),
      isStreaming: !idle,
      isCompacting: !!this.compacting,
      messageCount,
      pendingMessageCount,
      isIdle: idle,
      busy: this.busy,
      online: true,
    };
  }

  /** 读一个设置项（点号路径）；pi.getSettings() 未物化该键时用文档默认值兜底
   *  （rpc-commands.md：steering/followUp 默认 one-at-a-time；settings.md：自动压缩默认开）。 */
  _settingOr(path: string, dflt: any): any {
    try {
      const s: any = this.pi && typeof this.pi.getSettings === "function" ? this.pi.getSettings() || {} : {};
      const v = path.split(".").reduce((o: any, k) => (o && typeof o === "object" ? o[k] : undefined), s);
      return v === undefined || v === null ? dflt : v;
    } catch {
      return dflt;
    }
  }

  /** 手动压缩。ctx.compact 是 fire-and-forget（返回 void），结果只经 onComplete/onError 回调给出；
   *  官方参数名是 customInstructions（旧名 instructions 兼容）。
   *  压缩只在分支末尾追加 compaction 条目，镜像补一条 compactionSummary 即可（compaction_end 也会触发同步）。 */
  async cmdCompact(args: any) {
    if (!this.isIdleNow()) throw new RemoteError("busy", "会话正忙（模型还在跑），压缩易失败，请等它闲了再试");
    if (!this.ctx || typeof this.ctx.compact !== "function") throw new RemoteError("unsupported", "当前上下文不支持 compact");
    const ci = args.customInstructions ?? args.instructions;
    const res: any = await new Promise((resolve, reject) => {
      try {
        const r: any = this.ctx.compact({
          customInstructions: ci ? String(ci) : undefined,
          onComplete: (result: any) => resolve(result),
          onError: (err: any) => reject(err instanceof Error ? err : new Error(String(err))),
        });
        if (r && typeof r.then === "function") r.then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
    this.requestSync("compact");
    // 官方 compact 结果：{summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, details?}
    return res && typeof res === "object" ? { ok: true, ...res } : { ok: true };
  }

  cmdGetMessages(args?: any) {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") return { messages: [] };
    const all = mirrorMessages(sm.getBranch() || []);
    const limit = Number(args && args.limit) > 0 ? Math.floor(Number(args.limit)) : 0;
    const list = limit && all.length > limit ? all.slice(-limit) : all;
    return { messages: list.map((m: any) => shrinkDeep(m)), total: all.length, truncated: list.length < all.length, busy: this.busy };
  }

  /** 条目原始流水。可带 since（官方游标）与 limit（只取末尾 N 条）；图片照例降级——
   *  一张原图 base64 就能让整包超过单帧上限 */
  cmdGetEntries(args: any) {
    const sm = this.ctx && this.ctx.sessionManager;
    const leafId = sm && typeof sm.getLeafId === "function" ? this.safeRead(() => sm.getLeafId(), null) : null;
    if (!sm || typeof sm.getEntries !== "function") return { entries: [], leafId };
    const all = sm.getEntries() || [];
    let list = all;
    // 官方游标语义（rpc-commands.md §get_entries）：since 命中只返回其后条目，未命中报错
    if (args && args.since) {
      const i = all.findIndex((e: any) => e && e.id === String(args.since));
      if (i < 0) throw new RemoteError("bad_args", "since 不是有效的 entry id（先全量 get_entries 或用 get_tree 的节点 id）");
      list = all.slice(i + 1);
    }
    const limit = Number(args && args.limit) > 0 ? Math.floor(Number(args.limit)) : 0;
    const sliced = limit && list.length > limit ? list.slice(-limit) : list;
    return { entries: sliced.map((e: any) => shrinkEntryDeep(e)), leafId, total: all.length, truncated: sliced.length < list.length };
  }

  cmdGetLastAssistantText() {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") return { text: "" };
    const branch = extractMessages(sm.getBranch() || []);
    for (let i = branch.length - 1; i >= 0; i--) {
      const m = branch[i];
      if (m && m.role === "assistant" && Array.isArray(m.content)) {
        const text = m.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
        if (text.trim()) return { text };
      }
    }
    return { text: "" };
  }

  cmdGetModels() {
    // 官方入口：ctx.modelRegistry（extensions.md：model runtime 由 host 拥有）。
    // 方法名以实测为准（probe7）：modelRegistry 上没有 getAvailableModels，可用的是 getAll/getAvailable。
    // 顺序对齐 RPC get_available_models 的语义：先 getAll 全量，再 getAvailable；都不可用才回退读 models.json。
    const mr = this.ctx && this.ctx.modelRegistry;
    for (const fn of ["getAll", "getAvailable", "getAvailableModels"]) {
      if (mr && typeof mr[fn] === "function") {
        try {
          const list = mr[fn]();
          if (Array.isArray(list) && list.length) {
            return {
              models: list.map(toModel),
            // available = 认证可用（getAvailable）——告诉前端哪些真能切（[探针 probe12]：
            // setModel 对未认证模型返回 false，pi 自己的 /model 也不会列出来）
            available: (() => {
              try {
                if (mr && typeof mr.getAvailable === "function") return (mr.getAvailable() || []).map(toModel);
              } catch {}
              return [];
            })(),
            };
          }
        } catch {}
      }
    }
    try {
      const os = require("node:os");
      const nodePath = require("node:path");
      const agentDir = process.env.PI_CODING_AGENT_DIR || nodePath.join(os.homedir(), ".pi", "agent");
      const modelsPath = nodePath.join(agentDir, "models.json");
      if (!fs.existsSync(modelsPath)) return { models: [] };
      const raw = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
      const out = [];
      const providers = (raw && raw.providers) || {};
      for (const [provider, cfg] of Object.entries(providers)) {
        const models = (cfg && cfg.models) || [];
        for (const m of models) out.push(toModel({ provider, ...m }));
      }
      return { models: out };
    } catch (e) {
      return { models: [], error: e.message };
    }
  }

  /** pi 官方工具注册表（pi.getAllTools）。[探针 probe10] 实测每项字段：
   *  {name, description, parameters(JSON Schema), promptGuidelines[], exposure, sourceInfo}。
   *  只读直出（parameters 原样给，前端可渲染参数表单）；不掺内部字段。 */
  cmdGetAllTools() {
    if (!this.pi || typeof this.pi.getAllTools !== "function") return { tools: [] };
    try {
      const list = this.pi.getAllTools() || [];
      return {
        tools: list.map((t: any) => ({
          name: t.name,
          description: t.description || null,
          parameters: t.parameters ?? null,
          promptGuidelines: Array.isArray(t.promptGuidelines) ? t.promptGuidelines : [],
          exposure: t.exposure ?? null,
          sourceInfo: t.sourceInfo ?? null,
        })),
      };
    } catch (e: any) {
      return { tools: [], error: e.message };
    }
  }

  /** 各 provider 认证状态（modelRegistry 官方方法族，[探针 probe10] 实证存在）。
   *  **红线**：只回状态——绝不经 getApiKeyAndHeaders / getApiKeyForProvider 碰密钥。 */
  /** 终端 footer `cwd (branch)` 的 branch 半边（[源码] footer 的 Gh.resolveGitBranchSync 同源算法）：
   *  读 .git/HEAD：`ref: refs/heads/X` → X；短 SHA/detached → detached:true；无 repo → branch:null。
   *  不 spawn git（git 没装也能显示）；cwd 本级读不到时逐级上找（pi 只读本级，上找是扩展增强）。 */
  cmdGetGitBranch() {
    const out: any = { branch: null, repoRoot: null, detached: false };
    try {
      const fsx = require("node:fs");
      const np = require("node:path");
      const sm = this.ctx && this.ctx.sessionManager;
      const cwd = String((sm && typeof sm.getCwd === "function" ? sm.getCwd() : null) || this.cwd || (this.ctx && this.ctx.cwd) || process.cwd());
      let dir = cwd;
      for (let depth = 0; depth < 40; depth++) {
        const head = np.join(dir, ".git", "HEAD");
        let txt: string;
        try { txt = fsx.readFileSync(head, "utf8"); } catch { const parent = np.dirname(dir); if (parent === dir) break; dir = parent; continue; }
        out.repoRoot = dir.replace(/\\/g, "/");
        const m = /^ref:\s*refs\/heads\/(.+)\s*$/m.exec(txt);
        if (m) { out.branch = m[1].trim(); out.detached = false; }
        else { out.branch = txt.trim().slice(0, 64) || null; out.detached = true; }
        return out;
      }
      return out;
    } catch (e: any) {
      return { branch: null, repoRoot: null, detached: false, error: e?.message ?? String(e) };
    }
  }

  /** 模型实际所见（ctx.sessionManager.buildSessionProjection）：compaction 边界、
   *  context_edit 应用后、分支相对口径下的 messages + entry↔message 映射。
   *  get_entries 是原始流水，本命令是"模型此刻看到的上下文"权威视图。
   *  大会话保护：entries/messages 各截尾 2000 条 + truncated 标记。 */
  cmdGetProjection() {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.buildSessionProjection !== "function") {
      return { supported: false, entries: [], messages: [], error: "本机 pi 的 SessionManager 没有 buildSessionProjection" };
    }
    try {
      const proj: any = sm.buildSessionProjection() || {};
      const entries = Array.isArray(proj.entries) ? proj.entries : [];
      const messages = Array.isArray(proj.messages) ? proj.messages : [];
      // 投影消息可能是 context_edit 改写/合成的：只有 content 与 sourceEntry 原始 content 是同一引用时，
      // 它的 blockIndex 才等于 get_image 的下标。其余情况只给 sourceEntry 补地址，不碰投影消息。
      const annotated = entries.map((pe: any) => {
        const sourceEntry = pe && pe.sourceEntry;
        const sourceMessages = Array.isArray(pe && pe.messages) ? pe.messages : [];
        const raw = entryAddressableBlocks(sourceEntry);
        const entryId = sourceEntry && typeof sourceEntry.id === "string" ? sourceEntry.id : "";
        const addressedMessages = raw && entryId
          ? sourceMessages.map((m: any) => (m && m.content === raw ? addressMessageImages(m, entryId) : m))
          : sourceMessages;
        const source = sourceEntry ? addressEntryImages(sourceEntry) : sourceEntry;
        if (source === sourceEntry && addressedMessages.every((m: any, i: number) => m === sourceMessages[i])) return pe;
        return { ...pe, sourceEntry: source, messages: addressedMessages };
      });
      // proj.messages 是 entries 的 flatMap；按原消息引用把地址字段带到扁平列表，保持与 pi 同一顺序。
      const byMessage = new WeakMap<object, any>();
      for (let i = 0; i < annotated.length; i++) {
        const before = Array.isArray(entries[i] && entries[i].messages) ? entries[i].messages : [];
        const after = Array.isArray(annotated[i] && annotated[i].messages) ? annotated[i].messages : [];
        for (let j = 0; j < before.length; j++) {
          if (before[j] && after[j] && before[j] !== after[j] && typeof before[j] === "object") byMessage.set(before[j], after[j]);
        }
      }
      const flatOriginal = messages.length ? messages : entries.flatMap((e: any) => (Array.isArray(e && e.messages) ? e.messages : []));
      const flat = flatOriginal.map((m: any) => (m && typeof m === "object" && byMessage.has(m) ? byMessage.get(m) : m));
      const MAX = 2000;
      const out: any = { supported: true, counts: { entries: entries.length, messages: flat.length }, entries: [], messages: [] };
      out.entries = annotated.length > MAX ? annotated.slice(-MAX) : annotated;
      out.messages = flat.length > MAX ? flat.slice(-MAX) : flat;
      if (annotated.length > MAX || flat.length > MAX) { out.truncated = true; out.kept = "tail"; }
      out.entries = out.entries.map((e: any) => shrinkDeep(e));
      out.messages = out.messages.map((m: any) => shrinkDeep(m));
      try { out.leafId = typeof sm.getLeafId === "function" ? sm.getLeafId() : null; } catch {}
      return out;
    } catch (e: any) {
      return { supported: false, entries: [], messages: [], error: e?.message ?? String(e) };
    }
  }

  cmdGetProviderAuth() {
    const mr = this.ctx && this.ctx.modelRegistry;
    if (!mr) return { providers: [] };
    const ids = new Set<string>();
    const registered = new Set<string>();
    const regIds = typeof mr.getRegisteredProviderIds === "function" ? mr.getRegisteredProviderIds() || [] : [];
    for (const id of regIds) { const k = String(id); ids.add(k); registered.add(k); }
    let all: any[] = [];
    try { all = mr.getAll() || []; } catch {}
    for (const m of all) if (m && m.provider) ids.add(String(m.provider));
    const providers = [...ids].sort().map((id) => {
      const row: any = { id, registered: registered.has(id), models: 0 };
      for (const m of all) if (m && String(m.provider) === id) row.models++;
      try { if (typeof mr.getProviderDisplayName === "function") row.displayName = mr.getProviderDisplayName(id); } catch {}
      // [探针 probe12]：getProviderAuthStatus(provider) 才是权威（{configured, source}）；
      // hasConfiguredAuth(providerId) 语义不可靠（stepfun 已认证却返 false），弃用。
      try { if (typeof mr.getProviderAuthStatus === "function") { const st = mr.getProviderAuthStatus(id); if (st && typeof st === "object") { row.status = st; row.configured = !!st.configured; row.authSource = st.source ?? null; } } } catch {}
      try { if (typeof mr.isUsingOAuth === "function") row.usingOAuth = !!mr.isUsingOAuth(id); } catch {}
      try { if (typeof mr.isUsingSubscription === "function") row.usingSubscription = !!mr.isUsingSubscription(id); } catch {}
      return row;
    });
    return { providers };
  }

  /** MCP 服务器清单（pi.getMcpServers，[探针] 返回数组）。
   *  **白名单投影**：config 可能含 env/headers/command 等敏感或大体积内容，只回安全字段；
   *  同时回 `keys`（实际字段名）——本机无 MCP 服务器，元素形状待有服务器时实测。 */
  cmdGetMcpServers() {
    if (!this.pi || typeof this.pi.getMcpServers !== "function") return { servers: [] };
    try {
      const list = this.pi.getMcpServers() || [];
      return {
        servers: list.map((s: any) => {
          const o: any = { keys: s && typeof s === "object" ? Object.keys(s) : [] };
          for (const k of ["name", "id", "transport", "exposure", "enabled", "connected", "status", "toolCount", "error"]) {
            if (s && typeof s === "object" && k in s) {
              const v = s[k];
              o[k] = typeof v === "object" ? JSON.stringify(v).slice(0, 300) : v;
            }
          }
          return o;
        }),
      };
    } catch (e: any) {
      return { servers: [], error: e.message };
    }
  }

  /** 当前生效的系统提示词（ctx.getSystemPrompt，[探针 probe10] 事件 ctx 可用）。
   *  32KB 截断 + truncated 标记；getSystemPromptOptions 仅在部分 ctx 上存在（[探针] 事件 ctx 
   *  上不是函数）——存在才回 options 字段。 */
  cmdGetSystemPrompt() {
    if (!this.ctx || typeof this.ctx.getSystemPrompt !== "function") return { prompt: null, supported: false };
    try {
      const p = String(this.ctx.getSystemPrompt() || "");
      const MAX = 32 * 1024;
      const out: any = { prompt: p.length > MAX ? p.slice(0, MAX) : p, chars: p.length, truncated: p.length > MAX, supported: true };
      try {
        if (typeof (this.ctx as any).getSystemPromptOptions === "function") out.options = (this.ctx as any).getSystemPromptOptions();
      } catch {}
      return out;
    } catch (e: any) {
      return { prompt: null, supported: false, error: e.message };
    }
  }

  /** 单条目全字段（sm.getEntry / byId）——快照触及 12MB 预算被截断后，前端按 id 补洞用。 */
  /** 读扩展注册的 CLI flag（pi.getFlag(name)）。[探针 probe11]：只有 registerFlag
   *  注册的 flag 有值；未注册的名字（含 pi 内置 CLI flag）一律 undefined——因此本命令
   *  只能按前端已知的扩展 flag 名查询，没有"列全部 flag"的接口。 */
  cmdGetFlags(args: any) {
    const names: string[] = Array.isArray(args.names) ? args.names.map((x: any) => String(x)) : [];
    const flags: Record<string, any> = {};
    if (this.pi && typeof this.pi.getFlag === "function") {
      for (const nm of names.slice(0, 50)) flags[nm] = this.pi.getFlag(nm) ?? null;
    }
    return { flags };
  }

  /** 导出会话为纯文本：官方包函数 serializeConversation(convertToLlm(messages))
   *  （[探针 probe11] 输出 "[User]: …\n\n[Assistant]: …" 形态）。弥补 export_html
   *  不可用：直接回传文本、不落盘（无路径监狱问题）。maxChars 默认 100KB、硬顶 500KB。 */
  async cmdExportSession(args: any) {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") throw new RemoteError("not_ready", "无法读取会话");
    const messages = extractMessages(sm.getBranch() || []);
    const maxChars = Math.max(1000, Math.min(500000, Number(args.maxChars) || 100000));
    try {
      const pkg: any = await import("@earendil-works/pi-coding-agent");
      if (!pkg || typeof pkg.serializeConversation !== "function" || typeof pkg.convertToLlm !== "function") {
        throw new RemoteError("unsupported", "导出函数不可用");
      }
      const text = String(pkg.serializeConversation(pkg.convertToLlm(messages)) || "");
      return { format: "text", chars: text.length, truncated: text.length > maxChars, text: text.length > maxChars ? text.slice(0, maxChars) : text };
    } catch (e: any) {
      throw new RemoteError("internal", "导出失败：" + e.message);
    }
  }

  cmdGetEntry(args: any) {
    const id = String(args.entryId || "");
    if (!id) throw new RemoteError("bad_args", "get_entry 需要 entryId");
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm) return { entry: null };
    let e: any = null;
    try { e = typeof sm.getEntry === "function" ? sm.getEntry(id) : null; } catch {}
    if (!e && sm.byId && typeof sm.byId.get === "function") { try { e = sm.byId.get(id); } catch {} }
    if (!e) throw new RemoteError("not_found", "找不到条目：" + id);
    return { entry: shrinkEntryDeep(e) };
  }

  /** 书签（LabelEntry）清单（sm.labelsById / labelTimestampsById）。 */
  /** 模型路由态（virtual-models.md）：selected = 最后一个 model_change 条目的选择；
   *  lastDispatched = 最后一条 assistant 消息实际路由到的物理模型。从会话条目派生，零额外接口。 */
  cmdGetRouting() {
    const sm = this.ctx && this.ctx.sessionManager;
    const entries = sm && typeof sm.getEntries === "function" ? sm.getEntries() || [] : [];
    let selected: any = null;
    for (const e of entries) {
      if (e && e.type === "model_change") {
        selected = { provider: e.provider ?? null, modelId: e.modelId ?? null, at: e.timestamp ?? null };
      }
    }
    let lastDispatched: any = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e: any = entries[i];
      if (e && e.type === "message" && e.message && e.message.role === "assistant") {
        lastDispatched = { provider: e.message.provider ?? null, model: e.message.model ?? null, responseModel: e.message.responseModel ?? null, at: e.message.timestamp ?? null };
        break;
      }
    }
    const cur: any = this.ctx ? this.ctx.model : null;
    return { selected, lastDispatched, current: cur ? { provider: cur.provider ?? null, modelId: cur.modelId || cur.id || null } : null };
  }

  cmdGetLabels() {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm) return { labels: [] };
    const out: any[] = [];
    try {
      // [探针 probe11] labelsById / labelTimestampsById 是 Map（不是普通对象）
      const map: any = sm.labelsById instanceof Map ? sm.labelsById : new Map(Object.entries(sm.labelsById || {}));
      const ts: any = sm.labelTimestampsById instanceof Map ? sm.labelTimestampsById : new Map(Object.entries(sm.labelTimestampsById || {}));
      for (const [id, label] of map) {
        out.push({ targetId: id, label: label == null ? null : String(label), at: ts.get(id) ?? null });
      }
    } catch {}
    return { labels: out };
  }

  /** 会话树分页探索（sm.getChildren）。parentId 缺省 = 根层（具体语义以 pi 实现为准，
   *  [探针] getChildren(leafId) 返回数组）。 */
  cmdGetChildren(args: any) {
    const sm = this.ctx && this.ctx.sessionManager;
    const leafId = sm && typeof sm.getLeafId === "function" ? this.safeRead(() => sm.getLeafId(), null) : null;
    if (!sm || typeof sm.getChildren !== "function") return { children: [], leafId, parentId: null };
    const parentId = args.parentId ? String(args.parentId) : null;
    const children = this.safeRead(() => sm.getChildren(parentId || undefined) || [], []);
    return { children, leafId, parentId };
  }

  /** 模型作用域（ctx.scopedModels，--models / /scoped-models 选中的集合）。
   *  [探针] 事件 ctx 上是数组；空数组 = 未设作用域（全部模型可用）。 */
  cmdGetScopedModels() {
    const sc: any = this.ctx ? (this.ctx as any).scopedModels : null;
    if (!Array.isArray(sc)) return { scoped: false, models: [] };
    return { scoped: sc.length > 0, models: sc.map((m: any) => toModel(m)) };
  }

  /** 删除一个会话文件（pi 无对应命令；session-format.md §Deleting Sessions：删 .jsonl）。
   *  安全：路径监狱 + **禁删当前会话**。P9 §4.6：动作和 pi 一样（有 trash 先移进废纸篓），
   *  返回里带上 method 让网页写对提示文案。 */
  cmdDeleteSession(args: any) {
    const p = this.jailSessionPath(String(args.sessionPath || ""));
    const sm = this.ctx && this.ctx.sessionManager;
    const cur = this.safeRead(() => (sm && sm.getSessionFile ? String(sm.getSessionFile()).replace(/\\/g, "/") : null), null);
    if (samePath(p, cur, this.platform)) throw new RemoteError("bad_args", "不能删除当前会话（先切换走再删）");
    const removedId = sessionIdFromFile(p);
    const res = deleteLikePi(p, this.platform);
    if (!res.ok) throw new RemoteError("internal", res.error || "删除失败");
    log("已删除会话文件:", p, "方式:", res.method);
    if (removedId) this.enqueueManifest({ removed: [removedId] });
    return { ok: true, deleted: p.replace(/\\/g, "/"), method: res.method };
  }

  /** 未载入会话改名：向目标 .jsonl 追加一条 pi 语义的 session_info。
   *  不切会话、不改文件名/id；当前会话必须走 set_session_name（否则内存里的 leaf 会与文件脱节）。 */
  async cmdRenameSessionFile(args: any) {
    const p = this.jailSessionPath(String(args.sessionPath || ""));
    const name = String(args.name == null ? "" : args.name).replace(/[\r\n]+/g, " ").trim();
    if (!name) throw new RemoteError("bad_args", "rename_session_file 需要 name");
    if (name.length > SESSION_INFO_NAME_MAX) throw new RemoteError("bad_args", "会话名过长（上限 " + SESSION_INFO_NAME_MAX + " 字符）");
    const cur = this.currentSessionFile();
    if (cur && samePath(p, cur, this.platform)) {
      throw new RemoteError("bad_args", "当前活动会话改名请用 set_session_name（不能直接改正在使用的文件）");
    }

    // 纯文件实现：流式扫描只取头/叶/上一名字/消息数，不依赖 pi 包，也不整份读进内存。
    const scan = scanSessionFile(p, "改名");
    const headerId = String(scan.header.id);
    const cwd = String(scan.header.cwd || "");
    const previousName = scan.latestSessionName;
    const knownMessageCount = scan.messageCount;
    const entryId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const entry = {
      type: "session_info",
      id: entryId,
      parentId: scan.lastId,
      timestamp: new Date().toISOString(),
      name,
    };
    // 文件末尾没有换行时先补一个，避免把新条目拼到上一行 JSON 里。
    const prefix = scan.endsWithNewline ? "" : "\n";
    let fd: any = null;
    try {
      fd = fs.openSync(p, "a");
      writeAllSync(fd, prefix + JSON.stringify(entry) + "\n");
      try { fs.fsyncSync(fd); } catch {}
    } catch (e: any) {
      throw sessionFileError(e, "改名");
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }

    // 清单即时更新：不依赖 SessionManager.list 是否扫到这个会话目录。
    const one = this.parseSessionFile(p, null) || {};
    const row = normalizeSessionEntry({
      ...one,
      id: headerId,
      path: p,
      cwd,
      name,
      messageCount: knownMessageCount != null ? knownMessageCount : one.messageCount,
      updatedAt: Date.now(),
    }, cwd || this.cwd || "");
    if (row) {
      this.indexCache.set(row.id, row);
      this.enqueueManifest({ ids: [row.id], rows: [row] });
    }
    return {
      ok: true,
      id: headerId,
      sessionPath: p.replace(/\\/g, "/"),
      name,
      previousName: previousName || null,
      entryId,
      session: row || null,
    };
  }

  /** 未载入会话导出：直接读目标文件。JSONL 原样；文本按该文件自己的活动叶转换。
   *  超限明确报错，不返回截断的半份导出。 */
  async cmdExportSessionFile(args: any) {
    const p = this.jailSessionPath(String(args.sessionPath || ""));
    const format = args.format === "jsonl" ? "jsonl" : args.format === "text" || args.format == null ? "text" : "";
    if (!format) throw new RemoteError("bad_args", "export_session_file 的 format 只能是 text 或 jsonl");
    const requested = Number(args.maxBytes);
    const maxBytes = Math.max(16 * 1024, Math.min(
      SESSION_FILE_EXPORT_MAX_BYTES,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : SESSION_FILE_EXPORT_DEFAULT_BYTES,
    ));
    let st: any;
    try { st = fs.statSync(p); } catch (e: any) { throw sessionFileError(e, "导出"); }
    if (format === "jsonl" && st.size > maxBytes) {
      throw new RemoteError("payload_too_large", "会话文件 " + formatBytes(st.size) + "，超过 JSONL 导出上限 " + formatBytes(maxBytes) + "；请在本机打开 " + p + " 或在导出时调大上限（最多 " + formatBytes(SESSION_FILE_EXPORT_MAX_BYTES) + "）");
    }
    if (format === "text" && st.size > SESSION_FILE_TEXT_READ_MAX_BYTES) {
      throw new RemoteError("payload_too_large", "会话文件 " + formatBytes(st.size) + "，超过文本导出读取上限 " + formatBytes(SESSION_FILE_TEXT_READ_MAX_BYTES) + "；请在本机打开 " + p + " 或改用 JSONL（上限 " + formatBytes(maxBytes) + "）");
    }

    const info = readSessionFileStrict(p, "导出");
    let text = "";
    if (format === "jsonl") {
      text = info.text;
    } else {
      const pkg = await this.loadPiPackage();
      if (pkg && typeof pkg.buildSessionContext === "function" && typeof pkg.convertToLlm === "function" && typeof pkg.serializeConversation === "function") {
        try {
          const ctx = pkg.buildSessionContext(info.entries, info.entries.length ? info.entries[info.entries.length - 1].id : null);
          text = String(pkg.serializeConversation(pkg.convertToLlm(ctx.messages || [])) || "");
        } catch (e: any) {
          log("pi 会话文本转换失败，回退内置转换:", e?.message);
          text = fallbackConversationText(info.entries);
        }
      } else {
        text = fallbackConversationText(info.entries);
      }
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      throw new RemoteError("payload_too_large", "导出结果 " + formatBytes(bytes) + "，超过上限 " + formatBytes(maxBytes) + "；请调大 maxBytes（最多 " + formatBytes(SESSION_FILE_EXPORT_MAX_BYTES) + "）或在本机导出");
    }
    return {
      format,
      sessionId: String(info.header.id),
      sessionPath: p.replace(/\\/g, "/"),
      text,
      chars: text.length,
      bytes,
      totalBytes: st.size,
      truncated: false,
    };
  }

  /** 冷 fork：纯文件实现，复制目标文件 root→leaf 的活动分支并落一个新会话文件。
   *  不启动 pi 进程、不改当前活动会话、不依赖 pi 包；源文件流式扫描，正文不整份驻留。 */
  async cmdForkSessionFile(args: any) {
    const p = this.jailSessionPath(String(args.sessionPath || ""));
    const dir = this.sessionDir();
    if (!dir) throw new RemoteError("not_ready", "拿不到会话目录，无法分叉");
    // 严格扫描源文件：损坏行/缺头/越界/权限都在写新文件之前报清楚（不拿半份解析结果去 fork）。
    const scan = scanSessionFile(p, "分叉", { entries: true });
    const pathEntries = activeSessionPathFromScan(scan);
    if (!pathEntries.length) {
      const anyMessage = scan.byId
        ? [...scan.byId.values()].some((e) => e.type === "message" && (e.role === "user" || e.role === "assistant"))
        : false;
      if (!anyMessage) throw new RemoteError("bad_args", "这个会话还没有用户/助手消息，没有可分叉的分支");
      throw new RemoteError("bad_args", "这个会话没有活动分支");
    }
    const canFork = pathEntries.some((e) => e.type === "message" && (e.role === "user" || e.role === "assistant"));
    if (!canFork) throw new RemoteError("bad_args", "这个会话还没有用户/助手消息，没有可分叉的分支");

    const newFile = this.forkSessionFileReadOnly(p, dir, scan);
    // 新文件也必须落在会话目录监狱内；写文件名由我们生成，这里再校一次防止未来改动越界。
    const safe = this.jailSessionPath(newFile);
    const created = readSessionHeaderLine(safe, "读取分叉结果");
    const one = this.parseSessionFile(safe, null) || {};
    const cwd = String(created.cwd || scan.header.cwd || this.cwd || "");
    const messageCount = pathEntries.filter((e) => e.type === "message").length;
    const row = normalizeSessionEntry({
      ...one,
      id: String(created.id),
      path: safe,
      cwd,
      messageCount,
      updatedAt: Date.now(),
    }, cwd);
    if (row) {
      this.indexCache.set(row.id, row);
      this.enqueueManifest({ ids: [row.id], rows: [row] });
    }
    log("冷 fork 完成:", p, "→", safe);
    return {
      ok: true,
      id: String(created.id),
      sessionPath: safe.replace(/\\/g, "/"),
      parentSession: p.replace(/\\/g, "/"),
      cwd,
      session: row || null,
    };
  }

  /** 纯文件冷 fork：按 pi createBranchedSession 的规则复制 root→leaf，滤掉 label 后重新挂链。
   *  第一遍流式扫描已建好 id→{parentId,offset,length} 索引；这里只按偏移逐行读取目标分支，
   *  边读边写新文件，内存上限是一条条目的字节数。源文件在读的过程中被改写/截断会明确失败。 */
  forkSessionFileReadOnly(sourcePath: string, dir: string, scan: SessionFileScan): string {
    const byId = scan.byId;
    if (!byId) throw new RemoteError("internal", "冷 fork 缺少流式索引");
    const pathEntries = activeSessionPathFromScan(scan);
    if (!pathEntries.length) throw new RemoteError("bad_args", "这个会话没有活动分支");

    // 和 pi 一样：路径里的 label 条目不是模型上下文的一部分；先记下全部 label，
    // 重建活动链后再把“目标仍在路径里”的书签挂到末尾。
    const labels = scan.labels || new Map<string, { label: string; timestamp?: string }>();
    const kept: SessionEntryMeta[] = [];
    const replacementByLabelId = new Map<string, string>();
    const pendingLabelIds: string[] = [];
    let parentId: string | null = null;
    for (const entry of pathEntries) {
      if (entry.type === "label") {
        pendingLabelIds.push(entry.id);
        continue;
      }
      for (const lid of pendingLabelIds) replacementByLabelId.set(lid, entry.id);
      pendingLabelIds.length = 0;
      kept.push(entry);
      parentId = entry.id;
    }
    const pathIds = new Set(kept.map((e) => e.id));
    const extraLabels: any[] = [];
    for (const [targetId, label] of labels) {
      if (!pathIds.has(targetId)) continue;
      let lid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      while (pathIds.has(lid)) lid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      pathIds.add(lid);
      extraLabels.push({
        type: "label",
        id: lid,
        parentId,
        timestamp: label.timestamp || new Date().toISOString(),
        targetId,
        label: label.label,
      });
      parentId = lid;
    }

    const newId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const name = timestamp.replace(/[:.]/g, "-") + "_" + newId + ".jsonl";
    const newFile = path.join(dir, name);
    const header = {
      type: "session",
      version: Number(scan.header.version) || 3,
      id: newId,
      timestamp,
      cwd: scan.header.cwd || this.cwd || process.cwd(),
      parentSession: sourcePath,
    };
    let srcFd: any = null;
    let outFd: any = null;
    let created = false;
    try {
      srcFd = fs.openSync(sourcePath, "r");
      outFd = fs.openSync(newFile, "wx");
      created = true;
      writeAllSync(outFd, JSON.stringify(header) + "\n");
      let nextParent: string | null = null;
      for (const meta of kept) {
        const buf = readAllSync(srcFd, meta.length, meta.offset);
        if (!buf) throw new RemoteError("internal", "分叉失败：源会话在操作期间被截断（条目 " + meta.id + "）");
        let entry: any;
        try { entry = JSON.parse(buf.toString("utf8")); } catch {
          throw new RemoteError("internal", "分叉失败：源会话在操作期间被修改或损坏（第 " + (meta.offset + 1) + " 字节附近）");
        }
        if (!entry || entry.id !== meta.id) {
          throw new RemoteError("internal", "分叉失败：源会话在操作期间被修改（条目 " + meta.id + " 已变化）");
        }
        const copy: any = { ...entry, parentId: nextParent };
        if (entry.type === "compaction") {
          if (entry.firstKeptEntryId === entry.id) copy.firstKeptEntryId = entry.id;
          else copy.firstKeptEntryId = replacementByLabelId.get(String(entry.firstKeptEntryId)) || entry.firstKeptEntryId;
        }
        writeAllSync(outFd, JSON.stringify(copy) + "\n");
        nextParent = meta.id;
      }
      for (const label of extraLabels) writeAllSync(outFd, JSON.stringify(label) + "\n");
      try { fs.fsyncSync(outFd); } catch {}
    } catch (e: any) {
      // 先关句柄再删半成品（Windows 上打开的文件不能 unlink）。
      if (outFd !== null) { try { fs.closeSync(outFd); } catch {} outFd = null; }
      if (created) {
        try { fs.unlinkSync(newFile); } catch {}
      }
      throw sessionFileError(e, "写入新会话");
    } finally {
      if (srcFd !== null) { try { fs.closeSync(srcFd); } catch {} }
      if (outFd !== null) { try { fs.closeSync(outFd); } catch {} }
    }
    return newFile;
  }

  cmdGetSettings() {
    if (!this.pi || typeof this.pi.getSettings !== "function") return { settings: {} };
    try {
      const settings = this.pi.getSettings() || {};
      const redact = redactDeep(settings);
      return { settings: redact };
    } catch (e) {
      return { settings: {}, error: e.message };
    }
  }

  /** settings_set（additive）：只写全局 agentDir 的 settings.json，白名单字段。
   *  pi 1.3 扩展面没有 setSettings / 事件 ctx reload，运行中的 SettingsManager 不会重读文件，
   *  因此永远返回 restartRequired:true（不假装热更新）。不返回路径、完整设置或任何密钥。 */
  cmdSettingsSet(args: any) {
    const patch = settingsPatchFromArgs(args);
    const filePath = settingsFilePath();
    const result = settingsWritePatch(filePath, patch);
    // 只记字段名，不记值（defaultModel 等虽非密钥，也没必要进日志）
    log("settings_set 已写白名单设置:", Object.keys(result.applied).join(",") || "(none)");
    return {
      ok: true,
      applied: result.applied,
      restartRequired: true,
      restartReason: "运行中的 pi 从内存读取设置（SettingsManager 缓存）；写入 settings.json 不会热更新",
      reloadHint: "重启 pi 后生效。在本机 TUI 执行 /reload 会重载设置与扩展，但启动期设置（主题/TUI 模式等）仍需重启",
    };
  }

  async cmdRegenerate(args) {
    // 重复回复：重发指定（默认最后一条）user 消息
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") throw new RemoteError("not_ready", "无法读取会话历史");
    const messages = extractMessages(sm.getBranch() || []);
    const userMsgs = messages.filter((m) => m && typeof m.role === "string" && m.role === "user");
    if (!userMsgs.length) throw new RemoteError("not_found", "会话中没有 user 消息可重发");
    const idx = typeof args.fromIndex === "number" ? args.fromIndex : userMsgs.length - 1;
    const target = userMsgs[Math.max(0, Math.min(userMsgs.length - 1, idx))];
    let text = "";
    const content = target.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
    }
    if (!text.trim()) throw new RemoteError("bad_args", "目标消息没有可重发的文本");
    const idle = this.isIdleNow();
    this.deliverText(text, "steer");
    return { ok: true, resent: text.slice(0, 120), mode: idle ? "prompt" : "steer" };
  }

  /** 远程 bash 的 cwd 只允许落在会话目录或已登记项目内（末尾斜杠不计，Windows / macOS 大小写不计；子目录允许，与 attach 的 projects 语义一致），否则拒绝执行。
   *  本机 POSIX 上按真实路径比：项目里指向外面的符号链接不能当跳板 */
  bashCwdAllowed(want: any): boolean {
    const platform = this.platform;
    const norm = (p: any) => {
      let s = String(p == null ? "" : p).replace(/\\/g, "/").replace(/\/+$/, "");
      if (!s) return "";
      try {
        s = realDir(s, platform).replace(/\\/g, "/").replace(/\/+$/, "");
      } catch {}
      return caseInsensitivePaths(platform) ? s.toLowerCase() : s;
    };
    const target = norm(want);
    if (!target) return false;
    for (const dir of manifestProjectDirs(this.cwd, process.env, platform)) {
      const base = norm(dir);
      if (target === base || target.startsWith(base + "/")) return true;
    }
    return false;
  }

  async cmdBash(args: any) {
    // 远程 shell（默认关闭：需 PI_REMOTE_ALLOW_BASH=1）
    if (process.env.PI_REMOTE_ALLOW_BASH !== "1") {
      throw new RemoteError("unsupported", "bash 接口未启用（在本机 .env 设置 PI_REMOTE_ALLOW_BASH=1 后重启 pi）");
    }
    if (!args.command) throw new RemoteError("bad_args", "bash 需要 command");
    if (!this.pi || typeof this.pi.exec !== "function") throw new RemoteError("unsupported", "当前 pi 不支持 exec");
    // 官方签名 pi.exec(file, args[], options)（官方示例 examples/extensions/inline-bash.ts）。
    // Windows 上 PATH 通常没有 bash（probe8 实测直接失败）：必须走 ComSpec。
    // 超长直接拒绝：截断后的半条命令照样会被执行，后果不可预期
    const cmd = String(args.command);
    if (cmd.length > BASH_COMMAND_MAX_CHARS) throw new RemoteError("bad_args", `命令过长（${cmd.length} 字符，上限 ${BASH_COMMAND_MAX_CHARS}），未执行`);
    const isWin = process.platform === "win32";
    const file = isWin ? process.env.ComSpec || "cmd.exe" : "bash";
    const argv = isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    // 超时：默认 30s，可被 args.timeout 覆盖（硬顶 120s）——挂死的命令不能永远占着命令通道
    const timeout = Math.max(1, Math.min(120, Number(args.timeout) || 30)) * 1000;
    // 中断：AbortController 登记进 runningBash，abort_bash 命令可取消
    const ac = new AbortController();
    const runId = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.runningBash.set(runId, ac);
    let r: any;
    try {
      const opts: any = { signal: ac.signal, timeout };
      if (args.cwd) {
        const want = String(args.cwd);
        if (!this.bashCwdAllowed(want)) {
          throw new RemoteError("cwd_not_allowed", `bash 的 cwd 越界（必须在会话目录或已登记项目内）：${want}`);
        }
        opts.cwd = want;
      }
      r = await this.pi.exec(file, argv, opts);
    } finally {
      this.runningBash.delete(runId);
    }
    const stdout = r && r.stdout != null ? String(r.stdout) : "";
    const stderr = r && r.stderr != null ? String(r.stderr) : "";
    const output = stdout + stderr;
    const exitCode = r && r.code != null ? r.code : null;
    const cancelled = !!(r && r.killed) || ac.signal.aborted;
    // 官方副作用（rpc-commands.md §bash"How bash results reach the LLM"）：输出以
    // "Ran `<cmd>`\n```\n<output>\n```" 形态进会话，下一次 prompt 时模型看得到；
    // excludeFromContext=true 时只执行、不进上下文。pi 的对应接口就是 pi.sendMessage()：
    // 自定义消息 = 入库 + 进模型上下文 + 不触发回合（probe8 实测 branch 落 custom_message）。
    // 输出只保留尾部：进模型上下文的那份更小（整页日志会挤爆上下文），回包那份受单帧上限约束
    const tail = (s: string, max: number) => (s.length > max ? `…[前 ${s.length - max} 字符已省略]\n` + s.slice(-max) : s);
    if (args.excludeFromContext !== true) {
      try {
        const body = "Ran `" + cmd + "`\n```\n" + (tail(output, BASH_CONTEXT_MAX_CHARS) || "(no output)") + "\n```";
        const sr: any = this.pi.sendMessage({ customType: "remote-bash", content: body, display: true, details: { command: cmd.slice(0, 2000), exitCode, cancelled } });
        if (sr && typeof sr.then === "function") sr.catch((e: any) => log("bash 输出入库失败:", e?.message));
        // 空闲时 pi 直接落盘这条自定义消息，它的 message_end 只发给 pi 自己的监听者、不经扩展：靠对齐补给远端
        this.scheduleProbe(200);
      } catch (e: any) {
        log("bash 输出入库失败:", e?.message);
      }
    }
    // 官方响应形状（rpc-commands.md §bash）：truncated = 输出超过 1MB 只回了尾部
    return {
      result: {
        output: tail(output, BASH_RESULT_MAX_CHARS),
        exitCode,
        cancelled,
        truncated: output.length > BASH_RESULT_MAX_CHARS,
      },
    };
  }

  /** pi 官方 RPC abort_bash：取消本机正在执行的远程 bash。
   *  返回 {ok:true, aborted:n}（n=取消数；官方只有 success，多带的字段前端可忽略）。 */
  cmdAbortBash() {
    let aborted = 0;
    for (const [, ac] of this.runningBash) {
      try { ac.abort(); aborted++; } catch {}
    }
    return { ok: true, aborted };
  }

  /** 安全读取：runtime 失效时 getter 抛异常，包一层返回 fallback */
  safeRead<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
  }

  /** 测试可替换：返回 pi 包时用官方 SessionManager / 分支摘要；返回 null 时走明确降级路径。 */
  async loadPiPackage(): Promise<any> {
    try {
      return await import("@earendil-works/pi-coding-agent");
    } catch (e: any) {
      log("pi 包不可用:", e?.message);
      return null;
    }
  }

  currentSessionFile(): string | null {
    const sm = this.ctx && this.ctx.sessionManager;
    return this.safeRead(() => (sm && typeof sm.getSessionFile === "function" && sm.getSessionFile() ? String(sm.getSessionFile()) : null), null);
  }

  /** 解析单个会话文件：头 256KB + 尾 64KB。
   *  尾扫描是必须的——`session_info`（改名）条目通常落在文件后段，只读头部会丢名字。 */
  parseSessionFile(p: string, cur: string | null): any {
    const np = require("node:path");
    let fd: any = null;
    try {
      const st = fs.statSync(p);
      const HEAD = Math.min(st.size, 256 * 1024);
      const TAIL = st.size > HEAD ? Math.min(65536, st.size - HEAD) : 0;
      fd = fs.openSync(p, "r");
      let text: string;
      if (st.size <= HEAD + TAIL) {
        // 头+尾已经覆盖整份文件（≤ 320KB）：一次读完，避免“头尾拼接”把边界行拆断/丢弃。
        text = readFdBytes(fd, st.size).toString("utf8");
      } else {
        const headBuf = Buffer.alloc(HEAD);
        fs.readSync(fd, headBuf, 0, HEAD, 0);
        text = headBuf.toString("utf8");
        const tailBuf = Buffer.alloc(TAIL);
        fs.readSync(fd, tailBuf, 0, TAIL, st.size - TAIL);
        const tailText = tailBuf.toString("utf8");
        // 尾部第一段通常从行中间开始：丢掉半行，接在头部之后的完整行才是连续的。
        const nl = tailText.indexOf("\n");
        text += "\n" + (nl >= 0 ? tailText.slice(nl + 1) : tailText);
      }
      let id: any = null;
      let created: any = null;
      let name: any = null;
      let firstUser: any = null;
      let parentSession: string | null = null;
      let msgCount = 0;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "session") {
          id = e.id;
          created = e.timestamp;
          // 文件头 parentSession 是 fork 的权威父指针（pi 与本扩展冷 fork 都写），不靠标题/时间猜。
          if (typeof e.parentSession === "string" && e.parentSession) parentSession = e.parentSession.replace(/\\/g, "/");
        }
        else if (e.type === "message") {
          msgCount++;
          if (!firstUser && e.message && e.message.role === "user") { const t = msgText(e.message).trim(); if (t) firstUser = t; }
        } else if (e.type === "session_info" && e.name) { name = String(e.name).trim(); }
      }
      const self = p.replace(/\\/g, "/");
      return {
        id: id || np.basename(p).replace(/\.jsonl$/, ""),
        path: self,
        name: name || null,
        firstMessage: firstUser ? String(firstUser).slice(0, 80) : null,
        created: created || null,
        modified: new Date(st.mtimeMs).toISOString(),
        size: st.size,
        messageCount: msgCount,
        // 头 256KB + 尾 64KB 都读了；只有中间真被跳过才算截断。
        // 旧写法 `st.size > HEAD` 会把 256KB~320KB 的小会话文件误标成 truncated（整份其实已读完）。
        truncated: st.size > HEAD + TAIL,
        parentSession,
        current: !!cur && cur === self,
      };
    } catch {
      return null;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** ================= 只读：会话列表 / Fork 点 / 树 / 统计（event ctx 即可执行） ================= */
  async cmdListSessions(args: any) {
    // 官方 API 优先：SessionManager.list(cwd)（[探针 probe11]：每项 10 字段，
    // messageCount/firstMessage/name/created/modified 均为准确值）。失败回退 fs 扫描。
    const sm0 = this.ctx && this.ctx.sessionManager;
    try {
      const pkg: any = await import("@earendil-works/pi-coding-agent");
      if (pkg && pkg.SessionManager && typeof pkg.SessionManager.list === "function") {
        const dir = this.sessionDir();
        // list() 要的是**项目 cwd**（不是会话目录）——[探针 probe11] 口径；传会话目录会返回空
        const list = (await pkg.SessionManager.list(this.cwd || process.cwd())) || [];
        const cur0 = this.safeRead(() => (sm0 && sm0.getSessionFile ? String(sm0.getSessionFile()).replace(/\\/g, "/") : null), null);
        const limit2 = Math.max(1, Math.min(200, Number(args && args.limit) || 30));
        let out2: any[] = list.map((x: any) => ({
          id: x.id,
          path: String(x.path).replace(/\\/g, "/"),
          name: x.name ?? null,
          firstMessage: x.firstMessage ? String(x.firstMessage).slice(0, 80) : null,
          created: x.created ?? null,
          modified: x.modified ?? null,
          size: null,
          messageCount: Number(x.messageCount) || 0,
          truncated: false,
          parentSession: sessionParentPathOf(x),
          current: samePath(x.path, cur0, this.platform),
        }));
        const q2 = args && args.query ? String(args.query).trim().toLowerCase() : "";
        if (args && args.namedOnly) out2 = out2.filter((x: any) => !!x.name);
        if (q2) out2 = out2.filter((x: any) => String(x.name || "").toLowerCase().includes(q2) || String(x.firstMessage || "").toLowerCase().includes(q2) || String(x.id || "").toLowerCase().includes(q2));
        return { sessions: out2.slice(0, limit2), total: list.length, matched: out2.length, sessionDir: dir, source: "SessionManager.list" };
      }
    } catch (e: any) {
      log("SessionManager.list 不可用，回退 fs 扫描:", e?.message);
    }
    const sm = this.ctx && this.ctx.sessionManager;
    const dir = sm && typeof sm.getSessionDir === "function" ? sm.getSessionDir() : null;
    // 单文件模式：resolveSession 按名字匹配用，避免每次全目录 readdir + 逐文件 stat
    if (args && typeof args.only === "string" && dir) {
      // only 也走路径监狱：不监狱的话 ../ 能读出会话目录以外的文件内容
      let p = "";
      try {
        p = this.jailSessionPath(require("node:path").join(dir, args.only));
      } catch {
        return { sessions: [], total: 0, sessionDir: dir };
      }
      const cur0 = sm && sm.sessionFile ? String(sm.sessionFile).replace(/\\/g, "/") : null;
      const one = this.parseSessionFile(p, cur0);
      return { sessions: one ? [one] : [], total: one ? 1 : 0, sessionDir: dir };
    }
    // 默认 30、硬顶 200：原来的 100/500 会让最坏 500×256KB=128MB 同步读堵住命令通道
    const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 30));
    // runtime 失效时 sessionManager 的 getter 会直接抛（同文件 bindSession 的注释已说明）：
    // 裸访问会让整条只读命令失败，而目录列举本可以成功。
    const cur = this.safeRead(() => (sm && sm.sessionFile ? String(sm.sessionFile).replace(/\\/g, "/") : null), null);
    let out: any[] = [];
    let total = 0;
    if (dir && fs.existsSync(dir)) {
      let ents: any[] = [];
      try {
        ents = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e: any) => e.isFile() && e.name.endsWith(".jsonl"))
          .map((e: any) => {
            try { return { name: e.name, mtimeMs: fs.statSync(require("node:path").join(dir, e.name)).mtimeMs }; } catch { return null; }
          })
          .filter(Boolean)
          .sort((a: any, b: any) => b.mtimeMs - a.mtimeMs);
      } catch { ents = []; }
      total = ents.length;
      for (const ent of ents.slice(0, limit)) {
        const one = this.parseSessionFile(require("node:path").join(dir, ent.name), cur);
        if (one) out.push({ ...one, modified: new Date(ent.mtimeMs).toISOString() });
      }
    }
    // query / namedOnly 过滤（rpc-commands.md 无此参数，前端选择器要按名字/首条消息搜索）
    const q = args && args.query ? String(args.query).trim().toLowerCase() : "";
    const namedOnly = !!(args && args.namedOnly);
    let filtered = out;
    if (namedOnly) filtered = filtered.filter((x: any) => !!x.name);
    if (q) filtered = filtered.filter((x: any) => String(x.name || "").toLowerCase().includes(q) || String(x.firstMessage || "").toLowerCase().includes(q) || String(x.id || "").toLowerCase().includes(q));
    return { sessions: filtered, total, matched: filtered.length, sessionDir: dir };
  }

  /** 只读：会话正文搜索（R4-2）。只在宿主侧扫 sessionDir 内的 .jsonl——正文只经命令回包
   *  透传给发起的 viewer，relay 不落盘、不建索引（红线）。预算全部取 PROTOCOL.limits：
   *  文件数 / 总字节 / 自设 deadline / 单行字节上限 / 每会话命中与 snippet 上限 / 全局结果上限，任一到限
   *  即停并回 truncated:true + 已扫计数，绝不假装搜全。文件只从 sessionDir 枚举
   *  （readdir 的文件名拼路径），没有外部路径入口，监狱外文件天然搜不到。 */
  async cmdSearchSessionBodies(args: any) {
    const L: any = PROTOCOL.limits as any;
    const query = typeof (args && args.query) === "string" ? args.query.trim() : "";
    if (query.length < L.bodySearchQueryMin) throw new RemoteError("bad_args", "搜索词至少 " + L.bodySearchQueryMin + " 个字");
    if (query.length > L.bodySearchQueryMax) throw new RemoteError("bad_args", "搜索词太长（上限 " + L.bodySearchQueryMax + " 字）");
    const needle = query.toLowerCase();
    const resultsMax = Math.max(1, Math.min(L.bodySearchResultsMax, Number(args && args.limit) || L.bodySearchResultsMax));
    const dir = this.sessionDir();
    if (!dir) return { query, results: [], truncated: false, scannedFiles: 0, totalFiles: 0 };
    const np = require("node:path");
    let ents: { name: string; mtimeMs: number }[] = [];
    try {
      ents = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e: any) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e: any) => {
          try { return { name: e.name, mtimeMs: fs.statSync(np.join(dir, e.name)).mtimeMs }; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.mtimeMs - a.mtimeMs);
    } catch { ents = []; }
    const totalFiles = ents.length;
    const deadline = Date.now() + L.bodySearchDeadlineMs;
    const results: any[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;
    const budgetHit = () => scannedBytes >= L.bodySearchBytesMax || Date.now() >= deadline;
    for (const ent of ents) {
      if (results.length >= resultsMax || scannedFiles >= L.bodySearchFilesMax || budgetHit()) { truncated = true; break; }
      const p = np.join(dir, ent.name);
      const hit = await this.scanSessionBody(p, needle, budgetHit, (n: number) => { scannedBytes += n; });
      if (hit.stopped) truncated = true;
      // 完整扫完才计入已扫：中途停（预算/deadline/读异常）的文件不算已扫，
      // 「已扫 X/Y」文案与 truncated 诚实态同口径（B-1/B-3）。
      else scannedFiles++;
      if (hit.matchCount > 0) {
        results.push({
          session: p.replace(/\\/g, "/"),
          id: hit.id || np.basename(ent.name, ".jsonl"),
          title: hit.name || hit.firstMessage || hit.id || np.basename(ent.name, ".jsonl"),
          cwd: hit.cwd || "",
          mtime: ent.mtimeMs,
          matchCount: hit.matchCount,
          snippets: hit.snippets,
        });
      }
    }
    if (scannedFiles < totalFiles) truncated = true;
    return { query, results, truncated, scannedFiles, totalFiles };
  }

  /** 扫单个会话文件：按字节块流式切行，只抽消息类条目文本（msgText 既有口径，单条先截到
   *  bodySearchEntryTextMax 再匹配——工具大块输出按条截断计入）。命中记 snippet：
   *  命中点前约 60 字上下文、整段压到 bodySearchSnippetChars，空白折叠成单行呈现文本。
   *  预算到限（字节/deadline）立刻停、读异常中断同理：stopped=true 让上层标 truncated，
   *  且上层只把 stopped=false（扫完或命中早停收尾）的文件计入已扫计数。
   *  B-2 加固（R5-1）：读法是裸字节块 + StringDecoder 切行——字节/deadline 检查点在
   *  每一块之后、任何单行物化之前；单行超 bodySearchLineMaxBytes 的巨行整行丢弃
   *  （丢弃其剩余字节直至下一个换行、不解析、超限行内的命中不计），置 lineSkipped
   *  并入 stopped——跳过的行没搜过，不假装搜全。跨块多字节字符由 StringDecoder
   *  兜住（半截字符先扣住、拼齐再吐），不会切出乱码。 */
  async scanSessionBody(p: string, needle: string, budgetHit: () => boolean, addBytes: (n: number) => void): Promise<any> {
    const L: any = PROTOCOL.limits as any;
    const { StringDecoder } = require("node:string_decoder");
    const lineMax = typeof L.bodySearchLineMaxBytes === "number" && L.bodySearchLineMaxBytes > 0 ? L.bodySearchLineMaxBytes : 4194304;
    let id: string | null = null;
    let cwd = "";
    let name: string | null = null;
    let firstMessage: string | null = null;
    let matchCount = 0;
    const snippets: { text: string; entryId?: string }[] = [];
    let stopped = false;
    let lineSkipped = false;
    let finished = false; // 命中早停收尾：结果已完整，不算 stopped（与旧逐行版 break 同义）

    // 单行处理：返回 false = 结果已完整、提前收尾。逐行语义与旧 readline 版逐字一致。
    const handleLine = (line: string): boolean => {
      if (!line.trim()) return true;
      let e: any;
      try { e = JSON.parse(line); } catch { return true; }
      if (!e || typeof e !== "object") return true;
      if (e.type === "session") {
        if (typeof e.id === "string" && e.id) id = e.id;
        if (typeof e.cwd === "string") cwd = e.cwd;
        return true;
      }
      if (e.type === "session_info") {
        if (e.name) name = String(e.name).trim() || name;
        return true;
      }
      if (e.type !== "message" && e.type !== "custom_message") return true;
      const raw = e.type === "message" ? msgText(e.message) : msgText(e);
      if (!raw) return true;
      if (!firstMessage && e.type === "message" && e.message && e.message.role === "user") {
        const t = raw.trim();
        if (t) firstMessage = t.slice(0, 80);
      }
      const text = raw.length > L.bodySearchEntryTextMax ? raw.slice(0, L.bodySearchEntryTextMax) : raw;
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) return true;
      if (matchCount < L.bodySearchMatchesPerSession) matchCount++;
      if (snippets.length < L.bodySearchSnippetsPerSession) {
        let start = Math.max(0, at - 60);
        if (at - start + needle.length > L.bodySearchSnippetChars) start = Math.max(0, at + needle.length - L.bodySearchSnippetChars);
        const snippet = text.slice(start, start + L.bodySearchSnippetChars).replace(/\s+/g, " ").trim();
        if (snippet) snippets.push(typeof e.id === "string" && e.id ? { text: snippet, entryId: e.id } : { text: snippet });
      }
      // 命中计数与 snippet 都到顶、且名字已捡到：这个文件剩下的行不可能再改变结果，
      // 提前收尾（不算 stopped——按协议上限，结果已经完整）。名字没捡到时继续走，
      // session_info 常在尾段；字节照样计入预算，预算到限仍会停。
      if (name && matchCount >= L.bodySearchMatchesPerSession && snippets.length >= L.bodySearchSnippetsPerSession) return false;
      return true;
    };

    const stream = fs.createReadStream(p);
    const decoder = new StringDecoder("utf8");
    let pending = "";        // 当前行已解码、尚未成行的部分
    let pendingBytes = 0;    // pending 的字节数（与 lineMax 同口径计账）
    let discarding = false;  // 当前行已超限：丢弃其剩余字节直到下一个换行
    try {
      for await (const chunk of stream) {
        addBytes((chunk as Buffer).length);
        if (budgetHit()) { stopped = true; break; }
        let rest: string = decoder.write(chunk as Buffer);
        for (;;) {
          const nl = rest.indexOf("\n");
          if (discarding) {
            if (nl < 0) { rest = ""; break; }
            discarding = false;
            rest = rest.slice(nl + 1);
            continue;
          }
          if (nl < 0) {
            if (rest) {
              const n = Buffer.byteLength(rest, "utf8");
              if (pendingBytes + n > lineMax) {
                lineSkipped = true;
                discarding = true;
                pending = "";
                pendingBytes = 0;
              } else {
                pending += rest;
                pendingBytes += n;
              }
            }
            break;
          }
          const seg = rest.slice(0, nl);
          rest = rest.slice(nl + 1);
          if (pendingBytes + Buffer.byteLength(seg, "utf8") > lineMax) {
            lineSkipped = true;
            pending = "";
            pendingBytes = 0;
            continue;
          }
          let line = pending + seg;
          pending = "";
          pendingBytes = 0;
          if (line.endsWith("\r")) line = line.slice(0, -1); // \r\n 与旧 readline(crlfDelay) 同口径
          if (!handleLine(line)) { finished = true; break; }
        }
        if (finished) break;
      }
      if (!stopped && !finished) {
        // 文件末尾：解码器残余 + 没有换行收尾的最后一行
        const tail = decoder.end();
        if (!discarding) {
          if (tail) {
            const n = Buffer.byteLength(tail, "utf8");
            if (pendingBytes + n > lineMax) { lineSkipped = true; pending = ""; pendingBytes = 0; }
            else { pending += tail; pendingBytes += n; }
          }
          if (pending) handleLine(pending);
        }
      }
    } catch {
      // 读到一半文件被删/换：已命中的照常回、不整单失败，但这文件没扫完——置 stopped
      // 让上层标 truncated。哪怕它是最后一个文件（已扫计数兜底判断不到）也不假装搜全。
      stopped = true;
    } finally {
      try { stream.destroy(); } catch {}
    }
    if (lineSkipped) stopped = true;
    return { id, cwd, name, firstMessage, matchCount, snippets, stopped };
  }

  cmdGetForkMessages() {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getEntries !== "function") return { messages: [] };
    const out: any[] = [];
    for (const e of sm.getEntries() || []) {
      if (e && e.type === "message" && e.message && e.message.role === "user") {
        const t = msgText(e.message).trim();
        if (t) out.push({ entryId: e.id, text: t.slice(0, 120) });
      }
    }
    return { messages: out };
  }

  /** 会话树。默认节点里的 entry 只给轻量字段（id/parentId/type/timestamp/role/preview/customType）：
   *  完整条目让结果随会话线性增长（长会话轻松超过单帧上限），树导航也用不到正文。
   *  args.full=true 时给完整条目（图片照例降级）。 */
  cmdGetTree(args?: any) {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getTree !== "function") return { tree: [], leafId: null };
    let r: any = null;
    try { r = sm.getTree(); } catch (e: any) { return { tree: [], leafId: null, error: e?.message }; }
    const raw = Array.isArray(r) ? r : (r && r.tree) || [];
    const leafId = r && r.leafId !== undefined ? r.leafId : (typeof sm.getLeafId === "function" ? sm.getLeafId() : null);
    const full = !!(args && args.full);
    const lite = (e: any) => {
      if (!e || typeof e !== "object") return e;
      const o: any = { id: e.id, parentId: e.parentId ?? null, type: e.type, timestamp: e.timestamp };
      const m = e.type === "message" ? e.message : null;
      if (m && m.role) o.role = m.role;
      if (e.customType) o.customType = e.customType;
      const text = m ? msgText(m) : typeof e.summary === "string" ? e.summary : e.type === "custom_message" ? msgText(e) : "";
      if (text) o.preview = text.trim().slice(0, 120);
      return o;
    };
    // 重建节点（不改 pi 返回的对象）。显式栈先序遍历：树深度 = 分支长度，长会话递归会爆栈
    const tree: any[] = [];
    const byId = new Map<string, any>();
    const st: { list: any[]; i: number; dest: any[] }[] = [{ list: raw, i: 0, dest: tree }];
    while (st.length) {
      const top = st[st.length - 1];
      if (top.i >= top.list.length) { st.pop(); continue; }
      const nd = top.list[top.i++];
      if (!nd || typeof nd !== "object") continue;
      const node: any = { ...nd, entry: full ? shrinkEntryDeep(nd.entry) : lite(nd.entry), children: [] };
      top.dest.push(node);
      const id = nd.entry && nd.entry.id ? String(nd.entry.id) : null;
      if (id) byId.set(id, node);
      if (Array.isArray(nd.children) && nd.children.length) st.push({ list: nd.children, i: 0, dest: node.children });
    }
    // 活动路径（root → leaf 的 entry id 链）：pi 的 get_tree 不给 isOnActivePath，这里服务端算好
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: any = leafId ? byId.get(String(leafId)) : null;
    let guard = 0;
    while (cur && guard++ < 1000000) {
      const id = String(cur.entry.id);
      path.push(id);
      onPath.add(id);
      const pid = cur.entry.parentId;
      cur = pid ? byId.get(String(pid)) : null;
    }
    path.reverse();
    for (const [id, node] of byId) node.onPath = onPath.has(id);
    return { tree, leafId: leafId ?? null, path };
  }

  /** pi 的会话目录（路径监狱的基准） */
  sessionDir(): string | null {
    try {
      const sm = this.ctx && this.ctx.sessionManager;
      const dir = sm && typeof sm.getSessionDir === "function" ? sm.getSessionDir() : null;
      return dir && fs.existsSync(dir) ? String(dir) : null;
    } catch {
      return null;
    }
  }

  /** 路径监狱：把任意输入收敛成 sessionDir 内的绝对 .jsonl 路径，越界即抛错 */
  jailSessionPath(p: string): string {
    const np = require("node:path");
    const base = this.sessionDir();
    if (!base) throw new RemoteError("not_ready", "拿不到会话目录，拒绝切换会话");
    const abs = np.resolve(p);
    const b = np.resolve(base);
    // Windows 盘符/目录大小写可能不同（pi 给的 D:\Users\...，调用方传 d:\users\...），macOS 同样不分大小写：统一小写后再比，别把合法路径判越界
    const ci = caseInsensitivePaths(this.platform);
    const absC = ci ? abs.toLowerCase() : abs;
    const bC = ci ? b.toLowerCase() : b;
    if (absC !== bC && !absC.startsWith(bC + np.sep.toLowerCase())) throw new RemoteError("bad_args", "会话路径越界（必须在 " + base + " 内）");
    if (!abs.toLowerCase().endsWith(".jsonl")) throw new RemoteError("bad_args", "只支持 .jsonl 会话文件");
    // existsSync 会把 EACCES 也当成“不存在”：先 stat，权限错误要原样报出来。
    let st: any;
    try { st = fs.statSync(abs); } catch (e: any) {
      if (e && e.code === "ENOENT") throw new RemoteError("not_found", "会话文件不存在：" + abs);
      throw sessionFileError(e, "读取会话文件");
    }
    if (!st.isFile()) throw new RemoteError("bad_args", "不是普通会话文件：" + abs);
    // 符号链接可能在 sessionDir 内指向外面：真实路径也必须在监狱内。
    try {
      const realAbs = fs.realpathSync(abs);
      const realBase = fs.realpathSync(b);
      const ra = ci ? realAbs.toLowerCase() : realAbs;
      const rb = ci ? realBase.toLowerCase() : realBase;
      if (ra !== rb && !ra.startsWith(rb + np.sep.toLowerCase())) throw new RemoteError("bad_args", "会话路径越界（符号链接指向 " + realAbs + "）");
    } catch (e: any) {
      if (e instanceof RemoteError) throw e;
      throw sessionFileError(e, "检查会话路径");
    }
    return abs;
  }

  /** 轻量解析会话标识（id 或名字 → path）：先按文件名匹配（文件名含 sessionId），命中不了再限量扫内容 */
  resolveSession(q: string): any {
    const sm = this.ctx && this.ctx.sessionManager;
    const dir = sm && typeof sm.getSessionDir === "function" ? sm.getSessionDir() : null;
    if (!dir || !fs.existsSync(dir)) return null;
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((f: string) => f.endsWith(".jsonl")); } catch { return null; }
    const byName = names.find((f) => f.replace(/\.jsonl$/, "") === q || f === q || f.replace(/\.jsonl$/, "").endsWith("_" + q));
    if (byName) return { path: require("node:path").join(dir, byName).replace(/\\/g, "/") };
    // 名字匹配：只扫最近 NAME_SCAN_FILES 个会话（原实现循环体不用 ent 且首轮 break = 死循环，
    // 且每次调用都读最多 500 个文件，聚合可达 ~128MB 同步读，堵住命令通道）
    try {
      const ents = names
        .map((f: string) => ({ f, m: fs.statSync(require("node:path").join(dir, f)).mtimeMs }))
        .sort((a: any, b: any) => b.m - a.m)
        .slice(0, NAME_SCAN_FILES);
      for (const ent of ents) {
        const one = this.parseSessionFile(require("node:path").join(dir, ent.f), null);
        if (one && one.name === q) return one;
      }
    } catch {}
    return null;
  }

  /** 累计用量/费用/上下文——**与 pi 官方记账口径一致**（session-format.md 的 UsageEntry/
   *  CompactionEntry/BranchSummaryEntry + rpc-commands.md §get_session_stats）：
   *   1）任何带 usage 的消息（assistant + toolResult——工具嵌套调用的用量计入工具结果）
   *   2）usage 条目（cache_warm 等非消息用量，按 kind 拆分，未知 kind 照常计入）
   *   3）compaction / branch_summary 条目的 usage（生成摘要的消耗）
   *  4）contextUsage 取官方 ctx.getContextUsage()（= 压缩阈值与 footer 用的同一份估计） */
  buildUsage() {
    const sm = this.ctx && this.ctx.sessionManager;
    const entries = sm && typeof sm.getEntries === "function" ? sm.getEntries() || [] : [];
    const u: any = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      usageByKind: {} as Record<string, any>,
      costByModel: {} as Record<string, number>,
    };
    const add = (x: any) => {
      if (!x || typeof x !== "object") return;
      u.tokens.input += Number(x.input) || 0;
      u.tokens.output += Number(x.output) || 0;
      u.tokens.cacheRead += Number(x.cacheRead) || 0;
      u.tokens.cacheWrite += Number(x.cacheWrite) || 0;
      u.tokens.total += Number(x.totalTokens) || 0;
      u.cost += Number((x.cost && x.cost.total) || 0) || 0;
    };
    const byKind = (kind: any, x: any) => {
      const k = String(kind || "unknown");
      const slot = u.usageByKind[k] || (u.usageByKind[k] = { count: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
      slot.count += 1;
      slot.tokens.input += Number(x.input) || 0;
      slot.tokens.output += Number(x.output) || 0;
      slot.tokens.cacheRead += Number(x.cacheRead) || 0;
      slot.tokens.cacheWrite += Number(x.cacheWrite) || 0;
      slot.tokens.total += Number(x.totalTokens) || 0;
      slot.cost += Number((x.cost && x.cost.total) || 0) || 0;
    };
    const byModel = (provider: any, model: any, x: any) => {
      const key = String(provider || "?") + "/" + String(model || "?");
      u.costByModel[key] = (u.costByModel[key] || 0) + (Number((x && x.cost && x.cost.total) || 0) || 0);
    };
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      if (e.type === "message" && e.message) {
        const m = e.message;
        if (m.usage) { add(m.usage); byModel(m.provider || e.provider, m.model, m.usage); }
      } else if (e.type === "usage" && e.usage) {
        add(e.usage); byKind(e.kind, e.usage); byModel(e.provider, e.model, e.usage);
      } else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
        add(e.usage); byKind(e.type, e.usage);
      }
    }
    if (this.ctx && typeof this.ctx.getContextUsage === "function") {
      try { const cu = this.ctx.getContextUsage(); if (cu) u.contextUsage = cu; } catch {}
    }
    return u;
  }

  /** 推送实时用量帧（终端 footer 的服务器版：累计 tokens/费用/缓存/上下文）。
   *  去重：payload 与上次完全相同就不发（agent_settled 紧跟 message_end 时不重复帧）。 */
  pushUsage(_reason?: string) {
    if (!this.roomId) return;
    // 有 message_end 在等图片地址：用量帧不能插到它前面，等同一批放行后再发。
    if (this.pendingImageAddress) {
      this.pendingImageAddress.afterUsage = true;
      return;
    }
    try {
      const usage = this.buildUsage();
      const payload = JSON.stringify(usage);
      if (payload === this._lastUsagePayload) return;
      // 没发出去（断线/背压）就不记：否则这次变化永远补不上
      if (this.send({ type: "usage", room: this.roomId, usage })) this._lastUsagePayload = payload;
    } catch (e: any) {
      log("用量推送失败:", e?.message);
    }
  }

  cmdGetSessionStats() {
    const sm = this.ctx && this.ctx.sessionManager;
    const entries = sm && typeof sm.getEntries === "function" ? sm.getEntries() || [] : [];
    const st: any = {
      sessionFile: sm && sm.sessionFile ? sm.sessionFile : null,
      sessionId: sm && sm.sessionId ? sm.sessionId : null,
      userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
    };
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      if (e.type === "message" && e.message) {
        const m = e.message;
        st.totalMessages++;
        if (m.role === "user") st.userMessages++;
        else if (m.role === "assistant") {
          st.assistantMessages++;
          if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === "toolCall") st.toolCalls++;
        } else if (m.role === "toolResult") st.toolResults++;
      }
    }
    // 用量/费用/上下文/拆分：与实时 usage_state 帧同一口径（buildUsage）
    Object.assign(st, this.buildUsage());
    return st;
  }

  /** 当前会话 cwd：优先 sessionManager（getCwd / cwd），再退回 bindSession 记下的值。
   *  **不退回 process.cwd()**：那可能是 pi 进程启动目录，不是当前会话目录，拿来限定文件会放宽边界。 */
  sessionCwd(): string | null {
    try {
      const sm = this.ctx && this.ctx.sessionManager;
      if (sm && typeof sm.getCwd === "function") {
        const cwd = sm.getCwd();
        if (cwd) return String(cwd);
      }
    } catch {}
    if (this.cwd) return String(this.cwd);
    try {
      if (this.ctx && this.ctx.cwd) return String(this.ctx.cwd);
    } catch {}
    return null;
  }

  /** get_file：只读当前会话 cwd 内的普通文件；路径/符号链接越界、二进制、超大图片明确报码。 */
  cmdGetFile(args: any) {
    return readFileInRoot(this.sessionCwd(), args && args.path, this.platform);
  }

  /** 当前会话某条目的内容块（只认 getEntry/byId 能定位到的活条目，不跨会话扫描）。 */
  private entryContentBlocks(entryId: string): { entry: any; blocks: any[] } {
    const sm = this.ctx && this.ctx.sessionManager;
    if (!sm) throw new RemoteError("not_ready", "无法读取会话条目");
    let entry: any = null;
    try { entry = typeof sm.getEntry === "function" ? sm.getEntry(entryId) : null; } catch {}
    if (!entry && sm.byId && typeof sm.byId.get === "function") {
      try { entry = sm.byId.get(entryId); } catch {}
    }
    if (!entry) throw new RemoteError("not_found", "找不到条目：" + entryId);
    // 会话条目里的图片在 message.content 里；兼容部分路径直接给 entry.content。
    // 没有数组就不猜位置——blockIndex 不能稳定定位时明确报错，绝不伪造。
    const blocks = entry.type === "message" && entry.message && Array.isArray(entry.message.content)
      ? entry.message.content
      : Array.isArray(entry.content) ? entry.content : null;
    if (!blocks) throw new RemoteError("not_found", "条目没有可按 blockIndex 寻址的内容块：" + entryId);
    return { entry, blocks };
  }

  /** get_image：按 entryId + blockIndex 从当前会话条目读原图，绕过 projectEvent/shrinkDeep 的图片降级。
   *  超单帧回图上限时返回压缩占位并标 compressed:true；索引/条目/类型不明确一律报协议码。 */
  cmdGetImage(args: any) {
    const entryId = args && typeof args.entryId === "string" ? args.entryId.trim() : "";
    if (!entryId) throw new RemoteError("bad_args", "get_image 需要 entryId");
    const rawIndex = args && args.blockIndex;
    const blockIndex = typeof rawIndex === "number"
      ? rawIndex
      : typeof rawIndex === "string" && rawIndex.trim() !== "" ? Number(rawIndex) : NaN;
    if (!Number.isInteger(blockIndex) || blockIndex < 0) {
      throw new RemoteError("bad_args", "get_image 需要非负整数 blockIndex");
    }
    const { blocks } = this.entryContentBlocks(entryId);
    if (blockIndex >= blocks.length) {
      throw new RemoteError("not_found", "内容块不存在：blockIndex=" + blockIndex + "（共 " + blocks.length + " 块）");
    }
    const block = blocks[blockIndex];
    if (!block || typeof block !== "object" || block.type !== "image") {
      throw new RemoteError("bad_args", "第 " + blockIndex + " 个内容块不是图片");
    }
    if (typeof block.data !== "string" || !block.data) {
      throw new RemoteError("not_found", "该图片块没有可读的 base64 数据");
    }
    const mimeType = typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "image/png";
    const bytes = Math.floor((block.data.length * 3) / 4);
    if (block.data.length > IMAGE_RETURN_MAX_CHARS) {
      return {
        entryId,
        blockIndex,
        mimeType,
        bytes,
        data: "",
        omitted: true,
        omittedBytes: bytes,
        compressed: true,
      };
    }
    return { entryId, blockIndex, mimeType, bytes, data: block.data, compressed: false };
  }

  /** get_host_diag：一屏诊断。不执行外部命令；pi 版本只读 package.json，日志只读扩展自己的文件。 */
  cmdGetHostDiag() {
    const attach = attachDiagState();
    // 以 Bridge 实际使用的窗口判定为准（测试可替换 gateOpen；生产与 attachDiagState 同源）
    try { attach.active = this.gateOpen(); } catch {}
    return {
      piVersion: readPiVersion(process.argv[1]),
      nodeVersion: process.version,
      platform: platformId(process.platform),
      arch: process.arch,
      extensionVersion: EXT_VERSION,
      attach,
      // dialog tap 健康度：自检判失效（回退信号模式）在这里可见，见定版说明第一部分 §1
      tap: { state: this.tapState, captures: this.tapCaptures, missed: this.tapMissed, open: this.tapOpenDialogs.size },
      recentErrors: diagRecentErrors.map((e) => (e.code ? { at: e.at, message: e.message, code: e.code } : { at: e.at, message: e.message })),
      logTail: readLogTail(),
    };
  }

  /** 会话操作参数归一化：**远端命令与手动 /pi-remote 必须走同一条路**，
   *  否则两条路径的默认值/校验会漂移（手动 fork 不带参曾传 null，与远端行为不一致）。 */
  normalizeOpArgs(kind: string, raw: any): any {
    const a = raw || {};
    if (kind === "new_session") return a.parentSession ? { parentSession: String(a.parentSession) } : {};
    if (kind === "switch_session") {
      let p = String(a.sessionPath || a.path || a.sessionId || a.id || "").trim();
      if (!p) throw new RemoteError("bad_args", "switch_session 需要 sessionPath（先用 list_sessions 拿路径）");
      if (!/\.jsonl$/i.test(p)) {
        const hit = this.resolveSession(p);
        if (!hit) throw new RemoteError("not_found", "找不到会话：" + p + "（用 list_sessions 拿可用会话）");
        p = hit.path;
      }
      // 路径监狱：无论直接传 .jsonl 还是经 resolveSession 解析，最终文件必须落在 sessionDir 内
      return { sessionPath: this.jailSessionPath(p) };
    }
    if (kind === "fork") {
      let entryId = a.entryId ? String(a.entryId) : "";
      if (!entryId) {
        const ms = this.cmdGetForkMessages().messages;
        if (!ms.length) throw new RemoteError("not_found", "会话中没有 user 消息可 fork");
        entryId = ms[ms.length - 1].entryId; // 默认 fork 最后一条 user 消息
      }
      return { entryId };
    }
    if (kind === "navigate_tree") {
      let targetId = String(a.targetId || a.entryId || "").trim();
      if (!targetId) {
        // 不带参时默认跳到当前叶（等价于"刷新到模型当前所见"），与远端语义一致
        const tree = this.cmdGetTree();
        if (!tree || !tree.leafId) throw new RemoteError("bad_args", "navigate_tree 需要 targetId（用 get_tree 拿节点 id）");
        targetId = String(tree.leafId);
      }
      const out: any = { targetId };
      // 与 pi 的 navigateTree(targetId, {summarize}) 同名参数；只有明确 true 才生成摘要，
      // 缺省/旧客户端保持原来的直接跳转（不伪造上游没有的默认值）。
      if (a.summarize === true) out.summarize = true;
      return out;
    }
    if (kind === "clone") return {};
    throw new RemoteError("unsupported", "不支持的操作：" + kind);
  }

  /** 换会话或跳树前先等当前回答停下来。空闲时不调用 abort。
   *  正在输出时走现有 cmdAbort（内部最多等 10 秒）；到点仍不空闲就报 busy，调用方不得改会话。
   *  压缩中跳树会和摘要写入打架：直接报 busy，不 abort，不写分支摘要。 */
  async settleBeforeSessionOp(kind: string): Promise<void> {
    if (kind === "navigate_tree" && this.compacting) {
      throw new RemoteError("busy", "pi 正在压缩上下文，不能跳转");
    }
    if (this.isIdleNow()) return;
    await this.cmdAbort();
    if (!this.isIdleNow()) throw new RemoteError("busy", "会话仍在输出，未切换");
  }

  /** ================= 会话操作：直接执行，无需本机确认 ================= */
  /** 远端命令与终端里输命令**完全等价**：直接改 SessionManager，不排队、不要求本机按键。
   *
   *  背景：早先以为"pi 的会话替换 API 只在命令上下文可用"，于是做成
   *  "远程入队 → 本机按 Ctrl+Alt+S → 才真执行"。实测（见 tests/probe3-ext.ts）：
   *  `ctx.sessionManager` 上本来就有 newSession/setSessionFile/createBranchedSession/branch，
   *  在 WebSocket 回调这种**非 pi 生命周期**的上下文里直接调用完全不会死锁，
   *  而且运行时确实跟着切（下一条 prompt 落进新会话/新分支），与终端行为一致。
   *
   *  注意：这些操作**不会触发 session_start**，所以完成后必须自己重新绑定房间 + 推快照，
   *  否则镜像还停在旧会话/旧分支上。 */
  /** 找 pi 的公开 navigateTree：命令上下文（ExtensionCommandContext）优先；AgentSession / 未来
   *  可能挂到 ctx 上的同名额也可用。事件/WS 回调的普通 ExtensionContext 在 pi 1.3 没有该方法，
   *  返回 null 时由调用方走等价的手动实现（不会伪造钩子）。 */
  resolveNavigateTree(commandCtx?: any): ((targetId: string, options?: any) => Promise<any>) | null {
    let ctxSm: any = null;
    try { ctxSm = this.ctx && this.ctx.sessionManager; } catch {}
    const owners: any[] = [commandCtx, this.ctx, ctxSm, this.pi];
    for (const owner of owners) {
      if (!owner) continue;
      try {
        if (typeof owner.navigateTree === "function") {
          return (targetId: string, options?: any) => owner.navigateTree(targetId, options);
        }
        const session = owner.session || owner.agentSession;
        if (session && typeof session.navigateTree === "function") {
          return (targetId: string, options?: any) => session.navigateTree(targetId, options);
        }
      } catch {
        // getter 在 runtime 失效时可能抛：换下一个候选
      }
    }
    return null;
  }

  /** pi navigateTree 抛出的错误 → 协议错误码。保持真实原因，不把“没模型”伪装成内部错误。 */
  navigateTreeError(e: any): RemoteError {
    if (e instanceof RemoteError) return e;
    const msg = String((e && e.message) || e || "未知错误");
    if (/no model/i.test(msg)) return new RemoteError("no_model", "pi 未选择模型，无法生成分支摘要；可改用直接跳转");
    if (/not found/i.test(msg)) return new RemoteError("not_found", "找不到要跳转的节点");
    if (/wait for the current|compaction|navigat.*finish|streaming/i.test(msg)) return new RemoteError("busy", msg);
    if (/abort|cancel/i.test(msg)) return new RemoteError("timeout", "分支摘要已中止，未跳转");
    return new RemoteError("internal", "跳转失败：" + msg);
  }

  async runSessionOp(kind: string, args: any, commandCtx?: any): Promise<any> {
    if (kind === "navigate_tree" && this.compacting) {
      throw new RemoteError("busy", "pi 正在压缩上下文，不能跳转");
    }
    const opArgs = this.normalizeOpArgs(kind, args || {});
    const sm: any = this.ctx && this.ctx.sessionManager;
    if (!sm) throw new RemoteError("not_ready", "当前上下文不可用（runtime 可能已失效），请重试");
    await this.settleBeforeSessionOp(kind);
    const before = this.safeRead(() => (sm.getSessionFile ? String(sm.getSessionFile()) : null), null);
    const norm = (p: any) => (p ? String(p).replace(/\\/g, "/") : null);

    if (kind === "navigate_tree" && opArgs.summarize) {
      // 优先走 pi 的公开 navigateTree：它内部会发 session_before_tree / session_tree，
      // 其他扩展的钩子与终端 /tree 自然一致。pi 1.3 只在命令上下文/AgentSession 上暴露它，
      // 事件/WS 回调的 ctx 没有；拿不到才走下面的等价手动实现（说明见报告）。
      const navigate = this.resolveNavigateTree(commandCtx);
      if (navigate) {
        let result: any;
        try {
          result = await navigate(opArgs.targetId, { summarize: true });
        } catch (e: any) {
          throw this.navigateTreeError(e);
        }
        if (result && result.cancelled) {
          // 摘要被中止（aborted）不是“用户取消跳转”：沿用扩展原来的 timeout 语义，别伪装成已跳转。
          if (result.aborted) throw new RemoteError("timeout", "分支摘要已中止，未跳转");
          return { ok: true, cancelled: true, kind, sessionFile: norm(before), summarize: true, summary: false };
        }
        // 成功换代由 pi 的 session_tree 事件驱动（forward 里 bumpEpoch），这里不能再 bump 一次。
        const entry = result && result.summaryEntry;
        const details = entry && entry.details;
        const out: any = {
          ok: true,
          cancelled: false,
          kind,
          sessionFile: norm(before),
          summarize: true,
          summary: !!(entry && typeof entry.summary === "string" && entry.summary),
        };
        if (entry && typeof entry.summary === "string") out.summaryChars = entry.summary.length;
        if (details && Array.isArray(details.readFiles)) out.readFiles = details.readFiles.length;
        if (details && Array.isArray(details.modifiedFiles)) out.modifiedFiles = details.modifiedFiles.length;
        return out;
      }
      // 兜底：pi 版本/上下文没有公开 navigateTree。摘要算法与 AgentSession 内部一致，但钩子不会触发；
      // 生成失败时不改叶（原子性），只有 branchWithSummary 成功才换代。
      const extra = await this.navigateTreeWithSummary(opArgs.targetId);
      this.bumpEpoch("navigate_tree");
      return { ok: true, cancelled: false, kind, sessionFile: norm(before), summarize: true, ...extra };
    }

    let newFile: string | null = null;
    let forkText: string | null = null;
    if (kind === "fork") {
      // 官方 fork 返回带 text（被分叉的消息文本，rpc-commands.md §fork）：先读后建
      try {
        for (const e of sm.getEntries() || []) {
          if (e && e.id === opArgs.entryId && e.type === "message" && e.message) {
            forkText = msgText(e.message).trim() || null;
            break;
          }
        }
      } catch {}
    }
    if (kind === "new_session") {
      const r = sm.newSession(opArgs.parentSession ? { parentSession: opArgs.parentSession } : {});
      newFile = typeof r === "string" ? r : this.safeRead(() => (sm.getSessionFile ? String(sm.getSessionFile()) : null), null);
    } else if (kind === "switch_session") {
      sm.setSessionFile(opArgs.sessionPath);
      newFile = this.safeRead(() => (sm.getSessionFile ? String(sm.getSessionFile()) : null), null);
    } else if (kind === "fork") {
      const r = sm.createBranchedSession(opArgs.entryId);
      newFile = typeof r === "string" ? r : this.safeRead(() => (sm.getSessionFile ? String(sm.getSessionFile()) : null), null);
    } else if (kind === "clone") {
      // pi RPC clone：把当前活动分支原样复制进一个新会话。
      // pi 的对应原语就是 createBranchedSession(当前叶)（probe 实测存在）。
      const leaf = typeof sm.getLeafId === "function" ? this.safeRead(() => sm.getLeafId(), null) : null;
      if (!leaf) throw new RemoteError("not_found", "当前会话为空，无法 clone");
      const r = sm.createBranchedSession(leaf);
      newFile = typeof r === "string" ? r : this.safeRead(() => (sm.getSessionFile ? String(sm.getSessionFile()) : null), null);
    } else if (kind === "navigate_tree") {
      sm.branch(opArgs.targetId); // 同一会话，只把活动叶切到目标节点
    } else {
      throw new RemoteError("unsupported", "不支持的操作：" + kind);
    }

    const beforeN = norm(before);
    const afterN = norm(newFile);

    if (kind === "navigate_tree") {
      // 换分支：房间 id 与会话文件都不变，但内容全变 → 换代（relay reset 存储 → 回 0 条 → 推新分支全量）
      this.bumpEpoch("navigate_tree");
      return { ok: true, cancelled: false, kind, sessionFile: beforeN };
    }

    // 换会话：旧房间下线 → 重新绑定（读新 sessionId → 注册新房 → 对齐镜像）
    if (beforeN && afterN && beforeN !== afterN) {
      this.flushPending();
      this.send({ type: "room_closed", room: this.roomId }, { essential: true });
    }
    try {
      this.bindSession(this.ctx);
    } catch (e: any) {
      log("换会话后重新绑定失败:", e?.message);
    }
    const out: any = { ok: true, cancelled: false, kind, sessionFile: afterN || beforeN };
    if (kind === "fork" && forkText) out.text = forkText;
    return out;
  }

  /** 跳树并总结被放弃的分支（**兜底路径**：仅当 resolveNavigateTree() 拿不到公开 API 时使用）。
   *
   *  pi 1.3 的 AgentSession.navigateTree(targetId, {summarize}) 只通过 ExtensionCommandContext /
   *  AgentSession 暴露，事件 ctx 与 WebSocket 回调里没有这个方法。此时这里直接调用 pi 导出的
   *  collectEntriesForBranchSummary + generateBranchSummary（与 AgentSession 内部同一条实现），
   *  成功后用 SessionManager.branchWithSummary 落一条 branch_summary。
   *
   *  已知差异：这条兜底路径不会触发其他扩展的 session_before_tree / session_tree 钩子（没有公开的
   *  emit 入口，无法在不改 pi 的前提下手动触发）；能拿到公开 API 时走上面的 navigateTree。
   *
   *  与终端 /tree 的差异：终端选中 user message 时会把叶移到它的 parent 并把原文放回编辑器；
   *  本扩展的历史语义一直是“叶移到所选节点”，这里保持该语义，只额外附加摘要，避免同类节点
   *  在“直接跳转/跳转并总结”两种模式下落到不同位置。
   */
  async navigateTreeWithSummary(targetId: string): Promise<any> {
    const sm: any = this.ctx && this.ctx.sessionManager;
    if (!sm || typeof sm.getLeafId !== "function" || typeof sm.branchWithSummary !== "function" || typeof sm.getEntry !== "function") {
      throw new RemoteError("not_ready", "当前上下文不支持带摘要的跳转");
    }
    const target = this.safeRead(() => sm.getEntry(targetId), null);
    if (!target) throw new RemoteError("not_found", "找不到要跳转的节点：" + targetId);
    const oldLeaf = this.safeRead(() => sm.getLeafId(), null);
    if (oldLeaf && String(oldLeaf) === String(targetId)) return { summary: false, noop: true };

    const pkg = await this.loadPiPackage();
    const collect = pkg && typeof pkg.collectEntriesForBranchSummary === "function" ? pkg.collectEntriesForBranchSummary : null;
    const generate = pkg && typeof pkg.generateBranchSummary === "function" ? pkg.generateBranchSummary : null;
    if (!collect || !generate) {
      throw new RemoteError("unsupported", "当前 pi 版本没有分支摘要接口（需要 collectEntriesForBranchSummary / generateBranchSummary）；请升级 pi，或改用直接跳转");
    }
    let entries: any[] = [];
    try {
      const prep = collect(sm, oldLeaf, targetId);
      entries = prep && Array.isArray(prep.entries) ? prep.entries : [];
    } catch (e: any) {
      throw new RemoteError("internal", "收集待总结分支失败：" + String((e && e.message) || e));
    }
    if (!entries.length) {
      // 没有可总结的条目（例如旧叶为空），仍然完成跳转，不能把“没摘要”当成“已成功总结”。
      try { sm.branch(targetId); } catch (e: any) {
        throw new RemoteError("internal", "跳转失败：" + String((e && e.message) || e));
      }
      return { summary: false, noop: false };
    }

    const model = this.ctx ? this.ctx.model : null;
    if (!model) throw new RemoteError("no_model", "pi 未选择模型，无法生成分支摘要；可改用直接跳转");

    // 认证与 pi 内部同源：模型注册表按 provider 解析；拿不到就交给 provider 自己的环境变量。
    let auth: any = {};
    try {
      const registry: any = this.ctx ? this.ctx.modelRegistry : null;
      if (registry && typeof registry.getApiKeyAndHeaders === "function") {
        const resolved = await registry.getApiKeyAndHeaders(model);
        if (resolved && resolved.ok) auth = resolved;
      }
    } catch (e: any) {
      log("分支摘要取认证失败（继续尝试环境变量）:", e?.message);
    }

    // relay 对 summarize 的 timeout 是 120s；这里留 10s 余量，超时就中止且不写摘要。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 110000);
    if (timer.unref) timer.unref();
    let result: any = null;
    try {
      result = await generate(entries, {
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: ac.signal,
      });
    } catch (e: any) {
      if (ac.signal.aborted) throw new RemoteError("timeout", "分支摘要超时，未跳转");
      throw new RemoteError("internal", "生成分支摘要失败：" + String((e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
    if (ac.signal.aborted || (result && result.aborted)) throw new RemoteError("timeout", "分支摘要已中止，未跳转");
    if (result && result.error) throw new RemoteError("internal", "生成分支摘要失败：" + String(result.error));
    const summary = String((result && result.summary) || "").trim();
    if (!summary) throw new RemoteError("internal", "分支摘要为空，未跳转");

    try {
      sm.branchWithSummary(targetId, summary, {
        readFiles: Array.isArray(result.readFiles) ? result.readFiles : [],
        modifiedFiles: Array.isArray(result.modifiedFiles) ? result.modifiedFiles : [],
      }, false, result.usage);
    } catch (e: any) {
      throw new RemoteError("internal", "写入分支摘要失败：" + String((e && e.message) || e));
    }
    return {
      summary: true,
      summaryChars: summary.length,
      readFiles: Array.isArray(result.readFiles) ? result.readFiles.length : 0,
      modifiedFiles: Array.isArray(result.modifiedFiles) ? result.modifiedFiles.length : 0,
    };
  }

  /** 手动入口 /pi-remote：与远端命令走同一个 runSessionOp，行为完全一致 */
  async runManualOp(manualArgs: string, cmdCtx: any): Promise<any> {
    const m = String(manualArgs || "").trim();
    if (!m) {
      this.notifySafe(cmdCtx, `用法：/pi-remote [new | switch <路径> | fork [entryId] | goto <entryId>]`, "warning");
      return { ok: false, error: "缺少参数" };
    }
    const sp = m.split(/\s+/);
    const kind = sp[0];
    const rest = sp.slice(1).join(" ").trim();
    try {
      // 命令上下文（ExtensionCommandContext）里有 pi 的公开 navigateTree；传给 runSessionOp，
      // 让手动 /pi-remote goto 与终端一样触发 session_before_tree / session_tree。
      if (kind === "new" || kind === "new_session") return await this.runSessionOp("new_session", {}, cmdCtx);
      if (kind === "switch" || kind === "switch_session" || kind === "resume") {
        if (!rest) throw new Error("用法：/pi-remote switch <sessionPath 或会话 id>");
        return await this.runSessionOp("switch_session", { sessionPath: rest }, cmdCtx);
      }
      if (kind === "fork") return await this.runSessionOp("fork", { entryId: rest || undefined }, cmdCtx);
      if (kind === "goto" || kind === "navigate_tree") {
        if (!rest) throw new Error("用法：/pi-remote goto <entryId>");
        return await this.runSessionOp("navigate_tree", { targetId: rest }, cmdCtx);
      }
      throw new Error("用法：/pi-remote [new | switch <路径> | fork [entryId] | goto <entryId>]");
    } catch (e: any) {
      this.notifySafe(cmdCtx, String((e && e.message) || e), "error");
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  notifySafe(ctx: any, text: string, level?: string) {
    const ui = (ctx && ctx.ui) || (this.ctx && this.ctx.ui);
    if (!ui || typeof ui.notify !== "function") return;
    try {
      const r = ui.notify(text, level || "info");
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {}
  }

  notifyRemote(text: string) {
    const ui = this.ctx && this.ctx.ui;
    if (!ui || typeof ui.notify !== "function") return;
    try {
      const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      const r = ui.notify(`📱 远程消息：${short}`, "info");
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {}
  }
}

export default function (pi: any) {
  const bridge = new Bridge();
  bridge.pi = pi;

  if (!RELAY_URL || (!TOKEN && !HAS_DEVICE_TOKEN)) {
    // 未配置时扩展完全不干活，pi 行为零影响
    return;
  }

  // 远端会话操作已改为直接执行（与终端等价），不再需要本机确认快捷键。
  try {
    pi.registerCommand("pi-remote", {
    description: `会话操作（与终端等价，直接执行）；手动：/pi-remote [new|switch <路径>|fork [entryId]|goto <entryId>]`,
    handler: async (args: string, ctx: any) => { await bridge.runManualOp(args, ctx); },
    });
  } catch (e: any) {
    log("注册 pi-remote 命令失败:", e?.message);
  }

  for (const name of FORWARD_EVENTS) {
    try {
      pi.on(name, (event: any, ctx: any) => {
        if (ctx) bridge.ctx = ctx;
        if (BUSY_ON.has(name)) bridge.setBusy(true);
        bridge.forward(event);
        // 观察型钩子必须返回 undefined：session_before_compact 返回对象会取消或替换压缩
        return undefined;
      });
    } catch (e: any) {
      log("注册事件失败:", name, e?.message);
    }
  }

  // input 单独注册：不进 FORWARD_EVENTS，原始正文和图片不上线。返回 undefined = 不拦截、不改写。
  try {
    pi.on("input", (event: any, ctx: any) => {
      if (ctx) bridge.ctx = ctx;
      try { bridge.noteQueuedInput(event); } catch (e: any) { log("input 入队失败:", e?.message); }
      return undefined;
    });
  } catch (e: any) {
    log("注册 input 失败:", e?.message);
  }

  // 回合末纠偏：busy 只由 agent_settled 置假。若某路径只来了 message_start（非 assistant
  // 消息也会发）而没来 agent_settled，busy 会永久卡真 → compact/regenerate 永远"会话正忙"、
  // 远程消息全被静默 steer 入队。turn_end / agent_end 时用 pi 的权威空闲状态纠一次。
  try {
    pi.on("agent_settled", () => {
      bridge.setBusy(false);
      bridge.pushUsage();
      // 回合结束时 pi 冲刷挂起的 bashExecution / 自定义消息（不发 message_end）：对一次镜像
      bridge.scheduleProbe(400);
      try { bridge.noteManifestActivity(); } catch {}
    });
  } catch {}
  try {
    pi.on("turn_end", () => {
      try {
        const ctx: any = bridge.ctx;
        if (ctx && typeof ctx.isIdle === "function") bridge.setBusy(!ctx.isIdle());
      } catch {}
    });
  } catch {}
  try {
    pi.on("agent_end", (ev: any) => {
      if (ev && ev.willRetry) return; // 自动重试中：仍然忙
      try {
        const ctx: any = bridge.ctx;
        if (ctx && typeof ctx.isIdle === "function") bridge.setBusy(!ctx.isIdle());
      } catch {}
    });
  } catch {}

  try {
    pi.on("session_start", (_e: any, ctx: any) => {
      // 连接在这里才建立（不在工厂里）：`pi --list-models` 等不进会话的调用也会执行工厂
      // bindSession 内部已全兜底；这里再包一层，双保险防异常逃逸进 pi 事件分发
      try {
        bridge.start();
        bridge.bindSession(ctx);
      } catch (e: any) { log("session_start 处理失败（已忽略）:", e?.message); }
    });
  } catch (e: any) {
    log("注册 session_start 失败:", e?.message);
  }

  try {
    pi.on("session_shutdown", () => {
      // 会话关闭：先声明房间离线，再主动断线、清掉所有定时器。只发 room_closed 不断线会留下
      // 半死 socket；定时器不清，旧 runtime 还会往外发东西
      try { bridge.stop(); } catch {}
    });
  } catch {}
}


/* ================================================================================================
 * P10「使用活动」聚合（usage.activity.v1）
 *
 * 数据源：本机 pi 会话日志 `PI_CODING_AGENT_DIR|~/.pi/agent` + `/sessions/<project>/<session>.jsonl`（一个会话一个文件）。
 * 只读、只上聚合计数：**不读/不传 cost，不带正文/标题/cwd**；relay 侧缓存聚合快照（见 p10-usage-data-plan.md）。
 * 增量缓存：`<agentDir>/usage-days.json`（按文件 mtime+size 命中；时区/版本变化全量重扫）。
 * 本扩展单文件安装 → 类型镜像 ui/src/pi/usage/types.ts，由 test/usage-contract.test.mjs 防漂移。
 * ============================================================================================== */

const USAGE_ACTIVITY_VERSION = "usage.activity.v1";
const USAGE_CACHE_VERSION = 1;
const USAGE_DAYS_MAX = 400;
const USAGE_MODELS_MAX = 8;
const USAGE_MODELS_WINDOW_DAYS = 30;
const USAGE_MAX_FILES = 5000;
const USAGE_MAX_FILE_BYTES = 256 * 1024 * 1024;
const USAGE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const USAGE_CACHE_MAX_FILES = 2000;
const USAGE_PARSE_YIELD_LINES = 3000;

type UsageTokensShape = { total: number; input: number; output: number; cacheRead: number; cacheWrite: number };
type UsageMessagesShape = { user: number; assistant: number };
type UsageDayShape = { date: string; tokens: UsageTokensShape; messages: UsageMessagesShape; sessions: number };
type UsageModelSliceShape = { provider: string; model: string; tokens: number };
type UsagePeakShape = { date: string; value: number } | null;
type UsageTimezoneShape = { id: string; offsetMinutes: number };
type UsageContribution = {
  days: Record<string, { tokens: UsageTokensShape; messages: UsageMessagesShape; sessions: number }>;
  /** date -> modelKey -> tokens（只保留近 USAGE_DAYS_MAX 天，供 30 天分布合并） */
  models: Record<string, Record<string, number>>;
};

const usageNum = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const usageEmptyTokens = (): UsageTokensShape => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const usageEmptyMessages = (): UsageMessagesShape => ({ user: 0, assistant: 0 });
const usageDayKeyOf = (ms: number): string => {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const usageTodayKey = (now = Date.now()): string => usageDayKeyOf(now);
const usageAddDays = (dayKey: string, delta: number): string => {
  const [y, m, d] = dayKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

/** 设备本地时区（IANA + 采样偏移；分天按本地时区） */
function usageTimezone(): UsageTimezoneShape {
  let id = "local";
  try { id = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"; } catch {}
  return { id, offsetMinutes: -new Date().getTimezoneOffset() };
}

function usageModelKey(provider: any, model: any): string {
  const p = typeof provider === "string" && provider.trim() ? provider.trim() : "unknown";
  const m = typeof model === "string" && model.trim() ? model.trim() : "unknown";
  return `${p}/${m}`;
}
function usageModelParts(key: string): UsageModelSliceShape {
  const i = key.indexOf("/");
  return i < 0 ? { provider: "unknown", model: key, tokens: 0 } : { provider: key.slice(0, i), model: key.slice(i + 1), tokens: 0 };
}

const usageYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type UsageContributionResult = { contribution: UsageContribution; errors: number; sessions: number; firstDay: string | null };

/**
 * 增量聚合器：逐行 push，不在内存里攒整份 rows/文件文本。
 * 口径：message.role=user/assistant 才计消息；assistant.usage 计 token；session header 计会话日；
 * 其他条目（system/toolResult/model_change/compaction/branchSummary/custom…）忽略。
 * usageContributionOfRows / usageContributionOfText / usageContributionOfFile 共用这一份实现。
 */
function usageAggregator(timezone: UsageTimezoneShape = usageTimezone()) {
  const contribution: UsageContribution = { days: {}, models: {} };
  let errors = 0;
  let sessions = 0;
  let firstDay: string | null = null;
  const ensureDay = (day: string) => {
    if (!contribution.days[day]) contribution.days[day] = { tokens: usageEmptyTokens(), messages: usageEmptyMessages(), sessions: 0 };
    if (!contribution.models[day]) contribution.models[day] = {};
    return contribution.days[day];
  };
  const addSession = (day: string) => {
    if (!day) return;
    sessions += 1;
    if (!firstDay || day < firstDay) firstDay = day;
    ensureDay(day).sessions += 1;
  };
  const push = (row: any): void => {
    if (!row || typeof row !== "object") { errors += 1; return; }
    if (row.type === "session") {
      const ts = Date.parse(typeof row.timestamp === "string" ? row.timestamp : "");
      const day = Number.isFinite(ts) ? usageDayKeyOf(ts) : "";
      if (day) addSession(day);
      return;
    }
    if (row.type !== "message") return;
    const m = (row as any).message;
    if (!m || typeof m !== "object") return;
    const role = m.role;
    if (role !== "user" && role !== "assistant") return;
    const tsRaw = typeof m.timestamp === "number" ? m.timestamp : (typeof m.timestamp === "string" ? Date.parse(m.timestamp) : Date.parse(typeof (row as any).timestamp === "string" ? (row as any).timestamp : ""));
    if (!Number.isFinite(tsRaw)) { errors += 1; return; }
    const day = usageDayKeyOf(tsRaw);
    if (!day) { errors += 1; return; }
    const bucket = ensureDay(day);
    if (!firstDay || day < firstDay) firstDay = day;
    if (role === "user") { bucket.messages.user += 1; return; }
    bucket.messages.assistant += 1;
    const u = m.usage && typeof m.usage === "object" ? m.usage : null;
    if (!u) return;
    const input = usageNum(u.input);
    const output = usageNum(u.output);
    const cacheRead = usageNum(u.cacheRead);
    const cacheWrite = usageNum(u.cacheWrite);
    const total = usageNum(u.totalTokens) || input + output + cacheRead + cacheWrite;
    bucket.tokens.total += total;
    bucket.tokens.input += input;
    bucket.tokens.output += output;
    bucket.tokens.cacheRead += cacheRead;
    bucket.tokens.cacheWrite += cacheWrite;
    if (total > 0) {
      const key = usageModelKey(m.provider, m.model);
      contribution.models[day][key] = (contribution.models[day][key] || 0) + total;
    }
  };
  const finish = (): UsageContributionResult => {
    // 没有 session header 的旧文件：首个消息日补记一个会话，保证"一个文件 = 一个会话"口径
    if (sessions === 0) {
      const first = Object.keys(contribution.days).sort()[0];
      if (first) addSession(first);
    }
    return { contribution, errors, sessions, firstDay };
  };
  return { push, finish };
}

/** 解析单个会话 jsonl 文本的聚合贡献（测试直调；内部按行喂增量聚合器）。 */
function usageContributionOfRows(rows: readonly any[], timezone: UsageTimezoneShape = usageTimezone()): UsageContributionResult {
  const agg = usageAggregator(timezone);
  for (const row of rows) agg.push(row);
  return agg.finish();
}

/** 文本入口：行为与 usageContributionOfRows 完全一致；每解析若干行让出一次事件循环。 */
async function usageContributionOfText(text: string, timezone: UsageTimezoneShape = usageTimezone()): Promise<UsageContributionResult> {
  const agg = usageAggregator(timezone);
  let errors = 0;
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try { agg.push(JSON.parse(line)); } catch { errors += 1; }
    if (i > 0 && i % USAGE_PARSE_YIELD_LINES === 0) await usageYield();
  }
  const parsed = agg.finish();
  return { ...parsed, errors: parsed.errors + errors };
}

/** 文件入口（usage 扫描用）：按块流式切行并增量聚合，不再把整份会话文件读成 string + rows。
 *  逐行语义与 usageContributionOfText 一致（含空行跳过、\r 原样交给 JSON.parse、末行无换行照常解析）。 */
async function usageContributionOfFile(file: string, timezone: UsageTimezoneShape = usageTimezone()): Promise<UsageContributionResult> {
  const { StringDecoder } = require("node:string_decoder");
  const agg = usageAggregator(timezone);
  let errors = 0;
  let lines = 0;
  let pending = "";
  const feed = (line: string): void => {
    if (!line) return;
    try { agg.push(JSON.parse(line)); } catch { errors += 1; }
  };
  const stream = fs.createReadStream(file);
  const decoder = new StringDecoder("utf8");
  try {
    for await (const chunk of stream) {
      let rest: string = decoder.write(chunk as Buffer);
      for (;;) {
        const nl = rest.indexOf("\n");
        if (nl < 0) { pending += rest; break; }
        feed(pending + rest.slice(0, nl));
        pending = "";
        rest = rest.slice(nl + 1);
        lines += 1;
        if (lines % USAGE_PARSE_YIELD_LINES === 0) await usageYield();
      }
    }
    // 文件末尾：解码器残余 + 没有换行收尾的最后一行
    pending += decoder.end();
    feed(pending);
  } finally {
    try { stream.destroy(); } catch {}
  }
  const parsed = agg.finish();
  return { ...parsed, errors: parsed.errors + errors };
}

const usageMergeContribution = (into: UsageContribution, from: UsageContribution): void => {
  for (const [day, bucket] of Object.entries(from.days)) {
    const target = into.days[day] || (into.days[day] = { tokens: usageEmptyTokens(), messages: usageEmptyMessages(), sessions: 0 });
    target.sessions += bucket.sessions;
    for (const k of ["total", "input", "output", "cacheRead", "cacheWrite"] as const) target.tokens[k] += bucket.tokens[k];
    target.messages.user += bucket.messages.user;
    target.messages.assistant += bucket.messages.assistant;
  }
  for (const [day, models] of Object.entries(from.models)) {
    const target = into.models[day] || (into.models[day] = {});
    for (const [key, tokens] of Object.entries(models)) target[key] = (target[key] || 0) + tokens;
  }
};

/** 会话根目录（与 pi 本体一致：PI_CODING_AGENT_DIR 可覆盖） */
function usageSessionsRoot(env: any = process.env): string {
  const agentDir = String((env && env.PI_CODING_AGENT_DIR) || "").trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}
function usageCachePath(env: any = process.env): string {
  const agentDir = String((env && env.PI_CODING_AGENT_DIR) || "").trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "usage-days.json");
}

function usageWalkJsonl(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  // 只有真的还有下一个 .jsonl 没装下才标 truncated：旧实现在文件数达到上限后，
  // 只要同目录还剩任意条目（日志/子目录等非 jsonl）就误标「遍历超限」。
  const walk = (dir: string): boolean => {
    let entries: any[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(p)) return true;
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (files.length >= maxFiles) { truncated = true; return true; }
        files.push(p);
      }
    }
    return false;
  };
  walk(root);
  return { files, truncated };
}

type UsageCacheFileShape = {
  v: number;
  generatedAt: number;
  timezone: UsageTimezoneShape;
  files: Record<string, { mtimeMs: number; size: number; days: UsageContribution["days"]; models: UsageContribution["models"] }>;
};

function usageReadCache(cachePath: string, timezone: UsageTimezoneShape): UsageCacheFileShape | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!raw || raw.v !== USAGE_CACHE_VERSION) return null;
    if (!raw.timezone || raw.timezone.id !== timezone.id || Number(raw.timezone.offsetMinutes) !== timezone.offsetMinutes) return null;
    if (!raw.files || typeof raw.files !== "object") return null;
    if (Object.keys(raw.files).length > USAGE_CACHE_MAX_FILES) return null;
    return raw as UsageCacheFileShape;
  } catch { return null; }
}
function usageWriteCache(cachePath: string, cache: UsageCacheFileShape): void {
  try {
    const json = JSON.stringify(cache);
    if (Buffer.byteLength(json, "utf8") > USAGE_CACHE_MAX_BYTES) {
      // 太大就只留 fingerprint（下次全量重扫），避免缓存无限膨胀
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const slim = { v: USAGE_CACHE_VERSION, generatedAt: cache.generatedAt, timezone: cache.timezone, files: {} as any };
      const tmp = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(slim), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, cachePath);
      return;
    }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, cachePath);
  } catch (e: any) { try { log("usage 缓存写入失败（忽略）:", e?.message); } catch {} }
}

/**
 * 某本地日是否「活跃」：有任意活动（会话 / 用户消息 / assistant 回复）。
 * 口径必须与 summary.totals.activeDays、streak 完全一致——真实数据里会话 header 只落在开始日，
 * 后续几天"只有消息、没有新会话"也是活跃日；只按 sessions>0 会把连续 streak 切断（R9 bug）。
 */
function usageDayIsActive(bucket: { sessions: number; messages: { user: number; assistant: number } }): boolean {
  return bucket.sessions > 0 || bucket.messages.user > 0 || bucket.messages.assistant > 0;
}

/** 由合并后的日数据生成快照（近 30 天 totals + 全期 streak/峰值 + 近 30 天模型分布） */
function usageSnapshotFromContributions(
  merged: UsageContribution,
  meta: { files: number; parsedFiles: number; cacheHitFiles: number; skippedFiles: number; errors: number; truncated: boolean; scanMs: number; cacheHit: boolean; generatedFrom: "incremental" | "full"; timezone: UsageTimezoneShape; deviceId?: string; now: number; daysCapped?: boolean },
): any {
  const allDates = Object.keys(merged.days).sort();
  let truncated = meta.truncated;
  let dates = allDates;
  if (dates.length > USAGE_DAYS_MAX) { dates = dates.slice(dates.length - USAGE_DAYS_MAX); truncated = true; }
  const today = usageTodayKey(meta.now);
  const windowStart = usageAddDays(today, -(USAGE_MODELS_WINDOW_DAYS - 1));
  const days: UsageDayShape[] = [];
  const totals = { tokens: 0, messagesUser: 0, messagesAssistant: 0, sessions: 0, activeDays: 0 };
  let allTimeActive = 0;
  const modelsWindow: Record<string, number> = {};
  for (const date of dates) {
    const bucket = merged.days[date];
    days.push({ date, tokens: { ...bucket.tokens }, messages: { ...bucket.messages }, sessions: bucket.sessions });
    if (date >= windowStart) {
      totals.tokens += bucket.tokens.total;
      totals.messagesUser += bucket.messages.user;
      totals.messagesAssistant += bucket.messages.assistant;
      totals.sessions += bucket.sessions;
      if (usageDayIsActive(bucket)) totals.activeDays += 1;
      for (const [key, tokens] of Object.entries(merged.models[date] || {})) modelsWindow[key] = (modelsWindow[key] || 0) + tokens;
    }
    if (bucket.sessions > 0) allTimeActive += 1;
  }
  // streak：全期最长；current 以今天（无今天数据则昨天）为准往回数
  const activeSet = new Set(dates.filter((d) => usageDayIsActive(merged.days[d])));
  let longest = 0, run = 0, prev = "";
  for (const date of [...activeSet].sort()) {
    run = prev && usageAddDays(prev, 1) === date ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = date;
  }
  let current = 0;
  let cursor = activeSet.has(today) ? today : usageAddDays(today, -1);
  while (activeSet.has(cursor)) { current += 1; cursor = usageAddDays(cursor, -1); }
  // peaks（快照覆盖窗口内）：tokens = 单日 totalTokens 峰；messages = 单日 **user 消息数**峰（不叠加 assistant）
  let peakTokens: UsagePeakShape = null, peakMessages: UsagePeakShape = null;
  for (const day of days) {
    if (!peakTokens || day.tokens.total > peakTokens.value) peakTokens = { date: day.date, value: day.tokens.total };
    if (!peakMessages || day.messages.user > peakMessages.value) peakMessages = { date: day.date, value: day.messages.user };
  }
  const models: UsageModelSliceShape[] = Object.entries(modelsWindow)
    .map(([key, tokens]) => ({ ...usageModelParts(key), tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
    .slice(0, USAGE_MODELS_MAX);
  const snapshot = {
    v: USAGE_ACTIVITY_VERSION,
    generatedAt: meta.now,
    ...(meta.deviceId ? { deviceId: meta.deviceId } : null),
    timezone: meta.timezone,
    range: { firstDay: dates.length ? dates[0] : null, lastDay: dates.length ? dates[dates.length - 1] : null, days: days.length },
    days,
    summary: {
      totals,
      streaks: { current, longest },
      peaks: { tokens: peakTokens, messages: peakMessages },
      models,
      modelsWindowDays: USAGE_MODELS_WINDOW_DAYS,
    },
    coverage: {
      files: meta.files, parsedFiles: meta.parsedFiles, cacheHitFiles: meta.cacheHitFiles, skippedFiles: meta.skippedFiles,
      truncated, errors: meta.errors, scanMs: meta.scanMs, source: "pi-sessions",
    },
    cache: { hit: meta.cacheHit, generatedFrom: meta.generatedFrom },
  };
  return snapshot;
}

/**
 * 扫描 + 聚合（extension 收到 usage_refresh 时调用；也可被测试直接调用）。
 * @returns snapshot（usage.activity.v1）与诊断信息；永不抛出（出错回空快照 + errors 计数）。
 */
async function usageScanSnapshot(options: any = {}): Promise<any> {
  const now = Number(options.now) || Date.now();
  const timezone = options.timezone || usageTimezone();
  const root = String(options.sessionRoot || usageSessionsRoot());
  const cachePath = String(options.cachePath || usageCachePath());
  const maxFiles = Number(options.maxFiles) || USAGE_MAX_FILES;
  const maxFileBytes = Number(options.maxFileBytes) || USAGE_MAX_FILE_BYTES;
  const useCache = options.useCache !== false;
  const started = Date.now();
  const merged: UsageContribution = { days: {}, models: {} };
  const filesMeta: Record<string, any> = {};
  let files = 0, parsedFiles = 0, cacheHitFiles = 0, skippedFiles = 0, errors = 0, truncated = false;
  try {
    const walk = usageWalkJsonl(root, maxFiles);
    truncated = walk.truncated;
    files = walk.files.length;
    const cache = useCache ? usageReadCache(cachePath, timezone) : null;
    const cacheHit = !!cache;
    for (const file of walk.files) {
      const rel = path.relative(root, file);
      let st: any;
      try { st = fs.statSync(file); } catch { skippedFiles += 1; continue; }
      if (!st.isFile()) continue;
      // 超过单文件上限仍跳过（避免一次刷新被超大文件拖死），但必须让 coverage.truncated 诚实：
      // 旧实现只 +skippedFiles、truncated 仍为 false，等于把整份会话静默漏掉。
      if (st.size > maxFileBytes) { skippedFiles += 1; truncated = true; continue; }
      const cached = cache && cache.files[rel];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        cacheHitFiles += 1;
        usageMergeContribution(merged, { days: cached.days, models: cached.models });
        filesMeta[rel] = { mtimeMs: st.mtimeMs, size: st.size, days: cached.days, models: cached.models };
        continue;
      }
      parsedFiles += 1;
      let parsed: any;
      try {
        // 流式解析：大文件不再先 readFileSync 成整份 string 再 split/rows（低-1 内存尖峰）。
        parsed = await usageContributionOfFile(file, timezone);
      } catch { skippedFiles += 1; continue; }
      errors += parsed.errors;
      usageMergeContribution(merged, parsed.contribution);
      filesMeta[rel] = { mtimeMs: st.mtimeMs, size: st.size, days: parsed.contribution.days, models: parsed.contribution.models };
    }
    if (useCache) {
      usageWriteCache(cachePath, { v: USAGE_CACHE_VERSION, generatedAt: now, timezone, files: filesMeta });
    }
    const snapshot = usageSnapshotFromContributions(merged, {
      files, parsedFiles, cacheHitFiles, skippedFiles, errors, truncated,
      scanMs: Date.now() - started, cacheHit, generatedFrom: cacheHit ? "incremental" : "full",
      timezone, deviceId: options.deviceId, now,
    });
    return { snapshot, diagnostics: { files, parsedFiles, cacheHitFiles, skippedFiles, errors, truncated, scanMs: Date.now() - started, cacheHit } };
  } catch (e: any) {
    try { log("usage 扫描失败（回空快照）:", e?.message); } catch {}
    const empty = usageSnapshotFromContributions({ days: {}, models: {} }, {
      files, parsedFiles, cacheHitFiles, skippedFiles, errors: errors + 1, truncated,
      scanMs: Date.now() - started, cacheHit: false, generatedFrom: "full", timezone, deviceId: options.deviceId, now,
    });
    return { snapshot: empty, diagnostics: { files, parsedFiles, cacheHitFiles, skippedFiles, errors: errors + 1, truncated, scanMs: Date.now() - started, cacheHit: false } };
  }
}

/** 空快照（与 shared 的 piUsageEmptySnapshot 同形状；relay 降级/无数据用） */
function usageEmptySnapshot(options: any = {}): any {
  const now = Number(options.now) || Date.now();
  const timezone = options.timezone || usageTimezone();
  return usageSnapshotFromContributions({ days: {}, models: {} }, {
    files: 0, parsedFiles: 0, cacheHitFiles: 0, skippedFiles: 0, errors: 0, truncated: false, scanMs: 0,
    cacheHit: false, generatedFrom: "full", timezone, deviceId: options.deviceId, now,
  });
}

export { Bridge, RemoteError, usageScanSnapshot, usageContributionOfRows, usageContributionOfText, usageSnapshotFromContributions, usageEmptySnapshot, usageTimezone, usageDayKeyOf, usageTodayKey, usageAddDays, usageModelKey, usageSessionsRoot, usageCachePath, USAGE_ACTIVITY_VERSION, USAGE_CACHE_VERSION, USAGE_DAYS_MAX, USAGE_MODELS_MAX, remoteErrorCode, validCid, authFrame, CLIENT_CAPS, PROTOCOL, projectEvent, projectNotifyEvent, buildDialogOpen, capDialogOptions, shrinkDeep, mirrorMessages, hashOf, redactDeep, mergeableDelta, truncateStringsDeep, oversizeFallback, deliveryKey, deliveryMatches, deleteLikePi, hasTrashCommand, deviceIdentity, platformId, defaultDeviceName, samePath, evaluateAttachWindow, attachStatePath, attachGateHint, insecureRelayWarning, STREAM_DELTA_MAX_CHARS, IMAGE_RETURN_MAX_CHARS, buildSessionManifest, manifestProjectDirs, normalizeSessionEntry, sessionIdFromPath, sessionIdFromFile, MAX_MANIFEST_BATCH, MANIFEST_THROTTLE_MS, LOG_ROTATE_BYTES, LOG_CHECK_EVERY, LOG_FILE, log, pidAlive, taskListFromDetails, taskListFromPlanEntry, taskListFromBranch, DIAG_ERROR_MAX, LOG_TAIL_LINES, redactDiagText, recordDiagError, readLogTail, attachDiagState, FILE_MAX_BYTES, mimeForFile, resolveFileInRoot, readFileInRoot, readPiVersion, settingsFilePath, validateSettingsPatch, settingsPatchFromArgs, settingsReadFile, settingsApplyPatch, settingsAtomicWrite, settingsWritePatch, SETTINGS_THINKING_LEVELS };

