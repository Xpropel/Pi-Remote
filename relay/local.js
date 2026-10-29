"use strict";
/** local 通道（7001）：本机扩展与 attach 窗口 */
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
const { cleanCid } = require("./store");
const PROTOCOL = require("./protocol.json");
const { safeId, safeEqual, log, keyFingerprint } = require("./util");
const { normalizeAccount } = require("./config");
const { RELAY_CAPS, parseHello, helloVersionError, helloText, hasCap, failureCode, errorFrame, send, broadcast, ackFrame, snapshotBodyFrom, snapshotFrame } = require("./wire");
const { attachCommon, keepalive } = require("./conn");
const { PAIR_CODES_MAX, sha256hex, newPairCode, formatPairCode, normalizePairCode, pairCheckDigits, pairCheckDigitsV2, b64buf, verifyEd25519, cleanPubKeys, cleanPairKeys, popPayload, authPayload, keyUpdatePayload, p256PubKey, pairSourceBlocked, notePairFailure, requestSource, checkDeviceToken } = require("./pairing");
const { REMOTE_MESSAGE_EVENTS, finishWaiter, settleEntry } = require("./commands");
const { MAX_DEVICE_NAME, normalizePlatform, cleanProjects, blankDevice, boundAccount } = require("./devices");
const { cancelResend, restartResend, sendCachedAssistant, sendCachedAutoRetry, sendCachedUiPrompt, sendCachedDialogs, sendCachedExtStatus, sendCachedCompaction, sendCachedTools, sendCachedToolEnds, broadcastToolEndMeta, sendCachedTaskList, sendCachedAgentState, DROPPABLE_LOCAL_EVENTS, shrinkImagesDeep, ownRoom, clearSessionState, pushDialogGate, observeRoomTurnEvent, broadcastRoomAttention, broadcastRoomWaiting } = require("./rooms");
const { ackTrackerOf, isAckFp } = require("./acktrack");
const { createNotifier } = require("./notify");
const { storeSessionArchive, broadcastSessionArchive } = require("./sessionArchive");
const { purgeSessions } = require("./purge");

/** attach 声明的能力里 relay 关心的子集（P9 B/C）：决定设备级 session.files 命令与目录浏览是否可用 */
const DEVICE_FEATURES = ["session.files", "fs.browse"];

/** 深拷贝队列一侧，和刚收到的事件对象分开，避免之后改事件把缓存带跑。 */
function cloneQueueSide(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : value;
  }
}

/** 房间级「最后状态」缓存的体积防御（R-3，与 remote_queue 的条数 + 字段上限同口径）：
 *  条数上限与 remote_queue 一致（120）；单份缓存的序列化字节上限取补发口径的缺省值
 *  （maxPayloadBytes 256KB——补发端对超限帧本就整帧跳过，存得再大也发不出去）。
 *  超限时整帧不缓存、保留上一份，避免扩展异常时一条坏帧把大对象钉在房间上，
 *  让房间内存只涨不降、每次订阅补发都白做一次大序列化。 */
const ROOM_STATE_CACHE_MAX_ITEMS = 120;
const ROOM_STATE_CACHE_MAX_BYTES = 256 * 1024;

/** 值序列化后的 UTF-8 字节数；不可序列化按无穷大算。 */
function serializedBytes(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? Buffer.byteLength(text) : Infinity;
  } catch {
    return Infinity;
  }
}

/** 深拷贝并量体积：序列化后超过 maxBytes（或不可序列化）返回 undefined，调用方据此不缓存。 */
function cloneWithinBytes(value, maxBytes) {
  if (value === undefined) return undefined;
  if (serializedBytes(value) > maxBytes) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** 把 queue_update 的 steering / followUp 留在房间上。没收到过就不建这份缓存。
 *  体积防御（R-3）：每侧数组先截到条数上限，整份再量字节，超限整帧不缓存、
 *  保留上一份（条目正文是用户待发原文，不逐条截断——总量封顶已足够兜底）。 */
function rememberQueue(room, event) {
  const queue = {};
  if (event && Object.prototype.hasOwnProperty.call(event, "steering")) {
    queue.steering = cloneQueueSide(Array.isArray(event.steering) ? event.steering.slice(0, ROOM_STATE_CACHE_MAX_ITEMS) : event.steering);
  }
  if (event && Object.prototype.hasOwnProperty.call(event, "followUp")) {
    queue.followUp = cloneQueueSide(Array.isArray(event.followUp) ? event.followUp.slice(0, ROOM_STATE_CACHE_MAX_ITEMS) : event.followUp);
  }
  // 与 taskList 对齐的时间戳：补发时让前端知道这份队列是哪个时刻的。
  queue.at = Date.now();
  if (serializedBytes(queue) > ROOM_STATE_CACHE_MAX_BYTES) return;
  room.queue = queue;
}

/** 远程待发状态只在内存里缓存：字段白名单 + 长度上限，防止一条坏帧把房间内存撑爆。 */
const REMOTE_QUEUE_CACHE_MAX = 120;
const REMOTE_QUEUE_TEXT_MAX = 8000;
const REMOTE_QUEUE_IMAGE_MAX = 16;

function cleanRemoteQueueItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const segment = raw.segment === "steer" || raw.segment === "follow_up" ? raw.segment : "";
  const status = raw.status === "pending" || raw.status === "injected" || raw.status === "failed" ? raw.status : "";
  if (!id || !segment || !status) return null;
  const item = {
    id: id.slice(0, 80),
    segment,
    source: typeof raw.source === "string" && raw.source ? raw.source.slice(0, 32) : "web",
    text: typeof raw.text === "string" ? raw.text.slice(0, REMOTE_QUEUE_TEXT_MAX) : "",
    images: [],
    status,
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0,
  };
  if (Array.isArray(raw.images)) {
    for (const image of raw.images.slice(0, REMOTE_QUEUE_IMAGE_MAX)) {
      if (!image || typeof image !== "object") continue;
      const mimeType = typeof image.mimeType === "string" ? image.mimeType.slice(0, 80) : "";
      if (!mimeType) continue;
      const bytes = typeof image.bytes === "number" && Number.isFinite(image.bytes) ? Math.max(0, Math.floor(image.bytes)) : 0;
      item.images.push({ mimeType, bytes });
    }
  }
  const cid = cleanCid(raw.cid);
  if (cid) item.cid = cid;
  for (const key of ["updatedAt", "injectedAt"]) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) item[key] = raw[key];
  }
  if (typeof raw.error === "string" && raw.error) item.error = raw.error.slice(0, 500);
  if (typeof raw.code === "string" && raw.code) item.code = raw.code.slice(0, 64);
  return item;
}

/** remote_queue_state 整份替换；坏帧不覆盖现有缓存。 */
function rememberRemoteQueue(room, event) {
  if (!room || !event || !Array.isArray(event.items)) return;
  const items = [];
  for (const raw of event.items.slice(0, REMOTE_QUEUE_CACHE_MAX)) {
    const item = cleanRemoteQueueItem(raw);
    if (item) items.push(item);
  }
  const rev = typeof event.rev === "number" && Number.isFinite(event.rev) && event.rev >= 0 ? Math.floor(event.rev) : 0;
  room.remoteQueue = { rev, items, at: Date.now() };
}

/** 任务清单最后状态：只接受数组（空数组 = 清空），深拷贝后留在房间上，避免事件对象后续被改。
 *  source 只认契约里的 todo / plan；at 只留有限数字。没收到过就不建这份缓存。
 *  体积防御（R-3）：先截条数再整体量字节，超限整帧不缓存、保留上一份清单。 */
function rememberTaskList(room, event) {
  if (!room || !event || !Array.isArray(event.tasks)) return;
  const tasks = cloneWithinBytes(event.tasks.slice(0, ROOM_STATE_CACHE_MAX_ITEMS), ROOM_STATE_CACHE_MAX_BYTES);
  if (tasks === undefined) return;
  const cached = { tasks };
  if (event.source === "todo" || event.source === "plan") cached.source = event.source;
  if (typeof event.at === "number" && Number.isFinite(event.at)) cached.at = event.at;
  room.taskList = cached;
}

/** 子智能体状态最后一份全量快照：只接受数组（空数组 = 清空），深拷贝后留在房间上。
 *  at 只留有限数字；agents 非数组、或非空但一条都认不出（缺 id / 非法 status）都算坏帧，
 *  不覆盖现有缓存（与 UI 的“坏帧保留上一帧、认不出的条目跳过”一致）。
 *  条数与总字节另有上限（R-3，见 ROOM_STATE_CACHE_MAX_*），超限同样不覆盖。
 *  没收到过就不建这份缓存。 */
const AGENT_STATUSES = new Set(["queued", "running", "succeeded", "failed", "aborted"]);
function validAgentItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (typeof raw.id !== "string" || !raw.id.trim()) return false;
  return typeof raw.status === "string" && AGENT_STATUSES.has(raw.status);
}
function rememberAgentState(room, event) {
  if (!room || !event || !Array.isArray(event.agents)) return;
  const valid = [];
  for (const raw of event.agents) {
    if (validAgentItem(raw)) valid.push(raw);
    if (valid.length >= ROOM_STATE_CACHE_MAX_ITEMS) break;
  }
  if (event.agents.length && !valid.length) return;
  // 体积防御（R-3）：认得出的条目整体量字节，超限整帧不缓存、保留上一份快照。
  const agents = cloneWithinBytes(valid, ROOM_STATE_CACHE_MAX_BYTES);
  if (agents === undefined) return;
  const cached = { agents };
  if (typeof event.at === "number" && Number.isFinite(event.at)) cached.at = event.at;
  room.agentState = cached;
}

/** 压缩开始后、结束前，房间记下最后一帧的 reason 与 willRetry。没收到 compaction_start 不建这份缓存。 */
function rememberCompaction(room, event) {
  const src = event && typeof event === "object" ? event : {};
  const cached = { type: "compaction_start" };
  cached.reason = Object.prototype.hasOwnProperty.call(src, "reason") ? src.reason : null;
  cached.willRetry = Object.prototype.hasOwnProperty.call(src, "willRetry") ? src.willRetry : false;
  room.compaction = cached;
}

/** 只留有限数字；缺字段、字符串、NaN、Infinity 都记 null。 */
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 自动重试开始后、结束前，房间记下 attempt、maxAttempts、delayMs、errorMessage。
 *  三个数字非有限则 null，errorMessage 非字符串则 null。和原事件对象分开拷贝。没收到 auto_retry_start 不建这份缓存。 */
function rememberAutoRetry(room, event) {
  const src = event && typeof event === "object" ? event : {};
  const cached = {
    attempt: finiteOrNull(src.attempt),
    maxAttempts: finiteOrNull(src.maxAttempts),
    delayMs: finiteOrNull(src.delayMs),
    errorMessage: typeof src.errorMessage === "string" ? src.errorMessage : null,
  };
  room.autoRetry = cloneQueueSide(cached);
}

function clearAutoRetry(room) {
  if (room) room.autoRetry = null;
}

/** 本机弹窗开始后、结束前，房间记下 reason、kind、title。
 *  三者非字符串则 null，title 超过 120 字截到 120。和原事件对象分开拷贝。没收到 ui_prompt_start 不建这份缓存。
 *  再来一条 start 就换成新的。at 是收到这条信号的时间，给 room_waiting 的 waitingPrompt 当排序/展示锚点（P9 A）。 */
function rememberUiPrompt(room, event) {
  const L = PROTOCOL.limits || {};
  const src = event && typeof event === "object" ? event : {};
  const cached = {
    reason: typeof src.reason === "string" ? src.reason : null,
    kind: typeof src.kind === "string" ? src.kind : null,
    title: typeof src.title === "string" ? src.title.slice(0, L.dialogTitleMax || 120) : null,
    at: Date.now(),
  };
  room.uiPrompt = cloneQueueSide(cached);
}

function clearUiPrompt(room) {
  if (room) room.uiPrompt = null;
}

/* ---------------- 对话框观察（O1）多槽缓存 + 扩展 UI 状态快照 ----------------
 * dialog_open 按 dialogId 入槽、dialog_close 按 id 销槽；多个 dialog 交错不互相覆盖。
 * legacy 单槽 uiPrompt（ui_prompt_start/end）继续独立维护：旧 viewer 与 tap 失效时的
 * 信号回退都靠它，两者互不替代。字段清洗上限与扩展侧一致，全部取 PROTOCOL.limits。
 * room.dialogs 是普通对象（dialogId → 清洗后的 dialog_open 帧），保持插入顺序。 */

function cleanDialogSlot(src) {
  const L = PROTOCOL.limits || {};
  const dialogId = typeof src.dialogId === "string" ? src.dialogId.slice(0, 64) : "";
  const kind = typeof src.kind === "string" ? src.kind : "";
  if (!dialogId || !kind) return null;
  const slot = { type: "dialog_open", dialogId, kind };
  if (typeof src.title === "string") slot.title = src.title.slice(0, L.dialogTitleMax || 120);
  if (Array.isArray(src.options)) {
    slot.options = src.options.slice(0, L.dialogOptionsMax || 20).map((v) => String(v ?? "").slice(0, L.dialogOptionChars || 80));
    if (typeof src.optionsTotal === "number" && Number.isFinite(src.optionsTotal)) slot.optionsTotal = src.optionsTotal;
  }
  for (const key of ["message", "placeholder", "prefill"]) {
    if (typeof src[key] === "string") slot[key] = src[key].slice(0, L.dialogTextMax || 500);
  }
  // 多选（G3）：选择数区间随槽保留，补发时卡面计数/确认可用性靠它；桥侧组帧已钳制，这里只认整数
  if (kind === "multiselect") {
    if (Number.isInteger(src.minSelect)) slot.minSelect = src.minSelect;
    if (Number.isInteger(src.maxSelect)) slot.maxSelect = src.maxSelect;
  }
  if (typeof src.timeout === "number" && Number.isFinite(src.timeout) && src.timeout > 0) slot.timeout = src.timeout;
  // O2 接管中的 dialog 带 answerable:true：补发（sendCachedDialogs）原样保留，剩余时限由前端按 startedAt+timeout 重算
  if (src.answerable === true) slot.answerable = true;
  slot.startedAt = typeof src.startedAt === "number" && Number.isFinite(src.startedAt) ? src.startedAt : Date.now();
  return slot;
}

