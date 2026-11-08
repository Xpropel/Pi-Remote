"use strict";
/**
 * 页面外通知编排器（R2-2 / P2-4b）：relay 侧独立出口，与页面内通知
 * （pushNotice / Toast / 提示音）分工——页面关了、标签被回收、手机锁屏时，
 * 完成 / 失败 / 等待处理三类事件经 webhook 渠道主动触达（ntfy 兼容）。
 *
 * 流水线：事件归一 → 去重 → 偏好矩阵判定 → 渠道发送。
 *  - 归一口径：回合以 agent_settled 为落定信号（relay 既有的权威落定点），
 *    成败看落定前最后一条助手终态消息（stopReason === "error" 或带 errorMessage
 *    即 turn_error，与 UI 的 finishTurn 判定同源）；dialog 以 dialog_open 到达计。
 *  - 去重：同一回合落定只推一次（新回合活动信号到达后才允许下一次）；
 *    同一 dialogId 只推一次（dialog_close 后释放，补发/重放不重复推）。
 *  - 偏好矩阵字段（定版，P4-1 的 UI 必须对同一份字段施工）：
 *      notifyWebhookUrl  webhook 目标地址（env PI_REMOTE_NOTIFY_WEBHOOK_URL 覆盖）；
 *                        空 = 整渠道禁用、零行为变化。地址即凭据（含 ntfy 话题名），
 *                        只许存服务器侧 config / env，绝不写进仓库任何文件。
 *      notifyEvents      { turn_done, turn_error, dialog_waiting } 三类各自开关，
 *                        默认全关，须显式 true 才发（防意外轰炸）。
 *  - 发送失败只记一行日志（不带 URL），不重试、不阻塞事件主流程。
 */

const EVENT_KINDS = ["turn_done", "turn_error", "dialog_waiting"];

/** 偏好矩阵清洗：只认三类事件键、只认布尔 true，其余一律关。返回新对象，不改入参。 */
function sanitizeNotifyEvents(value) {
  const out = { turn_done: false, turn_error: false, dialog_waiting: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const kind of EVENT_KINDS) out[kind] = value[kind] === true;
  return out;
}

/* ---------------- 呈现口径（title / message / priority / tags） ---------------- */

const KIND_PRESENTATION = {
  turn_done: { title: "Pi-Remote · 回合完成", priority: 3, tags: ["white_check_mark"] },
  turn_error: { title: "Pi-Remote · 回合出错", priority: 4, tags: ["x"] },
  dialog_waiting: { title: "Pi-Remote · 等你处理", priority: 5, tags: ["hourglass_flowing_sand"] },
};

const DIALOG_KIND_LABELS = { select: "选择", confirm: "确认", input: "输入", editor: "编辑" };

function roomDisplayName(room) {
  const label = room && typeof room.label === "string" ? room.label.trim() : "";
  if (label) return label.slice(0, 80);
  const id = room && typeof room.id === "string" ? room.id : "";
  return id ? id.slice(0, 80) : "未知会话";
}

function buildEvent(kind, room, dialogInfo = {}, now = Date.now()) {
  const presentation = KIND_PRESENTATION[kind];
  const roomName = roomDisplayName(room);
  let message;
  if (kind === "turn_done") message = `会话「${roomName}」的这一回合已完成。`;
  else if (kind === "turn_error") message = `会话「${roomName}」的这一回合出错中断。`;
  else {
    const kindLabel = DIALOG_KIND_LABELS[dialogInfo.dialogKind] || "对话框";
    // 文案分段（R2-1 补验位）：第 1 轮的 dialog_open 都是观察态，只能"回去处理"；
    // R2-1 落地后帧上带 answerable=true，同一函数自动切到"点开可答"版——
    // R2-2 验收 5 的补验对象就是这一行分支，R2-1 合入后须实测复核。
    message = dialogInfo.answerable
      ? `会话「${roomName}」有${kindLabel}对话框在等应答，点开 Pi-Remote 即可作答。`
      : `会话「${roomName}」弹出了${kindLabel}对话框，等你回去处理。`;
  }
  return {
    kind,
    roomId: room && typeof room.id === "string" ? room.id : "",
    title: presentation.title,
    message,
    priority: presentation.priority,
    tags: [...presentation.tags],
    at: now,
  };
}

