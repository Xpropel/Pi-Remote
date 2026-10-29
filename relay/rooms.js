"use strict";
/** 房间：内存里的房间表、名册广播、resend 兜底、图片降级、local 消息归属 */
const crypto = require("node:crypto");
const { DEFAULT_ACCOUNT } = require("./index");
const { log } = require("./util");
const { send, broadcast, hasCap, snapshotBodyFrom, snapshotFrame } = require("./wire");
const { UNREGISTERED_DEVICE, roomListForDevice } = require("./devices");
const { armWaiter, settleEntry, finishWaiter, commandTimeoutMs } = require("./commands");
const { scheduleCid, wireOf: scheduleWireOf } = require("./schedule");

function cancelResend(room) {
  if (!room) return;
  if (room.resendTimer) {
    clearTimeout(room.resendTimer);
    room.resendTimer = null;
  }
  room.resendWaiters = [];
}

/** 房间从内存表移除时的统一清理（空闲淘汰 / 保留期清理）。与 close 路径一致：
 *  先取消 resend 兜底定时器，再清快照正文缓存及其 TTL 定时器；不清会留下持有 viewer/store 的悬挂回调。 */
function disposeRoom(room) {
  if (!room) return;
  cancelResend(room);
  if (room.snap) {
    if (room.snap.timer) clearTimeout(room.snap.timer);
    room.snap = null;
  }
}

/** 房间表：任何 delete（含 server.js 保留期清理里直接调用的 rooms.map.delete）都走 disposeRoom，
 *  避免只有 idle 淘汰清理定时器、保留期删除却漏掉的路径不一致。 */
class RoomMap extends Map {
  delete(id) {
    const room = super.get(id);
    if (room) disposeRoom(room);
    return super.delete(id);
  }
}

/** 压缩还没结束时，把房间记下的最后一条 compaction_start 补给这一条连接。
 *  没发过、已经结束、换了 instance 或 room_closed 后缓存是空的，这里不编造。不带 seq / rev。 */
function sendCachedCompaction(ws, room, cfg) {
  if (!room || !room.compaction) return;
  const cached = room.compaction;
  const event = { type: "compaction_start" };
  if (Object.prototype.hasOwnProperty.call(cached, "reason")) event.reason = cached.reason;
  if (Object.prototype.hasOwnProperty.call(cached, "willRetry")) event.willRetry = cached.willRetry;
  send(ws, JSON.stringify({ type: "room_event", room: room.id, event }), cfg);
}

/** 助手还在写、房间仍在线时，补一条不带 seq / rev 的 message_start。
 *  没有工具块时 content 只输出思考和文本，空洞跳过。
 *  有工具块时从下标 0 到最后一格都出现：思考和文本照旧，工具块和空洞是 {type:text,text:""}，不含 toolCall。
 *  stopReason 固定 pending。
 *  快照里已有相同 timestamp 的 assistant 消息则不补。房间不在线、没记过开始，也不编造。
 *  超过 maxPayloadBytes 时改发空 content，不断开。since 增量由调用方跳过。
 *  紧接着按 contentIndex 补还在写的工具参数（message_update，不带 seq / rev / usage），
 *  仍在进行中工具补发之前。单条超限则跳过该条，不断开。 */
function sendCachedAssistant(ws, room, cfg, store) {
  if (!room || !room.online || !room.assistantDraft) return;
  const draft = room.assistantDraft;
  if (snapshotHasAssistant(store, room, cfg, draft)) return;
  const content = assistantDraftContent(draft);
  let message = assistantCatchupMessage(draft, content);
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event: { type: "message_start", message } });
  } catch (e) {
    log("进行中助手补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("进行中助手补发超过 maxPayloadBytes，改为空正文:", room.id, Buffer.byteLength(frame));
    message = assistantCatchupMessage(draft, []);
    try {
      frame = JSON.stringify({ type: "room_event", room: room.id, event: { type: "message_start", message } });
    } catch (e) {
      log("进行中助手补发序列化失败，跳过:", room.id, e.message);
      return;
    }
  }
  send(ws, frame, cfg);
  sendCachedToolArgs(ws, room, cfg, draft);
}

function assistantCatchupMessage(draft, content) {
  const message = { role: "assistant", content, stopReason: "pending" };
  if (Object.prototype.hasOwnProperty.call(draft, "timestamp")) message.timestamp = draft.timestamp;
  return message;
}

function assistantDraftContent(draft) {
  const blocks = draft && draft.blocks ? draft.blocks : [];
  let hasTool = false;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] && blocks[i].type === "tool") {
      hasTool = true;
      break;
    }
  }
  if (!hasTool) {
    const content = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) continue;
      if (block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking });
      else if (block.type === "text") content.push({ type: "text", text: block.text });
    }
    return content;
  }
  const content = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block && block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking });
    else if (block && block.type === "text") content.push({ type: "text", text: block.text });
    else content.push({ type: "text", text: "" });
  }
  return content;
}