function rememberDialogOpen(room, event) {
  if (!room || !event) return;
  const slot = cleanDialogSlot(event);
  if (!slot) return;
  if (!room.dialogs) room.dialogs = {};
  // 同 id 重入（重连补发/重放）只更新内容，不改插入顺序语义：删后重插到末尾即可
  delete room.dialogs[slot.dialogId];
  room.dialogs[slot.dialogId] = slot;
  const max = (PROTOCOL.limits && PROTOCOL.limits.dialogSlotsMax) || 8;
  const ids = Object.keys(room.dialogs);
  for (let i = 0; i < ids.length - max; i++) delete room.dialogs[ids[i]];
}

function forgetDialog(room, dialogId) {
  if (!room || !room.dialogs || typeof dialogId !== "string") return;
  delete room.dialogs[dialogId];
}

/** dialog_close 的 note 出口复核（A-3，纵深防御）：长度上限在 viewer 转发与桥侧
 *  各切过一刀，但 relay 广播前不复核的话，桥异常/被篡改时超长 note 仍可原样直达
 *  各端。这里在事件出口再按 limits.dialogNoteMax 切一刀并滤掉控制字符；原地改
 *  事件对象，store 落盘与广播吃到的是同一份清洗结果。清洗后为空则删字段。 */
function cleanDialogCloseNote(event) {
  if (!event || typeof event.note !== "string") return;
  const max = (PROTOCOL.limits && PROTOCOL.limits.dialogNoteMax) || 500;
  const cleaned = event.note.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max);
  if (cleaned) event.note = cleaned;
  else delete event.note;
}

/** dialog_open 直播的 cap 门控（A-6）：answerable 是"应答面"数据，只发给握手声明了
 *  dialog.respond 的 viewer；未声明的（旧端）收到剥掉 answerable 的同一帧——观察
 *  形态的只读卡（kind/title/options 等）照常到达，不许把卡一起剥掉。dialog_close
 *  等收卡帧不走这里：旧端同样需要它摘卡，门控了只会留幽灵卡。
 *  多选（G3）在此之上再加一道：kind=multiselect 的 answerable 还要求 dialog.multiselect。 */
function broadcastDialogOpen(room, frame, cfg) {
  // 多选（G3）：answerable 还要再过 dialog.multiselect 一道 cap——未声明的端只收只读卡
  let kind = null;
  try {
    const parsed = JSON.parse(frame);
    kind = parsed && parsed.event && typeof parsed.event.kind === "string" ? parsed.event.kind : null;
  } catch {}
  const withCap = [];
  const withoutCap = [];
  for (const v of room.viewers) {
    const ok = hasCap(v, "dialog.respond") && (kind !== "multiselect" || hasCap(v, "dialog.multiselect"));
    (ok ? withCap : withoutCap).push(v);
  }
  if (!withoutCap.length) {
    broadcast(withCap, frame, cfg);
    return;
  }
  let stripped = null;
  try {
    const parsed = JSON.parse(frame);
    if (parsed && parsed.event && typeof parsed.event === "object") {
      delete parsed.event.answerable;
      stripped = JSON.stringify(parsed);
    }
  } catch {}
  broadcast(withCap, frame, cfg);
  // 剥不出来（自家序列化帧理论上不会）时宁可不发应答面，也不能把 answerable 漏给旧端
  if (stripped) broadcast(withoutCap, stripped, cfg);
}

/** 取走并清空全部在开 dialog 槽（宿主断开合成关闭用）。返回被清掉的槽列表。 */
function takeDialogs(room) {
  if (!room || !room.dialogs) return [];
  const slots = Object.values(room.dialogs);
  room.dialogs = {};
  return slots;
}

/** ext_status 最后一份全量快照：白名单清洗后留在房间上，晚订阅补发（task_list 同范式）。
 *  坏帧（statuses 不是对象）不覆盖现有缓存。 */
function rememberExtStatus(room, event) {
  if (!room || !event || typeof event !== "object") return;
  if (!event.statuses || typeof event.statuses !== "object" || Array.isArray(event.statuses)) return;
  const L = PROTOCOL.limits || {};
  const statuses = {};
  for (const [key, value] of Object.entries(event.statuses)) {
    if (typeof value === "string") statuses[String(key).slice(0, 64)] = value.slice(0, L.statusTextMax || 200);
  }
  const widgets = [];
  if (Array.isArray(event.widgets)) {
    for (const raw of event.widgets.slice(0, 32)) {
      if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || !raw.key) continue;
      const widget = { key: raw.key.slice(0, 64) };
      if (Array.isArray(raw.lines)) widget.lines = raw.lines.slice(0, L.widgetLinesMax || 50).map((line) => String(line ?? "").slice(0, L.widgetLineChars || 200));
      if (raw.factory === true) widget.factory = true;
      if (typeof raw.placement === "string") widget.placement = raw.placement.slice(0, 32);
      widgets.push(widget);
    }
  }
  const cached = { type: "ext_status", statuses, widgets };
  cached.title = typeof event.title === "string" ? event.title.slice(0, L.dialogTitleMax || 120) : null;
  cached.working = event.working && typeof event.working === "object" && !Array.isArray(event.working) ? cloneQueueSide(event.working) : null;
  cached.tap = event.tap && typeof event.tap === "object" && typeof event.tap.state === "string" ? { state: event.tap.state } : null;
  if (typeof event.at === "number" && Number.isFinite(event.at)) cached.at = event.at;
  room.extStatus = cached;
}

/** toolCallId 必须是非空字符串，否则这帧不进进行中工具缓存。 */
function runningToolId(event) {
  const id = event && event.toolCallId;
  return typeof id === "string" && id ? id : "";
}

/** 进行中工具条数硬顶（R-3，与 ASSISTANT_INDEX_MAX 同级）：工具的 end 帧丢失时
 *  条目只涨不降，必须封顶；超限丢最旧（被丢条目迟到的 update 会按「没见过 start」
 *  重新建一条、迟到的 end 按不存在处理，都与现状口径一致）。 */
const RUNNING_TOOLS_MAX = 128;

/** 工具名 / 参数 / 中间输出的单项体积上限：与房间状态缓存同口径（256KB）。
 *  超限返回 undefined，调用方不写这一项（保留先前记下的值），避免一条坏帧把
 *  大 args / partialResult 钉在房间上。 */
function cloneToolField(value) {
  return cloneWithinBytes(value, ROOM_STATE_CACHE_MAX_BYTES);
}

function ensureRunningTool(room, id) {
  if (!room.runningTools) room.runningTools = [];
  for (const entry of room.runningTools) if (entry.toolCallId === id) return entry;
  const entry = { toolCallId: id, fromStart: false };
  room.runningTools.push(entry);
  while (room.runningTools.length > RUNNING_TOOLS_MAX) room.runningTools.shift();
  return entry;
}

/** 工具开始：按 toolCallId 记下 toolName、args 与 relay 收到 start 的时刻。
 *  startedAt 只在第一次看到该工具时打戳（重复 start 不重置锚点），并和原事件对象分开。 */
function rememberToolStart(room, event) {
  const id = runningToolId(event);
  if (!id) return;
  const entry = ensureRunningTool(room, id);
  entry.fromStart = true;
  if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) entry.startedAt = Date.now();
  if (event && Object.prototype.hasOwnProperty.call(event, "toolName")) {
    const toolName = cloneToolField(event.toolName);
    if (toolName !== undefined) entry.toolName = toolName;
  }
  if (event && Object.prototype.hasOwnProperty.call(event, "args")) {
    const args = cloneToolField(event.args);
    if (args !== undefined) entry.args = args;
  }
}

/** 工具中间输出：没收到过 start 也记。toolName 有才覆盖；partialResult 有才写下。 */
function rememberToolUpdate(room, event) {
  const id = runningToolId(event);
  if (!id) return;
  const entry = ensureRunningTool(room, id);
  if (event && typeof event.toolName === "string" && event.toolName) {
    const toolName = cloneToolField(event.toolName);
    if (toolName !== undefined) entry.toolName = toolName;
  }
  if (event && Object.prototype.hasOwnProperty.call(event, "partialResult")) {
    const partialResult = cloneToolField(event.partialResult);
    if (partialResult !== undefined) entry.partialResult = partialResult;
  }
}

function forgetRunningTool(room, id) {
  if (!room || !room.runningTools || typeof id !== "string" || !id) return;
  const next = room.runningTools.filter((entry) => entry.toolCallId !== id);
  room.runningTools = next.length ? next : null;
}

function clearRunningTools(room) {
  if (room) room.runningTools = null;
}

/** 只认有限下标，避免一条坏帧把内容数组撑爆。 */
const ASSISTANT_INDEX_MAX = 128;

/** 进行中助手草稿的单块正文上限：与工具参数一致（maxPayloadBytes，缺省 256KB）。
 *  长会话里 text/thinking 的 delta 会无限累积在房间上，必须和 args 一样设硬顶。 */
function draftLimit(cfg) {
  return (cfg && cfg.maxPayloadBytes) || 256 * 1024;
}

/** 按 UTF-8 字节截断字符串；切到多字节字符中间时去掉末尾的替换字符。 */
function truncateUtf8(text, limit) {
  if (typeof text !== "string" || limit <= 0) return "";
  if (Buffer.byteLength(text) <= limit) return text;
  const out = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
  return out.endsWith("\uFFFD") ? out.replace(/\uFFFD+$/, "") : out;
}

/** 草稿正文追加：达到上限后不再增长，单次 delta 超限也截断。 */
function appendDraftText(prev, delta, limit) {
  const base = typeof prev === "string" ? prev : "";
  if (Buffer.byteLength(base) >= limit) return base;
  return truncateUtf8(base + delta, limit);
}

/** assistant 的 message_start 之后、message_end 之前，房间记下这条还在写的消息。非 assistant 不建缓存。 */
function rememberAssistantStart(room, event) {
  const message = event && event.message;
  if (!message || typeof message !== "object" || message.role !== "assistant") return;
  const draft = { blocks: [] };
  if (Object.prototype.hasOwnProperty.call(message, "timestamp") && message.timestamp !== undefined) {
    draft.timestamp = cloneQueueSide(message.timestamp);
  }
  room.assistantDraft = draft;
}

function blankToolBlock() {
  return { type: "tool", id: "", toolName: "", args: "" };
}

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** toolcall_start 换成一块新的工具块。id、toolName 非空字符串才记下，否则是空字符串。参数从空字符串开始。不读 partial。 */
function rememberToolcallStart(blocks, idx, ame) {
  const block = blankToolBlock();
  if (typeof ame.id === "string" && ame.id) block.id = ame.id;
  if (typeof ame.toolName === "string" && ame.toolName) block.toolName = ame.toolName;
  blocks[idx] = block;
}

/** toolcall_delta：delta 是字符串才追加。还不是工具块就先建成空 id、空名字。参数字节数达到 maxPayloadBytes 后不再追加。 */
function rememberToolcallDelta(blocks, idx, ame, cfg) {
  if (typeof ame.delta !== "string") return;
  let block = blocks[idx];
  if (!block || block.type !== "tool") {
    block = blankToolBlock();
    blocks[idx] = block;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  const prev = typeof block.args === "string" ? block.args : "";
  if (Buffer.byteLength(prev) >= limit) return;
  block.args = prev + ame.delta;
}

/** toolcall_end：toolCall 是普通对象才处理。id、name 非空字符串才覆盖。arguments 是普通对象才分开拷贝；拷贝失败或不符就不记 arguments。没有 start 也建块。 */
function rememberToolcallEnd(blocks, idx, ame) {
  const tc = ame.toolCall;
  if (!plainObject(tc)) return;
  let block = blocks[idx];
  if (!block || block.type !== "tool") {
    block = blankToolBlock();
    blocks[idx] = block;
  }
  if (typeof tc.id === "string" && tc.id) block.id = tc.id;
  if (typeof tc.name === "string" && tc.name) block.toolName = tc.name;
  if (!Object.prototype.hasOwnProperty.call(tc, "arguments")) return;
  if (!plainObject(tc.arguments)) {
    delete block.arguments;
    return;
  }
  try {
    const copied = JSON.parse(JSON.stringify(tc.arguments));
    if (!plainObject(copied)) {
      delete block.arguments;
      return;
    }
    block.arguments = copied;
  } catch {
    delete block.arguments;
  }
}

/** 把 text / thinking / toolcall 按 contentIndex 拼进还在写的助手。没发过 message_start 不编造。
 *  contentIndex 缺省 0；不是 0 到 128 的整数就跳过这一帧。 */
function rememberAssistantDelta(room, event, cfg) {
  if (!room || !room.assistantDraft) return;
  const ame = event && event.assistantMessageEvent;
  if (!ame || typeof ame !== "object") return;
  const idx = ame.contentIndex === undefined ? 0 : ame.contentIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx > ASSISTANT_INDEX_MAX) return;
  const blocks = room.assistantDraft.blocks;
  const limit = draftLimit(cfg);
  if (ame.type === "text_delta" && typeof ame.delta === "string") {
    const prev = blocks[idx] && blocks[idx].type === "text" ? blocks[idx].text : "";
    blocks[idx] = { type: "text", text: appendDraftText(prev, ame.delta, limit) };
  } else if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
    const prev = blocks[idx] && blocks[idx].type === "thinking" ? blocks[idx].thinking : "";
    blocks[idx] = { type: "thinking", thinking: appendDraftText(prev, ame.delta, limit) };
  } else if (ame.type === "text_end" && typeof ame.content === "string") {
    blocks[idx] = { type: "text", text: truncateUtf8(ame.content, limit) };
  } else if (ame.type === "thinking_end" && typeof ame.content === "string") {
    blocks[idx] = { type: "thinking", thinking: truncateUtf8(ame.content, limit) };
  } else if (ame.type === "toolcall_start") {
    rememberToolcallStart(blocks, idx, ame);
  } else if (ame.type === "toolcall_delta") {
    rememberToolcallDelta(blocks, idx, ame, cfg);
  } else if (ame.type === "toolcall_end") {
    rememberToolcallEnd(blocks, idx, ame);
  }
}