/* ---------------- webhook 渠道 ----------------
 * 发送模式（C-1，按 ntfy 官方 JSON 发布语义）：JSON 发布必须 POST 到站点根 URL、
 * topic 放 body 里；把 JSON 直接 POST 到话题 URL 会被 ntfy 当成纯文本消息（正文
 * 就是 JSON 原文），标题 / priority / tags 全部丢失。配置形态不变——地址仍写成
 * https://ntfy.sh/<话题> 或自建地址/<前缀>/<话题>（话题在路径最后一段）——渠道
 * 在装配时把话题拆出来：发送端点 = 去掉话题段的地址，body 补 topic 字段，另带
 * kind / room / at 供通用 webhook 消费端区分（ntfy 忽略未知字段）。
 * （另一条官方路线“话题 URL + 纯文本 body + Title/Priority 请求头”没选：Node 的
 * fetch 按 ByteString 校验请求头，中文标题会直接抛错，真机上发不出去。）
 * 地址里拆不出话题段（无路径段 / 解析失败）= 配置不完整：渠道按未配置处理并在
 * 装配时记一行不带地址的告警，绝不把坏形态发出去。
 * send 永不抛错：失败只记一行日志（绝不带 URL——它即凭据）。 */
function parseNotifyTarget(rawUrl) {
  const target = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!target) return null;
  let parsedUrl;
  try { parsedUrl = new URL(target); } catch { return null; }
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  if (!segments.length) return null;
  const topic = segments[segments.length - 1];
  parsedUrl.pathname = "/" + segments.slice(0, -1).join("/");
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return { endpoint: parsedUrl.toString(), topic };
}

function createWebhookChannel({ url, fetchImpl, timeoutMs = 5000, log } = {}) {
  const target = parseNotifyTarget(url);
  const fetchImplementation = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof url === "string" && url.trim() && !target && log) {
    log("页面外通知：webhook 地址里拆不出话题段（应为 站点根/<话题> 形态），渠道未启用");
  }
  return {
    name: "webhook",
    configured: !!target && !!fetchImplementation,
    async send(event) {
      if (!target || !fetchImplementation) return false;
      const body = JSON.stringify({
        topic: target.topic,
        title: event.title,
        message: event.message,
        priority: event.priority,
        tags: event.tags,
        kind: event.kind,
        room: event.roomId,
        at: event.at,
      });
      try {
        const response = await fetchImplementation(target.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response && response.ok === false) {
          if (log) log(`页面外通知发送失败：webhook ${event.kind} HTTP ${response.status}`);
          return false;
        }
        return true;
      } catch (sendError) {
        const reason = (sendError && sendError.cause && sendError.cause.code) || (sendError && sendError.name) || "network error";
        if (log) log(`页面外通知发送失败：webhook ${event.kind} ${reason}`);
        return false;
      }
    },
  };
}

/* ---------------- 编排器 ---------------- */

const DIALOG_DEDUPE_TTL_MS = 30 * 60 * 1000;
const MAX_DIALOG_KEYS_PER_ROOM = 64;
const MAX_ROOM_STATES = 1000;
// 助手消息的终态口径与 UI 一致：stopReason 在场且不是中间态（toolUse / pending / deferred）。
// 本组集合与回合归一逻辑在 relay/rooms.js 的 observeRoomTurnEvent 里有一份同口径副本
// （摘要通道），两份的等价性由 test/notify.test.js 的等价用例钉住，改一处须同步另一处（第 3 轮审查 A-3）。
const NON_TERMINAL_STOP_REASONS = new Set(["toolUse", "pending", "deferred"]);
// 出现这些事件 = 新一轮活动开始，上一回合的"已通知"标记与旧成败结论一并作废。
const TURN_ACTIVITY_TYPES = new Set(["agent_start", "turn_start", "message_start", "before_agent_start"]);