/** 一条工具参数补发。超过 maxPayloadBytes 就记一行日志并跳过这一条，不断开。不带 seq / rev / usage。 */
function sendAssistantToolFrame(ws, room, cfg, assistantMessageEvent) {
  const event = { type: "message_update", assistantMessageEvent };
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (e) {
    log("进行中工具参数补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("进行中工具参数补发超过 maxPayloadBytes，跳过:", room.id, assistantMessageEvent.type, assistantMessageEvent.contentIndex, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** 按 contentIndex 从小到大，每个工具块先 toolcall_start，参数字符串非空再发一条拼好的 toolcall_delta，记下了 arguments 再发 toolcall_end。 */
function sendCachedToolArgs(ws, room, cfg, draft) {
  const blocks = draft && draft.blocks ? draft.blocks : [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || block.type !== "tool") continue;
    const start = { type: "toolcall_start", contentIndex: i };
    if (typeof block.id === "string" && block.id) start.id = block.id;
    if (typeof block.toolName === "string" && block.toolName) start.toolName = block.toolName;
    sendAssistantToolFrame(ws, room, cfg, start);
    if (typeof block.args === "string" && block.args) {
      sendAssistantToolFrame(ws, room, cfg, { type: "toolcall_delta", contentIndex: i, delta: block.args });
    }
    if (!Object.prototype.hasOwnProperty.call(block, "arguments")) continue;
    const toolCall = {};
    if (typeof block.id === "string" && block.id) toolCall.id = block.id;
    if (typeof block.toolName === "string" && block.toolName) toolCall.name = block.toolName;
    toolCall.arguments = block.arguments;
    sendAssistantToolFrame(ws, room, cfg, { type: "toolcall_end", contentIndex: i, toolCall });
  }
}

/** 全量快照里已经有同一 timestamp 的 assistant，就别再补一条 message_start。 */
function snapshotHasAssistant(store, room, cfg, draft) {
  if (!store || !draft || !Object.prototype.hasOwnProperty.call(draft, "timestamp")) return false;
  let snap = null;
  try {
    snap = store.snapshot(room.id, {
      limit: (cfg && cfg.maxSnapshotRecords) || 10000,
      maxBytes: (cfg && cfg.maxSnapshotBytes) || 24 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  const items = snap && snap.items;
  if (!Array.isArray(items)) return false;
  for (const raw of items) {
    let msg = raw;
    if (typeof raw === "string") {
      try { msg = JSON.parse(raw); } catch { continue; }
    }
    if (msg && msg.role === "assistant" && msg.timestamp === draft.timestamp) return true;
  }
  return false;
}

/** 把一条进行中工具补发帧发出去。超过 maxPayloadBytes 就记一行日志并跳过，不断开。不带 seq / rev。 */
function sendRunningToolFrame(ws, room, cfg, event) {
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (e) {
    log("进行中工具补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("进行中工具补发超过 maxPayloadBytes，跳过:", room.id, event.type, event.toolCallId, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** 全量快照里 role 为 toolResult 的 toolCallId，加上 store 里已记 end 元数据的 toolCallId。
 *  房间上还没有存储、或快照/元数据都读不到时返回 null，调用方仍按还在跑补发。
 *  读到了、只是没有对应结果时返回空集，不能因此把补发变成恒空。 */
function settledToolIds(room, cfg) {
  const store = room && room.store;
  if (!store || typeof store.snapshot !== "function") return null;
  let snap = null;
  let snapOk = false;
  try {
    snap = store.snapshot(room.id, {
      limit: (cfg && cfg.maxSnapshotRecords) || 10000,
      maxBytes: (cfg && cfg.maxSnapshotBytes) || 24 * 1024 * 1024,
    });
    snapOk = !!(snap && Array.isArray(snap.items));
  } catch {
    snapOk = false;
  }
  const ids = new Set();
  if (snapOk) {
    for (const raw of snap.items) {
      let msg = raw;
      if (typeof raw === "string") {
        try { msg = JSON.parse(raw); } catch { continue; }
      }
      if (!msg || msg.role !== "toolResult") continue;
      if (typeof msg.toolCallId === "string" && msg.toolCallId) ids.add(msg.toolCallId);
    }
  }
  // 乱序时 start 可能晚于 end 到达：即使 runningTools 里还留着，同一 toolCallId 已有权威 end 也不再补成"还在跑"。
  if (typeof store.toolEnds === "function") {
    try {
      const metas = store.toolEnds(room.id);
      if (Array.isArray(metas)) {
        for (const meta of metas) if (meta && typeof meta.toolCallId === "string" && meta.toolCallId) ids.add(meta.toolCallId);
      }
    } catch {}
  }
  if (!snapOk && ids.size === 0) return null;
  return ids;
}

/** 工具还没结束、房间仍在线时，按开始顺序补 tool_execution_start / tool_execution_update。
 *  有 start 才发 start（toolCallId、toolName、args，以及 relay 收到 start 的时刻 startedAt）；
 *  有 partialResult 才发 update（toolCallId、toolName、partialResult）。
 *  全量快照里已经有同一 toolCallId 的 toolResult 时，这一条不再补 start / update。不从 runningTools 里删除，不编造 tool_execution_end。
 *  快照读取失败或房间上还没有存储时，仍按还在跑补发。没记过、已经结束、房间不在线时不编造。
 *  调用方把它排在还在写的助手正文之后、自动重试补发与 compaction_start 补发之前。 */
function sendCachedTools(ws, room, cfg) {
  if (!room || !room.online || !room.runningTools || !room.runningTools.length) return;
  const settled = settledToolIds(room, cfg);
  for (const cached of room.runningTools) {
    if (settled && settled.has(cached.toolCallId)) continue;
    if (cached.fromStart) {
      const start = { type: "tool_execution_start", toolCallId: cached.toolCallId };
      if (Object.prototype.hasOwnProperty.call(cached, "toolName")) start.toolName = cached.toolName;
      if (Object.prototype.hasOwnProperty.call(cached, "args")) start.args = cached.args;
      // 补丁 1：晚到者靠这个锚点算耗时，不能从 0 重计
      if (typeof cached.startedAt === "number" && Number.isFinite(cached.startedAt)) start.startedAt = cached.startedAt;
      sendRunningToolFrame(ws, room, cfg, start);
    }
    if (Object.prototype.hasOwnProperty.call(cached, "partialResult")) {
      const update = { type: "tool_execution_update", toolCallId: cached.toolCallId };
      if (Object.prototype.hasOwnProperty.call(cached, "toolName")) update.toolName = cached.toolName;
      update.partialResult = cached.partialResult;
      sendRunningToolFrame(ws, room, cfg, update);
    }
  }
}

/** store 里的 ended-tool 元数据（扩展帧字段名）→ 线上 `tool_end_meta` 的 entry（camelCase）。
 *  字段缺省就不带，绝不补默认值；toolCallId 非法返回 null。 */
function toolEndMetaEntry(meta) {
  if (!meta || typeof meta.toolCallId !== "string" || !meta.toolCallId) return null;
  const entry = { toolCallId: meta.toolCallId };
  if (typeof meta.exit_code === "number" && Number.isFinite(meta.exit_code)) entry.exitCode = meta.exit_code;
  if (typeof meta.wall_time_seconds === "number" && Number.isFinite(meta.wall_time_seconds)) {
    entry.wallTimeSeconds = meta.wall_time_seconds;
  }
  if (meta.termStatus === "timeout" || meta.termStatus === "aborted") entry.termStatus = meta.termStatus;
  if (typeof meta.endedAt === "number" && Number.isFinite(meta.endedAt) && meta.endedAt > 0) entry.endedAt = meta.endedAt;
  if (typeof meta.isError === "boolean") entry.isError = meta.isError;
  return entry;
}

/** 一帧 tool_end_meta（entries 恒为数组，不带 seq / rev）。
 *  at 是 relay 发帧时刻：UI 用它校正 relay/浏览器时钟差后再换算 endedAt。 */
function toolEndMetaFrame(room, entries) {
  return JSON.stringify({ type: "room_event", room: room.id, event: { type: "tool_end_meta", entries, at: Date.now() } });
}

/** 给一条连接发 tool_end_meta。每房默认保留 2000 条后，整包可能超过单帧上限：
 *  按“尽量装满但不超过 maxPayloadBytes”分批发多帧（UI 按 entries 合并，多帧等价），
 *  不因为总数变大就整批跳过；只有单条本身就超限时才记日志跳过。 */
function sendToolEndMeta(ws, room, cfg, entries) {
  if (!room || !Array.isArray(entries) || !entries.length) return;
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  let start = 0;
  while (start < entries.length) {
    // 二分找本批最多能带多少条：帧字节数随条数单调增长。
    let lo = start + 1;
    let hi = entries.length;
    let best = start;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const bytes = Buffer.byteLength(toolEndMetaFrame(room, entries.slice(start, mid)));
      if (bytes <= limit) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best === start) {
      log("ended-tool 单条元数据超过 maxPayloadBytes，跳过:", room.id, entries[start] && entries[start].toolCallId);
      start += 1;
      continue;
    }
    send(ws, toolEndMetaFrame(room, entries.slice(start, best)), cfg);
    start = best;
  }
}

/** 订阅/补发：按 toolCallId 把 store 里保留的全部 ended-tool 元数据带给新 viewer（超限分批）。
 *  只发元数据、不发 result/输出；离线房间也能补（历史仍在磁盘/内存里）。 */
function sendCachedToolEnds(ws, room, cfg) {
  if (!room) return;
  const store = room.store;
  if (!store || typeof store.toolEnds !== "function") return;
  let list = null;
  try {
    list = store.toolEnds(room.id);
  } catch (e) {
    log("ended-tool 元数据读取失败，跳过:", room.id, e.message);
    return;
  }
  if (!Array.isArray(list) || !list.length) return;
  const entries = [];
  for (const meta of list) {
    const entry = toolEndMetaEntry(meta);
    if (entry) entries.push(entry);
  }
  sendToolEndMeta(ws, room, cfg, entries);
}

/** live tool_execution_end 之后广播一条 tool_end_meta（单条 entries），不带 seq / rev。 */
function broadcastToolEndMeta(room, cfg, metas) {
  if (!room || !Array.isArray(metas) || !metas.length) return;
  const entries = [];
  for (const meta of metas) {
    const entry = toolEndMetaEntry(meta);
    if (entry) entries.push(entry);
  }
  if (!entries.length) return;
  const frame = toolEndMetaFrame(room, entries);
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("live ended-tool 元数据超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  broadcast(room.viewers, frame, cfg);
}

/** 自动重试还没结束、房间仍在线时，把记下的 auto_retry_start 补给这一条连接。
 *  四个字段始终带上。没发过、已经结束、换了 instance、epoch 重置、room_closed 或房间不在线时缓存是空的或不发，这里不编造。
 *  不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。
 *  调用方把它排在进行中工具之后、compaction_start 之前。 */
function sendCachedAutoRetry(ws, room, cfg) {
  if (!room || !room.online || !room.autoRetry) return;
  const cached = room.autoRetry;
  const event = {
    type: "auto_retry_start",
    attempt: cached.attempt,
    maxAttempts: cached.maxAttempts,
    delayMs: cached.delayMs,
    errorMessage: cached.errorMessage,
  };
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (e) {
    log("自动重试补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("自动重试补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** 本机弹窗还没关掉、房间仍在线时，把记下的 ui_prompt_start 补给这一条连接。
 *  reason、kind、title 三个字段始终带上。没发过、已经结束、换了 instance、room_closed 或房间不在线时缓存是空的或不发，这里不编造。
 *  不带 seq / rev。不补发 ui_prompt_end。超过 maxPayloadBytes 就记一行日志并跳过，不断开。
 *  调用方把它排在自动重试补发之后、compaction_start 之前。 */
function sendCachedUiPrompt(ws, room, cfg) {
  if (!room || !room.online || !room.uiPrompt) return;
  const cached = room.uiPrompt;
  const event = {
    type: "ui_prompt_start",
    reason: cached.reason,
    kind: cached.kind,
    title: cached.title,
  };
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (e) {
    log("本机弹窗补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("本机弹窗补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** 剥掉 answerable 的槽副本（A-6）：只剥应答面标记，观察形态的卡本体不动；
 *  缓存槽本体不改（其他有 cap 的连接还要按原样补发）。 */
function withoutAnswerable(slot) {
  if (!slot || slot.answerable !== true) return slot;
  const copy = { ...slot };
  delete copy.answerable;
  return copy;
}

/** 对话框观察（O1）多槽补发：房间上每个在开 dialog 槽各补一条 dialog_open。
 *  startedAt 用首次捕获的原值（前端倒计时/已等待以它为锚，多端一致）。
 *  离线房间不补发（与 uiPrompt 对齐）；不带 seq / rev。
 *  门控粒度（A-6）：按这条连接握手声明的 cap 逐槽处理——声明了 dialog.respond
 *  才带 answerable:true；未声明的（旧端）剥掉 answerable 只发观察形态只读卡。 */
function sendCachedDialogs(ws, room, cfg) {
  if (!room || !room.online || !room.dialogs) return;
  const canAnswer = hasCap(ws, "dialog.respond");
  for (const slot of Object.values(room.dialogs)) {
    let frame;
    try {
      frame = JSON.stringify({ type: "room_event", room: room.id, event: canAnswer ? slot : withoutAnswerable(slot) });
    } catch (e) {
      log("弹窗观察补发序列化失败，跳过:", room.id, e.message);
      continue;
    }
    const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
    if (Buffer.byteLength(frame) > limit) {
      log("弹窗观察补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
      continue;
    }
    send(ws, frame, cfg);
  }
}

/** 扩展 UI 状态（ext_status）最后一份快照补发：statuses/widgets/title/working/tap 全量。
 *  离线房间不补发；不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。 */
function sendCachedExtStatus(ws, room, cfg) {
  if (!room || !room.online || !room.extStatus) return;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event: room.extStatus });
  } catch (e) {
    log("扩展状态补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("扩展状态补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** 房间上缓存了最后一份 task_list_state 时，把它补给这一条连接。
 *  空数组也是合法状态（清空），按缓存原样补发。没收到过不编造。
 *  不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。 */
function sendCachedTaskList(ws, room, cfg) {
  // 离线房间不补发旧清单：与 uiPrompt 对齐，晚到观众不该看到上一个会话的任务状态。
  if (!room || !room.online || !room.taskList) return;
  const cached = room.taskList;
  const event = { type: "task_list_state", tasks: cached.tasks };
  if (Object.prototype.hasOwnProperty.call(cached, "source")) event.source = cached.source;
  if (Object.prototype.hasOwnProperty.call(cached, "at")) event.at = cached.at;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (e) {
    log("任务清单补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("任务清单补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** 房间上缓存了最后一份 agent_state 时，把它补给这一条连接。
 *  空 agents 也是合法状态（清空），按缓存原样补发；没收到过不编造。
 *  离线房间不补发旧快照（与任务清单/uiPrompt 对齐）；不带 seq / rev。
 *  超过 maxPayloadBytes 就记一行日志并跳过，不断开。 */
function sendCachedAgentState(ws, room, cfg) {
  if (!room || !room.online || !room.agentState) return;
  const cached = room.agentState;
  const event = { type: "agent_state", agents: cached.agents };
  if (Object.prototype.hasOwnProperty.call(cached, "at")) event.at = cached.at;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (e) {
    log("子智能体状态补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("子智能体状态补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** 房间上缓存了最后一份 remote_queue_state 时，把它补给这一条连接。
 *  整份状态原样补发（空 items 也合法，表示没有待发/已清空）；没收到过不编造。
 *  不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。 */
function sendCachedRemoteQueue(ws, room, cfg) {
  // 离线房间不补发旧待发队列：缓存只在房间在线期间有效。
  if (!room || !room.online || !room.remoteQueue) return;
  const cached = room.remoteQueue;
  const event = { type: "remote_queue_state", rev: cached.rev, items: cached.items };
  if (typeof cached.at === "number" && Number.isFinite(cached.at)) event.at = cached.at;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (e) {
    log("远程待发补发序列化失败，跳过:", room.id, e.message);
    return;
  }
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("远程待发补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/** resend 兜底帧正文：store 里有可交付记录就给真快照，否则给带真实 rev/seq 的空 pending 帧。
 *  读快照失败时**不能**直接落回 `"rev":null` —— 那是注释里明说要避免的错误形态（前端当成"世代变了"，
 *  会多打一次全量重订阅）。快照失败就单独再问一次锚点，尽量把真 rev/seq 带出去。 */
function resendFallbackBody(cfg, store, room) {
  let snap = null;
  try {
    snap = store.snapshot(room.id, { limit: cfg.maxSnapshotRecords, maxBytes: cfg.maxSnapshotBytes });
  } catch (e) {
    log("resend 兜底快照读取失败，改用锚点帧:", room.id, e.message);
  }
  if (snap && Array.isArray(snap.items) && snap.items.length) return snapshotBodyFrom(snap);
  // 兜底帧也要带真实 rev/seq：rev:null 会被前端当成"世代变了"而多打一次全量重订阅
  let rev = null;
  let seq = 0;
  try {
    const info = store.info(room.id);
    if (info) {
      if (typeof info.rev === "string") rev = info.rev;
      if (Number.isInteger(info.seq) && info.seq >= 0) seq = info.seq;
    }
  } catch (e) {
    log("resend 兜底锚点读取失败，只能发 rev:null 空帧:", room.id, e.message);
  }
  return `"rev":${JSON.stringify(rev)},"seq":${seq},"truncated":false,"snapshotPending":true,"messages":[]`;
}

/**
 * 换绑/顶替设备窗口时调用：作废旧窗口发起的那次重发，但**不能丢正在等首帧快照的 viewer**。
 * 房间的 local 是扩展那条 socket（和 attach 窗口不是同一条连接），所以向 room.local 重新要一次；
 * 房间不在线或没有 local 就立刻给兜底帧。只清 timer 不清 waiters 会把 viewer 永久挂在 loading。
 */
function restartResend(cfg, store, room) {
  if (!room) return;
  if (room.resendTimer) {
    clearTimeout(room.resendTimer);
    room.resendTimer = null;
  }
  const waiters = room.resendWaiters || [];
  if (!waiters.length) {
    room.resendWaiters = [];
    return;
  }
  if (!room.online || !room.local) {
    room.resendWaiters = [];
    const body = resendFallbackBody(cfg, store, room);
    for (const w of waiters) {
      send(w, snapshotFrame(room, body), cfg);
      sendCachedTaskList(w, room, cfg);
      sendCachedAgentState(w, room, cfg);
      sendCachedRemoteQueue(w, room, cfg);
      sendCachedAssistant(w, room, cfg, store);
      sendCachedTools(w, room, cfg);
      sendCachedToolEnds(w, room, cfg);
      sendCachedAutoRetry(w, room, cfg);
      sendCachedUiPrompt(w, room, cfg);
      sendCachedDialogs(w, room, cfg);
      sendCachedExtStatus(w, room, cfg);
      sendCachedCompaction(w, room, cfg);
    }
    return;
  }
  send(room.local, { type: "resend_snapshot", room: room.id }, cfg);
  room.resendTimer = setTimeout(() => {
    room.resendTimer = null;
    const left = room.resendWaiters || [];
    room.resendWaiters = [];
    const body = resendFallbackBody(cfg, store, room);
    for (const w of left) {
      send(w, snapshotFrame(room, body), cfg);
      sendCachedTaskList(w, room, cfg);
      sendCachedAgentState(w, room, cfg);
      sendCachedRemoteQueue(w, room, cfg);
      sendCachedAssistant(w, room, cfg, store);
      sendCachedTools(w, room, cfg);
      sendCachedToolEnds(w, room, cfg);
      sendCachedAutoRetry(w, room, cfg);
      sendCachedUiPrompt(w, room, cfg);
      sendCachedDialogs(w, room, cfg);
      sendCachedExtStatus(w, room, cfg);
      sendCachedCompaction(w, room, cfg);
    }
  }, cfg.resendSnapshotWaitMs || 3000);
  room.resendTimer.unref();
}

/** 对话框应答（O2）viewer 在线门控：房间订阅数 0↔>0 变化时向桥推 dialog_gate 帧
 * （定版：事件推送、桥以最近一帧为准）。force=true 时无条件重推当前值（桥重连补发用）。
 * 桥不在（room.local 空）只记状态，连上后由 room_register 路径 force 补发。 */
function pushDialogGate(room, cfg, force) {
  if (!room) return;
  const has = room.viewers.size > 0;
  if (!force && room.dialogGate === has) return;
  room.dialogGate = has;
  if (room.local) send(room.local, { type: "dialog_gate", room: room.id, hasViewers: has }, cfg);
}

/* ---------------- 回合摘要（R3-1 注意力恢复通道） ----------------
 * relay 按房维护 lastTurnEnd，给 UI 的 RoomTurnTracker 当刷新/重连恢复种子：
 * tracker 是实时边沿引擎（在场时靠 busy 边沿/别房事件记账），页面刷新后内存
 * 清零，只能靠这里的摘要把"别房跑完/出错还没看"种回来。成败归一与页面外
 * 通知编排器（notify.js）同源同点：以 agent_settled 为落定信号、看落定前
 * 最后一条助手终态消息；aborted 是用户主动打断，不记；新回合活动信号到达
 * 即清旧摘要（与 notify 的重置点同一组事件）。本摘要只活在内存里（与 busy
 * 同级），relay 重启即失，不落盘、不带任何正文/标题。 */
// 出现这些事件 = 新一轮活动开始（与 notify.js 的 TURN_ACTIVITY_TYPES 同一组，改一处须同步另一处；
// 两份副本的等价性由 test/notify.test.js 的等价用例钉住——同序列喂两边结论必须一致，第 3 轮审查 A-3）
const TURN_ACTIVITY_TYPES = new Set(["agent_start", "turn_start", "message_start", "before_agent_start"]);
// 助手消息的中间态 stopReason（与 notify.js 同口径）：在场不算终态
const NON_TERMINAL_STOP_REASONS = new Set(["toolUse", "pending", "deferred"]);
// 最近事件摘要（设计 D §2.3，cap room.activity）：只记这组白名单事件类型，
// tool_execution_start 只取 toolName 工具名元数据——不带任何正文/参数。
const LAST_EVENT_TYPES = new Set(["turn_start", "agent_start", "message_update", "tool_execution_start", "compaction_start"]);

/**
 * 在 local 事件出口旁喂一帧宿主事件，维护 room.lastTurnEnd。
 * 返回 true = 摘要变了（新落定 / 被新活动清掉），调用方据此广播 room_attention。
 * 同一回合重复 settled 只记一次（turnSettled 守卫，新活动才重置）。
 * 同址顺带维护 room.lastEvent（最近事件摘要）：白名单事件到达即刷新，
 * 回合落定（agent_settled）即清——busy 结束后状态行走 lastTurnEnd 分支。
 * lastEvent 只活在内存里（与 lastTurnEnd 同级），不落盘、不新开广播帧，
 * 搭 room_list 顺风车下发（list 条目 + roomsViewFor 按 cap 裁剪）。
 */
function observeRoomTurnEvent(room, event, now = Date.now()) {
  if (!room || !event || typeof event !== "object") return false;
  const type = typeof event.type === "string" ? event.type : "";
  // 收件箱账本（§1.3 原因映射）：dialog_close 在 local 的处理顺序里先经对账消项（记 resolved），
  // 准确 reason 到本出口才可见——在此回填墓碑：answered/denied → answered、timeout → timeout。
  if (type === "dialog_close" && typeof event.dialogId === "string" && room._inboxRef) {
    const r = typeof event.reason === "string" ? event.reason : "";
    const reason = r === "answered" || r === "denied" ? "answered" : (r === "timeout" || event.outcome === "timeout" ? "timeout" : null);
    if (reason) room._inboxRef.store.amendTombReason(room._inboxRef.accountId, `dialog:${event.dialogId}`, reason);
  }
  // 定时排期（设计 D §3.4）：扩展队列注入失败的 remote_message_failed 带 cid——排期
  // 引擎据 cid 对号把对应排期判失败停机（送达确认的第三种失败来源）。普通远程消息的
  // cid 不合排期格式，引擎侧直接忽略。
  if (type === "remote_message_failed" && typeof event.cid === "string" && room._scheduleRef) {
    try {
      room._scheduleRef.engine.noteRemoteFailed(event.cid, typeof event.error === "string" ? event.error : "");
    } catch {}
  }
  if (LAST_EVENT_TYPES.has(type)) {
    const le = { type, at: now };
    if (type === "tool_execution_start" && typeof event.toolName === "string" && event.toolName) {
      le.toolName = event.toolName.slice(0, 64);
    }
    room.lastEvent = le;
  }
  if (TURN_ACTIVITY_TYPES.has(type)) {
    room.turnOutcome = null;
    room.turnSettled = false;
    if (room.lastTurnEnd) {
      room.lastTurnEnd = null;
      return true;
    }
    return false;
  }
  if (type === "message_end") {
    const msg = event.message;
    if (msg && typeof msg === "object" && msg.role === "assistant") {
      const sr = typeof msg.stopReason === "string" ? msg.stopReason : "";
      if (sr && !NON_TERMINAL_STOP_REASONS.has(sr)) {
        room.turnOutcome = sr === "aborted" ? "aborted" : (sr === "error" || !!msg.errorMessage ? "error" : "ok");
      }
    }
    return false;
  }
  if (type === "agent_settled") {
    if (room.turnSettled) return false;
    room.turnSettled = true;
    room.lastEvent = null; // 回合落定：最近事件摘要清掉，状态行转走 lastTurnEnd 分支
    const outcome = room.turnOutcome;
    room.turnOutcome = null;
    if (outcome === "aborted") return false; // 用户主动打断：不记（与 UI 追踪器同口径）
    room.lastTurnEnd = { kind: outcome === "error" ? "error" : "done", at: now };
    return true;
  }
  return false;
}

/** 进房即已读（R3-1 定版，relay 落实）：清掉该房摘要。返回 true = 原本有摘要、已清。
 *  收件箱账本同步清同房 turn 条目（§1.3「进房清」扩到账本）：账本里有、摘要已不在的
 *  恢复期残留也算清掉——返回 true 让调用方照常补广播 room_attention{null} 对齐各端。 */
function clearRoomTurnEnd(room) {
  if (!room) return false;
  let had = false;
  if (room.lastTurnEnd) {
    room.lastTurnEnd = null;
    had = true;
  }
  const ref = room._inboxRef;
  if (ref && ref.store && ref.store.clearRoomTurns(ref.accountId, room.id) > 0) had = true;
  return had;
}

/** room_attention 帧：字段白名单只有 room 与 lastTurnEnd{kind,at}|null，不带任何正文/标题。
 *  听众与 room_list 同一批设备级连接（rooms.viewers 全体），不按房间订阅过滤——
 *  说的正是"别的房间"的落定，订阅了该房的人反而不需要它。
 *  cap 门控（第 3 轮审查 A-1，粒度仿第 2 轮 A-6）：room.attention 是新面，只发给
 *  握手声明过该 cap 的连接；未声明的旧端不收新帧、清单条目也剥 lastTurnEnd
 *  （见 roomsViewFor），既有面（在线/忙闲/标题）一律不剥。 */
function broadcastRoomAttention(rooms, room, cfg) {
  if (!rooms || !room) return;
  if (typeof rooms.syncInboxTurn === "function") rooms.syncInboxTurn(room); // 收件箱账本来源三：落定/清除先与账本对账，再广播（同帧口径一致）
  broadcast([...rooms.viewers].filter((v) => hasCap(v, "room.attention")), {
    type: "room_attention",
    room: room.id,
    lastTurnEnd: room.lastTurnEnd ? { kind: room.lastTurnEnd.kind, at: room.lastTurnEnd.at } : null,
  }, cfg);
}

/* ---------------- 房间等待摘要（P9 A：room.dialogs） ----------------
 * 旧端（未声明 room.dialogs）不看这两个字段，但仍要收 room_list 的既有面；
 * 所以摘要只在 list()/listFor 里按 cap 附加或剥离，广播帧 room_waiting 只发给声明端。 */

/** 房间的等待摘要：只在线房间有；canAnswer=false 时去掉 answerable。
 *  waiting 只带 6 个字段（不带 options/message/prefill 等正文面）；waitingPrompt 是
 *  旧的单槽 ui_prompt 兜底信号，只在 waiting 为空时才有意义。 */
function waitingOf(room, canAnswer) {
  if (!room || !room.online) return { waiting: [], waitingPrompt: null };
  const waiting = Object.values(room.dialogs || {}).map((s) => {
    const w = { dialogId: s.dialogId, kind: s.kind, startedAt: s.startedAt };
    if (s.title) w.title = s.title;
    if (s.timeout) w.timeout = s.timeout;
    if (canAnswer && s.answerable === true) w.answerable = true;
    return w;
  });
  const p = room.uiPrompt;
  const waitingPrompt = !waiting.length && p ? { kind: p.kind || "", title: p.title || "", at: p.at || 0 } : null;
  return { waiting, waitingPrompt };
}

/** 同一个 tick 里多次触发只广播一次（仿 broadcastRoomList 的 setImmediate）。
 *  每帧是房间的全量摘要；听众与 room_attention 同一批（rooms.viewers 全体，不按订阅过滤），
 *  只发给握手声明了 room.dialogs 的连接。 */
function broadcastRoomWaiting(rooms, room, cfg) {
  if (!rooms || !room) return;
  if (typeof rooms.syncInboxDialogs === "function") rooms.syncInboxDialogs(room); // 收件箱账本来源一/二：槽位调用点每次变化后必经此地，同步对账不依赖广播合并
  if (room._waitingScheduled) return;
  room._waitingScheduled = true;
  setImmediate(() => {
    room._waitingScheduled = false;
    for (const v of rooms.viewers) {
      if (!hasCap(v, "room.dialogs")) continue;
      send(v, { type: "room_waiting", room: room.id, ...waitingOf(room, hasCap(v, "dialog.respond")) }, cfg);
    }
  });
}

/* ---------------- 按连接能力组合裁剪 room_list 条目（P9 A） ----------------
 * 原先 stripRoomAttention / listFor / broadcastRoomList 各写一份"按 cap 去字段"，
 * 现在合成一处：没有 room.attention 去 lastTurnEnd；没有 room.dialogs 去 waiting/waitingPrompt；
 * 没有 dialog.respond 去 waiting[].answerable；没有 room.activity 去 lastEvent（设计 D §2.3 追加）。
 * 四个 cap 的组合最多 16 种，
 * broadcastRoomList 按组合分组，每组只算一份副本（设备窗口连接不声明 cap，走最干净那份）。 */
const ROOM_LIST_CAPS = ["room.attention", "room.dialogs", "dialog.respond", "room.activity", "room.schedule"];

function roomListCapKey(ws) {
  let key = 0;
  for (let i = 0; i < ROOM_LIST_CAPS.length; i++) if (hasCap(ws, ROOM_LIST_CAPS[i])) key |= 1 << i;
  return key;
}

function roomsViewFor(ws, list) {
  const key = roomListCapKey(ws);
  if (key === (1 << ROOM_LIST_CAPS.length) - 1) return list;
  const keepAttention = !!(key & 1);
  const keepDialogs = !!(key & 2);
  const keepAnswerable = !!(key & 4);
  const keepActivity = !!(key & 8);
  const keepSchedule = !!(key & 16);
  return (list || []).map((r) => {
    if (!r) return r;
    let out = r;
    if (!keepAttention && Object.prototype.hasOwnProperty.call(out, "lastTurnEnd")) {
      out = { ...out };
      delete out.lastTurnEnd;
    }
    if (!keepActivity && Object.prototype.hasOwnProperty.call(out, "lastEvent")) {
      if (out === r) out = { ...r };
      delete out.lastEvent;
    }
    if (!keepSchedule && Object.prototype.hasOwnProperty.call(out, "schedules")) {
      if (out === r) out = { ...r };
      delete out.schedules;
    }
    if (!keepDialogs && (Object.prototype.hasOwnProperty.call(out, "waiting") || Object.prototype.hasOwnProperty.call(out, "waitingPrompt"))) {
      if (out === r) out = { ...r };
      delete out.waiting;
      delete out.waitingPrompt;
    }
    if (keepDialogs && !keepAnswerable && Array.isArray(out.waiting)) {
      const hasAnswerable = out.waiting.some((w) => w && Object.prototype.hasOwnProperty.call(w, "answerable"));
      if (hasAnswerable) {
        if (out === r) out = { ...r };
        out.waiting = out.waiting.map((w) => {
          if (!w || !Object.prototype.hasOwnProperty.call(w, "answerable")) return w;
          const copy = { ...w };
          delete copy.answerable;
          return copy;
        });
      }
    }
    return out;
  });
}

/* ---------------- 房间 ---------------- */
/** get_sessions 查询键：连接序号 + 前端自选 id。两个页面用相同 id 时不会互相覆盖/误删对方的 10s 超时。 */
let querySeq = 0;
function queryKey(ws, id) {
  if (!ws._qseq) ws._qseq = ++querySeq;
  return ws._qseq + "|" + id;
}
class Rooms {
  constructor(cfg) {
    this.cfg = cfg;
    this.map = new RoomMap();
    this.viewers = new Set();
    this.commandWaiters = new Map(); // wireId -> CommandEntry
    this.dialogAnswerWaiters = new Map(); // aid -> { ws, origId, room, dialogId, timer }（O2 应答回执对号）
    this.dedupe = new Map();         // `${room}|${dedupeKey}` -> CommandEntry
    this.viewerQueries = new Map();  // queryKey(ws,id) -> {ws, timer}
    this.deviceSnapshot = () => [];
    // 进程实例 id：去重表只活在本进程内存里，viewer 断线重连后只有 boot 相同才能安全重发有副作用的命令
    this.boot = crypto.randomBytes(6).toString("hex");
    // 收件箱账本（设计 D §1）：server 装配时 bindInbox 注入 InboxStore；未注入时全部账本动作静默跳过。
    this.inbox = null;
    this._inboxFlushScheduled = false;
    // 定时排期（设计 D §3）：server 装配时 bindSchedule 注入 ScheduleEngine；未注入时排期面静默跳过。
    this.schedule = null;
    this._scheduleFlushScheduled = false;
    this._inboxGrace = new Map(); // roomId -> timer：恢复期 waiting 条目的补发对账宽限
    this.inboxGraceMs = Number.isFinite(cfg.inboxResyncGraceMs) && cfg.inboxResyncGraceMs >= 0 ? cfg.inboxResyncGraceMs : 15000;
  }
  /** 会话存储。进行中工具补发用它看快照里有没有 toolResult。已挂上的房间不覆盖。 */
  bindStore(store) {
    this._transcriptStore = store || null;
    if (!this._transcriptStore) return;
    // 房文件分组定位（store 的目录两级分组/存量迁移靠它定房间的家）。
    if (typeof store.setLocator === "function") {
      store.setLocator((id) => this.locateRoom(id));
    }
    for (const r of this.map.values()) this._stampStore(r);
  }

  /* ---------------- 收件箱账本（设计 D §1） ----------------
   * 账本（relay/inbox.js）是「别的房间在等你」这条线的 relay 侧唯一事实源：只存元数据。
   * 三路来源在此对账：dialog/prompt 活槽（syncInboxDialogs，挂 broadcastRoomWaiting 入口）、
   * 回合落定（syncInboxTurn，挂 broadcastRoomAttention 入口）、dialog_close 原因回填
   * （observeRoomTurnEvent 经 room._inboxRef 补墓碑原因——close 事件到达时对账已先行）。 */

  /** 账本装配：与 bindStore 同位由 server 调；顺手给存量房间打上 _inboxRef。 */
  bindInbox(store) {
    this.inbox = store || null;
    if (!this.inbox) return;
    for (const r of this.map.values()) this._stampInboxRef(r);
  }
  _stampInboxRef(room) {
    if (this.inbox && room) room._inboxRef = { store: this.inbox, accountId: room.accountId || DEFAULT_ACCOUNT };
  }
  _inboxAccount(room) {
    return (room && room.accountId) || DEFAULT_ACCOUNT;
  }
  /** 账本 pending 快照（上行白名单形状）：viewer 的 auth_result / list_rooms 附带面取这里。 */
  inboxSnapshot() {
    return this.inbox ? this.inbox.snapshot() : [];
  }
  /** inbox_dismiss 命令面：只清 done/error（waiting 拒清在 store 内裁决），清成后增量广播对齐各端。 */
  dismissInbox(key) {
    if (!this.inbox || typeof key !== "string" || !key) return false;
    const gone = this.inbox.dismiss(key);
    if (gone) this._flushInbox();
    return !!gone;
  }
  /** 增量广播：与 room_waiting 同批听众（设备级连接全体，不按房间订阅过滤），只发声明 room.inbox 的连接；
   *  同 tick 多次变更合并一帧（store 的 drain 语义保证 upserts/removed 不打架）。 */
  _flushInbox() {
    if (!this.inbox || this._inboxFlushScheduled) return;
    this._inboxFlushScheduled = true;
    setImmediate(() => {
      this._inboxFlushScheduled = false;
      if (!this.inbox) return;
      const changes = this.inbox.drainChanges();
      if (!changes) return;
      for (const v of this.viewers) {
        if (!hasCap(v, "room.inbox")) continue;
        send(v, { type: "inbox_update", upserts: changes.upserts, removed: changes.removed }, this.cfg);
      }
    });
  }
  /** 来源一/二对账：以房间活槽为准。dialog 槽在 → upsert waiting/dialog；ui_prompt 只在无 dialog
   *  槽时兜底（与 attention.ts 同款去重纪律，下沉到账本层）；活槽里没有的 waiting 条目消项
   *  （reason 先记 resolved，dialog_close 的准确原因随后由 observeRoomTurnEvent 回填墓碑）。
   *  恢复期未确认条目（重启落盘恢复的 waiting）豁免消项：等补发确认或宽限清扫判 stale（§1.4）。 */
  syncInboxDialogs(room) {
    if (!this.inbox || !room) return;
    const store = this.inbox;
    const accountId = this._inboxAccount(room);
    this._stampInboxRef(room);
    const live = new Set();
    if (room.online) {
      const slots = Object.values(room.dialogs || {}).filter((s) => s && typeof s.dialogId === "string" && s.dialogId);
      let canAnswer = false;
      for (const v of this.viewers) if (hasCap(v, "dialog.respond")) { canAnswer = true; break; }
      for (const s of slots) {
        const key = `dialog:${s.dialogId}`;
        live.add(key);
        store.upsert({
          key, accountId, roomId: room.id, deviceId: room.deviceId || null,
          kind: "waiting", subkind: "dialog",
          dialogKind: typeof s.kind === "string" ? s.kind : undefined,
          title: s.title || undefined,
          answerable: canAnswer && s.answerable === true,
          at: s.startedAt || Date.now(),
        });
      }
      const p = room.uiPrompt;
      if (p && !slots.length) {
        const key = `prompt:${room.id}:${p.at || 0}`;
        live.add(key);
        store.upsert({
          key, accountId, roomId: room.id, deviceId: room.deviceId || null,
          kind: "waiting", subkind: "prompt",
          dialogKind: typeof p.kind === "string" ? p.kind : undefined,
          title: p.title || undefined,
          at: p.at || Date.now(),
        });
      }
    }
    for (const e of store.roomEntries(accountId, room.id)) {
      if (e.kind !== "waiting" || live.has(e.key) || e._restored) continue;
      store.remove(accountId, e.key, "resolved");
    }
    if (room.online) {
      if (store.restoredWaitingKeys(accountId, room.id).size) this._armInboxGrace(room);
    } else {
      this._disarmInboxGrace(room.id);
    }
    this._flushInbox();
  }
  /** 来源三对账：以 room.lastTurnEnd 为准——有落定则整房替换成最新一条 turn 条目，无则清同房 turn 条目。 */
  syncInboxTurn(room) {
    if (!this.inbox || !room) return;
    this._stampInboxRef(room);
    const accountId = this._inboxAccount(room);
    const end = room.lastTurnEnd;
    if (end && (end.kind === "done" || end.kind === "error") && Number.isFinite(end.at)) {
      this.inbox.replaceRoomTurn({
        key: `turn:${room.id}:${end.at}`, accountId, roomId: room.id, deviceId: room.deviceId || null,
        kind: end.kind, subkind: "turn", at: end.at,
      });
    } else if (!end) {
      this.inbox.clearRoomTurns(accountId, room.id);
    }
    this._flushInbox();
  }
  _armInboxGrace(room) {
    if (this._inboxGrace.has(room.id)) return;
    const timer = setTimeout(() => {
      this._inboxGrace.delete(room.id);
      this._sweepInboxRoom(room.id);
    }, this.inboxGraceMs);
    if (typeof timer.unref === "function") timer.unref();
    this._inboxGrace.set(room.id, timer);
  }
  _disarmInboxGrace(roomId) {
    const timer = this._inboxGrace.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this._inboxGrace.delete(roomId);
    }
  }
  /** 宽限到期/房间淘汰：补发始终没确认的恢复期 waiting 批量转 stale（§1.4 的近似触发点——
   *  协议没有显式「补发完成」帧，可观测等价物 = 重连后的 dialog 补发涌入 + 本宽限窗）。 */
  _sweepInboxRoom(roomId) {
    if (!this.inbox) return;
    if (this.inbox.sweepRestored(roomId)) this._flushInbox();
  }

  /* ---------------- 定时排期（设计 D §3） ----------------
   * 计时器与排期表在 relay/schedule.js（ScheduleStore + ScheduleEngine）；rooms 只做
   * 装配三件事：给引擎注入房间宿主（peekRoom/deliver）、给房间打 _scheduleRef 供事件
   * 钩子对号、把排期清单搭 room_list 下发并在变化时广播 schedule_update。
   * 投递不新造路径：到点经既有 commandWaiters 命令通道下发一条普通 prompt 命令
   * （恒带 streamingBehavior，忙时进扩展自管队列，永不打断当前回合）。 */

  /** 排期装配：与 bindInbox 同位由 server 调；引擎宿主在此注入，存量房间顺手打戳。 */
  bindSchedule(engine) {
    this.schedule = engine || null;
    if (!this.schedule) return;
    this.schedule.bindHost({
      peekRoom: (roomId) => this.peek(roomId),
      deliver: (room, entry, fireNo, done) => this.dispatchSchedulePrompt(room, entry, fireNo, done),
      flushInbox: () => this._flushInbox(),
      onDirty: () => this._flushSchedule(),
    });
    for (const r of this.map.values()) this._stampScheduleRef(r);
  }
  _stampScheduleRef(room) {
    if (this.schedule && room) room._scheduleRef = { engine: this.schedule };
  }
  /** 某房的排期清单（上行白名单形状，armed + 保留期内终态）；未装配时为空。 */
  schedulesOf(room) {
    if (!this.schedule || !room) return [];
    return this.schedule.store.listRoom(room.accountId || DEFAULT_ACCOUNT, room.id);
  }
  /** schedule_create 命令面：引擎裁决（校验/上限），成功后广播对齐各端。 */
  createSchedule(accountId, raw) {
    if (!this.schedule) return { code: "unsupported", error: "此中继未启用定时消息" };
    const res = this.schedule.create(accountId, raw);
    if (res.entry) return { entry: scheduleWireOf(res.entry) };
    return res;
  }
  /** schedule_cancel 命令面。 */
  cancelSchedule(accountId, id) {
    if (!this.schedule) return null;
    const entry = this.schedule.cancel(accountId, id);
    return entry ? scheduleWireOf(entry) : null;
  }
  /** schedule_list 命令面：与 room_list 内的 schedules 同一数据源。 */
  scheduleList(accountId, roomId) {
    if (!this.schedule) return [];
    return this.schedule.store.listRoom(accountId, roomId);
  }
  /** 变化广播：store 的脏房间 drain 出来后逐房全量替换下发（同 room_waiting 的听众
   *  纪律——设备级连接全体，不按房间订阅过滤），只发声明 room.schedule 的连接。 */
  _flushSchedule() {
    if (!this.schedule || this._scheduleFlushScheduled) return;
    this._scheduleFlushScheduled = true;
    setImmediate(() => {
      this._scheduleFlushScheduled = false;
      if (!this.schedule) return;
      const dirty = this.schedule.store.drainDirtyRooms();
      for (const key of dirty) {
        const sep = key.indexOf("|");
        const accountId = key.slice(0, sep);
        const roomId = key.slice(sep + 1);
        const schedules = this.schedule.store.listRoom(accountId, roomId);
        for (const v of this.viewers) {
          if (!hasCap(v, "room.schedule")) continue;
          send(v, { type: "schedule_update", room: roomId, schedules }, this.cfg);
        }
      }
    });
  }
  /**
   * 到点投递：把排期消息当普通 prompt 命令经 commandWaiters 下发给房间的 local。
   * 等待者是「无连接」占位（ws:null）——回执不回给任何 viewer，只经 onResult/onSettle
   * 结案给引擎：onResult 先于 settle 触发（local.js 的 command_result 顺序），故结果
   * 优先；只有超时/断线走到 onSettle，一律按投递未确认判失败。send 本身失败（通道
   * 刚断）立刻摘等待者按失败结案，不等 15 秒命令超时。
   */
  dispatchSchedulePrompt(room, entry, fireNo, done) {
    const local = room && room.local;
    if (!local || local.readyState !== 1) {
      done({ ok: false, error: "本机未连接，消息无法送达" });
      return;
    }
    const args = {
      text: entry.text,
      streamingBehavior: entry.segment === "follow_up" ? "followUp" : "steer",
      cid: scheduleCid(entry, fireNo),
    };
    const timeoutMs = commandTimeoutMs("prompt", args, this.cfg.harnessStartTimeoutMs);
    const wireId = "w_" + crypto.randomBytes(8).toString("hex");
    let finished = false;
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      done(outcome);
    };
    const cmdEntry = {
      wireId, room, command: "prompt", local, timeoutMs,
      waiters: [], done: false, result: null, at: Date.now(), key: null,
      onResult: (result) => finish(result && result.ok
        ? { ok: true }
        : { ok: false, error: (result && typeof result.error === "string" && result.error) || "本机执行失败" }),
      onSettle: () => finish({ ok: false, error: "投递未确认（本机未回执或连接已断开）" }),
    };
    const w = { ws: null, origId: null, timer: null };
    cmdEntry.waiters.push(w);
    armWaiter(this, cmdEntry, w, this.cfg);
    this.commandWaiters.set(wireId, cmdEntry);
    const sent = send(local, { type: "command", id: wireId, command: "prompt", args, timeoutMs, room: room.id }, this.cfg);
    if (!sent) {
      finishWaiter(w);
      cmdEntry.waiters = [];
      this.commandWaiters.delete(wireId);
      settleEntry(cmdEntry); // 触发 onSettle → finish 按投递未确认判失败收尾
    }
  }

  /** store 的房间定位：注册表优先（deviceId/cwd 在 room_register 时已打戳）；
   *  注册表还没有（进程刚起、存量迁移）时，按设备名册逐台查会话索引兜底。
   *  都查不到返回 null（store 归 _未分类，数据不丢）。 */
  locateRoom(id) {
    const r = this.map.get(id);
    if (r && (r.deviceId || r.cwd)) return { deviceId: r.deviceId || null, cwd: r.cwd || null };
    if (this.sessionLookup && typeof this.deviceSnapshot === "function") {
      let devs = [];
      try { devs = this.deviceSnapshot(); } catch {}
      for (const dev of devs) {
        if (!dev || !dev.id) continue;
        let session = null;
        try { session = this.sessionLookup(dev.accountId || DEFAULT_ACCOUNT, dev.id, id); } catch {}
        if (session) return { deviceId: dev.id, cwd: session.cwd || null };
      }
    }
    return null;
  }
  _stampStore(r) {
    if (r && this._transcriptStore && !r.store) r.store = this._transcriptStore;
  }
  get(id) {
    let r = this.map.get(id);
    if (r) {
      r.lastActivity = Date.now();
      this._stampStore(r);
      if (this.inbox && !r._inboxRef) this._stampInboxRef(r);
      if (this.schedule && !r._scheduleRef) this._stampScheduleRef(r);
      return r;
    }
    r = {
      id,
      label: null,
      cwd: null,
      local: null,
      lastLocal: null,
      viewers: new Set(),
      snap: null,
      busy: false,
      online: false,
      epoch: 0,
      instance: null,
      generation: 0,
      lastActivity: Date.now(),
      accountId: DEFAULT_ACCOUNT,
      deviceId: null,
      deviceName: null,
      platform: null,
      resendTimer: null,
      resendWaiters: null,
      remoteQueue: null,
      agentState: null,
      // 注意力恢复通道（R3-1）：本房最近一次落定摘要 {kind:"done"|"error",at}，无未读落定时为 null；
      // turnOutcome/turnSettled 是落定判定的一回合内暂态（口径见 observeRoomTurnEvent）。
      lastTurnEnd: null,
      turnOutcome: null,
      turnSettled: false,
      // 最近事件摘要（设计 D §2.3）：{type, toolName?, at}，无事件/已落定时为 null
      lastEvent: null,
    };
    this._stampStore(r);
    this._stampInboxRef(r);
    this._stampScheduleRef(r);
    this.map.set(id, r);
    return r;
  }
  /** 只看不建，也不刷新活跃度（sweep 用它判断"近期活跃"，peek 自己刷新就永远判活） */
  peek(id) {
    if (!id) return null;
    return this.map.get(id) || null;
  }
  touch(r) {
    if (r) r.lastActivity = Date.now();
    return r;
  }
  /** 全量快照正文缓存（TTL）：subscribe 风暴时避免反复扫盘/拼接。只缓存正文，busy 每次现取。
   *  装配抛错（store 读异常等）不能把异常抛给订阅路径：那样已经加进 viewers 的连接收不到任何
   *  snapshot 帧、UI 永远停在"正在拉取会话…"（报告：快照发布抛错，订阅者干等）。
   *  这里退回带真实锚点的 truncated 空快照（不写缓存，下次订阅会重试装配）。 */
  snapshotBody(roomId, build) {
    const r = this.get(roomId);
    const now = Date.now();
    if (r.snap && r.snap.at + this.cfg.snapshotCacheTtlMs > now) return r.snap.body;
    let body;
    try {
      body = build();
    } catch (e) {
      log("快照装配失败，退回截断空快照:", roomId, e.message);
      return this._fallbackSnapshotBody(roomId);
    }
    if (r.snap && r.snap.timer) clearTimeout(r.snap.timer);
    const timer = setTimeout(() => { if (r.snap && r.snap.body === body) r.snap = null; }, this.cfg.snapshotCacheTtlMs);
    timer.unref();
    r.snap = { at: now, body, timer };
    return body;
  }
  /** 装配失败时的兜底正文：锚点尽量取真值（rev:null 会被前端当成"世代变了"再打一次全量重订阅），
   *  truncated:true 让 UI 明确显示"历史不完整"，而不是把空正文当成完整快照。 */
  _fallbackSnapshotBody(roomId) {
    let rev = null;
    let seq = 0;
    const store = this._transcriptStore;
    if (store && typeof store.info === "function") {
      try {
        const info = store.info(roomId);
        if (info) {
          if (typeof info.rev === "string") rev = info.rev;
          if (Number.isInteger(info.seq) && info.seq >= 0) seq = info.seq;
        }
      } catch (e) {
        log("快照兜底锚点读取失败:", roomId, e.message);
      }
    }
    return `"rev":${JSON.stringify(rev)},"seq":${seq},"truncated":true,"messages":[]`;
  }
  invalidate(roomId) {
    const r = this.map.get(roomId);
    if (r && r.snap) {
      clearTimeout(r.snap.timer);
      r.snap = null;
    }
  }
  /** 列表：在线房间 + 仍在内存里的离线房间（离线未淘汰 = 可回看，UI 折叠成"已结束 N"）。
   *  每条带 lastActivity：同 cwd 多房间时前端据此挑最新的，不靠 id 排序猜。 */
  list({ includeOffline = true } = {}) {
    const cutoff = Date.now() - this.cfg.roomIdleEvictMs;
    const out = [];
    for (const r of this.map.values()) {
      if (!r.online) {
        if (!includeOffline) continue;
        // 长期没人看、也没有活动的离线房间：即将被 evictIdle 收走，不再下发
        if (!r.viewers.size && (r.lastActivity || 0) < cutoff) continue;
      }
      const session = this.sessionLookup
        ? this.sessionLookup(r.accountId || DEFAULT_ACCOUNT, r.deviceId || UNREGISTERED_DEVICE, r.id)
        : null;
      out.push({
        id: r.id,
        accountId: r.accountId || DEFAULT_ACCOUNT,
        deviceId: r.deviceId || UNREGISTERED_DEVICE,
        label: r.label,
        name: session && session.name ? session.name : null,
        firstMessage: session && session.firstMessage ? session.firstMessage : null,
        cwd: r.cwd,
        online: r.online,
        // 与快照/room_state 同一口径（wire.snapshotFrame 也是 online && busy）：离线房间保留的
        // 上一次 busy 只是扩展断开前的残留，不能出现在列表里（报告：房间列表 busy 不做掩码）。
        busy: !!(r.online && r.busy),
        viewers: r.viewers.size,
        lastActivity: r.lastActivity || 0,
        // 注意力恢复通道（R3-1）：订阅/重连时 UI 靠它把别房落定记录种回追踪器；只带 kind/at
        lastTurnEnd: r.lastTurnEnd ? { kind: r.lastTurnEnd.kind, at: r.lastTurnEnd.at } : null,
        // 最近事件摘要（设计 D §2.3）：只带 type/toolName/at 元数据；由 roomsViewFor 按 room.activity cap 裁剪
        lastEvent: r.lastEvent ? { ...r.lastEvent } : null,
        // 等待摘要（P9 A）：列表侧按"能应答"算（answerable 只在 connections 有 dialog.respond 时下发，
        // 由 roomsViewFor 按连接 cap 再裁剪）；离线房间恒为 []/null
        ...waitingOf(r, true),
        // 定时排期清单（设计 D §3.7）：armed 全量 + 保留期内终态；由 roomsViewFor 按 room.schedule cap 裁剪
        schedules: this.schedulesOf(r),
      });
    }
    return out.sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
  }
  /** 按连接 cap 的清单视图：auth_result / list_rooms 单发与广播都走这里，不许各写一份。
   *  能力组合的裁剪规则见 roomsViewFor（P9 A 起把 lastTurnEnd/waiting/answerable 一起管）。 */
  listFor(ws) {
    return roomsViewFor(ws, this.list());
  }
  broadcastRoomList() {
    // 同一事件里可能被触发多次（订阅/注册/断开/观众数变化）：合并成一次广播，省带宽也省客户端重入
    if (this._roomListScheduled) return;
    this._roomListScheduled = true;
    setImmediate(() => {
      this._roomListScheduled = false;
      let devices = [];
      try { devices = this.deviceSnapshot(); } catch (e) { log("设备列表异常:", e.message); }
      const rooms = this.list();
      // P9 A 分流：按「能力组合」分组（room.attention / room.dialogs / dialog.respond / room.activity 四位，最多 16 组），
      // 每组只算一份副本（roomsViewFor），组内共用；没有声明任何 cap 的连接拿剥得最干净的那份。
      const views = new Map(); // capKey -> 清单副本
      const viewFor = (ws) => {
        const key = roomListCapKey(ws);
        let view = views.get(key);
        if (!view) {
          view = roomsViewFor(ws, rooms);
          views.set(key, view);
        }
        return view;
      };
      const groups = new Map(); // capKey(+inbox 位) -> { view, inbox, conns }
      let inboxSnap = null; // 账本快照懒算一次：只有声明 room.inbox 的组才附带（§1.5 cap 门控）
      for (const v of this.viewers) {
        const withInbox = hasCap(v, "room.inbox");
        // inbox 位用 32：roomListCapKey 已占满低 5 位（room.schedule 是第 5 位 = 16），
        // 原先的 16 位与排期 cap 位相撞，必须上移一位。
        const key = roomListCapKey(v) | (withInbox ? 32 : 0);
        let g = groups.get(key);
        if (!g) {
          g = { view: viewFor(v), inbox: withInbox, conns: [] };
          groups.set(key, g);
        }
        g.conns.push(v);
      }
      for (const g of groups.values()) {
        if (!g.conns.length) continue;
        const frame = { type: "room_list", devices, rooms: g.view };
        if (g.inbox) {
          if (!inboxSnap) inboxSnap = this.inboxSnapshot();
          frame.inbox = inboxSnap;
        }
        broadcast(g.conns, JSON.stringify(frame), this.cfg);
      }
      if (typeof this.deviceConns === "function") {
        // 设备窗口只需要判断"本机哪些房间在线"：只发它自己的设备和房间，
        // 不把别的账号/设备的房间（cwd、标题）推给每个本机窗口。
        // 设备窗口连接不声明 cap，固定走「什么能力都没有」的那份（P9 A）。
        for (const ws of this.deviceConns()) {
          if (!ws || ws.readyState !== 1) continue;
          send(ws, JSON.stringify(roomListForDevice(ws._deviceId, devices, viewFor(null))), this.cfg);
        }
      }
    });
  }
  /** 离线、无人看、长时间无活动的房间移出内存（存储文件不动，再次订阅/上线时重建） */
  evictIdle() {
    const cutoff = Date.now() - this.cfg.roomIdleEvictMs;
    let n = 0;
    let swept = 0;
    for (const [id, r] of this.map) {
      if (r.online || r.local || r.viewers.size || r.lastActivity > cutoff) continue;
      // RoomMap.delete 与 close 路径一致：取消 resend 兜底 / 快照 TTL 定时器
      this.map.delete(id);
      n++;
      // 房间从内存消失 = 再也不会有补发来确认：它名下恢复期 waiting 条目一并判 stale（§1.4），
      // 免得收件箱永远挂着回不来的房间的陈年等待。
      this._disarmInboxGrace(id);
      if (this.inbox) swept += this.inbox.sweepRestored(id);
      // 名下 armed 排期一并退休（session_ended）：房间已消失，排期无处投递（§3.5）。
      if (this.schedule) this.schedule.retireRoom(id);
    }
    if (swept) this._flushInbox();
    return n;
  }
}

/** 可丢弃的事件类型（流式 delta / 原始 provider 流）：丢了远端只是少一帧画面，下一帧或 message_end 会补上 */
const DROPPABLE_LOCAL_EVENTS = new Set([
  "message_update",
  "tool_execution_update",
  "bash_execution_update",
  "provider_stream_event",
]);

/** 图片降级上限：ImageContent.data（base64）超过它换成结构化占位 */
const IMAGE_MAX_CHARS = 128 * 1024;
/** 一次降级（一个事件 / 一份快照 / 一条命令回包）里所有图片的合计预算（base64 字符）。
 *  viewer 单帧上限默认 256 KiB，给正文与 JSON 外壳留 64 KiB；口径与网页输入条的
 *  SEND_IMAGE_TOTAL_MAX_CHARS 一致。只限单张时，几十张卡线图仍会整包穿过，把房文件与
 *  直播帧一起撑大（报告 relay 中-10），所以合计也必须有一道硬顶。 */
const IMAGE_TOTAL_MAX_CHARS = 192 * 1024;

/** 单张图片是否要降级：超单张上限，或塞进本次合计预算会越界。
 *  命中时就地换成与原有降级完全一致的结构化占位，返回 true；只有未命中的图才计入合计，
 *  已换占位的图不占预算（一张超限图不会把后面的小图一起挤掉）。 */
function omitImageIfNeeded(v, state) {
  const chars = v.data.length;
  if (chars <= IMAGE_MAX_CHARS && state.total + chars <= IMAGE_TOTAL_MAX_CHARS) {
    state.total += chars;
    return false;
  }
  v.omittedBytes = Math.floor((chars * 3) / 4);
  v.data = "";
  v.omitted = true;
  return true;
}

/** viewer 侧图片降级兜底（扩展已做同样处理，这里防旧扩展/漏网路径）：
 *  遍历任意事件/消息结构，把超限 ImageContent 换成 {type:"image", mimeType, data:"", omitted:true, omittedBytes}。
 *  单张超 128KB 与"本次合计超预算"都降级；图片节点不受深度早退影响，深层嵌套也必须被降级
 *  （报告 relay 中-10）。遍历改用显式栈而不是递归：不再有 12 层上限，也不会被深层结构打爆调用栈。
 *  **必须在 store.record 之前**做：否则磁盘存的是原图、快照与实时流不一致，且房间文件被大图撑爆。
 *  relay 拥有这些对象（刚从帧里 parse 出来），就地改写即可。 */
function shrinkImagesDeep(root) {
  if (!root || typeof root !== "object") return 0;
  const state = { total: 0 };
  const seen = new WeakSet(); // 防环/重复引用把同一张图重复计入合计
  const stack = [root];
  let hit = 0;
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      // 逆序入栈，保证按数组原顺序处理（合计预算先到先得）
      for (let i = v.length - 1; i >= 0; i--) {
        const x = v[i];
        if (x && typeof x === "object") stack.push(x);
      }
      continue;
    }
    if (v.type === "image" && typeof v.data === "string" && omitImageIfNeeded(v, state)) {
      hit++;
      continue; // 已换成占位，与原实现一样不再深入它的字段
    }
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i >= 0; i--) {
      const x = v[keys[i]];
      if (x && typeof x === "object") stack.push(x);
    }
  }
  return hit;
}

/** local 通道业务消息的归属校验：只接受发给本 socket 已注册房间的消息，防止未注册连接造幽灵房 */
function ownRoom(ws, msg) {
  const room = ws._room;
  if (!room) return null;
  if (room.id !== String(msg.room || "")) return null;
  // 必须确认本 socket 仍是该房间的 local：room_closed/被顶替后 room.local 已置 null，
  // 否则已离线的房间仍会被注入事件，观众看到"离线了还在动"。
  return room.local === ws ? room : null;
}

/** 会话结束/换代（room_closed、扩展实例更替、分支 epoch 重置）时统一清掉不跨会话的瞬时缓存。
 *  usage 必须一起清：它是上一会话的终端 footer 用量，留着会让新订阅者在快照后收到旧值。
 *  注意力摘要三件套（lastTurnEnd/turnOutcome/turnSettled）也必须一起清（第 3 轮审查 A-2）：
 *  漏清会让上一会话的落定跨会话残留——刷新端从清单把旧"已完成"种回新会话，
 *  残留的 turnOutcome 还能给新会话第一次 settled 贴错成败。
 *  返回 true = 清前有未读摘要，调用方据此补广播一次 room_attention{null}。
 *  不动 label/cwd/epoch/instance 等房间身份字段，也不动已有消息存储。 */
function clearSessionState(room) {
  if (!room) return false;
  // 定时排期（设计 D §3）：会话结束/换代 → 该房 armed 排期全部退休（session_ended，
  // 引擎同步写账本 error 提示）——排期绑的是这段对话的上下文，旧排期不跨会话复活。
  if (room._scheduleRef && typeof room._scheduleRef.engine.retireRoom === "function") {
    try { room._scheduleRef.engine.retireRoom(room.id); } catch {}
  }
  const hadTurnEnd = !!room.lastTurnEnd;
  room.queue = null;
  room.compaction = null;
  room.runningTools = null;
  room.autoRetry = null;
  room.uiPrompt = null;
  room.dialogs = null;
  room.extStatus = null;
  room.taskList = null;
  room.agentState = null;
  room.remoteQueue = null;
  room.assistantDraft = null;
  room.usage = null;
  room.lastTurnEnd = null;
  room.turnOutcome = null;
  room.turnSettled = false;
  room.lastEvent = null;
  return hadTurnEnd;
}

module.exports = { cancelResend, sendCachedAssistant, sendCachedAutoRetry, sendCachedUiPrompt, sendCachedDialogs, sendCachedExtStatus, sendCachedCompaction, sendCachedTools, sendCachedToolEnds, toolEndMetaEntry, broadcastToolEndMeta, sendCachedTaskList, sendCachedAgentState, sendCachedRemoteQueue, resendFallbackBody, restartResend, queryKey, Rooms, DROPPABLE_LOCAL_EVENTS, shrinkImagesDeep, IMAGE_MAX_CHARS, IMAGE_TOTAL_MAX_CHARS, ownRoom, clearSessionState, pushDialogGate, observeRoomTurnEvent, clearRoomTurnEnd, broadcastRoomAttention, waitingOf, broadcastRoomWaiting, roomListCapKey, roomsViewFor };