function clearAssistantDraft(room) {
  if (room) room.assistantDraft = null;
}

/* ---------------- local 通道（7001） ---------------- */
function startLocalServer(cfg, rooms, store, ctx, onListening, onError) {
  const index = ctx.index;
  const devices = ctx.devices;
  // 页面外通知编排器（R2-2）：只观察下方 event 出口的事件流，未配 webhook 时整体禁用、零行为变化。
  const notifier = createNotifier(cfg, { log });
  const clearActive = (room) => {
    if (!room || !room.deviceId) return;
    const dev = devices.get(room.deviceId);
    if (dev && dev.activeRoomId === room.id) dev.activeRoomId = null;
  };
  const noteActive = (room) => {
    if (!room || !room.deviceId) return;
    const dev = devices.get(room.deviceId);
    if (dev) dev.activeRoomId = room.id;
  };
  /** 宿主异常断开 / 房间关闭：收起队列、任务清单、子智能体状态并合成弹窗关闭。
   *  不清 assistantDraft/runningTools——socket 重连后仍要补发进行中的气泡与工具；
   *  但 queue/taskList/agentState/remoteQueue/uiPrompt 都属于“本机还在跑”的瞬时状态，不能留给晚到的观众。 */
  const broadcastClearedSessionState = (room, { settled = false } = {}) => {
    if (!room) return;
    const sendEvent = (event) => broadcast(room.viewers, { type: "room_event", room: room.id, event }, cfg);
    sendEvent({ type: "queue_update", steering: [], followUp: [] });
    sendEvent({ type: "remote_queue_state", rev: 0, items: [] });
    sendEvent({ type: "task_list_state", tasks: [] });
    sendEvent({ type: "agent_state", agents: [] });
    if (room.uiPrompt) sendEvent({ type: "ui_prompt_end" });
    // 在开的每个 dialog 逐槽合成关闭（outcome=gone）：前端按 id 摘卡，不留幽灵弹窗
    for (const slot of takeDialogs(room)) {
      const ev = { type: "dialog_close", dialogId: slot.dialogId, outcome: "gone", synthetic: true };
      sendEvent(ev);
      // 合成关闭也喂一遍编排器释放 dialog 去重键（C-3）：否则宿主重连后若复用同一
      // dialogId 重开，observe 会误判"已推过"而漏推，只能干等 30 分钟 TTL 过期。
      try { notifier.observe(room, ev); } catch (e) { log("页面外通知观察失败:", e.message); }
    }
    room.extStatus = null;
    // 注意：合成的 agent_settled 只广播给 viewer，不喂 notifier——宿主异常断开不等于
    // 回合"完成/出错"，喂了会把断线误报成回合落定。dialog 去重键靠上面的 close 释放。
    if (settled) sendEvent({ type: "agent_settled" });
    room.queue = null;
    room.taskList = null;
    room.agentState = null;
    room.remoteQueue = null;
    room.uiPrompt = null;
    // P9 A：合成关闭也要让别端看到摘要变空（room_waiting 每帧全量）
    broadcastRoomWaiting(rooms, room, cfg);
  };
  const wss = new WebSocketServer({ port: cfg.localPort, host: cfg.localHost || "127.0.0.1", maxPayload: cfg.localMaxPayloadBytes });
  // 端口被占用必须让调用方知道：startRelay 走 reject → main 打印并退出（或测试里按失败处理）。
  // 没给 onError 的直接调用方保持旧行为（默认退出，exitOnListenError 可关）。
  wss.on("error", (e) => {
    console.error("[relay] local 通道失败:", e.message);
    if (typeof onError === "function") onError(e);
    else if (cfg.exitOnListenError !== false) process.exit(1);
  });
  wss.on("listening", () => {
    log(`local 通道监听 :${wss.address().port}`);
    if (onListening) onListening(wss.address().port);
  });

  /** 断开属于某台设备的本机连接（窗口、扩展）；tokenOnly 只断用设备令牌登录的（重新配对后它们的令牌已作废） */
  ctx.dropDevice = (deviceId, { tokenOnly = false, except = null } = {}) => {
    let n = 0;
    for (const c of wss.clients) {
      if (c === except) continue;
      const byToken = !!(c._state && c._state.boundDeviceId === deviceId);
      const claimed = c._deviceId === deviceId || !!(c._room && c._room.local === c && c._room.deviceId === deviceId);
      if (!byToken && (tokenOnly || !claimed)) continue;
      send(c, errorFrame("device_revoked"), cfg);
      try { c.close(4003, "device revoked"); } catch {}
      n++;
    }
    return n;
  };

  /** 用设备令牌登录的连接只能以绑定的那台设备身份说话：别的 id 一律丢帧 */
  const mismatch = (ws, what, claimed) => {
    log("拒绝 " + what + "：设备身份与令牌不符", "bound=" + ws._state.boundDeviceId, "claimed=" + (claimed || "-"));
    send(ws, errorFrame("device_mismatch", "设备身份与令牌不符（" + what + "）"), cfg);
  };

  /** legacy（共享 localToken）不能碰"配过对"的设备：设备身份只认设备令牌。
   *  pairedAt 是持久标记，撤销令牌后仍然生效，所以撤销不会给 legacy 留后门。 */
  const legacyPaired = (accountId, deviceId) => {
    if (!deviceId) return false;
    try {
      if (index.hasDeviceToken(accountId, deviceId)) return true;
      const row = index.getDeviceRow(accountId, deviceId);
      return !!(row && Number(row.pairedAt) > 0);
    } catch {
      return false;
    }
  };
  const rejectLegacyPaired = (ws, what, deviceId) => {
    log("拒绝 legacy " + what + "：设备已配对", deviceId);
    send(ws, errorFrame("device_mismatch", "这台设备已经配对，必须用设备令牌连接（共享 localToken 不能冒用；" + what + "）"), cfg);
  };

  /* ---------------- 设备身份钥（加密地基阶段 1，设计 §3） ----------------
   * 名册钥的唯一读口：keys.sign.pub 是 Ed25519 spki der base64；sign.revokedAt 一旦
   * 写下（device_revoke 写），该钥在配对/鉴权/轮换所有路径上都按已撤销论处。 */

  /** 读设备行（反查/名册异常时按无行处理，绝不让钥路径把连接处理掀翻） */
  const deviceRowSafe = (accountId, deviceId) => {
    try {
      return index.getDeviceRow(accountId, deviceId);
    } catch {
      return null;
    }
  };

  /** 设备已登记且未撤销的钥：{signPub, boxPub, addedAt}；无钥/已撤销返回 null */
  const activeKeysOf = (row) => {
    const sign = row && row.keys && row.keys.sign;
    if (!sign || typeof sign.pub !== "string" || !sign.pub || sign.revokedAt) return null;
    const box = row.keys.box;
    return {
      signPub: sign.pub,
      boxPub: box && typeof box.pub === "string" ? box.pub : "",
      addedAt: Number(sign.addedAt) || 0,
    };
  };

  /** 设备登记过钥但已被撤销（device_revoke 写 sign.revokedAt） */
  const revokedKeysOf = (row) => {
    const sign = row && row.keys && row.keys.sign;
    return !!(sign && typeof sign.pub === "string" && sign.pub && sign.revokedAt);
  };

  /** 连接在 local 通道上的设备 id：令牌/钥绑定优先，其次窗口登记，再次房间归属 */
  const connDeviceId = (c) => {
    const s = c && c._state;
    return (s && s.boundDeviceId) || c._deviceId || (c._room && c._room.deviceId) || "";
  };

  /** 本账号在线持钥端（local 连接）：[{ws, deviceId, keyFp}]。内容钥路由的端点表，
   * 现算不缓存——连接数小，名册钥又是刚性事实，不值得再养一份会漂移的副本。 */
  const keyEndpoints = (accountId) => {
    const out = [];
    for (const c of wss.clients) {
      const s = c._state;
      if (!s || !s.authed || c.readyState !== 1) continue;
      const deviceId = connDeviceId(c);
      if (!deviceId) continue;
      const row = deviceRowSafe(boundAccount(index, devices, deviceId, cfg.accountId), deviceId);
      const keys = activeKeysOf(row);
      if (!keys) continue;
      if (boundAccount(index, devices, deviceId, cfg.accountId) !== accountId) continue;
      out.push({ ws: c, deviceId, keyFp: keyFingerprint(keys.signPub) });
    }
    return out;
  };

  /**
   * 内容钥 grant 路由（设计 §3.2/§7 透传骨架）：按目标指纹投给在线持钥端，原样转发、
   * 不解析 blob、不落盘。投不到返回 false，调用方给发送方明确回执（不静默吞）。
   * 经 ctx 暴露给 viewer 通道（阶段 2 的观看端持钥端接入时复用同一路由）。
   */
  const routeContentKeyGrant = (accountId, toKeyFp, frame) => {
    // Deliver to EVERY endpoint holding the target fingerprint, never just the
    // first match: one device normally holds two local connections with the
    // same keyFp -- the attach window connection (which does not process grant
    // frames) and the extension bridge connection (which does) -- and first-
    // match routing silently drops the grant whenever the window connected
    // first. Delivery is idempotent (receivers store the same ACK; non-
    // processing connections ignore the frame). Keyed viewers are first-class
    // targets too and always get their matching copies, not only when no local
    // end matched. Returns true iff at least one send succeeded, so callers
    // still answer "offline" when the target is genuinely unreachable.
    let delivered = false;
    for (const e of keyEndpoints(accountId)) {
      if (e.keyFp !== toKeyFp) continue;
      if (send(e.ws, frame, cfg)) delivered = true;
    }
    if (typeof ctx.viewerKeyEndpoints === "function") {
      for (const e of ctx.viewerKeyEndpoints(accountId)) {
        if (e.keyFp !== toKeyFp) continue;
        if (send(e.ws, frame, cfg)) delivered = true;
      }
    }
    return delivered;
  };
  ctx.routeContentKeyGrant = routeContentKeyGrant;
  // The viewer channel needs the local endpoint list to broadcast content_key_request
  // frames from viewers to the account's keyed devices.
  ctx.localKeyEndpoints = keyEndpoints;

  /** content_key_grant 帧的透传清洗：只认 {to, nonce, ct} 三个字符串字段并按 limits 钉尺寸；
   *  blob 本体对 relay 不透明——只量字节，不解内容。不合规返回 null。
   *  可选 fromBoxPub（阶段 2 的观看端发送方在 blob 外自带其 box 公钥时）合规则原样保留，
   *  不合规只丢该字段不挡整帧——收端缺它解不开包裹，但那是发送方的事，relay 不代偿。 */
  const cleanKeyGrant = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const to = typeof raw.to === "string" ? raw.to : "";
    const nonce = typeof raw.nonce === "string" ? raw.nonce : "";
    const ct = typeof raw.ct === "string" ? raw.ct : "";
    if (!/^[0-9a-f]{16}$/.test(to) || !nonce || nonce.length > 64 || !ct) return null;
    const ctBytes = b64buf(ct);
    if (!ctBytes || ctBytes.length > PROTOCOL.limits.wrappedKeyMaxBytes) return null;
    const out = { to, nonce, ct };
    if (typeof raw.fromBoxPub === "string" && p256PubKey(raw.fromBoxPub)) out.fromBoxPub = raw.fromBoxPub;
    return out;
  };
  ctx.cleanKeyGrant = cleanKeyGrant;

  /**
   * 配对设备信息规整（handlePair 与 pair_request 同口径）：id 可选但给了就必须 safeId；
   * name 必填（设备没给时用码条目里预置的名字兜底），platform 必填。不合规返回 null。
   */
  const cleanPairDevice = (device, fallbackName) => {
    const raw = device && typeof device === "object" ? device : {};
    const wantId = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = (typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName || "").slice(0, MAX_DEVICE_NAME);
    const platform = normalizePlatform(raw.platform);
    if ((wantId && !safeId(wantId)) || !name || !platform) return null;
    return { wantId, name, platform };
  };

  /**
   * 配对签发共用段：handlePair（设备拿手输码来消费）与 viewer 的 pair_approve（手机批准
   * 二维码链接的 pending 条目）共用，保证两条路径的防接管校验与签发口径完全一致，不写第二份。
   * 流程：定设备 id 与绑定账号 → 重新配对必须用 checkDeviceToken 核验出示的旧令牌 →
   * 签发新令牌（只存 sha256 哈希）→ 登记设备 → 删码（一次性）→ 踢掉该设备旧令牌连接 → 广播名册。
   * 返回 {ok:true, accountId, deviceId, deviceToken} 或 {ok:false, code, error}；
   * 失败一律不删码、不签发，调用方决定怎么回执（handlePair 是码可重试，approve 路径会作废条目）。
   */
  const issueForPairEntry = ({ code, entry, cleaned, presentedToken, exceptWs, keys }) => {
    const now = Date.now();
    const deviceId = cleaned.wantId || crypto.randomUUID();
    const accountId = boundAccount(index, devices, deviceId, entry.accountId);
    // 设备身份钥（阶段 1）：keys 是调用方已清洗（且 pop 已验签）的公钥材料，无 keys = 旧令牌路径。
    const prevRow = deviceRowSafe(accountId, deviceId);
    const prevKeys = activeKeysOf(prevRow);
    const prevRevoked = revokedKeysOf(prevRow);
    if (!keys && prevKeys) {
      // 已启用密钥的设备不许经旧配对路径降级回令牌（降级即绕过，设计 §3.3 双轨铁律）
      log("拒绝重新配对：设备已启用密钥配对，旧路径不许降级", accountId, deviceId);
      return { ok: false, code: "device_mismatch", error: "这台设备已启用密钥配对，不能用旧方式重新配对（请用新版 attach；确需重来先在管理端撤销该设备）" };
    }
    if (keys && prevKeys && prevKeys.signPub !== keys.signPub) {
      // 钥已登记且未撤销时配对不许换钥：换钥走 key_update（旧钥签名）或先撤销再配对（§3.5）
      log("拒绝重新配对：设备钥已登记，配对换钥被拒", accountId, deviceId);
      return { ok: false, code: "device_mismatch", error: "这台设备的钥已登记且未撤销，配对不能换钥（换钥请用 key_update，或先撤销设备再重新配对）" };
    }
    // 已知 deviceId + 还有有效令牌：这是一次"替换/重新配对"，必须出示旧设备令牌。
    // 否则任何人拿一个自己生成的配对码就能接管网页名册里看到的那台设备。
    // 例外：带 keys 且公钥与已登记的一致时，pop（调用方已验）就是持有证明，等同旧令牌核验。
    let replacing = false;
    try {
      replacing = index.hasDeviceToken(accountId, deviceId);
    } catch {}
    if (replacing && !(keys && prevKeys && prevKeys.signPub === keys.signPub)) {
      const oldToken = typeof presentedToken === "string" ? presentedToken : "";
      const verified = oldToken ? checkDeviceToken(index, devices, cfg, deviceId, oldToken) : { ok: false };
      if (!verified.ok) {
        log("拒绝重新配对：缺少或错误旧设备令牌", accountId, deviceId);
        return { ok: false, code: "device_mismatch", error: "这台设备已经配过对；重新配对需要旧设备令牌（先撤销或在本机 attach --pair 时带上原令牌）" };
      }
    }
    if (keys) {
      // 钥设备签发：登记公钥、停发令牌（新令牌不签发、已有令牌行一并作废，§3.4），其余口径与令牌路径一致。
      // hasKeyHolder：本次登记之前，本账号是否已有「其他」设备登记了未撤销的公钥——
      // 在册持钥端存在的代理信号。relay 没有也不该有 ACK 本身，只能报存在性；attach
      // 据此不自生成 ACK（第二台钥设备再各生成一把就是账号内容钥分叉），改走上线索取。
      let hasKeyHolder = false;
      try {
        for (const row of index.listDevices(accountId)) {
          if (!row || row.id === deviceId) continue;
          if (activeKeysOf(row)) { hasKeyHolder = true; break; }
        }
      } catch {}
      try {
        const prevFps = Array.isArray(prevRow && prevRow.prevKeyFps) ? [...prevRow.prevKeyFps] : [];
        if (prevRevoked && prevRow.keys && prevRow.keys.sign && typeof prevRow.keys.sign.pub === "string") {
          const oldFp = keyFingerprint(prevRow.keys.sign.pub);
          if (oldFp !== keyFingerprint(keys.signPub) && !prevFps.includes(oldFp)) prevFps.push(oldFp);
        }
        const rosterKeys = {
          sign: { alg: "ed25519", pub: keys.signPub, addedAt: prevKeys && prevKeys.addedAt ? prevKeys.addedAt : now },
          box: { alg: "p256", pub: keys.boxPub },
        };
        index.revokeDeviceTokens(accountId, deviceId);
        index.touchAccount(accountId);
        index.upsertDevice(accountId, {
          id: deviceId,
          name: cleaned.name,
          platform: cleaned.platform,
          pairedAt: now,
          keys: rosterKeys,
          prevKeyFps: prevFps.length ? prevFps.slice(-8) : undefined,
        });
      } catch (e) {
        log("配对登记公钥失败（配对码保留，可重试）:", e.message);
        return { ok: false, code: "server_error", error: "设备公钥保存失败" };
      }
      ctx.pairCodes.delete(code); // 只能用一次
      ctx.dropDevice(deviceId, { tokenOnly: true, except: exceptWs });
      log("设备配对（密钥）:", accountId, deviceId, cleaned.name, cleaned.platform, "keyFp", keyFingerprint(keys.signPub));
      rooms.broadcastRoomList();
      return { ok: true, accountId, deviceId, keyRegistered: true, hasKeyHolder };
    }
    const deviceToken = crypto.randomBytes(PROTOCOL.limits.deviceTokenBytes).toString("base64url");
    try {
      index.issueDeviceToken(accountId, deviceId, sha256hex(deviceToken));
      index.touchAccount(accountId);
      index.upsertDevice(accountId, { id: deviceId, name: cleaned.name, platform: cleaned.platform, pairedAt: now });
    } catch (e) {
      log("配对写入失败（配对码保留，可重试）:", e.message);
      return { ok: false, code: "server_error", error: "设备令牌保存失败" };
    }
    ctx.pairCodes.delete(code); // 只能用一次
    ctx.dropDevice(deviceId, { tokenOnly: true, except: exceptWs });
    log("设备配对:", accountId, deviceId, cleaned.name, cleaned.platform);
    rooms.broadcastRoomList();
    return { ok: true, accountId, deviceId, deviceToken };
  };
  // viewer 通道的 pair_approve 经 ctx 调用同一签发段（与 ctx.dropDevice 同款跨通道共用方式）
  ctx.issuePairEntry = issueForPairEntry;

  /** 撤下某条连接挂着的二维码待链接码：出示端断开/重复申请时调用，码随连接生死，不悬空。 */
  const dropPairPending = (ws) => {
    for (const [code, e] of ctx.pairCodes) {
      if (e.pending && e.pending.ws === ws) ctx.pairCodes.delete(code);
    }
  };

  /** 配对：未鉴权连接的第一帧。校验配对码 → 签发设备令牌（只存 hash）→ 回 pair_result 后关闭连接 */
  const handlePair = (ws, msg, source) => {
    clearTimeout(ws._state.authTimer);
    const reply = (frame) => {
      send(ws, frame, cfg);
      try { ws.close(1000, "pair done"); } catch {}
    };
    const fail = (code, error) => reply({ type: "pair_result", ok: false, code, error: error || PROTOCOL.errors[code].message });
    const now = Date.now();
    if (pairSourceBlocked(ctx.pairFailures, source, now)) return fail("rate_limited", "配对尝试太频繁，请一分钟后再试");
    const code = normalizePairCode(msg.code);
    const entry = code ? ctx.pairCodes.get(code) : null;
    if (!entry || entry.expiresAt <= now) {
      notePairFailure(ctx.pairFailures, source, now);
      if (entry) ctx.pairCodes.delete(code);
      log("配对失败:", source, entry ? "配对码过期" : "配对码无效");
      return fail(entry ? "pair_expired" : "pair_invalid");
    }
    const cleaned = cleanPairDevice(msg.device, entry.name);
    if (!cleaned) {
      return fail("bad_args", "设备信息不完整：需要 name、platform，id 只能用字母数字和 ._-");
    }
    // 带 keys = 密钥配对（阶段 1）：先清洗公钥、再验持有证明（对裸码的 Ed25519 签名），
    // 不过一律不登记——没有私钥的人把别人的公钥填进来也登记不上。
    let keys;
    if (msg.keys != null) {
      keys = cleanPairKeys(msg.keys);
      if (!keys) return fail("bad_args", "公钥材料不合规：需要 Ed25519 签名公钥与 P-256 box 公钥（spki der base64）及 pop 签名");
      if (!verifyEd25519(keys.signPub, popPayload(code), keys.pop)) {
        notePairFailure(ctx.pairFailures, source, now);
        log("配对失败：pop 验签不过", source);
        return fail("auth_failed", "公钥持有证明（pop）验签失败：签名与所登记的公钥不匹配");
      }
    }
    const r = issueForPairEntry({ code, entry, cleaned, presentedToken: msg.deviceToken, exceptWs: ws, keys });
    if (!r.ok) return fail(r.code, r.error);
    if (r.keyRegistered) {
      reply({ type: "pair_result", ok: true, accountId: r.accountId, deviceId: r.deviceId, keyRegistered: true, hasKeyHolder: !!r.hasKeyHolder });
      return;
    }
    reply({ type: "pair_result", ok: true, accountId: r.accountId, deviceId: r.deviceId, deviceToken: r.deviceToken });
  };

  /**
   * 二维码链接申请：未鉴权连接的预鉴权帧（与 pair 并列）。relay 生成与 pair_create 同表、
   * 同 TTL 的码，条目绑定本连接（pending），连接保持开启等手机端 pair_approve 核销；
   * 连接断开即删码（close 处理里 dropPairPending）。失败回 pair_request_result{ok:false,code}，
   * 连接不关——出示端可以改正后在本连接重试。
   */
  const handlePairRequest = (ws, msg, source) => {
    clearTimeout(ws._state.authTimer);
    const fail = (code, error) => send(ws, { type: "pair_request_result", ok: false, code, error: error || PROTOCOL.errors[code].message }, cfg);
    const now = Date.now();
    if (pairSourceBlocked(ctx.pairFailures, source, now)) return fail("rate_limited", "配对尝试太频繁，请一分钟后再试");
    // 一条连接只挂一个待链接条目：重复申请先撤旧码，免得一个终端占着多个码位
    dropPairPending(ws);
    const cleaned = cleanPairDevice(msg.device, "");
    if (!cleaned) {
      notePairFailure(ctx.pairFailures, source, now);
      return fail("bad_args", "设备信息不完整：需要 name、platform，id 只能用字母数字和 ._-");
    }
    for (const [k, e] of ctx.pairCodes) if (e.expiresAt <= now) ctx.pairCodes.delete(k);
    if (ctx.pairCodes.size >= PAIR_CODES_MAX) return fail("rate_limited", "未使用的配对码太多，等旧的过期后再生成");
    // 带 keys = 密钥配对（阶段 1）：pop 签的是裸码、码在申请帧到达前 relay 还没生成——
    // 所以带钥申请必须自带配对码（设备生成并签名），relay 验 pop 后采用该码；
    // 核对字随之升级 SAS v2（绑握手记录）。不带 keys 的旧申请仍由 relay 生成码、用 v1 核对字，逐字节不变。
    let keys;
    let code;
    if (msg.keys != null) {
      keys = cleanPairKeys(msg.keys);
      if (!keys) return fail("bad_args", "公钥材料不合规：需要 Ed25519 签名公钥与 P-256 box 公钥（spki der base64）及 pop 签名");
      code = normalizePairCode(msg.code);
      if (!code) return fail("bad_args", "带公钥申请链接码时必须自带配对码（pop 签的就是它），请重新生成后再申请");
      if (ctx.pairCodes.has(code)) return fail("pair_invalid", "自带的配对码已被占用，请换一个重新申请");
      if (!verifyEd25519(keys.signPub, popPayload(code), keys.pop)) {
        notePairFailure(ctx.pairFailures, source, now);
        log("链接码申请失败：pop 验签不过", source);
        return fail("auth_failed", "公钥持有证明（pop）验签失败：签名与所登记的公钥不匹配");
      }
    } else {
      code = newPairCode(ctx.pairCodes);
    }
    const expiresAt = now + (cfg.pairCodeTtlMs || PROTOCOL.limits.pairCodeTtlMs);
    // 账号只认 relay 配置：设备侧申请不能指定账号，也不采信客户端上报的 accountId
    const accountId = normalizeAccount(cfg.accountId);
    // 重新配对时 attach 会带上 .env 里的旧设备令牌：先存进 pending，approve 签发前由共用段核验
    const presentedToken = typeof msg.deviceToken === "string" ? msg.deviceToken : "";
    const pending = { ws, device: cleaned, deviceToken: presentedToken };
    if (keys) pending.keys = { signPub: keys.signPub, boxPub: keys.boxPub };
    ctx.pairCodes.set(code, { accountId, name: cleaned.name, expiresAt, pending });
    const digits = keys ? pairCheckDigitsV2(code, keys.signPub, keys.boxPub) : pairCheckDigits(code);
    // 日志不打印码本身（与 pair_create 同口径）；核对字是派生值，可以记
    log("设备申请二维码链接码:", cleaned.name, cleaned.platform, "核对字", digits, "有效至", new Date(expiresAt).toISOString());
    send(ws, { type: "pair_request_result", ok: true, code: formatPairCode(code), expiresAt, checkDigits: digits }, cfg);
  };

  const registered = (ws, room) => {
    const info = store.info(room.id);
    send(ws, { type: "room_registered", room: room.id, epoch: room.epoch, rev: info.rev, seq: info.seq, msgCount: info.msgCount, firstHash: info.firstHash, lastHash: info.lastHash, tailHashes: store.tailHashes(room.id), enc: info.enc || 0 }, cfg);
  };

  /** Enc rooms (design sections 5/7): when a room becomes encrypted (register
   *  declaration or migration), viewers that never declared crypto.content are
   *  evicted with a crypto_required frame — they must never receive ciphertext
   *  snapshots, and re-subscribing hits the same gate in viewer.js. */
  const evictIncapableViewers = (room) => {
    for (const v of [...room.viewers]) {
      if (hasCap(v, "crypto.content")) continue;
      send(v, { type: "error", code: "crypto_required", retryable: false, room: room.id }, cfg);
      room.viewers.delete(v);
      if (v._room === room) v._room = null;
      if (v._state) v._state.room = null;
    }
  };

  /** Snapshot recipients for a room: everyone watching, except that enc rooms
   *  only ever send snapshot frames to crypto.content connections. */
  const snapViewers = (room) => {
    if (store && store.encInfo(room.id)) return [...room.viewers].filter((v) => hasCap(v, "crypto.content"));
    return room.viewers;
  };

  /** 快照落地后同步给观众：换代/seed → 全量；追加 → 增量（delta，baseSeq 对不上的 viewer 自己带 since 重订阅）。
   *  全量快照之后、工具执行补发之前，补上还在写的助手正文和工具参数（增量不补）。
   *  然后补进行中的工具、自动重试、本机弹窗、compaction_start。 */
  const publishSnapshot = (room, r) => {
    rooms.invalidate(room.id);
    if (!room.viewers.size) return;
    let sent = false;
    let full = false;
    if (r.reset || r.seeded) {
      const snap = store.snapshot(room.id, { limit: cfg.maxSnapshotRecords, maxBytes: cfg.maxSnapshotBytes });
      broadcast(snapViewers(room), snapshotFrame(room, snapshotBodyFrom(snap)), cfg);
      sent = true;
      full = true;
    } else if (r.merged) {
      const info = store.info(room.id);
      const em = store.encInfo(room.id);
      const encFields = em ? { enc: 1, keyInfo: { ackFp: em.ackFp || null, rckWrap: em.rckWrap || null } } : {};
      broadcast(snapViewers(room), snapshotFrame(room, snapshotBodyFrom({ rev: info.rev, seq: info.seq, truncated: false, delta: true, baseSeq: r.baseSeq, items: r.items, ...encFields })), cfg);
      sent = true;
    }
    if (sent) {
      for (const w of room.viewers) {
        // 快照之后补最后一份任务清单与子智能体状态：全量/增量都补，新观众和重连都不会丢状态
        sendCachedTaskList(w, room, cfg);
        sendCachedAgentState(w, room, cfg);
        if (full) sendCachedAssistant(w, room, cfg, store);
        sendCachedTools(w, room, cfg);
        sendCachedToolEnds(w, room, cfg);
        sendCachedAutoRetry(w, room, cfg);
        sendCachedUiPrompt(w, room, cfg);
        sendCachedDialogs(w, room, cfg);
        sendCachedExtStatus(w, room, cfg);
        sendCachedCompaction(w, room, cfg);
      }
    }
  };

  wss.on("connection", (ws, req) => {
    const source = requestSource(req);
    attachCommon(ws, cfg, {
      onMessage(msg) {
        const s = ws._state;
        if (!s.authed) {
          if (msg.type === "pair") {
            handlePair(ws, msg, source);
            return;
          }
          if (msg.type === "pair_request") {
            handlePairRequest(ws, msg, source);
            return;
          }
          const fail = (code, error) => {
            send(ws, { type: "auth_result", ok: false, error: error || PROTOCOL.errors[code].message, code }, cfg);
            ws.close(4003, "unauthorized");
          };
          // 挑战-签名鉴权（加密地基阶段 1，设计 §3.3）：auth 带 keyFp 先领挑战，
          // auth_response 带签名回来验。nonce 只活在连接内存里、用后即删（无论成败），
          // 总预算与 10 秒未鉴权截止（attachCommon 的 authTimer）共用一本账、不延长。
          if (msg.type === "auth_response") {
            const pend = s.keyAuth;
            delete s.keyAuth;
            if (!pend) return fail("auth_failed", "没有待验签的挑战，请重新发起 auth");
            if (Date.now() > pend.expiresAt) return fail("auth_failed", "鉴权挑战已过期，请重连后重试");
            const row = deviceRowSafe(pend.accountId, pend.deviceId);
            if (revokedKeysOf(row)) return fail("device_revoked");
            const keys = activeKeysOf(row);
            if (!keys || keyFingerprint(keys.signPub) !== pend.keyFp) return fail("device_mismatch");
            if (!verifyEd25519(keys.signPub, authPayload(pend.deviceId, pend.nonce, pend.clientNonce), msg.sig)) {
              log("钥鉴权验签失败:", pend.deviceId);
              return fail("auth_failed", "签名不正确");
            }
            const protoError = helloVersionError(pend.hello);
            if (protoError) {
              log("local 协议版本过低，拒绝握手:", protoError.message, "来源:", source);
              return fail(protoError.code, protoError.message);
            }
            s.authed = true;
            s.stream = true;
            Object.assign(s, parseHello(pend.hello));
            clearTimeout(s.authTimer);
            s.auth = "key";
            s.boundDeviceId = pend.deviceId;
            s.accountId = pend.accountId;
            const res = { type: "auth_result", ok: true, proto: PROTOCOL.proto, caps: RELAY_CAPS, boot: rooms.boot, auth: "key", deviceId: pend.deviceId };
            // §7: key-authed connections learn the account's currently agreed ackFp
            // (null while unknown or diverged) so the end can reconcile its own copy.
            res.ackFp = ackTrackerOf(ctx).knownAckFp(pend.accountId);
            if (cfg.serverName) res.serverName = cfg.serverName;
            send(ws, res, cfg);
            log("local 已认证 key", pend.deviceId, helloText(s));
            return;
          }
          // Key challenge in flight (the auth frame was accepted, the
          // client still owes auth_response): business frames pipelined
          // behind the auth frame -- an optimistic client sends
          // room_register / state / usage in the same burst -- are dropped
          // silently. They are never processed, but they must not be
          // answered with an auth_result failure or kill the connection
          // either: a legitimate auth is in flight on this socket, and the
          // client reads that failure as a credential rejection. Logged
          // at most once per connection.
          if (s.keyAuth && msg.type !== "auth") {
            if (!s.preAuthDropLogged) {
              s.preAuthDropLogged = true;
              log("未认证连接在钥挑战待验期间发来业务帧，已丢弃（不处理）:", msg.type, "conn=" + s.connId);
            }
            return;
          }
          if (msg.type !== "auth" || msg.role !== "local") return fail("auth_failed", "token 不正确");
          if (typeof msg.keyFp === "string" && msg.keyFp) {
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            if (!deviceId || !safeId(deviceId)) return fail("device_mismatch", "钥鉴权需要合法的 deviceId");
            const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
            const row = deviceRowSafe(accountId, deviceId);
            if (revokedKeysOf(row)) return fail("device_revoked");
            const keys = activeKeysOf(row);
            if (!keys) return fail("device_mismatch", "这台设备没有登记公钥，无法用密钥登录（先完成密钥配对）");
            if (keyFingerprint(keys.signPub) !== msg.keyFp) return fail("device_mismatch", "出示的钥指纹与名册登记不一致");
            const clientNonce = b64buf(msg.clientNonce);
            if (!clientNonce || clientNonce.length < 16 || clientNonce.length > 64) return fail("auth_failed", "clientNonce 不合规（需 16–64 字节的 base64）");
            const nonce = crypto.randomBytes(PROTOCOL.limits.authNonceBytes);
            s.keyAuth = { deviceId, accountId, keyFp: msg.keyFp, nonce, clientNonce, hello: msg, expiresAt: Date.now() + 10000 };
            send(ws, { type: "auth_challenge", nonce: nonce.toString("base64"), expiresAt: s.keyAuth.expiresAt }, cfg);
            return;
          }
          const deviceToken = typeof msg.deviceToken === "string" ? msg.deviceToken : "";
          if (deviceToken) {
            // 带了设备令牌就只按令牌认：失败不退回共享 token，否则撤销形同虚设
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            // 双轨铁律（§3.3/§3.4）：已登记公钥的设备不许改走令牌——降级即绕过。
            // 停发时令牌行已一并作废，这里再钉一道显式拒绝，不依赖令牌表状态。
            if (deviceId && activeKeysOf(deviceRowSafe(boundAccount(index, devices, deviceId, cfg.accountId), deviceId))) {
              log("拒绝令牌登录：设备已启用密钥登录", deviceId);
              return fail("auth_failed", "这台设备已启用密钥登录，设备令牌已停用");
            }
            let r = { ok: false, code: "auth_failed" };
            try {
              if (deviceId) r = checkDeviceToken(index, devices, cfg, deviceId, deviceToken);
            } catch (e) {
              log("读设备令牌失败:", e.message);
            }
            if (!r.ok) {
              log("设备令牌鉴权失败:", deviceId || "-", r.code);
              return fail(r.code, r.code === "auth_failed" ? "设备令牌不正确" : "");
            }
            s.auth = "token";
            s.boundDeviceId = deviceId;
            s.accountId = r.accountId;
          } else if (cfg.allowLegacyLocal !== false && cfg.localToken && safeEqual(msg.token, cfg.localToken)) {
            s.auth = "legacy";
          } else {
            return fail("auth_failed", cfg.allowLegacyLocal === false ? "relay 只接受配对换来的设备令牌，请先配对" : "token 不正确");
          }
          // 低-12：鉴权通过后再判协议版本；显式过低必须拒绝，不能静默抬到 minProto。
          const protoError = helloVersionError(msg);
          if (protoError) {
            log("local 协议版本过低，拒绝握手:", protoError.message, "来源:", source);
            return fail(protoError.code, protoError.message);
          }
          s.authed = true;
          s.stream = true;
          Object.assign(s, parseHello(msg));
          clearTimeout(s.authTimer);
          const res = { type: "auth_result", ok: true, proto: PROTOCOL.proto, caps: RELAY_CAPS, boot: rooms.boot, auth: s.auth };
          if (cfg.serverName) res.serverName = cfg.serverName;
          if (s.boundDeviceId) res.deviceId = s.boundDeviceId;
          send(ws, res, cfg);
          log("local 已认证", s.auth, s.boundDeviceId || "", helloText(s));
          return;
        }
        switch (msg.type) {
          case "device_register": {
            // 窗口连接与房间连接互斥：这条 socket 已经在镜像某个 pi，就不能再当 attach 窗口
            if (ws._room) {
              log("拒绝 device_register：连接已绑定房间");
              send(ws, errorFrame("bad_args", "该连接已登记房间"), cfg);
              return;
            }
            const device = msg.device && typeof msg.device === "object" ? msg.device : null;
            const id = device && typeof device.id === "string" ? device.id.trim() : "";
            const name = device && typeof device.name === "string" ? device.name.trim().slice(0, MAX_DEVICE_NAME) : "";
            const platform = normalizePlatform(device && device.platform);
            if (!id || !name || !platform) {
              send(ws, errorFrame("bad_args", "设备登记字段不完整"), cfg);
              return;
            }
            if (s.boundDeviceId && id !== s.boundDeviceId) {
              mismatch(ws, "device_register", id);
              return;
            }
            if (!s.boundDeviceId && legacyPaired(boundAccount(index, devices, id, cfg.accountId), id)) {
              rejectLegacyPaired(ws, "device_register", id);
              return;
            }
            // 账号由服务端绑定：令牌登录的用令牌所在账号；已登记过的设备沿用索引里的账号，新设备落到本 relay 配置的账号（cfg.accountId）。
            // 上报的 accountId（包括首次登记）不采信，只在不一致时记一行日志。
            // 反查失败（名册读不了）不能掀翻整条 device_register：按新设备落到本 relay 账号
            let known = null;
            if (!s.accountId) {
              try {
                known = index.findDevice(id);
              } catch (e) {
                log("findDevice 失败，按新设备处理:", e.message);
              }
            }
            const accountId = s.accountId || (known && known.row ? known.accountId : normalizeAccount(cfg.accountId));
            const claimed = typeof msg.accountId === "string" ? msg.accountId.trim() : "";
            if (claimed && claimed !== accountId) log("device_register 上报的账号与服务端绑定不一致，已忽略:", id, "claimed=" + claimed, "bound=" + accountId);
            let dev = devices.get(id);
            if (!dev) {
              dev = blankDevice(accountId, id);
              devices.set(id, dev);
            }
            if (dev.conn && dev.conn !== ws) {
              const old = dev.conn;
              try { send(old, { type: "device_replaced" }, cfg); } catch {}
              try { old.close(4009, "device replaced"); } catch {}
            }
            if (ws._deviceId && ws._deviceId !== id) {
              const prev = devices.get(ws._deviceId);
              if (prev && prev.conn === ws) {
                prev.conn = null;
                prev.online = false;
              }
              // 换绑设备：旧设备的活动房间重发任务和 activeRoomId 一起作废。
              // 用 restartResend 而不是 cancelResend：后者会把正在等首帧快照的 viewer 一起丢掉，
              // 而房间的 local 是扩展那条 socket，重新向它要一次就能救活（见 restartResend 注释）
              if (prev && prev.activeRoomId) {
                restartResend(cfg, store, rooms.peek(prev.activeRoomId));
                prev.activeRoomId = null;
              }
            }
            // 被顶替的旧窗口：同样只作废它发起的那次重发，viewer 不受影响
            if (dev.activeRoomId && dev.conn && dev.conn !== ws) {
              restartResend(cfg, store, rooms.peek(dev.activeRoomId));
            }
            dev.accountId = accountId;
            dev.name = name;
            dev.platform = platform;
            dev.projects = cleanProjects(device.projects);
            // P9 B/C：attach 声明的能力、设备侧事实（PATH 里有没有 trash）、允许浏览的根目录。
            // features 只留 relay 关心的两个；browseRoots 复用 cleanProjects 的清洗（非空字符串/去重/单条上限），
            // 总条数按协议的 browseRootsMax 截断。
            dev.features = DEVICE_FEATURES.filter((c) => hasCap(ws, c));
            dev.trash = device.trash === true;
            dev.browseRoots = cleanProjects(device.browse && device.browse.roots)
              .slice(0, (PROTOCOL.limits && PROTOCOL.limits.browseRootsMax) || 8);
            dev.windowExpiresAt = Number.isFinite(Number(device.windowExpiresAt)) ? Number(device.windowExpiresAt) : null;
            dev.conn = ws;
            dev.online = true;
            dev.lastAttachAt = Date.now();
            if (!dev.activeRoomId || !(rooms.peek(dev.activeRoomId) && rooms.peek(dev.activeRoomId).online && rooms.peek(dev.activeRoomId).deviceId === id)) {
              dev.activeRoomId = null;
              for (const r of rooms.map.values()) {
                if (r.online && r.deviceId === id) dev.activeRoomId = r.id;
              }
            }
            ws._deviceId = id;
            try {
              index.touchAccount(accountId, dev.lastAttachAt);
              index.upsertDevice(accountId, {
                id,
                name,
                platform,
                projects: dev.projects,
                lastAttachAt: dev.lastAttachAt,
                // 设备令牌登录过的设备补上不可逆的 pairedAt（老索引里没有这个字段）：
                // 撤销令牌后 legacy 仍然不能冒用，而不是等下一次重新配对。
                pairedAt: s.boundDeviceId ? dev.lastAttachAt : undefined,
                updatedAt: dev.lastAttachAt,
              });
            } catch (e) {
              log("设备名册写入失败:", e.message);
            }
            log("设备登记:", accountId, id, name);
            rooms.broadcastRoomList();
            break;
          }
          case "session_manifest": {
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            if (!deviceId) {
              log("丢弃 session_manifest：无 deviceId");
              return;
            }
            if (s.boundDeviceId && deviceId !== s.boundDeviceId) {
              mismatch(ws, "session_manifest", deviceId);
              return;
            }
            if (!s.boundDeviceId && legacyPaired(boundAccount(index, devices, deviceId, cfg.accountId), deviceId)) {
              rejectLegacyPaired(ws, "session_manifest", deviceId);
              return;
            }
            const dev = devices.get(deviceId);
            // 账号以服务端登记为准（窗口连接 → dev.accountId；房间连接 → 索引反查；都没有 → 本 relay 配置的账号）；
            // 客户端上报的 accountId 不采信，持 localToken 不能写进别人账号
            const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
            const fromWindow = ws._deviceId === deviceId && dev && dev.conn === ws;
            let fromRoom = false;
            if (!fromWindow) {
              for (const r of rooms.map.values()) {
                if (r.online && r.deviceId === deviceId && r.local === ws) { fromRoom = true; break; }
              }
            }
            if (!fromWindow && !fromRoom) {
              log("丢弃 session_manifest：连接不属于该设备", deviceId);
              return;
            }
            try {
              // P9 B：attach 窗口发来的全量清单带 scope:"device" + root（设备会话根目录），
              // relay 据此对账（root 下缺失的会话打墓碑并清理服务器副本）；扩展/房间连接不带，行为照旧。
              const deviceScope = fromWindow && msg.scope === "device" && typeof msg.root === "string" && msg.root
                ? { root: msg.root, platform: dev ? dev.platform : "" }
                : null;
              const result = index.applyManifest(accountId, deviceId, {
                full: msg.full === true,
                updatedAt: msg.updatedAt,
                sessions: msg.sessions,
                removed: msg.removed,
                truncated: msg.truncated === true,
              }, Date.now(), deviceScope);
              if (result && result.stale) log("manifest_stale", deviceId, msg.updatedAt);
              else if (result && !result.ok) log("session_manifest 丢弃:", result.reason || "", deviceId);
              else {
                // 这一帧新打墓碑的会话（removed 或 deviceScope 对账）走同一个清理入口。
                // 在线房间由 purgeSessions 跳过；不清的话名册/正文/索引会一直留着已删会话。
                if (Array.isArray(result.tombstoned) && result.tombstoned.length) {
                  purgeSessions({ accountId, deviceId, ids: result.tombstoned, rooms, store, devices, index, cfg });
                }
                rooms.broadcastRoomList();
              }
            } catch (e) {
              log("session_manifest 写入失败（不影响转发）:", e.message);
            }
            break;
          }
          case "usage_snapshot": {
            // P10：extension 聚合快照（只含聚合计数）→ relay 校验/缓存/分发给等待 viewer
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            if (!deviceId) { log("丢弃 usage_snapshot：无 deviceId"); return; }
            if ((ws._deviceId && deviceId !== ws._deviceId) || (s.boundDeviceId && deviceId !== s.boundDeviceId)) {
              mismatch(ws, "usage_snapshot", deviceId);
              return;
            }
            const dev = devices.get(deviceId);
            const accountId = s.accountId || (dev && dev.accountId) || normalizeAccount(cfg.accountId);
            try { ctx.usage && ctx.usage.onSnapshot(deviceId, accountId, msg); } catch (e) { log("usage_snapshot 处理失败:", e && e.message); }
            break;
          }
          case "session_archive": {
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            if (!deviceId) return;
            if (s.boundDeviceId && deviceId !== s.boundDeviceId) {
              mismatch(ws, "session_archive", deviceId);
              return;
            }
            const dev = devices.get(deviceId);
            const fromWindow = ws._deviceId === deviceId && dev && dev.conn === ws;
            let fromRoom = false;
            if (!fromWindow) {
              for (const r of rooms.map.values()) {
                if (r.online && r.deviceId === deviceId && r.local === ws) { fromRoom = true; break; }
              }
            }
            if (!fromWindow && !fromRoom) return;
            const body = storeSessionArchive(dev, msg.session);
            if (body) broadcastSessionArchive(rooms, deviceId, body, cfg);
            break;
          }
          case "room_register": {
            if (ws._deviceId) {
              log("拒绝 room_register：连接已是设备窗口");
              send(ws, errorFrame("bad_args", "该连接已登记为设备窗口"), cfg);
              return;
            }
            const rid = String((msg.room && msg.room.id) || "");
            if (!safeId(rid)) {
              send(ws, errorFrame("bad_args", "房间 id 非法"), cfg);
              return;
            }
            const claimedDevice = msg.room && typeof msg.room.deviceId === "string" ? msg.room.deviceId.trim() : "";
            if (s.boundDeviceId && claimedDevice !== s.boundDeviceId) {
              mismatch(ws, "room_register", claimedDevice);
              return;
            }
            if (!s.boundDeviceId) {
              // 已有房间按房间归属判断，新房间按上报的 deviceId 判断：两条路都不能碰已配对设备。
              // 用 peek 而不是 get：被拒绝的登记不该顺手创建一条离线房间。
              const existing = rooms.peek(rid);
              const owner = (existing && existing.deviceId) || claimedDevice;
              if (legacyPaired(boundAccount(index, devices, owner, cfg.accountId), owner)) {
                rejectLegacyPaired(ws, "room_register", owner);
                return;
              }
            }
            const room = rooms.get(rid);
            if (room.local && room.local !== ws) {
              try {
                room.local.close(4009, "replaced by new local connection");
              } catch {}
            }
            // 同一 socket 改注册别的房间：先把旧房间下线，否则旧房间会变"永久在线"幽灵
            if (ws._room && ws._room !== room) {
              const old = ws._room;
              old.local = null;
              old.online = false;
              clearActive(old);
              broadcast(old.viewers, { type: "room_offline", room: old.id }, cfg);
              log("local 改注册房间，旧房间离线:", old.id);
            }
            room.local = ws;
            room.lastLocal = ws;
            room.online = true;
            room.label = (msg.room && msg.room.label) || room.label;
            room.cwd = (msg.room && msg.room.cwd) || room.cwd;
            room.deviceId = (msg.room && typeof msg.room.deviceId === "string" && msg.room.deviceId.trim()) ? msg.room.deviceId.trim() : null;
            // 房间账号同样由服务端绑定（按设备反查），不信 room.accountId
            room.accountId = boundAccount(index, devices, room.deviceId, cfg.accountId);
            if (msg.room && msg.room.deviceName) room.deviceName = String(msg.room.deviceName).slice(0, MAX_DEVICE_NAME);
            if (msg.room && msg.room.platform) room.platform = normalizePlatform(String(msg.room.platform)) || room.platform;
            noteActive(room);
            // 分支换代 epoch（扩展在 navigate_tree / 终端 /tree 之后递增）：同一扩展实例（instance）的
            // epoch 变了 → 存储整体重置，避免新旧分支消息并集。instance 变了（pi 重启/runtime 重载，
            // epoch 从 1 重来）不代表换分支：不清库，由扩展按 room_registered 的首尾 hash 决定续传还是全量。
            // 旧扩展不带 instance：沿用"epoch 变即重置"。
            const epoch = Number(msg.room && msg.room.epoch) || 0;
            const instance = msg.room && typeof msg.room.instance === "string" ? msg.room.instance : null;
            const generation = Number(msg.room && msg.room.generation) || 0;
            if (generation) room.generation = generation;
            const sameInstance = instance ? room.instance === instance : true;
            if (instance && room.instance && room.instance !== instance) {
              log("扩展实例更替:", room.id, room.instance, "→", instance);
              // A-2：清前有未读摘要时补广播一次 null，否则已连端的追踪器还留着旧落定
              if (clearSessionState(room)) broadcastRoomAttention(rooms, room, cfg);
            }
            if (epoch && room.epoch && epoch !== room.epoch && sameInstance) {
              try { store.reset(room.id); } catch (e) { log("存储重置异常:", e.message); }
              rooms.invalidate(room.id);
              if (clearSessionState(room)) broadcastRoomAttention(rooms, room, cfg);
              log("会话换代，重置存储:", room.id, room.epoch, "→", epoch);
            }
            if (epoch) room.epoch = epoch;
            if (instance) room.instance = instance;
            ws._room = room;
            // Enc declaration at register time (design section 5): the room meta
            // gains enc/ackFp/rckWrap. Two wire spellings are accepted — flat
            // fields on the room object ({enc:1, ackFp, rckWrap}) and a nested
            // enc object. Only crypto.content connections may declare it;
            // viewers already watching without the cap are evicted.
            const regEncDecl = msg.room && msg.room.enc
              ? (typeof msg.room.enc === "object" ? msg.room.enc : msg.room)
              : null;
            if (regEncDecl && store && typeof store.setEncMeta === "function") {
              if (!hasCap(ws, "crypto.content")) {
                log("拒绝 enc 声明（连接未声明 crypto.content）:", room.id);
                send(ws, { type: "error", code: "crypto_required", retryable: false, room: room.id }, cfg);
              } else if (store.setEncMeta(room.id, regEncDecl)) {
                evictIncapableViewers(room);
              }
            }
            log("房间注册:", room.id, room.label || "", "epoch", room.epoch);
            registered(ws, room);
            // O2 门控/开关补发：桥（重）连后内存状态已回默认——门控按当前订阅数重推，
            // 开关按 relay 存着的当前值重下达（从未下达过就不发，桥侧缺省即关）
            pushDialogGate(room, cfg, true);
            if (typeof room.dialogRemoteAnswer === "boolean") {
              send(ws, { type: "dialog_answer_switch", room: room.id, enabled: room.dialogRemoteAnswer }, cfg);
            }
            // G1/G2 开关补发（同 dialog_answer_switch 纪律）：从未下达过就不发，桥侧缺省即默认
            if (typeof room.askUserEnabled === "boolean") {
              send(ws, { type: "ask_user_switch", room: room.id, enabled: room.askUserEnabled }, cfg);
            }
            if (room.approvalGateSwitch) {
              send(ws, { type: "approval_gate_switch", room: room.id, ...room.approvalGateSwitch }, cfg);
            }
            rooms.broadcastRoomList();
            break;
          }
          case "event": {
            const room = ownRoom(ws, msg);
            if (!room || !msg.event || typeof msg.event !== "object") return;
            const type = String(msg.event.type || "");
            // Phase 3 gates (design sections 5/7):
            // - An enc room only accepts traffic from crypto.content connections;
            //   anything else is rejected per write with a crypto_required
            //   receipt and the room data is left untouched.
            // - A crypto-capable connection must not plant plaintext records
            //   into an enc room (message_end / remote_message envelope forms
            //   are mandatory there).
            // - Encrypted traffic skips image rewriting: there is no image
            //   inside a ct, and rewriting would break the h anchor.
            // - Plaintext rooms honor cryptoPlaintextRooms: readonly/deny
            //   reject record-bearing writes.
            const roomEncMeta = store ? store.encInfo(room.id) : null;
            if (roomEncMeta) {
              if (!hasCap(ws, "crypto.content")) {
                log("拒绝写入 enc 房间（连接未声明 crypto.content）:", room.id, type);
                send(ws, { type: "error", code: "crypto_required", retryable: false, room: room.id }, cfg);
                return;
              }
              if (type === "message_end" && !(msg.event.message && msg.event.message.enc === 1)) {
                log("拒绝明文 message_end 写入 enc 房间:", room.id);
                send(ws, { type: "error", code: "crypto_required", retryable: false, room: room.id }, cfg);
                return;
              }
              if (type === "remote_message" && !(typeof msg.event.h === "string" && typeof msg.event.ct === "string")) {
                log("拒绝明文 remote_message 写入 enc 房间:", room.id);
                send(ws, { type: "error", code: "crypto_required", retryable: false, room: room.id }, cfg);
                return;
              }
            } else {
              if ((type === "message_end" || type === "remote_message" || type === "tool_execution_end") &&
                  ((cfg && cfg.cryptoPlaintextRooms) || "allow") !== "allow") {
                log("拒绝明文房间写入（cryptoPlaintextRooms =", (cfg && cfg.cryptoPlaintextRooms) || "allow", "）:", room.id, type);
                send(ws, { type: "error", code: "unsupported", retryable: false, room: room.id, message: "plaintext room writes are disabled by the cryptoPlaintextRooms policy" }, cfg);
                return;
              }
              shrinkImagesDeep(msg.event);
            }
            if (type === "remote_message_failed") msg.event.code = failureCode(msg.event.code);
            if (REMOTE_MESSAGE_EVENTS.has(type) && "cid" in msg.event) {
              const cid = cleanCid(msg.event.cid);
              if (cid) msg.event.cid = cid;
              else delete msg.event.cid;
            }
            if (type === "queue_update") {
              try { rememberQueue(room, msg.event); } catch (e) { log("待发队列缓存失败:", e.message); }
            }
            if (type === "remote_queue_state") {
              try {
                rememberRemoteQueue(room, msg.event);
                // 直播也用清洗后的缓存帧：正文/图片元数据有上限，坏条目不会原样打给所有观众
                if (room.remoteQueue) msg.event = { type: "remote_queue_state", rev: room.remoteQueue.rev, items: room.remoteQueue.items };
              } catch (e) { log("远程待发缓存失败:", e.message); }
            }
            if (type === "task_list_state") {
              try { rememberTaskList(room, msg.event); } catch (e) { log("任务清单缓存失败:", e.message); }
            }
            if (type === "agent_state") {
              try { rememberAgentState(room, msg.event); } catch (e) { log("子智能体状态缓存失败:", e.message); }
            }
            if (type === "message_start") {
              try { rememberAssistantStart(room, msg.event); } catch (e) { log("进行中助手缓存失败:", e.message); }
            } else if (type === "message_update") {
              try { rememberAssistantDelta(room, msg.event, cfg); } catch (e) { log("进行中助手缓存失败:", e.message); }
            }
            if (type === "tool_execution_start") {
              try { rememberToolStart(room, msg.event); } catch (e) { log("进行中工具缓存失败:", e.message); }
            } else if (type === "tool_execution_update") {
              try { rememberToolUpdate(room, msg.event); } catch (e) { log("进行中工具缓存失败:", e.message); }
            } else if (type === "tool_execution_end") {
              forgetRunningTool(room, msg.event.toolCallId);
            } else if (type === "message_end") {
              const message = msg.event.message;
              if (message && typeof message === "object" && message.role === "toolResult") forgetRunningTool(room, message.toolCallId);
              if (message && typeof message === "object" && message.role === "assistant") clearAssistantDraft(room);
            } else if (type === "agent_settled") {
              clearRunningTools(room);
              clearAutoRetry(room);
              clearAssistantDraft(room);
            }
            if (type === "compaction_start") {
              try { rememberCompaction(room, msg.event); } catch (e) { log("压缩开始缓存失败:", e.message); }
            } else if (type === "compaction_end") {
              room.compaction = null;
            }
            if (type === "auto_retry_start") {
              try { rememberAutoRetry(room, msg.event); } catch (e) { log("自动重试缓存失败:", e.message); }
            } else if (type === "auto_retry_end") {
              clearAutoRetry(room);
            }
            if (type === "ui_prompt_start") {
              try { rememberUiPrompt(room, msg.event); } catch (e) { log("本机弹窗缓存失败:", e.message); }
              // P9 A：等待摘要变了（waitingPrompt 出现），广播全量
              broadcastRoomWaiting(rooms, room, cfg);
            } else if (type === "ui_prompt_end") {
              clearUiPrompt(room);
              // 兜底销槽：tap 若中途失效，dialog_close 可能永不到达；以 pi 的权威 end 信号
              // 关掉最旧一槽，避免幽灵卡常驻（正常路径下 dialog_close 先到，这里无槽可关）
              if (room.dialogs) {
                const ids = Object.keys(room.dialogs);
                if (ids.length) delete room.dialogs[ids[0]];
              }
              broadcastRoomWaiting(rooms, room, cfg);
            }
            if (type === "dialog_open") {
              try { rememberDialogOpen(room, msg.event); } catch (e) { log("弹窗观察缓存失败:", e.message); }
              // P9 A：多槽摘要变了（waiting 多/变了一条）
              broadcastRoomWaiting(rooms, room, cfg);
            } else if (type === "dialog_close") {
              try { cleanDialogCloseNote(msg.event); } catch (e) { log("弹窗关闭理由清洗失败:", e.message); }
              try { forgetDialog(room, msg.event.dialogId); } catch (e) { log("弹窗观察销槽失败:", e.message); }
              broadcastRoomWaiting(rooms, room, cfg);
            }
            if (type === "ext_status") {
              try { rememberExtStatus(room, msg.event); } catch (e) { log("扩展状态缓存失败:", e.message); }
            }
            let toolEnd = null;
            const storesToolEnd = type === "tool_execution_end" && store && typeof store.recordToolEnd === "function";
            if (storesToolEnd) {
              // end 元数据单独落盘（不占 seq），并与 live 广播用同一份规范化结果。
              // 重复 end changed=false：库和补发都保持幂等。
              try {
                toolEnd = store.recordToolEnd(room.id, msg.event);
              } catch (e) {
                log("ended-tool 元数据写入异常（不影响实时流）:", e.message);
              }
            }
            let seq = 0;
            if (!storesToolEnd) {
              try {
                seq = store.record(room.id, msg.event);
              } catch (e) {
                log("存储写入异常（不影响实时流）:", e.message);
              }
            }
            if (seq || type === "remote_message_failed") rooms.invalidate(room.id);
            const frame = seq
              ? `{"type":"room_event","room":${JSON.stringify(room.id)},"seq":${seq},"rev":${JSON.stringify(store.info(room.id).rev)},"event":${JSON.stringify(msg.event)}}`
              : `{"type":"room_event","room":${JSON.stringify(room.id)},"event":${JSON.stringify(msg.event)}}`;
            if (type === "dialog_open" && msg.event.answerable === true) {
              // A-6：带 answerable 的直播帧按 viewer cap 分流（旧端只收观察卡）
              broadcastDialogOpen(room, frame, cfg);
            } else {
              broadcast(room.viewers, frame, cfg, { droppable: DROPPABLE_LOCAL_EVENTS.has(type) });
            }
            // 原始 end 帧保持不变（含 result），后面紧跟一条小的元数据帧：统一契约、不带 seq/rev、
            // 不重复发完整输出。重复 end 不再补发。
            if (toolEnd && toolEnd.meta && toolEnd.changed !== false) {
              broadcastToolEndMeta(room, cfg, [toolEnd.meta]);
            }
            // 页面外通知（R2-2）：归一/去重/分发全在 notify.js；这里只喂事件流，
            // dialog_open 的补发走 rooms.sendCachedDialogs 直发 viewer、不经此口，天然不重复推。
            try { notifier.observe(room, msg.event); } catch (e) { log("页面外通知观察失败:", e.message); }
            // 注意力恢复通道（R3-1）：在同一出口旁维护房间回合摘要，变化时广播
            // room_attention 给设备级连接（UI 刷新/重连的恢复种子）。与 notify 同点
            // 不同责——notify 管页面外推送，本摘要管页面内清单的跨刷新恢复。
            try {
              if (observeRoomTurnEvent(room, msg.event)) broadcastRoomAttention(rooms, room, cfg);
            } catch (e) { log("房间回合摘要维护失败:", e.message); }
            break;
          }
          case "snapshot": {
            const room = ownRoom(ws, msg);
            if (!room) return;
            const messages = Array.isArray(msg.messages) ? msg.messages : [];
            // Phase 3 snapshot gates (design sections 5/7), same discipline as
            // the event gate: enc rooms only take snapshot writes from
            // crypto.content connections; declaring enc also requires the cap;
            // plaintext-policy modes reject plaintext snapshot writes.
            const snapEncMeta = store ? store.encInfo(room.id) : null;
            // Enc declaration spellings (same as room_register): flat fields on
            // the frame ({enc:1, ackFp, rckWrap}) or a nested enc object.
            const snapEncDecl = msg.enc ? (typeof msg.enc === "object" ? msg.enc : msg) : null;
            const declaresEnc = !!snapEncDecl;
            if ((snapEncMeta || declaresEnc) && !hasCap(ws, "crypto.content")) {
              log("拒绝 enc 房间快照写入（连接未声明 crypto.content）:", room.id);
              send(ws, { type: "error", code: "crypto_required", retryable: false, room: room.id }, cfg);
              return;
            }
            if (!snapEncMeta && !declaresEnc && ((cfg && cfg.cryptoPlaintextRooms) || "allow") !== "allow") {
              log("拒绝明文房间快照写入（cryptoPlaintextRooms =", (cfg && cfg.cryptoPlaintextRooms) || "allow", "）:", room.id);
              send(ws, { type: "error", code: "unsupported", retryable: false, room: room.id, message: "plaintext room writes are disabled by the cryptoPlaintextRooms policy" }, cfg);
              return;
            }
            // Migration frames skip the standalone declaration on purpose: the
            // declaration is part of the migration and may only take effect
            // AFTER the trailer verifies (design section 5 — verification
            // precedes any state change; migrateRoom applies the meta itself
            // once verification passes). Applying it here would flip a
            // still-plaintext room to enc on a refused migration.
            if (declaresEnc && !msg.migration && store && typeof store.setEncMeta === "function") store.setEncMeta(room.id, snapEncDecl);
            if (msg.migration && store && typeof store.migrateRoom === "function") {
              // Encrypted-generation migration (design section 5): the store
              // verifies the trailer before touching the plaintext generation;
              // a second live writer blocks the deletion step entirely.
              const hasLiveWriter = !!(room.busy || (room.local && room.local !== ws));
              const res = store.migrateRoom(room.id, messages, msg.migration, snapEncDecl, { hasLiveWriter });
              if (res.ok) {
                log("房间迁移到加密代完成:", room.id, res.msgCount, "条");
                evictIncapableViewers(room);
                cancelResend(room);
                publishSnapshot(room, { reset: true });
                rooms.broadcastRoomList();
              } else {
                log("房间迁移校验失败（两代数据均保留）:", room.id, res.reason);
              }
              send(ws, { type: "migration_result", room: room.id, ok: res.ok, ...(res.ok ? { msgCount: res.msgCount, lastHash: res.lastHash } : { reason: res.reason }) }, cfg);
              return;
            }
            // Encrypted payloads skip image rewriting (nothing readable inside a
            // ct; rewriting would break the h anchors).
            if (!snapEncMeta && !declaresEnc) shrinkImagesDeep(messages);
            // 全量快照为空 = 本机确认这个会话确实还没有消息。空快照也是权威快照：
            // 不处理的话，订阅者会一直停在“正在从本机拉取会话…”，直到会话里发出第一条消息。
            // append 模式为空只表示“没有新消息”，不是权威全量，仍走原来的 no-op 路径。
            if (msg.mode !== "append" && !messages.length) {
              const info = store.info(room.id);
              if (!info.msgCount) {
                cancelResend(room);
                broadcast(room.viewers, snapshotFrame(room, snapshotBodyFrom({ rev: info.rev, seq: info.seq, truncated: false, items: [] })), cfg);
                log("空快照：本机确认会话还没有消息", room.id);
                return;
              }
            }
            let r;
            try {
              if (msg.mode === "append") {
                r = store.appendMessages(room.id, msg.base, messages);
                if (!r.ok) {
                  log("append 快照锚点不符，要求全量:", room.id, r.reason);
                  send(ws, { type: "snapshot_request", room: room.id, reason: r.reason }, cfg);
                  return;
                }
              } else {
                r = store.seedOrMerge(room.id, messages, { truncated: msg.truncated === true });
              }
            } catch (e) {
              log("存储 seed 异常:", e.message);
              return;
            }
            if (r.seeded || r.merged || r.reset) {
              log(`存储 ${r.reset ? "reset+seed" : r.seeded ? "seed" : msg.mode === "append" ? "append" : "merge"} 房间 ${room.id}: ${r.seeded || r.merged} 条`);
              cancelResend(room);
            }
            publishSnapshot(room, r);
            break;
          }
          case "sync": {
            // 轻量对齐探测：不改注册信息、不广播房间列表，只回存储锚点
            const room = ownRoom(ws, msg);
            if (!room) return;
            registered(ws, room);
            break;
          }
          case "state": {
            const room = ownRoom(ws, msg);
            if (!room) return;
            room.busy = !!msg.busy;
            broadcast(room.viewers, { type: "room_state", room: room.id, busy: room.busy }, cfg);
            break;
          }
          case "room_label": {
            // 会话改名：只更新房间标题并广播名列表，不用整包 room_register
            const room = ownRoom(ws, msg);
            if (!room) return;
            const label = typeof msg.label === "string" && msg.label.trim() ? msg.label.trim() : room.label;
            if (label && label !== room.label) {
              room.label = label;
              rooms.broadcastRoomList();
            }
            break;
          }
          case "usage": {
            // 终端 footer 的实时用量帧：原样广播给观众，并在房间上缓存——新订阅者接入时随快照补送
            const room = ownRoom(ws, msg);
            if (!room) return;
            room.usage = msg.usage && typeof msg.usage === "object" ? msg.usage : null;
            if (room.usage) broadcast(room.viewers, { type: "usage_state", room: room.id, usage: room.usage }, cfg);
            break;
          }
          case "command_result": {
            const wireId = String(msg.id || "");
            const entry = rooms.commandWaiters.get(wireId);
            if (!entry) {
              log("命令结果迟到，waiter 已不存在（视为超时失败）:", msg.room, wireId, !!msg.ok);
              return;
            }
            // 只认转发目标那条 local 连接的回包：别的 socket（被顶替的旧实例）不能伪造/错投结果
            if (entry.local !== ws) {
              log("命令结果来源不符，丢弃:", msg.room, wireId);
              return;
            }
            log("命令结果:", entry.room && entry.room.id, wireId, entry.command, !!msg.ok, msg.ok ? "ok" : String(msg.error || ""));
            // 低-20：relay 已超时、viewer 已收到 timeout 后结果才到——这是对账路径，
            // 照常落定/跑 onResult/写去重表，让迟到的删除等副作用不会因为"waiter 已判定超时"而丢失。
            if (entry._timedOut && !entry.done) log("命令超时后收到迟到结果（对账）:", entry.room && entry.room.id, wireId, entry.command, !!msg.ok);
            let result = msg.ok
              ? { ok: true, data: msg.data === undefined ? null : msg.data }
              : { ok: false, error: String(msg.error || "本机执行失败"), code: failureCode(msg.code) };
            // 命令回包同样要做图片降级：事件/快照路径都做，漏了这条大 base64 会顶破 viewer 单帧预算（256KiB→1009 断线）
            if (result.ok && result.data) shrinkImagesDeep(result.data);
            entry.done = true;
            entry.result = result;
            entry.at = Date.now();
            // P9 B：结果落定后、给网页回执前执行后置钩子（删除成功先清服务器副本）。
            // 抛错不能影响回执，否则网页以为命令失败、实际副本已清。
            if (typeof entry.onResult === "function") {
              try {
                entry.onResult(result);
              } catch (e) {
                log("命令结果后置处理失败:", entry.command, e.message);
              }
            }
            settleEntry(entry);
            for (const w of entry.waiters) {
              finishWaiter(w);
              send(w.ws, ackFrame(w.origId, result.ok, {
                room: entry.room && entry.room.id,
                deviceId: entry.deviceId,
                ...(result.ok ? { data: result.data } : { error: result.error, code: result.code }),
              }), cfg);
            }
            entry.waiters = [];
            rooms.commandWaiters.delete(wireId);
            // 去重表只留小结果：大结果（读类命令）重发时重新执行即可
            if (entry.key && msg.ok && JSON.stringify(result.data || null).length > 256 * 1024) rooms.dedupe.delete(entry.key);
            break;
          }
          case "dialog_answer_result": {
            // O2 应答回执（桥→答题 viewer）：aid 对号，只认当前 local 连接的回包
            const aid = String(msg.aid || "");
            const waiter = rooms.dialogAnswerWaiters.get(aid);
            if (!waiter) return;
            if (waiter.local !== ws) {
              // 回执来源与登记的桥连接不符（别的桥连接拿 aid 乱回、桥换连接后旧回执
              // 迟到等）：结果不采信，但不能把答题端晾到 15s waiter 超时——删 waiter、
              // 清 timer，立刻以 dialog_gone 结案（A-2）。
              rooms.dialogAnswerWaiters.delete(aid);
              if (waiter.timer) clearTimeout(waiter.timer);
              send(waiter.ws, errorFrame("dialog_gone", undefined, { id: waiter.origId, room: waiter.room.id }), cfg);
              return;
            }
            rooms.dialogAnswerWaiters.delete(aid);
            if (waiter.timer) clearTimeout(waiter.timer);
            if (msg.ok) {
              send(waiter.ws, ackFrame(waiter.origId, true, { room: waiter.room.id }), cfg);
            } else {
              send(waiter.ws, errorFrame(failureCode(msg.code || "dialog_gone"), undefined, { id: waiter.origId, room: waiter.room.id }), cfg);
            }
            break;
          }
          case "remote_message_failed": {
            // 注入目标已不是本 socket 当前的房间（会话切换窗口）：扩展把失败报回原房间，
            // 只接受该房间当前或上一任 local 的上报
            const room = rooms.peek(String(msg.room || ""));
            if (!room || (room.local !== ws && room.lastLocal !== ws)) return;
            const event = { type: "remote_message_failed", text: String(msg.text || ""), error: String(msg.error || "消息未注入"), code: failureCode(msg.code), at: Date.now() };
            const cid = cleanCid(msg.cid);
            if (cid) event.cid = cid;
            try { if (store.markRemoteFailed(room.id, event.text, cid)) rooms.invalidate(room.id); } catch {}
            broadcast(room.viewers, { type: "room_event", room: room.id, event }, cfg);
            break;
          }
          case "room_closed": {
            const room = ownRoom(ws, msg);
            if (!room) return;
            // 房间已经结束：先让正在看的网页收起待发队列/任务清单/本机弹窗和还在写的气泡，再走原来的清理。
            // 不写 store，不带 seq / rev。socket 断开不发这几帧，草稿还要能在重新在线后补发。
            broadcastClearedSessionState(room, { settled: true });
            room.online = false;
            room.local = null;
            if (clearSessionState(room)) broadcastRoomAttention(rooms, room, cfg);
            clearActive(room);
            cancelResend(room);
            // P9 A：离线房间摘要是空的，补一次空摘要（在离线态之后广播，waitingOf 才返回空）
            broadcastRoomWaiting(rooms, room, cfg);
            broadcast(room.viewers, { type: "room_offline", room: room.id }, cfg);
            rooms.broadcastRoomList();
            break;
          }
          case "content_key_request": {
            // 内容钥交付请求（阶段 1 透传骨架，设计 §3.2/§7）：relay 只把请求转给本账号
            // 其他在线持钥端，不落盘、不缓存 grant；无人可投时给请求方明确回执，
            // 请求方据此保持「已配对、无内容钥」状态，不装作正常。
            const deviceId = connDeviceId(ws);
            if (!deviceId) return;
            const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
            const myKeys = activeKeysOf(deviceRowSafe(accountId, deviceId));
            if (!myKeys) {
              send(ws, errorFrame("device_mismatch", "本设备未登记公钥，不能请求内容钥交付"), cfg);
              return;
            }
            // 转发盖戳（跨端契约）：请求方 keyFp + box 公钥一并带上——持钥端要拿请求方的
            // box 公钥才能把 ACK 包裹给它（§7 的 request 只有 {want}，无从交付，必须靠转发补齐）。
            const frame = { type: "content_key_request", from: keyFingerprint(myKeys.signPub), fromBoxPub: myKeys.boxPub, accountId };
            let delivered = 0;
            for (const e of keyEndpoints(accountId)) {
              if (e.ws === ws) continue;
              if (send(e.ws, frame, cfg)) delivered++;
            }
            // Phase 2: keyed viewers are request targets as well — a viewer holding
            // the ACK can answer a device's delivery request.
            if (typeof ctx.viewerKeyEndpoints === "function") {
              for (const e of ctx.viewerKeyEndpoints(accountId)) {
                if (send(e.ws, frame, cfg)) delivered++;
              }
            }
            if (!delivered) {
              send(ws, errorFrame("offline", "本账号当前没有其他在线的持钥端，内容钥交付要等持钥设备上线后再请求"), cfg);
            }
            break;
          }
          case "content_key_grant": {
            // 内容钥交付（透传骨架）：发送方必须是本账号在册持钥端；包裹只按目标指纹
            // 路由、原样转发，relay 不解析、不落盘（§3.2/§7）。目标不在线明确回执。
            const deviceId = connDeviceId(ws);
            if (!deviceId) return;
            const grant = cleanKeyGrant(msg);
            if (!grant) {
              send(ws, errorFrame("bad_args", "content_key_grant 字段不合规（需要 to 指纹、nonce 与 ct 包裹）"), cfg);
              return;
            }
            const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
            const myKeys = activeKeysOf(deviceRowSafe(accountId, deviceId));
            if (!myKeys) {
              send(ws, errorFrame("device_mismatch", "本设备未登记公钥，不能发送内容钥交付"), cfg);
              return;
            }
            // 转发盖戳（跨端契约，桥侧钉死）：blob 只有 {to, nonce, ct}，收端做 ECDH 必须
            // 知道交付方的 box 公钥——帧上补 from（交付方 keyFp）与 fromBoxPub（spki base64），
            // 缺一桥会整帧丢弃。发送方在 blob 里自带了 fromBoxPub 也不采信，以名册登记为准。
            const frame = { type: "content_key_grant", ...grant, from: keyFingerprint(myKeys.signPub), fromBoxPub: myKeys.boxPub };
            if (!routeContentKeyGrant(accountId, grant.to, frame)) {
              send(ws, errorFrame("offline", "目标设备不在线，内容钥未能送达（relay 不缓存交付，请待其上线后重发）"), cfg);
            }
            break;
          }
          case "ack_report": {
            // ackFp reconciliation (design §3.5 / §7): only key-authed ends hold an ACK
            // copy, so only they may report. The relay keeps fingerprints only (never
            // the key); on divergence every reporting end of the account is warned.
            if (s.auth !== "key" || !s.boundDeviceId) return;
            if (!isAckFp(msg.ackFp)) {
              send(ws, errorFrame("bad_args", "ackFp 必须是 16 位小写十六进制指纹"), cfg);
              return;
            }
            const accountId = s.accountId || boundAccount(index, devices, s.boundDeviceId, cfg.accountId);
            ackTrackerOf(ctx).report(accountId, "device:" + s.boundDeviceId, msg.ackFp, (frame) => send(ws, frame, cfg));
            break;
          }
          case "key_update": {
            // 设备钥轮换（§3.5）：旧 DIK 对新公钥集合签名（域分隔 pi-remote-keyupdate-v1），
            // 验过才换登记；旧钥指纹进 prevKeyFps 备查，换完断该设备其他连接。
            // 旧钥已丢/签不了名 → 只能走重新配对（管理员批准），这里不留后门。
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            if (!deviceId || deviceId !== connDeviceId(ws)) {
              if (deviceId) mismatch(ws, "key_update", deviceId);
              return;
            }
            const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
            const row = deviceRowSafe(accountId, deviceId);
            const cur = activeKeysOf(row);
            if (!cur) {
              send(ws, errorFrame("device_mismatch", "本设备没有在册公钥，不能轮换（先完成密钥配对）"), cfg);
              return;
            }
            const pubs = cleanPubKeys({ signPub: msg.newSignPub, boxPub: msg.newBoxPub });
            if (!pubs) {
              send(ws, errorFrame("bad_args", "新公钥不合规：需要 Ed25519 签名公钥与 P-256 box 公钥（spki der base64）"), cfg);
              return;
            }
            if (!verifyEd25519(cur.signPub, keyUpdatePayload(deviceId, pubs.signPub, pubs.boxPub), msg.sig)) {
              log("key_update 验签失败:", deviceId);
              send(ws, errorFrame("auth_failed", "key_update 验签失败：须由当前登记的设备私钥对新公钥签名"), cfg);
              return;
            }
            try {
              const prevFps = Array.isArray(row.prevKeyFps) ? [...row.prevKeyFps] : [];
              const oldFp = keyFingerprint(cur.signPub);
              if (!prevFps.includes(oldFp)) prevFps.push(oldFp);
              index.upsertDevice(accountId, {
                id: deviceId,
                keys: { sign: { alg: "ed25519", pub: pubs.signPub, addedAt: Date.now() }, box: { alg: "p256", pub: pubs.boxPub } },
                prevKeyFps: prevFps.slice(-8),
              });
            } catch (e) {
              log("key_update 登记失败:", e.message);
              send(ws, errorFrame("server_error", "新公钥保存失败"), cfg);
              return;
            }
            ctx.dropDevice(deviceId, { except: ws });
            log("设备钥轮换:", accountId, deviceId, "keyFp", keyFingerprint(pubs.signPub));
            rooms.broadcastRoomList();
            break;
          }
          case "pong":
            break;
          default:
            // 文案里的帧名不能改：旧扩展靠它判断 relay 认不认 room_label
            send(ws, errorFrame("unknown_type", `未知消息类型：${msg.type}`), cfg);
        }
      },
    });

    ws.on("close", () => {
      // A disconnected keyed end no longer counts in ackFp reconciliation.
      const cs = ws._state;
      if (cs && cs.authed && cs.auth === "key" && cs.boundDeviceId) {
        try { ackTrackerOf(ctx).forget(cs.accountId || "", "device:" + cs.boundDeviceId); } catch {}
      }
      // 二维码待链接码随出示连接生死：连接一断，pending 条目立即作废（手机再扫只会得到 pair_invalid）
      dropPairPending(ws);
      const room = ws._room;
      if (room && room.local === ws) {
        room.local = null;
        room.online = false;
        clearActive(room);
        cancelResend(room);
        // 异常断开（没有 room_closed）也要把“本机还在跑”的队列/清单/弹窗收起来；
        // 否则新订阅者会从补发缓存里拿到上一个会话的旧状态。
        broadcastClearedSessionState(room);
        // P9 A：离线房间摘要是空的，补一次空摘要
        broadcastRoomWaiting(rooms, room, cfg);
        broadcast(room.viewers, { type: "room_offline", room: room.id }, cfg);
        rooms.broadcastRoomList();
        log("local 断开，房间离线:", room.id);
      }
      if (ws._deviceId) {
        const dev = devices.get(ws._deviceId);
        // 只在这条 socket 仍是当前窗口时改内存在线态；顶替后的旧连接关掉不能把新窗口打成离线
        if (dev && dev.conn === ws) {
          dev.conn = null;
          dev.online = false;
          rooms.broadcastRoomList();
          log("设备窗口断开:", ws._deviceId);
        }
      }
      // 兜底：同一 socket 注册过的其他房间也清掉（room_register 顶替/异常路径残留）
      for (const r of rooms.map.values()) {
        if (r !== room && r.local === ws) {
          r.local = null;
          r.online = false;
          clearActive(r);
          cancelResend(r);
          broadcastClearedSessionState(r);
          broadcastRoomWaiting(rooms, r, cfg);
          broadcast(r.viewers, { type: "room_offline", room: r.id }, cfg);
          rooms.broadcastRoomList();
          log("local 断开，残留房间离线:", r.id);
        }
        if (r.lastLocal === ws) r.lastLocal = null;
      }
      // 发给这条连接、还没回结果的命令：立刻失败，不让 viewer 干等超时
      for (const [wireId, entry] of rooms.commandWaiters) {
        if (entry.local !== ws || entry.done) continue;
        settleEntry(entry);
        for (const w of entry.waiters) {
          finishWaiter(w);
          send(w.ws, ackFrame(w.origId, false, { room: entry.room && entry.room.id, deviceId: entry.deviceId, error: "本机连接已断开，命令结果未知", code: "result_unknown" }), cfg);
        }
        entry.waiters = [];
        rooms.commandWaiters.delete(wireId);
        if (entry.key) rooms.dedupe.delete(entry.key);
      }
      // O2 应答回执：桥已断开，它经手在飞的 dialog_answer_result 永远不会来，立刻按 gone 结案
      for (const [aid, waiter] of rooms.dialogAnswerWaiters) {
        if (waiter.local !== ws) continue;
        rooms.dialogAnswerWaiters.delete(aid);
        if (waiter.timer) clearTimeout(waiter.timer);
        send(waiter.ws, errorFrame("dialog_gone", undefined, { id: waiter.origId, room: waiter.room.id }), cfg);
      }
    });
  });

  // 同 viewer 侧：定时器挂 wss 上，close() 统一清
  wss._keepalive = keepalive(wss);
  return wss;
}

module.exports = { startLocalServer, rememberAssistantStart, rememberAssistantDelta };