function createNotifier(config, dependencies = {}) {
  const log = typeof dependencies.log === "function" ? dependencies.log : () => {};
  const now = typeof dependencies.now === "function" ? dependencies.now : Date.now;
  const eventPreferences = sanitizeNotifyEvents(config && config.notifyEvents);
  const channel = createWebhookChannel({
    url: config && config.notifyWebhookUrl,
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
    log,
  });
  const enabled = channel.configured;
  if (enabled) {
    const enabledKinds = EVENT_KINDS.filter((kind) => eventPreferences[kind]);
    log(enabledKinds.length
      ? `页面外通知已启用：webhook 渠道，事件 ${enabledKinds.join(" / ")}`
      : "页面外通知：webhook 已配置，但三类事件开关全关，不会发送");
  }

  // roomId → { lastOutcome: "ok" | "error" | null, settledNotified: bool,
  //            sawMessage: bool（本回合是否观察到任何 message_end）, dialogs: Map<key, expiresAt> }
  const roomStates = new Map();

  function stateFor(roomId) {
    let roomState = roomStates.get(roomId);
    if (!roomState) {
      roomState = { lastOutcome: null, settledNotified: false, sawMessage: false, dialogs: new Map() };
      roomStates.set(roomId, roomState);
      if (roomStates.size > MAX_ROOM_STATES) {
        // 房间状态只是去重/成败的短时记忆，超限丢最旧一条即可，不影响主流程。
        roomStates.delete(roomStates.keys().next().value);
      }
    }
    return roomState;
  }

  function dispatch(kind, room, dialogInfo) {
    if (!enabled || !eventPreferences[kind]) return false;
    const event = buildEvent(kind, room, dialogInfo, now());
    // fire-and-forget：send 内部已吞错并记日志，这里再兜一层防渠道实现变更。
    Promise.resolve(channel.send(event)).catch(() => {});
    return true;
  }

  /**
   * 观察宿主事件流（local.js 的 event 出口旁挂调用）。同步、快速返回；
   * 本函数自身不向外抛（C-4：函数体整体兜底，调用方另有一层，两边都属实）。
   */
  function observe(room, event) {
    try {
      observeEvent(room, event);
    } catch {
      // 通知是旁路：自身任何异常（包括事件对象属性读取抛错）都吞在这里，
      // 绝不冒泡进宿主事件主流程。
    }
  }

  function observeEvent(room, event) {
    if (!enabled || !room || !event || typeof event !== "object") return;
    const type = typeof event.type === "string" ? event.type : "";
    const roomId = typeof room.id === "string" ? room.id : "";
    if (!roomId) return;
    const roomState = stateFor(roomId);

    if (TURN_ACTIVITY_TYPES.has(type)) {
      roomState.settledNotified = false;
      roomState.lastOutcome = null;
      roomState.sawMessage = false;
      return;
    }
    if (type === "message_end") {
      roomState.sawMessage = true;
      const assistantMessage = event.message;
      if (assistantMessage && typeof assistantMessage === "object" && assistantMessage.role === "assistant") {
        const stopReason = typeof assistantMessage.stopReason === "string" ? assistantMessage.stopReason : "";
        if (stopReason && !NON_TERMINAL_STOP_REASONS.has(stopReason)) {
          // aborted 单列（C-2）：用户主动打断既不是"完成"也不是"出错"，归入
          // 静默终态，落定时不推——免得用户刚按下打断就收到一条"回合完成"。
          roomState.lastOutcome = stopReason === "aborted" ? "aborted" : (stopReason === "error" || !!assistantMessage.errorMessage ? "error" : "ok");
        }
      }
      return;
    }
    if (type === "agent_settled") {
      if (roomState.settledNotified) return;
      roomState.settledNotified = true;
      const outcome = roomState.lastOutcome;
      roomState.lastOutcome = null;
      if (outcome === "aborted") return; // C-2：被用户打断的回合不推任何一条
      // 低-24：落定前一条 message_end 都没观察到（扩展在模型返回前就失败/事件流断了）时，
      // 不能默认按"回合完成"推送——那会把失败报成成功。保留"只有中间态/无 stopReason 时按完成"
      // 的既有兼容口径（与 rooms 摘要副本等价性测试同源），只堵"零观察"这一种假完成。
      if (!outcome && !roomState.sawMessage) return;
      dispatch(outcome === "error" ? "turn_error" : "turn_done", room);
      return;
    }
    if (type === "dialog_open") {
      const dialogId = typeof event.dialogId === "string" ? event.dialogId : "";
      if (!dialogId) return;
      const nowMs = now();
      for (const [key, expiresAt] of roomState.dialogs) if (expiresAt <= nowMs) roomState.dialogs.delete(key);
      if (roomState.dialogs.has(dialogId)) return; // 同一 dialog 只推一次：重连/补发/重放不重复
      roomState.dialogs.set(dialogId, nowMs + DIALOG_DEDUPE_TTL_MS);
      if (roomState.dialogs.size > MAX_DIALOG_KEYS_PER_ROOM) {
        roomState.dialogs.delete(roomState.dialogs.keys().next().value);
      }
      dispatch("dialog_waiting", room, {
        dialogKind: typeof event.kind === "string" ? event.kind.slice(0, 32) : "",
        answerable: event.answerable === true,
      });
      return;
    }
    if (type === "dialog_close") {
      const dialogId = typeof event.dialogId === "string" ? event.dialogId : "";
      if (dialogId) roomState.dialogs.delete(dialogId);
    }
  }

  return { enabled, prefs: eventPreferences, channel, observe, buildEvent };
}

module.exports = {
  EVENT_KINDS,
  sanitizeNotifyEvents,
  buildEvent,
  createWebhookChannel,
  createNotifier,
};
