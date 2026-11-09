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
function sendCachedCompaction(socket, room, config) {
  if (!room || !room.compaction) return;
  const cached = room.compaction;
  const event = { type: "compaction_start" };
  if (Object.prototype.hasOwnProperty.call(cached, "reason")) event.reason = cached.reason;
  if (Object.prototype.hasOwnProperty.call(cached, "willRetry")) event.willRetry = cached.willRetry;
  send(socket, JSON.stringify({ type: "room_event", room: room.id, event }), config);
}

/** 助手还在写、房间仍在线时，补一条不带 seq / rev 的 message_start。
 *  没有工具块时 content 只输出思考和文本，空洞跳过。
 *  有工具块时从下标 0 到最后一格都出现：思考和文本照旧，工具块和空洞是 {type:text,text:""}，不含 toolCall。
 *  stopReason 固定 pending。
 *  快照里已有相同 timestamp 的 assistant 消息则不补。房间不在线、没记过开始，也不编造。
 *  超过 maxPayloadBytes 时改发空 content，不断开。since 增量由调用方跳过。
 *  紧接着按 contentIndex 补还在写的工具参数（message_update，不带 seq / rev / usage），
 *  仍在进行中工具补发之前。单条超限则跳过该条，不断开。 */
function sendCachedAssistant(socket, room, config, transcriptStore) {
  if (!room || !room.online || !room.assistantDraft) return;
  // Enc rooms never get the plaintext catch-up draft (design section 4.1): the
  // draft body exists only as ciphertext envelopes on the encrypted path, so
  // fabricating a plaintext-shaped message here would leak/corrupt content.
  if (transcriptStore && typeof transcriptStore.encInfo === "function" && transcriptStore.encInfo(room.id)) return;
  const draft = room.assistantDraft;
  if (snapshotHasAssistant(transcriptStore, room, config, draft)) return;
  const content = assistantDraftContent(draft);
  let message = assistantCatchupMessage(draft, content);
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event: { type: "message_start", message } });
  } catch (serializeError) {
    log("进行中助手补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("进行中助手补发超过 maxPayloadBytes，改为空正文:", room.id, Buffer.byteLength(frame));
    message = assistantCatchupMessage(draft, []);
    try {
      frame = JSON.stringify({ type: "room_event", room: room.id, event: { type: "message_start", message } });
    } catch (serializeError) {
      log("进行中助手补发序列化失败，跳过:", room.id, serializeError.message);
      return;
    }
  }
  send(socket, frame, config);
  sendCachedToolArgs(socket, room, config, draft);
}

function assistantCatchupMessage(draft, content) {
  const message = { role: "assistant", content, stopReason: "pending" };
  if (Object.prototype.hasOwnProperty.call(draft, "timestamp")) message.timestamp = draft.timestamp;
  return message;
}

function assistantDraftContent(draft) {
  const blocks = draft && draft.blocks ? draft.blocks : [];
  let hasTool = false;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    if (blocks[blockIndex] && blocks[blockIndex].type === "tool") {
      hasTool = true;
      break;
    }
  }
  if (!hasTool) {
    const content = [];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      if (!block) continue;
      if (block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking });
      else if (block.type === "text") content.push({ type: "text", text: block.text });
    }
    return content;
  }
  const content = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (block && block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking });
    else if (block && block.type === "text") content.push({ type: "text", text: block.text });
    else content.push({ type: "text", text: "" });
  }
  return content;
}

/** 一条工具参数补发。超过 maxPayloadBytes 就记一行日志并跳过这一条，不断开。不带 seq / rev / usage。 */
function sendAssistantToolFrame(socket, room, config, toolEvent) {
  const event = { type: "message_update", assistantMessageEvent: toolEvent };
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (serializeError) {
    log("进行中工具参数补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("进行中工具参数补发超过 maxPayloadBytes，跳过:", room.id, toolEvent.type, toolEvent.contentIndex, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/** 按 contentIndex 从小到大，每个工具块先 toolcall_start，参数字符串非空再发一条拼好的 toolcall_delta，记下了 arguments 再发 toolcall_end。 */
function sendCachedToolArgs(socket, room, config, draft) {
  const blocks = draft && draft.blocks ? draft.blocks : [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (!block || block.type !== "tool") continue;
    const start = { type: "toolcall_start", contentIndex: blockIndex };
    if (typeof block.id === "string" && block.id) start.id = block.id;
    if (typeof block.toolName === "string" && block.toolName) start.toolName = block.toolName;
    sendAssistantToolFrame(socket, room, config, start);
    if (typeof block.args === "string" && block.args) {
      sendAssistantToolFrame(socket, room, config, { type: "toolcall_delta", contentIndex: blockIndex, delta: block.args });
    }
    if (!Object.prototype.hasOwnProperty.call(block, "arguments")) continue;
    const toolCall = {};
    if (typeof block.id === "string" && block.id) toolCall.id = block.id;
    if (typeof block.toolName === "string" && block.toolName) toolCall.name = block.toolName;
    toolCall.arguments = block.arguments;
    sendAssistantToolFrame(socket, room, config, { type: "toolcall_end", contentIndex: blockIndex, toolCall });
  }
}

/** 全量快照里已经有同一 timestamp 的 assistant，就别再补一条 message_start。 */
function snapshotHasAssistant(transcriptStore, room, config, draft) {
  if (!transcriptStore || !draft || !Object.prototype.hasOwnProperty.call(draft, "timestamp")) return false;
  let snapshot = null;
  try {
    snapshot = transcriptStore.snapshot(room.id, {
      limit: (config && config.maxSnapshotRecords) || 10000,
      maxBytes: (config && config.maxSnapshotBytes) || 24 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  const items = snapshot && snapshot.items;
  if (!Array.isArray(items)) return false;
  for (const storedItem of items) {
    let message = storedItem;
    if (typeof storedItem === "string") {
      try { message = JSON.parse(storedItem); } catch { continue; }
    }
    if (message && message.role === "assistant" && message.timestamp === draft.timestamp) return true;
  }
  return false;
}

/** 把一条进行中工具补发帧发出去。超过 maxPayloadBytes 就记一行日志并跳过，不断开。不带 seq / rev。 */
function sendRunningToolFrame(socket, room, config, toolEvent) {
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event: toolEvent });
  } catch (serializeError) {
    log("进行中工具补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("进行中工具补发超过 maxPayloadBytes，跳过:", room.id, toolEvent.type, toolEvent.toolCallId, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/** 全量快照里 role 为 toolResult 的 toolCallId，加上 store 里已记 end 元数据的 toolCallId。
 *  房间上还没有存储、或快照/元数据都读不到时返回 null，调用方仍按还在跑补发。
 *  读到了、只是没有对应结果时返回空集，不能因此把补发变成恒空。 */
function settledToolIds(room, config) {
  const transcriptStore = room && room.store;
  if (!transcriptStore || typeof transcriptStore.snapshot !== "function") return null;
  let snapshot = null;
  let snapshotReadable = false;
  try {
    snapshot = transcriptStore.snapshot(room.id, {
      limit: (config && config.maxSnapshotRecords) || 10000,
      maxBytes: (config && config.maxSnapshotBytes) || 24 * 1024 * 1024,
    });
    snapshotReadable = !!(snapshot && Array.isArray(snapshot.items));
  } catch {
    snapshotReadable = false;
  }
  const settledIds = new Set();
  if (snapshotReadable) {
    for (const storedItem of snapshot.items) {
      let message = storedItem;
      if (typeof storedItem === "string") {
        try { message = JSON.parse(storedItem); } catch { continue; }
      }
      if (!message || message.role !== "toolResult") continue;
      if (typeof message.toolCallId === "string" && message.toolCallId) settledIds.add(message.toolCallId);
    }
  }
  // 乱序时 start 可能晚于 end 到达：即使 runningTools 里还留着，同一 toolCallId 已有权威 end 也不再补成"还在跑"。
  if (typeof transcriptStore.toolEnds === "function") {
    try {
      const endedToolMetas = transcriptStore.toolEnds(room.id);
      if (Array.isArray(endedToolMetas)) {
        for (const endedToolMeta of endedToolMetas) if (endedToolMeta && typeof endedToolMeta.toolCallId === "string" && endedToolMeta.toolCallId) settledIds.add(endedToolMeta.toolCallId);
      }
    } catch {}
  }
  if (!snapshotReadable && settledIds.size === 0) return null;
  return settledIds;
}

/** 工具还没结束、房间仍在线时，按开始顺序补 tool_execution_start / tool_execution_update。
 *  有 start 才发 start（toolCallId、toolName、args，以及 relay 收到 start 的时刻 startedAt）；
 *  有 partialResult 才发 update（toolCallId、toolName、partialResult）。
 *  全量快照里已经有同一 toolCallId 的 toolResult 时，这一条不再补 start / update。不从 runningTools 里删除，不编造 tool_execution_end。
 *  快照读取失败或房间上还没有存储时，仍按还在跑补发。没记过、已经结束、房间不在线时不编造。
 *  调用方把它排在还在写的助手正文之后、自动重试补发与 compaction_start 补发之前。 */
function sendCachedTools(socket, room, config) {
  if (!room || !room.online || !room.runningTools || !room.runningTools.length) return;
  const settled = settledToolIds(room, config);
  for (const cached of room.runningTools) {
    if (settled && settled.has(cached.toolCallId)) continue;
    if (cached.fromStart) {
      const start = { type: "tool_execution_start", toolCallId: cached.toolCallId };
      if (Object.prototype.hasOwnProperty.call(cached, "toolName")) start.toolName = cached.toolName;
      if (Object.prototype.hasOwnProperty.call(cached, "args")) start.args = cached.args;
      // 补丁 1：晚到者靠这个锚点算耗时，不能从 0 重计
      if (typeof cached.startedAt === "number" && Number.isFinite(cached.startedAt)) start.startedAt = cached.startedAt;
      sendRunningToolFrame(socket, room, config, start);
    }
    if (Object.prototype.hasOwnProperty.call(cached, "partialResult")) {
      const update = { type: "tool_execution_update", toolCallId: cached.toolCallId };
      if (Object.prototype.hasOwnProperty.call(cached, "toolName")) update.toolName = cached.toolName;
      update.partialResult = cached.partialResult;
      sendRunningToolFrame(socket, room, config, update);
    }
  }
}

/** store 里的 ended-tool 元数据（扩展帧字段名）→ 线上 `tool_end_meta` 的 entry（camelCase）。
 *  字段缺省就不带，绝不补默认值；toolCallId 非法返回 null。 */
function toolEndMetaEntry(endedToolMeta) {
  if (!endedToolMeta || typeof endedToolMeta.toolCallId !== "string" || !endedToolMeta.toolCallId) return null;
  const entry = { toolCallId: endedToolMeta.toolCallId };
  if (typeof endedToolMeta.exit_code === "number" && Number.isFinite(endedToolMeta.exit_code)) entry.exitCode = endedToolMeta.exit_code;
  if (typeof endedToolMeta.wall_time_seconds === "number" && Number.isFinite(endedToolMeta.wall_time_seconds)) {
    entry.wallTimeSeconds = endedToolMeta.wall_time_seconds;
  }
  if (endedToolMeta.termStatus === "timeout" || endedToolMeta.termStatus === "aborted") entry.termStatus = endedToolMeta.termStatus;
  if (typeof endedToolMeta.endedAt === "number" && Number.isFinite(endedToolMeta.endedAt) && endedToolMeta.endedAt > 0) entry.endedAt = endedToolMeta.endedAt;
  if (typeof endedToolMeta.isError === "boolean") entry.isError = endedToolMeta.isError;
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
function sendToolEndMeta(socket, room, config, entries) {
  if (!room || !Array.isArray(entries) || !entries.length) return;
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  let start = 0;
  while (start < entries.length) {
    // 二分找本批最多能带多少条：帧字节数随条数单调增长。
    let low = start + 1;
    let high = entries.length;
    let batchEnd = start;
    while (low <= high) {
      const middleIndex = (low + high) >> 1;
      const bytes = Buffer.byteLength(toolEndMetaFrame(room, entries.slice(start, middleIndex)));
      if (bytes <= limit) { batchEnd = middleIndex; low = middleIndex + 1; }
      else high = middleIndex - 1;
    }
    if (batchEnd === start) {
      log("ended-tool 单条元数据超过 maxPayloadBytes，跳过:", room.id, entries[start] && entries[start].toolCallId);
      start += 1;
      continue;
    }
    send(socket, toolEndMetaFrame(room, entries.slice(start, batchEnd)), config);
    start = batchEnd;
  }
}

/** 订阅/补发：按 toolCallId 把 store 里保留的全部 ended-tool 元数据带给新 viewer（超限分批）。
 *  只发元数据、不发 result/输出；离线房间也能补（历史仍在磁盘/内存里）。 */
function sendCachedToolEnds(socket, room, config) {
  if (!room) return;
  const transcriptStore = room.store;
  if (!transcriptStore || typeof transcriptStore.toolEnds !== "function") return;
  let endedToolMetas = null;
  try {
    endedToolMetas = transcriptStore.toolEnds(room.id);
  } catch (readError) {
    log("ended-tool 元数据读取失败，跳过:", room.id, readError.message);
    return;
  }
  if (!Array.isArray(endedToolMetas) || !endedToolMetas.length) return;
  const entries = [];
  for (const endedToolMeta of endedToolMetas) {
    const entry = toolEndMetaEntry(endedToolMeta);
    if (entry) entries.push(entry);
  }
  sendToolEndMeta(socket, room, config, entries);
}

/** live tool_execution_end 之后广播一条 tool_end_meta（单条 entries），不带 seq / rev。 */
function broadcastToolEndMeta(room, config, endedToolMetas) {
  if (!room || !Array.isArray(endedToolMetas) || !endedToolMetas.length) return;
  const entries = [];
  for (const endedToolMeta of endedToolMetas) {
    const entry = toolEndMetaEntry(endedToolMeta);
    if (entry) entries.push(entry);
  }
  if (!entries.length) return;
  const frame = toolEndMetaFrame(room, entries);
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("live ended-tool 元数据超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  broadcast(room.viewers, frame, config);
}

/** 自动重试还没结束、房间仍在线时，把记下的 auto_retry_start 补给这一条连接。
 *  四个字段始终带上。没发过、已经结束、换了 instance、epoch 重置、room_closed 或房间不在线时缓存是空的或不发，这里不编造。
 *  不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。
 *  调用方把它排在进行中工具之后、compaction_start 之前。 */
function sendCachedAutoRetry(socket, room, config) {
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
  } catch (serializeError) {
    log("自动重试补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("自动重试补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/** 本机弹窗还没关掉、房间仍在线时，把记下的 ui_prompt_start 补给这一条连接。
 *  reason、kind、title 三个字段始终带上。没发过、已经结束、换了 instance、room_closed 或房间不在线时缓存是空的或不发，这里不编造。
 *  不带 seq / rev。不补发 ui_prompt_end。超过 maxPayloadBytes 就记一行日志并跳过，不断开。
 *  调用方把它排在自动重试补发之后、compaction_start 之前。 */
function sendCachedUiPrompt(socket, room, config) {
  if (!room || !room.online || !room.uiPrompt) return;
  const cached = room.uiPrompt;
  const event = {
    type: "ui_prompt_start",
    reason: cached.reason,
    kind: cached.kind,
    title: cached.title,
  };
  // (b+) sealed title (crypto.dialog): the cache holds the envelope instead
  // of a plaintext title (title stays null); resend it only to connections
  // that declared crypto.dialog -- the same downgrade rule sendCachedDialogs
  // applies. A sealed field reaching a non-cap viewer makes the client
  // classify the room as body-encrypted and park its plaintext snapshots.
  if (cached.titleEnc && hasCap(socket, "crypto.dialog")) event.titleEnc = cached.titleEnc;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (serializeError) {
    log("本机弹窗补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("本机弹窗补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/** 剥掉 answerable 的槽副本（A-6）：只剥应答面标记，观察形态的卡本体不动；
 *  缓存槽本体不改（其他有 cap 的连接还要按原样补发）。 */
function withoutAnswerable(slot) {
  if (!slot || slot.answerable !== true) return slot;
  const copy = { ...slot };
  delete copy.answerable;
  return copy;
}

/** (b+) downgrade copy of a sealed slot for connections without crypto.dialog:
 *  structural fields only -- the text envelopes, the answerable flag and
 *  the slot-internal sealed-form marker are removed. The cached slot
 *  itself is never mutated (other connections still get the full form). */
function downgradeSealedSlot(slot) {
  const copy = { ...slot };
  delete copy.answerable;
  delete copy.textEnc;
  delete copy.titleEnc;
  delete copy.sealed;
  return copy;
}

/** 对话框观察（O1）多槽补发：房间上每个在开 dialog 槽各补一条 dialog_open。
 *  startedAt 用首次捕获的原值（前端倒计时/已等待以它为锚，多端一致）。
 *  离线房间不补发（与 uiPrompt 对齐）；不带 seq / rev。
 *  门控粒度（A-6）：按这条连接握手声明的 cap 逐槽处理——声明了 dialog.respond
 *  才带 answerable:true；未声明的（旧端）剥掉 answerable 只发观察形态只读卡。 */
function sendCachedDialogs(socket, room, config) {
  if (!room || !room.online || !room.dialogs) return;
  const canAnswer = hasCap(socket, "dialog.respond");
  const canMulti = canAnswer && hasCap(socket, "dialog.multiselect");
  const canSealed = hasCap(socket, "crypto.dialog");
  for (const slot of Object.values(room.dialogs)) {
    // 多选槽（G3）的 answerable 还要 dialog.multiselect 那道 cap，与直播门控同口径
    const slotCanAnswer = slot.kind === "multiselect" ? canMulti : canAnswer;
    // (b+) sealed-form slot (crypto.dialog): sealed-form is the slot's
    // internal presence marker (set when the intake frame carried an
    // envelope field, valid or not), so a connection without the cap gets
    // the downgrade card (structural fields only); with the cap the cached
    // slot is resent with whatever valid payload it holds, under the usual
    // answerable gate. The marker itself is never sent upstream.
    let out = slot.sealed && !canSealed ? downgradeSealedSlot(slot) : (slotCanAnswer ? slot : withoutAnswerable(slot));
    if (out.sealed !== undefined) {
      out = { ...out };
      delete out.sealed;
    }
    let frame;
    try {
      frame = JSON.stringify({ type: "room_event", room: room.id, event: out });
    } catch (serializeError) {
      log("弹窗观察补发序列化失败，跳过:", room.id, serializeError.message);
      continue;
    }
    const limit = (config && config.maxPayloadBytes) || 256 * 1024;
    if (Buffer.byteLength(frame) > limit) {
      log("弹窗观察补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
      continue;
    }
    send(socket, frame, config);
  }
}

/** Minimum spacing between ext_status requests to the same room's bridge.
 *  Asking is demand-driven (a viewer is being served and the cache is
 *  empty); the spacing keeps a burst of subscribes from turning into a
 *  burst of identical snapshots. The timestamp lives on the room and is
 *  reset when a report lands (rememberExtStatus) and when the session
 *  state is cleared, so a genuinely new miss can ask again at once. */
const EXT_STATUS_REQUEST_MIN_MS = 10000;

/** Ask the room's bridge for a fresh ext_status snapshot (relay -> local).
 *  Old bridges ignore the unknown frame type and simply keep today's
 *  behavior (their first natural emit warms the cache). No-op when the
 *  room is offline, has no bridge, or was asked very recently. */
function requestExtStatus(room, config) {
  if (!room || !room.online || !room.local) return;
  const now = Date.now();
  if (room.extStatusAskedAt && now - room.extStatusAskedAt < EXT_STATUS_REQUEST_MIN_MS) return;
  room.extStatusAskedAt = now;
  send(room.local, { type: "ext_status_request", room: room.id }, config);
}

/** 扩展 UI 状态（ext_status）最后一份快照补发：statuses/widgets/title/working/tap 全量。
 *  离线房间不补发；不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。
 *  缓存为空但房间在线时，向桥索取一份新的（requestExtStatus）：注册竞态丢帧、
 *  换代清缓存之后，缓存不会自己长回来，晚到的观看端会永远等不到设备开关真值。 */
function sendCachedExtStatus(socket, room, config) {
  if (!room || !room.online) return;
  if (!room.extStatus) {
    requestExtStatus(room, config);
    return;
  }
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event: room.extStatus });
  } catch (serializeError) {
    log("扩展状态补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("扩展状态补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/** 房间上缓存了最后一份 task_list_state 时，把它补给这一条连接。
 *  空数组也是合法状态（清空），按缓存原样补发。没收到过不编造。
 *  不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。 */
function sendCachedTaskList(socket, room, config) {
  // 离线房间不补发旧清单：与 uiPrompt 对齐，晚到观众不该看到上一个会话的任务状态。
  if (!room || !room.online || !room.taskList) return;
  const cached = room.taskList;
  const event = { type: "task_list_state", tasks: cached.tasks };
  if (Object.prototype.hasOwnProperty.call(cached, "source")) event.source = cached.source;
  if (Object.prototype.hasOwnProperty.call(cached, "at")) event.at = cached.at;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (serializeError) {
    log("任务清单补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("任务清单补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/** 房间上缓存了最后一份 agent_state 时，把它补给这一条连接。
 *  空 agents 也是合法状态（清空），按缓存原样补发；没收到过不编造。
 *  离线房间不补发旧快照（与任务清单/uiPrompt 对齐）；不带 seq / rev。
 *  超过 maxPayloadBytes 就记一行日志并跳过，不断开。 */
function sendCachedAgentState(socket, room, config) {
  if (!room || !room.online || !room.agentState) return;
  const cached = room.agentState;
  const event = { type: "agent_state", agents: cached.agents };
  if (Object.prototype.hasOwnProperty.call(cached, "at")) event.at = cached.at;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (serializeError) {
    log("子智能体状态补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("子智能体状态补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/** 房间上缓存了最后一份 remote_queue_state 时，把它补给这一条连接。
 *  整份状态原样补发（空 items 也合法，表示没有待发/已清空）；没收到过不编造。
 *  不带 seq / rev。超过 maxPayloadBytes 就记一行日志并跳过，不断开。 */
function sendCachedRemoteQueue(socket, room, config) {
  // 离线房间不补发旧待发队列：缓存只在房间在线期间有效。
  if (!room || !room.online || !room.remoteQueue) return;
  const cached = room.remoteQueue;
  const event = { type: "remote_queue_state", rev: cached.rev, items: cached.items };
  if (typeof cached.at === "number" && Number.isFinite(cached.at)) event.at = cached.at;
  let frame;
  try {
    frame = JSON.stringify({ type: "room_event", room: room.id, event });
  } catch (serializeError) {
    log("远程待发补发序列化失败，跳过:", room.id, serializeError.message);
    return;
  }
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("远程待发补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/* ---------------- E1: recent delivery finals per room ----------------
 * The delivered/failed verdict for a viewer-sent message is broadcast
 * live to the room's current viewers only (see the event path in
 * local.js). A viewer who sent a message and then switched rooms never
 * sees the verdict, and its outbox entry lingers in "awaiting" until
 * the 10-minute patrol fails it (possibly wrongly). The relay therefore
 * keeps, per room, a small bounded table of recent finals; snapshot
 * bodies assembled for the room carry the in-TTL entries as an
 * additive `finalFrames` field, so a re-subscribing viewer settles its
 * outbox on arrival. Old viewers ignore the unknown field.
 * Bounds: at most FINAL_FRAMES_MAX_PER_ROOM entries per room and a
 * FINAL_FRAMES_TTL_MS time-to-live (the same order as the outbox
 * patrol), so the table cannot grow with the room's lifetime.
 * In-memory only: a relay restart forgets the finals, which matches
 * the outbox's own in-memory lifetime. */
const FINAL_FRAMES_TTL_MS = 10 * 60 * 1000;
const FINAL_FRAMES_MAX_PER_ROOM = 200;

function pruneFinalFrames(room, now) {
  const table = room.finalFrames;
  if (!table) return;
  for (const [cid, entry] of table) {
    if (!entry || !(now - entry.at < FINAL_FRAMES_TTL_MS)) table.delete(cid);
  }
  // Map iteration order is insertion order: drop the oldest first.
  while (table.size > FINAL_FRAMES_MAX_PER_ROOM) {
    const oldest = table.keys().next().value;
    if (oldest === undefined) break;
    table.delete(oldest);
  }
}

/** Record one delivery final for a room. disposition is "delivered" or
 * "failed"; anything else is ignored. Re-recording a cid replaces its
 * entry and makes it the newest one. */
function recordFinalFrame(room, cid, disposition, at) {
  if (!room || typeof cid !== "string" || !cid) return;
  if (disposition !== "delivered" && disposition !== "failed") return;
  if (!room.finalFrames) room.finalFrames = new Map();
  const stamp = typeof at === "number" && Number.isFinite(at) ? at : Date.now();
  room.finalFrames.delete(cid);
  room.finalFrames.set(cid, { disposition, at: stamp });
  pruneFinalFrames(room, Date.now());
}

/** The room's in-TTL finals as a wire array: [{cid, disposition, at}],
 * oldest first. Prunes expired and overflow entries as a side effect. */
function finalFramesOf(room, now) {
  if (!room || !room.finalFrames) return [];
  pruneFinalFrames(room, typeof now === "number" && Number.isFinite(now) ? now : Date.now());
  const out = [];
  for (const [cid, entry] of room.finalFrames) out.push({ cid, disposition: entry.disposition, at: entry.at });
  return out;
}

/** Append the room's in-TTL finals to a snapshot body fragment (the
 * `"rev":...,"messages":[...]` string that snapshotFrame wraps).
 * Returns the body unchanged when the room has no in-TTL finals, so
 * snapshot frames keep their exact previous shape in the common case. */
function snapshotBodyWithFinalFrames(body, room) {
  const finals = finalFramesOf(room);
  if (!finals.length) return body;
  return `${body},"finalFrames":${JSON.stringify(finals)}`;
}

/** resend 兜底帧正文：store 里有可交付记录就给真快照，否则给带真实 rev/seq 的空 pending 帧。
 *  读快照失败时**不能**直接落回 `"rev":null` —— 那是注释里明说要避免的错误形态（前端当成"世代变了"，
 *  会多打一次全量重订阅）。快照失败就单独再问一次锚点，尽量把真 rev/seq 带出去。 */
function resendFallbackBody(config, transcriptStore, room) {
  let snapshot = null;
  try {
    snapshot = transcriptStore.snapshot(room.id, { limit: config.maxSnapshotRecords, maxBytes: config.maxSnapshotBytes });
  } catch (snapshotError) {
    log("resend 兜底快照读取失败，改用锚点帧:", room.id, snapshotError.message);
  }
  if (snapshot && Array.isArray(snapshot.items) && snapshot.items.length) return snapshotBodyWithFinalFrames(snapshotBodyFrom(snapshot), room);
  // 兜底帧也要带真实 rev/seq：rev:null 会被前端当成"世代变了"而多打一次全量重订阅
  let revision = null;
  let sequence = 0;
  try {
    const storeInfo = transcriptStore.info(room.id);
    if (storeInfo) {
      if (typeof storeInfo.rev === "string") revision = storeInfo.rev;
      if (Number.isInteger(storeInfo.seq) && storeInfo.seq >= 0) sequence = storeInfo.seq;
    }
  } catch (anchorError) {
    log("resend 兜底锚点读取失败，只能发 rev:null 空帧:", room.id, anchorError.message);
  }
  return snapshotBodyWithFinalFrames(`"rev":${JSON.stringify(revision)},"seq":${sequence},"truncated":false,"snapshotPending":true,"messages":[]`, room);
}

/**
 * 换绑/顶替设备窗口时调用：作废旧窗口发起的那次重发，但**不能丢正在等首帧快照的 viewer**。
 * 房间的 local 是扩展那条 socket（和 attach 窗口不是同一条连接），所以向 room.local 重新要一次；
 * 房间不在线或没有 local 就立刻给兜底帧。只清 timer 不清 waiters 会把 viewer 永久挂在 loading。
 */
function restartResend(config, transcriptStore, room) {
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
    const body = resendFallbackBody(config, transcriptStore, room);
    for (const viewerConnection of waiters) {
      send(viewerConnection, snapshotFrame(room, body), config);
      sendCachedTaskList(viewerConnection, room, config);
      sendCachedAgentState(viewerConnection, room, config);
      sendCachedRemoteQueue(viewerConnection, room, config);
      sendCachedAssistant(viewerConnection, room, config, transcriptStore);
      sendCachedTools(viewerConnection, room, config);
      sendCachedToolEnds(viewerConnection, room, config);
      sendCachedAutoRetry(viewerConnection, room, config);
      sendCachedUiPrompt(viewerConnection, room, config);
      sendCachedDialogs(viewerConnection, room, config);
      sendCachedExtStatus(viewerConnection, room, config);
      sendCachedCompaction(viewerConnection, room, config);
    }
    return;
  }
  send(room.local, { type: "resend_snapshot", room: room.id }, config);
  room.resendTimer = setTimeout(() => {
    room.resendTimer = null;
    const left = room.resendWaiters || [];
    room.resendWaiters = [];
    const body = resendFallbackBody(config, transcriptStore, room);
    for (const viewerConnection of left) {
      send(viewerConnection, snapshotFrame(room, body), config);
      sendCachedTaskList(viewerConnection, room, config);
      sendCachedAgentState(viewerConnection, room, config);
      sendCachedRemoteQueue(viewerConnection, room, config);
      sendCachedAssistant(viewerConnection, room, config, transcriptStore);
      sendCachedTools(viewerConnection, room, config);
      sendCachedToolEnds(viewerConnection, room, config);
      sendCachedAutoRetry(viewerConnection, room, config);
      sendCachedUiPrompt(viewerConnection, room, config);
      sendCachedDialogs(viewerConnection, room, config);
      sendCachedExtStatus(viewerConnection, room, config);
      sendCachedCompaction(viewerConnection, room, config);
    }
  }, config.resendSnapshotWaitMs || 3000);
  room.resendTimer.unref();
}

/** 对话框应答（O2）viewer 在线门控：房间订阅数 0↔>0 变化时向桥推 dialog_gate 帧
 * （定版：事件推送、桥以最近一帧为准）。force=true 时无条件重推当前值（桥重连补发用）。
 * 桥不在（room.local 空）只记状态，连上后由 room_register 路径 force 补发。 */
function pushDialogGate(room, config, force) {
  if (!room) return;
  const hasViewers = room.viewers.size > 0;
  if (!force && room.dialogGate === hasViewers) return;
  room.dialogGate = hasViewers;
  if (room.local) send(room.local, { type: "dialog_gate", room: room.id, hasViewers }, config);
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
    const closeReason = typeof event.reason === "string" ? event.reason : "";
    const reason = closeReason === "answered" || closeReason === "denied" ? "answered" : (closeReason === "timeout" || event.outcome === "timeout" ? "timeout" : null);
    if (reason) room._inboxRef.store.amendTombReason(room._inboxRef.accountId, `dialog:${room.id}:${event.dialogId}`, reason);
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
    const lastEvent = { type, at: now };
    if (type === "tool_execution_start" && typeof event.toolName === "string" && event.toolName) {
      lastEvent.toolName = event.toolName.slice(0, 64);
    }
    room.lastEvent = lastEvent;
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
    const assistantMessage = event.message;
    if (assistantMessage && typeof assistantMessage === "object" && assistantMessage.role === "assistant") {
      const stopReason = typeof assistantMessage.stopReason === "string" ? assistantMessage.stopReason : "";
      if (stopReason && !NON_TERMINAL_STOP_REASONS.has(stopReason)) {
        room.turnOutcome = stopReason === "aborted" ? "aborted" : (stopReason === "error" || !!assistantMessage.errorMessage ? "error" : "ok");
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
  const inboxRef = room._inboxRef;
  if (inboxRef && inboxRef.store && inboxRef.store.clearRoomTurns(inboxRef.accountId, room.id) > 0) had = true;
  return had;
}

/** room_attention 帧：字段白名单只有 room 与 lastTurnEnd{kind,at}|null，不带任何正文/标题。
 *  听众与 room_list 同一批设备级连接（rooms.viewers 全体），不按房间订阅过滤——
 *  说的正是"别的房间"的落定，订阅了该房的人反而不需要它。
 *  cap 门控（第 3 轮审查 A-1，粒度仿第 2 轮 A-6）：room.attention 是新面，只发给
 *  握手声明过该 cap 的连接；未声明的旧端不收新帧、清单条目也剥 lastTurnEnd
 *  （见 roomsViewFor），既有面（在线/忙闲/标题）一律不剥。 */
function broadcastRoomAttention(rooms, room, config) {
  if (!rooms || !room) return;
  if (typeof rooms.syncInboxTurn === "function") rooms.syncInboxTurn(room); // 收件箱账本来源三：落定/清除先与账本对账，再广播（同帧口径一致）
  broadcast([...rooms.viewers].filter((viewerConnection) => hasCap(viewerConnection, "room.attention")), {
    type: "room_attention",
    room: room.id,
    lastTurnEnd: room.lastTurnEnd ? { kind: room.lastTurnEnd.kind, at: room.lastTurnEnd.at } : null,
  }, config);
}

/* ---------------- 房间等待摘要（P9 A：room.dialogs） ----------------
 * 旧端（未声明 room.dialogs）不看这两个字段，但仍要收 room_list 的既有面；
 * 所以摘要只在 list()/listFor 里按 cap 附加或剥离，广播帧 room_waiting 只发给声明端。 */

/** 房间的等待摘要：只在线房间有；canAnswer=false 时去掉 answerable。
 *  waiting 只带 6 个字段（不带 options/message/prefill 等正文面）；waitingPrompt 是
 *  旧的单槽 ui_prompt 兜底信号，只在 waiting 为空时才有意义。 */
function waitingOf(room, canAnswer, canMulti = canAnswer, canSealed = true) {
  if (!room || !room.online) return { waiting: [], waitingPrompt: null };
  const waiting = Object.values(room.dialogs || {}).map((slot) => {
    const waitingEntry = { dialogId: slot.dialogId, kind: slot.kind, startedAt: slot.startedAt };
    // (b+) sealed-form slot (crypto.dialog): the summary carries only the
    // ACK-sealed title's ct string, never a plaintext title (the slot holds
    // none). Without the cap, titleEnc and the entry's answerable are both
    // withheld (downgrade posture, design section 5.2). Sealed-form is the
    // slot's presence marker: a slot whose envelope was invalid holds no
    // payload at all and still derives as sealed here.
    const sealed = !!slot.sealed;
    if (sealed) {
      if (canSealed && slot.titleEnc) waitingEntry.titleEnc = slot.titleEnc.ct;
    } else if (slot.title) waitingEntry.title = slot.title;
    if (slot.timeout) waitingEntry.timeout = slot.timeout;
    // 多选槽（G3）的 answerable 还要 dialog.multiselect 那道 cap，与直播/补发同口径
    if ((!sealed || canSealed) && (slot.kind === "multiselect" ? canMulti : canAnswer) && slot.answerable === true) waitingEntry.answerable = true;
    return waitingEntry;
  });
  const uiPrompt = room.uiPrompt;
  let waitingPrompt = null;
  if (!waiting.length && uiPrompt) {
    waitingPrompt = { kind: uiPrompt.kind || "", at: uiPrompt.at || 0 };
    if (uiPrompt.titleEnc) {
      if (canSealed) waitingPrompt.titleEnc = uiPrompt.titleEnc.ct;
    } else {
      waitingPrompt.title = uiPrompt.title || "";
    }
  }
  return { waiting, waitingPrompt };
}

/** 同一个 tick 里多次触发只广播一次（仿 broadcastRoomList 的 setImmediate）。
 *  每帧是房间的全量摘要；听众与 room_attention 同一批（rooms.viewers 全体，不按订阅过滤），
 *  只发给握手声明了 room.dialogs 的连接。 */
function broadcastRoomWaiting(rooms, room, config) {
  if (!rooms || !room) return;
  if (typeof rooms.syncInboxDialogs === "function") rooms.syncInboxDialogs(room); // 收件箱账本来源一/二：槽位调用点每次变化后必经此地，同步对账不依赖广播合并
  if (room._waitingScheduled) return;
  room._waitingScheduled = true;
  setImmediate(() => {
    room._waitingScheduled = false;
    for (const viewerConnection of rooms.viewers) {
      if (!hasCap(viewerConnection, "room.dialogs")) continue;
      send(viewerConnection, { type: "room_waiting", room: room.id, ...waitingOf(room, hasCap(viewerConnection, "dialog.respond"), hasCap(viewerConnection, "dialog.multiselect"), hasCap(viewerConnection, "crypto.dialog")) }, config);
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

function roomListCapKey(socket) {
  let capMask = 0;
  for (let capIndex = 0; capIndex < ROOM_LIST_CAPS.length; capIndex++) if (hasCap(socket, ROOM_LIST_CAPS[capIndex])) capMask |= 1 << capIndex;
  return capMask;
}

/** 设备条目的 cap 裁剪（加密设计 §3.5/§7）：keyFp/keyAddedAt 只发给声明 crypto.auth
 *  的连接；未声明的（旧端、设备窗口）拿剥掉这两键的副本，条目其余字段一律不动。
 *  与 roomsViewFor 同纪律：无字段可剥时原样返回，不造无谓副本。 */
function devicesViewFor(socket, devices) {
  if (hasCap(socket, "crypto.auth")) return devices;
  return (devices || []).map((device) => {
    if (!device || (!Object.prototype.hasOwnProperty.call(device, "keyFp") && !Object.prototype.hasOwnProperty.call(device, "keyAddedAt"))) return device;
    const prunedDevice = { ...device };
    delete prunedDevice.keyFp;
    delete prunedDevice.keyAddedAt;
    return prunedDevice;
  });
}

/* ---------------- Phase 4 T-1: honest plaintext-reason derivation ----------------
 * encReason explains WHY a room is not body-encrypted, derived only from
 * facts the relay already holds (the room's enc meta, the device roster, the
 * account ackFp consensus). Pure presentation: nothing here changes room
 * data, migration, or the cryptoPlaintextRooms policy. Classes follow the
 * phase-4 design section 2.5:
 *   sealed       -- the room carries enc meta;
 *   host_keyless -- the host device is on the roster without a registered
 *                   identity key (token-era device: it cannot hold an ACK, so
 *                   its rooms are plaintext by construction);
 *   awaiting_key -- the host is keyed and the account is known to have an
 *                   ACK (the live ackFp consensus, or a sealed room's meta
 *                   on the same account), so this room is migration backlog.
 *                   A room whose migration was attempted and failed is
 *                   indistinguishable from never-attempted backlog with
 *                   relay-side facts alone (migrateRoom is atomic and keeps
 *                   no failure marker), so both surface as awaiting_key;
 *   orphan       -- the host is not on the roster at all, or has not
 *                   attached within config.cryptoOrphanDays (default 30).
 * "no_source" is deliberately NOT derived here: per the design it is known
 * only from the device's migration backlog report (the slice T-2 frame),
 * which does not exist yet. When no class can be determined the field is
 * omitted and the UI keeps its legacy fallback label. */
const DAY_MS = 24 * 60 * 60 * 1000;

function orphanThresholdMsOf(config) {
  const days = config && Number.isSafeInteger(config.cryptoOrphanDays) && config.cryptoOrphanDays > 0 ? config.cryptoOrphanDays : 30;
  return days * DAY_MS;
}

function encReasonOf({ encMeta, host, accountAckKnown, now, orphanThresholdMs }) {
  if (encMeta) return "sealed";
  if (!host) return "orphan";
  const lastAttachAt = Number(host.lastAttachAt) || 0;
  if (!host.online && lastAttachAt > 0 && now - lastAttachAt > orphanThresholdMs) return "orphan";
  if (!host.keyFp) return "host_keyless";
  if (accountAckKnown) return "awaiting_key";
  return undefined;
}

function roomsViewFor(socket, roomList) {
  const key = roomListCapKey(socket);
  // The enc flag rides its own cap (crypto.content), outside the ROOM_LIST_CAPS
  // mask: even a full-mask viewer without it must not learn which rooms are
  // encrypted (design section 7 version-gate rule).
  const keepEnc = hasCap(socket, "crypto.content");
  // (b+) titleEnc in waiting entries rides its own cap (crypto.dialog), same
  // outside-the-mask pattern as enc: a connection without it must not learn
  // sealed titles, nor answer sealed dialogs from the summary.
  const keepSealed = hasCap(socket, "crypto.dialog");
  if (key === (1 << ROOM_LIST_CAPS.length) - 1 && keepEnc && keepSealed) return roomList;
  const keepAttention = !!(key & 1);
  const keepDialogs = !!(key & 2);
  const keepAnswerable = !!(key & 4);
  const keepActivity = !!(key & 8);
  const keepSchedule = !!(key & 16);
  return (roomList || []).map((roomEntry) => {
    if (!roomEntry) return roomEntry;
    let out = roomEntry;
    if (!keepEnc && Object.prototype.hasOwnProperty.call(out, "enc")) {
      out = { ...out };
      delete out.enc;
    }
    // encReason rides the same crypto.content gate as enc (phase-4 design
    // section 2.5): a connection that must not learn the enc flag must not
    // learn the plaintext reason either.
    if (!keepEnc && Object.prototype.hasOwnProperty.call(out, "encReason")) {
      if (out === roomEntry) out = { ...roomEntry };
      delete out.encReason;
    }
    if (!keepAttention && Object.prototype.hasOwnProperty.call(out, "lastTurnEnd")) {
      out = { ...out };
      delete out.lastTurnEnd;
    }
    if (!keepActivity && Object.prototype.hasOwnProperty.call(out, "lastEvent")) {
      if (out === roomEntry) out = { ...roomEntry };
      delete out.lastEvent;
    }
    if (!keepSchedule && Object.prototype.hasOwnProperty.call(out, "schedules")) {
      if (out === roomEntry) out = { ...roomEntry };
      delete out.schedules;
    }
    if (!keepDialogs && (Object.prototype.hasOwnProperty.call(out, "waiting") || Object.prototype.hasOwnProperty.call(out, "waitingPrompt"))) {
      if (out === roomEntry) out = { ...roomEntry };
      delete out.waiting;
      delete out.waitingPrompt;
    }
    if (keepDialogs && !keepAnswerable && Array.isArray(out.waiting)) {
      const hasAnswerable = out.waiting.some((waitingEntry) => waitingEntry && Object.prototype.hasOwnProperty.call(waitingEntry, "answerable"));
      if (hasAnswerable) {
        if (out === roomEntry) out = { ...roomEntry };
        out.waiting = out.waiting.map((waitingEntry) => {
          if (!waitingEntry || !Object.prototype.hasOwnProperty.call(waitingEntry, "answerable")) return waitingEntry;
          const prunedEntry = { ...waitingEntry };
          delete prunedEntry.answerable;
          return prunedEntry;
        });
      }
    }
    // (b+) sealed summary entries: titleEnc marks a sealed dialog/prompt.
    // Without crypto.dialog, strip titleEnc and the sealed entry's
    // answerable (the plaintext-title entries above are unaffected).
    if (keepDialogs && !keepSealed) {
      const sealedWaiting = Array.isArray(out.waiting) && out.waiting.some((waitingEntry) => waitingEntry && waitingEntry.titleEnc);
      const sealedPrompt = !!(out.waitingPrompt && out.waitingPrompt.titleEnc);
      if (sealedWaiting || sealedPrompt) {
        if (out === roomEntry) out = { ...roomEntry };
        if (sealedWaiting) {
          out.waiting = out.waiting.map((waitingEntry) => {
            if (!waitingEntry || !waitingEntry.titleEnc) return waitingEntry;
            const prunedEntry = { ...waitingEntry };
            delete prunedEntry.titleEnc;
            delete prunedEntry.answerable;
            return prunedEntry;
          });
        }
        if (sealedPrompt) {
          const copy = { ...out.waitingPrompt };
          delete copy.titleEnc;
          out.waitingPrompt = copy;
        }
      }
    }
    return out;
  });
}

/** (b+) per-connection inbox view (crypto.dialog): an entry carrying a
 *  sealed title (titleEnc) loses both titleEnc and its answerable flag for
 *  connections that did not declare the cap; every other entry passes
 *  through untouched (same reference, no copies when nothing is sealed). */
function inboxViewFor(socket, entries) {
  if (hasCap(socket, "crypto.dialog")) return entries;
  if (!Array.isArray(entries) || !entries.some((inboxEntry) => inboxEntry && inboxEntry.titleEnc)) return entries;
  return entries.map((inboxEntry) => {
    if (!inboxEntry || !inboxEntry.titleEnc) return inboxEntry;
    const prunedEntry = { ...inboxEntry };
    delete prunedEntry.titleEnc;
    delete prunedEntry.answerable;
    return prunedEntry;
  });
}

/* ---------------- 房间 ---------------- */
/** get_sessions 查询键：连接序号 + 前端自选 id。两个页面用相同 id 时不会互相覆盖/误删对方的 10s 超时。 */
let querySeq = 0;
function queryKey(socket, sessionId) {
  if (!socket._qseq) socket._qseq = ++querySeq;
  return socket._qseq + "|" + sessionId;
}
class Rooms {
  constructor(config) {
    this.config = config;
    this.map = new RoomMap();
    this.viewers = new Set();
    this.commandWaiters = new Map(); // wireId -> CommandEntry
    this.dialogAnswerWaiters = new Map(); // aid -> { ws, origId, room, dialogId, timer }（O2 应答回执对号）
    this.dedupe = new Map();         // `${room}|${dedupeKey}` -> CommandEntry
    this.viewerQueries = new Map();  // queryKey(ws,id) -> {ws, timer}
    // Last viewer-set values of the three conversation switches (dialog
    // remote answer / ask_user / approval gate), account-wide. Settings
    // surfaces present the trio as one global set, so an explicit set
    // applies to every room: viewer.js stamps the value onto all known
    // rooms, and this record covers rooms that register afterwards.
    // Memory only, like the per-room copies: a relay restart resets
    // every switch to the bridge defaults.
    this.accountSwitches = { dialogRemoteAnswer: undefined, askUserEnabled: undefined, approvalGateSwitch: undefined };
    this.deviceSnapshot = () => [];
    // Phase 4 T-1: account ackFp consensus lookup (acktrack.knownAckFp),
    // injected by server.js like deviceSnapshot; null = no live consensus
    // source, the derivation then relies on sealed-room meta evidence only.
    this.ackFpLookup = null;
    // 进程实例 id：去重表只活在本进程内存里，viewer 断线重连后只有 boot 相同才能安全重发有副作用的命令
    this.boot = crypto.randomBytes(6).toString("hex");
    // 收件箱账本（设计 D §1）：server 装配时 bindInbox 注入 InboxStore；未注入时全部账本动作静默跳过。
    this.inbox = null;
    this._inboxFlushScheduled = false;
    // 定时排期（设计 D §3）：server 装配时 bindSchedule 注入 ScheduleEngine；未注入时排期面静默跳过。
    this.schedule = null;
    this._scheduleFlushScheduled = false;
    this._inboxGrace = new Map(); // roomId -> timer：恢复期 waiting 条目的补发对账宽限
    this.inboxGraceMs = Number.isFinite(config.inboxResyncGraceMs) && config.inboxResyncGraceMs >= 0 ? config.inboxResyncGraceMs : 15000;
  }
  /** 会话存储。进行中工具补发用它看快照里有没有 toolResult。已挂上的房间不覆盖。 */
  bindStore(transcriptStore) {
    this._transcriptStore = transcriptStore || null;
    if (!this._transcriptStore) return;
    // 房文件分组定位（store 的目录两级分组/存量迁移靠它定房间的家）。
    if (typeof transcriptStore.setLocator === "function") {
      transcriptStore.setLocator((roomId) => this.locateRoom(roomId));
    }
    // Cap-state transitions (80% warning / hard cap) change the room_list
    // flags: rebroadcast so connected viewers see fileWarned/fileCapped
    // without waiting for the next roster change.
    transcriptStore.onCapState = () => { this.broadcastRoomList(); };
    for (const room of this.map.values()) this._stampStore(room);
  }

  /* ---------------- 收件箱账本（设计 D §1） ----------------
   * 账本（relay/inbox.js）是「别的房间在等你」这条线的 relay 侧唯一事实源：只存元数据。
   * 三路来源在此对账：dialog/prompt 活槽（syncInboxDialogs，挂 broadcastRoomWaiting 入口）、
   * 回合落定（syncInboxTurn，挂 broadcastRoomAttention 入口）、dialog_close 原因回填
   * （observeRoomTurnEvent 经 room._inboxRef 补墓碑原因——close 事件到达时对账已先行）。 */

  /** 账本装配：与 bindStore 同位由 server 调；顺手给存量房间打上 _inboxRef。 */
  bindInbox(inboxStore) {
    this.inbox = inboxStore || null;
    if (!this.inbox) return;
    for (const room of this.map.values()) this._stampInboxRef(room);
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
  /** Per-connection inbox snapshot view ((b+), crypto.dialog): sealed-title
   *  entries are stripped for connections without the cap (see inboxViewFor). */
  inboxSnapshotFor(socket) {
    return inboxViewFor(socket, this.inboxSnapshot());
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
      for (const viewerConnection of this.viewers) {
        if (!hasCap(viewerConnection, "room.inbox")) continue;
        send(viewerConnection, { type: "inbox_update", upserts: inboxViewFor(viewerConnection, changes.upserts), removed: changes.removed }, this.config);
      }
    });
  }
  /** 来源一/二对账：以房间活槽为准。dialog 槽在 → upsert waiting/dialog；ui_prompt 只在无 dialog
   *  槽时兜底（与 attention.ts 同款去重纪律，下沉到账本层）；活槽里没有的 waiting 条目消项
   *  （reason 先记 resolved，dialog_close 的准确原因随后由 observeRoomTurnEvent 回填墓碑）。
   *  恢复期未确认条目（重启落盘恢复的 waiting）豁免消项：等补发确认或宽限清扫判 stale（§1.4）。 */
  syncInboxDialogs(room) {
    if (!this.inbox || !room) return;
    const inboxStore = this.inbox;
    const accountId = this._inboxAccount(room);
    this._stampInboxRef(room);
    const liveKeys = new Set();
    if (room.online) {
      const slots = Object.values(room.dialogs || {}).filter((slot) => slot && typeof slot.dialogId === "string" && slot.dialogId);
      let canAnswer = false;
      let canMulti = false;
      for (const viewerConnection of this.viewers) {
        if (hasCap(viewerConnection, "dialog.respond")) {
          canAnswer = true;
          if (hasCap(viewerConnection, "dialog.multiselect")) canMulti = true;
        }
      }
      for (const slot of slots) {
        // Room-scoped key: bridge dialogIds are per-process counters
        // (dlg-1, dlg-2, ...), so two rooms can mint the same id; an
        // unscoped account-global key would let them overwrite and
        // tombstone each other.
        const key = `dialog:${room.id}:${slot.dialogId}`;
        liveKeys.add(key);
        inboxStore.upsert({
          key, accountId, roomId: room.id, deviceId: room.deviceId || null,
          kind: "waiting", subkind: "dialog",
          dialogKind: typeof slot.kind === "string" ? slot.kind : undefined,
          title: slot.title || undefined,
          // (b+) sealed slot (crypto.dialog): the ledger carries the title's
          // ct string from the slot's titleEnc, never a plaintext title (the
          // slot holds none); per-connection stripping happens at delivery.
          titleEnc: slot.sealed && slot.titleEnc ? slot.titleEnc.ct : undefined,
          // 多选槽（G3）的账本 answerable 同样要过 dialog.multiselect 那道 cap
          answerable: (slot.kind === "multiselect" ? canMulti : canAnswer) && slot.answerable === true,
          at: slot.startedAt || Date.now(),
        });
      }
      const uiPrompt = room.uiPrompt;
      if (uiPrompt && !slots.length) {
        const key = `prompt:${room.id}:${uiPrompt.at || 0}`;
        liveKeys.add(key);
        inboxStore.upsert({
          key, accountId, roomId: room.id, deviceId: room.deviceId || null,
          kind: "waiting", subkind: "prompt",
          dialogKind: typeof uiPrompt.kind === "string" ? uiPrompt.kind : undefined,
          title: uiPrompt.titleEnc ? undefined : (uiPrompt.title || undefined),
          titleEnc: uiPrompt.titleEnc ? uiPrompt.titleEnc.ct : undefined,
          at: uiPrompt.at || Date.now(),
        });
      }
    }
    for (const inboxEntry of inboxStore.roomEntries(accountId, room.id)) {
      if (inboxEntry.kind !== "waiting" || liveKeys.has(inboxEntry.key) || inboxEntry._restored) continue;
      inboxStore.remove(accountId, inboxEntry.key, "resolved");
    }
    if (room.online) {
      if (inboxStore.restoredWaitingKeys(accountId, room.id).size) this._armInboxGrace(room);
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
    const turnEnd = room.lastTurnEnd;
    if (turnEnd && (turnEnd.kind === "done" || turnEnd.kind === "error") && Number.isFinite(turnEnd.at)) {
      this.inbox.replaceRoomTurn({
        key: `turn:${room.id}:${turnEnd.at}`, accountId, roomId: room.id, deviceId: room.deviceId || null,
        kind: turnEnd.kind, subkind: "turn", at: turnEnd.at,
      });
    } else if (!turnEnd) {
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
    for (const room of this.map.values()) this._stampScheduleRef(room);
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
  createSchedule(accountId, rawRequest) {
    if (!this.schedule) return { code: "unsupported", error: "此中继未启用定时消息" };
    const outcome = this.schedule.create(accountId, rawRequest);
    if (outcome.entry) return { entry: scheduleWireOf(outcome.entry) };
    return outcome;
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
  /** schedule_text command surface: one entry's full text on demand, answered
   *  to the requesting viewer only (room lists carry just a preview). */
  scheduleText(accountId, id) {
    if (!this.schedule) return null;
    return this.schedule.textOf(accountId, id);
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
        for (const viewerConnection of this.viewers) {
          if (!hasCap(viewerConnection, "room.schedule")) continue;
          send(viewerConnection, { type: "schedule_update", room: roomId, schedules }, this.config);
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
    const commandArgs = {
      text: entry.text,
      streamingBehavior: entry.segment === "follow_up" ? "followUp" : "steer",
      cid: scheduleCid(entry, fireNo),
    };
    const timeoutMs = commandTimeoutMs("prompt", commandArgs, this.config.harnessStartTimeoutMs);
    const wireId = "w_" + crypto.randomBytes(8).toString("hex");
    let finished = false;
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      done(outcome);
    };
    const commandEntry = {
      wireId, room, command: "prompt", local, timeoutMs,
      waiters: [], done: false, result: null, at: Date.now(), key: null,
      onResult: (commandResult) => finish(commandResult && commandResult.ok
        ? { ok: true }
        : { ok: false, error: (commandResult && typeof commandResult.error === "string" && commandResult.error) || "本机执行失败" }),
      onSettle: () => finish({ ok: false, error: "投递未确认（本机未回执或连接已断开）" }),
    };
    const placeholderWaiter = { ws: null, origId: null, timer: null };
    commandEntry.waiters.push(placeholderWaiter);
    armWaiter(this, commandEntry, placeholderWaiter, this.config);
    this.commandWaiters.set(wireId, commandEntry);
    const sent = send(local, { type: "command", id: wireId, command: "prompt", args: commandArgs, timeoutMs, room: room.id }, this.config);
    if (!sent) {
      finishWaiter(placeholderWaiter);
      commandEntry.waiters = [];
      this.commandWaiters.delete(wireId);
      settleEntry(commandEntry); // 触发 onSettle → finish 按投递未确认判失败收尾
    }
  }

  /** store 的房间定位：注册表优先（deviceId/cwd 在 room_register 时已打戳）；
   *  注册表还没有（进程刚起、存量迁移）时，按设备名册逐台查会话索引兜底。
   *  都查不到返回 null（store 归 _未分类，数据不丢）。 */
  locateRoom(roomId) {
    const room = this.map.get(roomId);
    if (room && (room.deviceId || room.cwd)) return { deviceId: room.deviceId || null, cwd: room.cwd || null };
    if (this.sessionLookup && typeof this.deviceSnapshot === "function") {
      let deviceRecords = [];
      try { deviceRecords = this.deviceSnapshot(); } catch {}
      for (const deviceRecord of deviceRecords) {
        if (!deviceRecord || !deviceRecord.id) continue;
        let session = null;
        try { session = this.sessionLookup(deviceRecord.accountId || DEFAULT_ACCOUNT, deviceRecord.id, roomId); } catch {}
        if (session) return { deviceId: deviceRecord.id, cwd: session.cwd || null };
      }
    }
    return null;
  }
  _stampStore(room) {
    if (room && this._transcriptStore && !room.store) room.store = this._transcriptStore;
  }
  get(roomId, options) {
    let room = this.map.get(roomId);
    if (room) {
      // D-4: registration passes { activity: false } -- re-registering a
      // room must not renew its idle-eviction clock, or every attach
      // restart would keep the room's stale siblings alive forever. The
      // clock restarts when the session actually ends (the offline paths
      // in local.js stamp it) and on real traffic (touch / event paths).
      if (!options || options.activity !== false) room.lastActivity = Date.now();
      this._stampStore(room);
      if (this.inbox && !room._inboxRef) this._stampInboxRef(room);
      if (this.schedule && !room._scheduleRef) this._stampScheduleRef(room);
      return room;
    }
    room = {
      id: roomId,
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
      // D (U1): immutable shell creation stamp, exposed on list entries
      // so the UI can tell apart same-folder unnamed live rooms.
      // Display only -- never an eviction or ordering input (the D-4
      // lesson: registration/activity clocks must not be mixed).
      createdAt: Date.now(),
      // E1: recent delivery finals for this room (cid -> {disposition,
      // at}), bounded by count and TTL; see recordFinalFrame above.
      finalFrames: null,
      // D-4 observability only: when this shell last completed a
      // room_register. Never used as an eviction input (lastActivity is).
      lastRegisterAt: null,
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
    this._stampStore(room);
    this._stampInboxRef(room);
    this._stampScheduleRef(room);
    this.map.set(roomId, room);
    return room;
  }
  /** 只看不建，也不刷新活跃度（sweep 用它判断"近期活跃"，peek 自己刷新就永远判活） */
  peek(roomId) {
    if (!roomId) return null;
    return this.map.get(roomId) || null;
  }
  touch(room) {
    if (room) room.lastActivity = Date.now();
    return room;
  }
  /** 全量快照正文缓存（TTL）：subscribe 风暴时避免反复扫盘/拼接。只缓存正文，busy 每次现取。
   *  装配抛错（store 读异常等）不能把异常抛给订阅路径：那样已经加进 viewers 的连接收不到任何
   *  snapshot 帧、UI 永远停在"正在拉取会话…"（报告：快照发布抛错，订阅者干等）。
   *  这里退回带真实锚点的 truncated 空快照（不写缓存，下次订阅会重试装配）。 */
  snapshotBody(roomId, build) {
    const room = this.get(roomId);
    const now = Date.now();
    if (room.snap && room.snap.at + this.config.snapshotCacheTtlMs > now) return room.snap.body;
    let body;
    try {
      // E1: full snapshots assembled here carry the room's in-TTL
      // delivery finals (see snapshotBodyWithFinalFrames).
      body = snapshotBodyWithFinalFrames(build(), room);
    } catch (buildError) {
      log("快照装配失败，退回截断空快照:", roomId, buildError.message);
      return this._fallbackSnapshotBody(roomId);
    }
    if (room.snap && room.snap.timer) clearTimeout(room.snap.timer);
    const timer = setTimeout(() => { if (room.snap && room.snap.body === body) room.snap = null; }, this.config.snapshotCacheTtlMs);
    timer.unref();
    room.snap = { at: now, body, timer };
    return body;
  }
  /** 装配失败时的兜底正文：锚点尽量取真值（rev:null 会被前端当成"世代变了"再打一次全量重订阅），
   *  truncated:true 让 UI 明确显示"历史不完整"，而不是把空正文当成完整快照。 */
  _fallbackSnapshotBody(roomId) {
    let revision = null;
    let sequence = 0;
    const transcriptStore = this._transcriptStore;
    if (transcriptStore && typeof transcriptStore.info === "function") {
      try {
        const storeInfo = transcriptStore.info(roomId);
        if (storeInfo) {
          if (typeof storeInfo.rev === "string") revision = storeInfo.rev;
          if (Number.isInteger(storeInfo.seq) && storeInfo.seq >= 0) sequence = storeInfo.seq;
        }
      } catch (anchorError) {
        log("快照兜底锚点读取失败:", roomId, anchorError.message);
      }
    }
    return snapshotBodyWithFinalFrames(`"rev":${JSON.stringify(revision)},"seq":${sequence},"truncated":true,"messages":[]`, this.map.get(roomId));
  }
  invalidate(roomId) {
    const room = this.map.get(roomId);
    if (room && room.snap) {
      clearTimeout(room.snap.timer);
      room.snap = null;
    }
  }
  /** 列表：在线房间 + 仍在内存里的离线房间（离线未淘汰 = 可回看，UI 折叠成"已结束 N"）。
   *  每条带 lastActivity：同 cwd 多房间时前端据此挑最新的，不靠 id 排序猜。 */
  list({ includeOffline = true } = {}) {
    const cutoff = Date.now() - this.config.roomIdleEvictMs;
    const now = Date.now();
    // Phase 4 T-1: the encReason derivation needs the host roster and the
    // per-account ACK evidence for the whole list, so entries are assembled
    // in two passes (facts first, entries second). The roster snapshot is
    // the same buildDeviceList output the broadcast attaches as `devices`.
    const hosts = new Map();
    try {
      for (const deviceRecord of this.deviceSnapshot()) if (deviceRecord && deviceRecord.id) hosts.set(String(deviceRecord.id), deviceRecord);
    } catch {}
    const orphanThresholdMs = orphanThresholdMsOf(this.config);
    const metaAckAccounts = new Set();
    const facts = [];
    for (const room of this.map.values()) {
      if (!room.online) {
        if (!includeOffline) continue;
        // 长期没人看、也没有活动的离线房间：即将被 evictIdle 收走，不再下发
        if (!room.viewers.size && (room.lastActivity || 0) < cutoff) continue;
      }
      const session = this.sessionLookup
        ? this.sessionLookup(room.accountId || DEFAULT_ACCOUNT, room.deviceId || UNREGISTERED_DEVICE, room.id)
        : null;
      const encMeta = this._transcriptStore && typeof this._transcriptStore.encInfo === "function"
        ? this._transcriptStore.encInfo(room.id)
        : null;
      if (encMeta && encMeta.ackFp) metaAckAccounts.add(room.accountId || DEFAULT_ACCOUNT);
      // Transcript cap state (sparse; null when the store has nothing to
      // report). Presentation only, like enc/encReason: no cap gating, old
      // viewers simply ignore the unknown fields.
      const capInfo = this._transcriptStore && typeof this._transcriptStore.capInfo === "function"
        ? this._transcriptStore.capInfo(room.id)
        : null;
      facts.push({ room, session, encMeta, capInfo });
    }
    const ackKnownCache = new Map();
    const accountAckKnown = (accountId) => {
      if (!ackKnownCache.has(accountId)) {
        let known = metaAckAccounts.has(accountId);
        if (!known && typeof this.ackFpLookup === "function") {
          try { known = !!this.ackFpLookup(accountId); } catch {}
        }
        ackKnownCache.set(accountId, known);
      }
      return ackKnownCache.get(accountId);
    };
    const out = facts.map(({ room, session, encMeta, capInfo }) => {
      const accountId = room.accountId || DEFAULT_ACCOUNT;
      const deviceId = room.deviceId || UNREGISTERED_DEVICE;
      const entry = {
        id: room.id,
        accountId,
        deviceId,
        label: room.label,
        name: session && session.name ? session.name : null,
        // Crypto Phase 3: a sealed preview envelope stored on the index row
        // is served inside firstMessage -- the form the web room parser
        // reads (firstMessageEncOf); plaintext rows are unchanged.
        firstMessage: session && session.firstMessage ? session.firstMessage : (session && session.firstMessageEnc ? session.firstMessageEnc : null),
        cwd: room.cwd,
        online: room.online,
        // 与快照/room_state 同一口径（wire.snapshotFrame 也是 online && busy）：离线房间保留的
        // 上一次 busy 只是扩展断开前的残留，不能出现在列表里（报告：房间列表 busy 不做掩码）。
        busy: !!(room.online && room.busy),
        viewers: room.viewers.size,
        lastActivity: room.lastActivity || 0,
        // D (U1): immutable creation stamp (see the factory note in
        // get()). Presentation only: not cap-stripped in roomsViewFor
        // and never fed to any eviction or ordering decision.
        createdAt: room.createdAt || 0,
        // 注意力恢复通道（R3-1）：订阅/重连时 UI 靠它把别房落定记录种回追踪器；只带 kind/at
        lastTurnEnd: room.lastTurnEnd ? { kind: room.lastTurnEnd.kind, at: room.lastTurnEnd.at } : null,
        // 最近事件摘要（设计 D §2.3）：只带 type/toolName/at 元数据；由 roomsViewFor 按 room.activity cap 裁剪
        lastEvent: room.lastEvent ? { ...room.lastEvent } : null,
        // 等待摘要（P9 A）：列表侧按"能应答"算（answerable 只在 connections 有 dialog.respond 时下发，
        // 由 roomsViewFor 按连接 cap 再裁剪）；离线房间恒为 []/null
        ...waitingOf(room, true),
        // 定时排期清单（设计 D §3.7）：armed 全量 + 保留期内终态；由 roomsViewFor 按 room.schedule cap 裁剪
        schedules: this.schedulesOf(room),
        // Body encryption flag (design section 7): present only in the raw list;
        // roomsViewFor strips it for connections without crypto.content.
        enc: encMeta ? 1 : 0,
      };
      // Phase 4 T-1: honest plaintext reason (design section 2.5). Present
      // only in the raw list and stripped with enc by roomsViewFor; omitted
      // entirely when no class can be determined from relay-side facts.
      const encReason = encReasonOf({
        encMeta,
        host: hosts.get(String(deviceId)),
        accountAckKnown: accountAckKnown(accountId),
        now,
        orphanThresholdMs,
      });
      if (encReason !== undefined) entry.encReason = encReason;
      // Transcript cap flags (sparse: only the facts that hold are sent, so
      // rooms nowhere near the cap keep their exact previous entry shape).
      if (capInfo) {
        if (capInfo.capped) entry.fileCapped = true;
        if (capInfo.warned) entry.fileWarned = true;
        if (capInfo.dropped > 0) entry.dropped = capInfo.dropped;
      }
      return entry;
    });
    return out.sort((left, right) => Number(right.online) - Number(left.online) || left.id.localeCompare(right.id));
  }
  /** 按连接 cap 的清单视图：auth_result / list_rooms 单发与广播都走这里，不许各写一份。
   *  能力组合的裁剪规则见 roomsViewFor（P9 A 起把 lastTurnEnd/waiting/answerable 一起管）。 */
  listFor(socket) {
    return roomsViewFor(socket, this.list());
  }
  broadcastRoomList() {
    // 同一事件里可能被触发多次（订阅/注册/断开/观众数变化）：合并成一次广播，省带宽也省客户端重入
    if (this._roomListScheduled) return;
    this._roomListScheduled = true;
    setImmediate(() => {
      this._roomListScheduled = false;
      let devices = [];
      try { devices = this.deviceSnapshot(); } catch (rosterError) { log("设备列表异常:", rosterError.message); }
      const rooms = this.list();
      // P9 A 分流：按「能力组合」分组（room.attention / room.dialogs / dialog.respond / room.activity 四位，最多 16 组），
      // 每组只算一份副本（roomsViewFor），组内共用；没有声明任何 cap 的连接拿剥得最干净的那份。
      const views = new Map(); // capKey(+crypto 位) -> 清单副本
      const viewFor = (viewerConnection) => {
        // The rooms view now also depends on crypto.content (enc flag), so the
        // cache key must include it — same discipline as the group key below.
        // (b+) adds crypto.dialog (titleEnc stripping) on bit 256, same reason.
        const key = roomListCapKey(viewerConnection) | (hasCap(viewerConnection, "crypto.content") ? 128 : 0) | (hasCap(viewerConnection, "crypto.dialog") ? 256 : 0);
        let view = views.get(key);
        if (!view) {
          view = roomsViewFor(viewerConnection, rooms);
          views.set(key, view);
        }
        return view;
      };
      const groups = new Map(); // capKey(+inbox 位 +crypto 位) -> { view, devices, inbox, conns }
      let cachedInboxSnapshot = null; // 账本快照懒算一次：只有声明 room.inbox 的组才附带（§1.5 cap 门控）
      for (const viewerConnection of this.viewers) {
        const withInbox = hasCap(viewerConnection, "room.inbox");
        // inbox 位用 32：roomListCapKey 已占满低 5 位（room.schedule 是第 5 位 = 16），
        // 原先的 16 位与排期 cap 位相撞，必须上移一位。
        // crypto 位用 64：设备条目的 keyFp/keyAddedAt 只给声明 crypto.auth 的组（devicesViewFor）。
        // crypto.content 位用 128：rooms 视图的 enc 标志随它开关，组键必须区分。
        const key = roomListCapKey(viewerConnection) | (withInbox ? 32 : 0) | (hasCap(viewerConnection, "crypto.auth") ? 64 : 0) | (hasCap(viewerConnection, "crypto.content") ? 128 : 0) | (hasCap(viewerConnection, "crypto.dialog") ? 256 : 0);
        let group = groups.get(key);
        if (!group) {
          group = { view: viewFor(viewerConnection), devices: devicesViewFor(viewerConnection, devices), inbox: withInbox, sample: viewerConnection, conns: [] };
          groups.set(key, group);
        }
        group.conns.push(viewerConnection);
      }
      for (const group of groups.values()) {
        if (!group.conns.length) continue;
        const frame = { type: "room_list", devices: group.devices, rooms: group.view };
        if (group.inbox) {
          if (!cachedInboxSnapshot) cachedInboxSnapshot = this.inboxSnapshot();
          // (b+): the shared snapshot is raw; each group gets its own
          // crypto.dialog view of it (group members share the cap bit).
          frame.inbox = inboxViewFor(group.sample, cachedInboxSnapshot);
        }
        broadcast(group.conns, JSON.stringify(frame), this.config);
      }
      if (typeof this.deviceConns === "function") {
        // 设备窗口只需要判断"本机哪些房间在线"：只发它自己的设备和房间，
        // 不把别的账号/设备的房间（cwd、标题）推给每个本机窗口。
        // 设备窗口连接不声明 cap，固定走「什么能力都没有」的那份（P9 A）。
        const bareDevices = devicesViewFor(null, devices);
        for (const deviceConnection of this.deviceConns()) {
          if (!deviceConnection || deviceConnection.readyState !== 1) continue;
          send(deviceConnection, JSON.stringify(roomListForDevice(deviceConnection._deviceId, bareDevices, viewFor(null))), this.config);
        }
      }
    });
  }
  /* ---------------- D-4: registry hygiene (shell reaping) ----------------
   * A "shell" is a Rooms entry with no live local, no viewer and nothing
   * worth keeping. Attach re-registrations mint a fresh shell per restart
   * (new room id, same device + cwd), and before D-4 nothing ever removed
   * the old ones: registration renewed lastActivity via get(), so the
   * idle evictor never fired, and the registry grew by a handful of
   * shells per re-registration. Reaping a shell only removes the
   * in-memory registry entry and its inbox/schedule bookkeeping; stored
   * transcripts on disk and in the store are never touched. */

  /** True when the room has stored content worth keeping the shell for:
   *  messages in the store, an index still in flight over a real file, or
   *  a transcript file on disk the store has not loaded yet. With no
   *  store bound there is nothing stored, so the answer is false. */
  shellHasTranscript(room) {
    const transcriptStore = this._transcriptStore;
    if (!transcriptStore || !room) return false;
    try {
      if (typeof transcriptStore.info === "function") {
        const storeInfo = transcriptStore.info(room.id);
        if (storeInfo && (storeInfo.indexing || (storeInfo.msgCount || 0) > 0)) return true;
        if (storeInfo && storeInfo.exists) return false;
      }
      // No store record: fall back to the on-disk existence probe.
      if (typeof transcriptStore.exists === "function") return !!transcriptStore.exists(room.id);
    } catch {}
    return false;
  }

  /** True when an unanswered dialog is attached to the room: a live slot
   *  on the room object, or a waiting entry in the inbox ledger. */
  shellHasPendingDialog(room) {
    if (!room) return false;
    if (room.dialogs && Object.keys(room.dialogs).length) return true;
    if (room.uiPrompt) return true;
    if (this.inbox && typeof this.inbox.roomEntries === "function") {
      try {
        const entries = this.inbox.roomEntries(room.accountId || DEFAULT_ACCOUNT, room.id);
        if (entries && entries.some((inboxEntry) => inboxEntry && inboxEntry.kind === "waiting")) return true;
      } catch {}
    }
    return false;
  }

  /** True when the room still has armed (not yet fired) schedules. */
  shellHasArmedSchedule(room) {
    if (!room || !this.schedule || !this.schedule.store) return false;
    try {
      const armed = this.schedule.store.armedOfRoom(room.id);
      return !!(armed && armed.length);
    } catch {
      return false;
    }
  }

  /** A shell may be reaped only when nothing live or stored hangs off it. */
  shellReapable(room) {
    if (!room || room.online || room.local) return false;
    if (room.viewers && room.viewers.size) return false;
    if (this.shellHasTranscript(room)) return false;
    if (this.shellHasPendingDialog(room)) return false;
    if (this.shellHasArmedSchedule(room)) return false;
    return true;
  }

  /** Remove one shell from the registry with the full teardown every
   *  removal path needs: timers (via RoomMap.delete), inbox grace,
   *  restored waiting entries, leftover turn entries, armed schedules.
   *  Returns true when the room was present and removed. */
  reapShell(roomId) {
    const room = this.map.get(roomId);
    if (!room) return false;
    // RoomMap.delete matches the close path: cancels resend / snapshot timers.
    this.map.delete(roomId);
    let swept = 0;
    // The room is gone from memory, so no resend can ever confirm its
    // restored waiting entries: mark them stale (design section 1.4)
    // instead of leaving them hanging in the inbox forever.
    this._disarmInboxGrace(roomId);
    if (this.inbox) {
      swept += this.inbox.sweepRestored(roomId) || 0;
      // Turn entries keyed to a gone room can never settle either; the
      // pre-D-4 eviction path forgot them and they accumulated forever.
      if (typeof this.inbox.clearRoomTurns === "function") {
        swept += this.inbox.clearRoomTurns(room.accountId || DEFAULT_ACCOUNT, roomId) || 0;
      }
    }
    // Armed schedules retire with the room (session_ended): there is
    // nowhere left to deliver them (design section 3.5).
    if (this.schedule) this.schedule.retireRoom(roomId);
    if (swept) this._flushInbox();
    return true;
  }

  /** Registration-time supersede: a device that just registered a live
   *  room leaves behind earlier shells for the same device + workspace
   *  (every attach restart mints one). Reap those that are empty right
   *  away instead of waiting out the idle window, so N re-registrations
   *  keep the registry bounded. Live, watched, stored, dialog-pending
   *  and schedule-armed shells are all preserved by shellReapable. */
  supersedeStaleShells(liveRoom) {
    if (!liveRoom || !liveRoom.deviceId || !liveRoom.cwd) return 0;
    const cwd = String(liveRoom.cwd).trim();
    if (!cwd) return 0;
    let reaped = 0;
    for (const room of [...this.map.values()]) {
      if (room === liveRoom || room.id === liveRoom.id) continue;
      if (!room.deviceId || room.deviceId !== liveRoom.deviceId) continue;
      if (!room.cwd || String(room.cwd).trim() !== cwd) continue;
      if (!this.shellReapable(room)) continue;
      if (this.reapShell(room.id)) reaped++;
    }
    return reaped;
  }

  /** 离线、无人看、长时间无活动的房间移出内存（存储文件不动，再次订阅/上线时重建） */
  evictIdle() {
    const cutoff = Date.now() - this.config.roomIdleEvictMs;
    let reaped = 0;
    for (const [roomId, room] of this.map) {
      if (room.online || room.local || room.viewers.size || room.lastActivity > cutoff) continue;
      if (this.reapShell(roomId)) reaped++;
    }
    return reaped;
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
function omitImageIfNeeded(imageBlock, budget) {
  const chars = imageBlock.data.length;
  if (chars <= IMAGE_MAX_CHARS && budget.total + chars <= IMAGE_TOTAL_MAX_CHARS) {
    budget.total += chars;
    return false;
  }
  imageBlock.omittedBytes = Math.floor((chars * 3) / 4);
  imageBlock.data = "";
  imageBlock.omitted = true;
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
  const budget = { total: 0 };
  const seen = new WeakSet(); // 防环/重复引用把同一张图重复计入合计
  const stack = [root];
  let omittedCount = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      // 逆序入栈，保证按数组原顺序处理（合计预算先到先得）
      for (let index = node.length - 1; index >= 0; index--) {
        const child = node[index];
        if (child && typeof child === "object") stack.push(child);
      }
      continue;
    }
    if (node.type === "image" && typeof node.data === "string" && omitImageIfNeeded(node, budget)) {
      omittedCount++;
      continue; // 已换成占位，与原实现一样不再深入它的字段
    }
    const keys = Object.keys(node);
    for (let index = keys.length - 1; index >= 0; index--) {
      const child = node[keys[index]];
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return omittedCount;
}

/** local 通道业务消息的归属校验：只接受发给本 socket 已注册房间的消息，防止未注册连接造幽灵房 */
function ownRoom(socket, frame) {
  const room = socket._room;
  if (!room) return null;
  if (room.id !== String(frame.room || "")) return null;
  // 必须确认本 socket 仍是该房间的 local：room_closed/被顶替后 room.local 已置 null，
  // 否则已离线的房间仍会被注入事件，观众看到"离线了还在动"。
  return room.local === socket ? room : null;
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
  room.extStatusAskedAt = 0;
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

module.exports = { cancelResend, sendCachedAssistant, sendCachedAutoRetry, sendCachedUiPrompt, sendCachedDialogs, sendCachedExtStatus, requestExtStatus, EXT_STATUS_REQUEST_MIN_MS, sendCachedCompaction, sendCachedTools, sendCachedToolEnds, toolEndMetaEntry, broadcastToolEndMeta, sendCachedTaskList, sendCachedAgentState, sendCachedRemoteQueue, resendFallbackBody, restartResend, queryKey, Rooms, DROPPABLE_LOCAL_EVENTS, shrinkImagesDeep, IMAGE_MAX_CHARS, IMAGE_TOTAL_MAX_CHARS, ownRoom, clearSessionState, pushDialogGate, observeRoomTurnEvent, clearRoomTurnEnd, broadcastRoomAttention, waitingOf, broadcastRoomWaiting, roomListCapKey, roomsViewFor, devicesViewFor, encReasonOf, inboxViewFor, recordFinalFrame, finalFramesOf, snapshotBodyWithFinalFrames, FINAL_FRAMES_TTL_MS, FINAL_FRAMES_MAX_PER_ROOM };
