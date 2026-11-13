"use strict";
/** viewer 通道（7002）：页面 + WebSocket */
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
const { cleanCid } = require("./store");
const { DEFAULT_ACCOUNT } = require("./index");
const PROTOCOL = require("./protocol.json");
const { safeEqual, safeId, log, keyFingerprint } = require("./util");
const { ROOT, DEFAULT_CONFIG, normalizeAccount, positiveInt, warnAdminTokenSeparation } = require("./config");
const { RELAY_CAPS, hasCap, parseHello, helloVersionError, helloText, errorFrame, send, broadcast, ackFrame, snapshotBodyFrom, snapshotFrame } = require("./wire");
const { PrefsStore, cleanPrefsSubset } = require("./prefs");
const { attachCommon, keepalive } = require("./conn");
const { PAIR_CODES_MAX, newPairCode, formatPairCode, normalizePairCode, pairCheckDigits, pairCheckDigitsV2, pairSourceBlocked, notePairFailure, requestSource, b64buf, authPayload, p256PubKey, verifyP256, cleanViewerPubKeys, adminPayload } = require("./pairing");
const { ackTrackerOf, isAckFp } = require("./acktrack");
const { commandTimeoutMs, MESSAGE_COMMANDS, DEVICE_COMMANDS, READONLY_DEVICE_COMMANDS, INACTIVE_SESSION_COMMANDS, DEVICE_ERRORS, HARNESS_BUSY, HARNESS_ARGS, COMMAND_RECONCILE_GRACE_MS, finishWaiter, settleEntry, armWaiter, pruneDedupe, dedupeKeyOf } = require("./commands");
const { MAX_DEVICE_NAME, UNREGISTERED_DEVICE, normPath, canonicalCwd, cwdAllowed, underRoots, boundAccount } = require("./devices");
const { replaySessionArchives } = require("./sessionArchive");
const { purgeSessions } = require("./purge");
const { resendFallbackBody, queryKey, sendCachedAssistant, sendCachedAutoRetry, sendCachedUiPrompt, sendCachedDialogs, sendCachedExtStatus, sendCachedCompaction, sendCachedTools, sendCachedToolEnds, sendCachedTaskList, sendCachedAgentState, sendCachedRemoteQueue, pushDialogGate, clearRoomTurnEnd, broadcastRoomAttention, devicesViewFor, snapshotBodyWithFinalFrames } = require("./rooms");
const { makeServeWeb, healthBody } = require("./web");

// 认证失败记账的来源数上限（只在内存里）。满了挤掉最久没有活动的来源；正常部署远到不了这个数。
const AUTH_FAIL_SOURCES_MAX = 1000;

/** O2 应答回执等待上限：桥正常都即时回 dialog_answer_result；超过这个数按 timeout 结案，不让答题端干挂。 */
const DIALOG_ANSWER_RESULT_TIMEOUT_MS = 15000;

/** G2 审批门档位（与桥侧 APPROVAL_GATE_TIERS 同值）：relay 只转发合法档位，非法值不带（桥保持当前值）。 */
const APPROVAL_GATE_TIERS = ["high-risk", "all-non-readonly", "list"];

/** prefs_set per-connection token bucket (storm backstop): 5 tokens/second
 *  sustained, burst capacity 10. Legitimate prefs traffic — a human toggling
 *  settings, the shell pushing one mobileNav change at a time — sits orders of
 *  magnitude below this; the bucket only exists so a client that echoes
 *  prefs_changed back into prefs_set cannot make the relay amplify the loop
 *  with a rev bump, a disk write, and a broadcast per round trip. */
const PREFS_SET_BUCKET_CAPACITY = 10;
const PREFS_SET_BUCKET_REFILL_PER_MS = 5 / 1000;

/** Take one prefs_set token from the connection's bucket; false when empty.
 *  State rides on the socket (same pattern as socket._room) and dies with the
 *  connection. Rejections are logged at most once per 5 s per connection so a
 *  storming client cannot turn the rejection path into a log flood. */
function takePrefsSetToken(socket, now) {
  let bucket = socket._prefsSetBucket;
  if (!bucket) bucket = socket._prefsSetBucket = { tokens: PREFS_SET_BUCKET_CAPACITY, refilledAt: now, limitedLoggedAt: 0 };
  bucket.tokens = Math.min(PREFS_SET_BUCKET_CAPACITY, bucket.tokens + Math.max(0, now - bucket.refilledAt) * PREFS_SET_BUCKET_REFILL_PER_MS);
  bucket.refilledAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  if (now - bucket.limitedLoggedAt > 5000) {
    bucket.limitedLoggedAt = now;
    log("prefs_set 超过单连接速率上限，本连接限流中（rate_limited）");
  }
  return false;
}

const ADMIN_REQUIRED = "admin_required";
const ADMIN_REQUIRED_TEXT = "需要管理员令牌";

/**
 * 管理命令（pair_create / device_revoke）的独立口令校验。
 * 未配置 adminToken 时一律拒绝；配置了才做常量时间比较。错误响应和日志都不透露“是否已配置”。
 */
function adminAuthorized(config, frame) {
  if (!config || !config.adminToken) return false;
  const supplied = typeof frame.adminToken === "string" ? frame.adminToken : "";
  return !!supplied && safeEqual(supplied, config.adminToken);
}

/* The rejection side of the admin gate lives in rejectAdminAny inside
 * startViewerServer: management frames accept adminToken OR adminSig (Phase 2),
 * and the signature track needs roster access that only exists in that scope. */

/** 从会话文件路径取会话 id（P9 B 旧房间寻址删除用）：文件名最后一个 `_` 之后、`.jsonl` 之前那段。
 *  pi 的会话文件名是 `<timestamp>_<id>.jsonl`；取不出合法 id 时返回 null（调用方不做服务器清理）。 */
function sessionIdFromPath(sessionPath) {
  const base = String(sessionPath || "").split(/[\\/]/).pop() || "";
  if (!base.endsWith(".jsonl")) return null;
  const stem = base.slice(0, -".jsonl".length);
  const underscoreAt = stem.lastIndexOf("_");
  const id = underscoreAt >= 0 ? stem.slice(underscoreAt + 1) : stem;
  return /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : null;
}

/** 订阅成功后，把房间上已缓存的待发队列只补给这一条连接。
 *  没有缓存不编造空队列。序列化后超过 maxPayloadBytes 就记一行日志并跳过，不断开。不带 seq / rev。 */
function sendCachedQueue(socket, room, config) {
  // 离线房间不补发旧队列：与 sendCachedUiPrompt/sendCachedTaskList 对齐，晚来的观众只看当前会话状态。
  if (!room || !room.online || !room.queue) return;
  const event = { type: "queue_update" };
  const cached = room.queue;
  if (Object.prototype.hasOwnProperty.call(cached, "steering")) event.steering = cached.steering;
  if (Object.prototype.hasOwnProperty.call(cached, "followUp")) event.followUp = cached.followUp;
  // 缓存时间戳与 taskList 对齐：前端可据此判断这份队列是哪个时刻的快照。
  if (typeof cached.at === "number" && Number.isFinite(cached.at)) event.at = cached.at;
  const frame = JSON.stringify({ type: "room_event", room: room.id, event });
  const limit = (config && config.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("待发队列补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(socket, frame, config);
}

/* ---------------- viewer 通道（7002）：页面 + WebSocket ---------------- */
function startViewerServer(config, rooms, store, relayContext, onListening, onError) {
  const index = relayContext.index;
  const devices = relayContext.devices;
  // 主题偏好同步（R4-1）：per-account 托管存储，与名册同根落盘（index.dir = data/accounts）
  const prefsStore = new PrefsStore(index.dir);
  // viewer 通道只有一个账号口径（握手令牌即账号），客户端上报的 accountId 不作数
  const viewerAccount = () => normalizeAccount(config.accountId);

  /* ---------------- Viewer identity keys (crypto Phase 2, design §3.2–§3.5 / §7) ---------------- */

  /** Roster read that never throws: a broken roster reads as "no such viewer". */
  const viewerRowSafe = (viewerId) => {
    try {
      return index.getViewerRow(viewerAccount(), viewerId);
    } catch {
      return null;
    }
  };

  /**
   * Live keyed viewer endpoints for content-key routing: connections that completed
   * viewer challenge-response auth whose roster row is still active. keyFp/boxPub
   * always come from the roster row, never from the connection's own claims.
   */
  const viewerKeyEndpoints = (accountId) => {
    const out = [];
    if (accountId !== viewerAccount()) return out;
    for (const viewerConnection of rooms.viewers) {
      const state = viewerConnection._state;
      if (!state || !state.authed || state.auth !== "key" || !state.viewerId || viewerConnection.readyState !== 1) continue;
      const row = viewerRowSafe(state.viewerId);
      if (!row || row.revokedAt || !row.signPub || !row.boxPub) continue;
      out.push({ ws: viewerConnection, viewerId: state.viewerId, keyFp: keyFingerprint(row.signPub), boxPub: row.boxPub });
    }
    return out;
  };
  // The local channel consults this provider when routing content_key_grant frames
  // and when broadcasting content_key_request frames to every keyed end.
  relayContext.viewerKeyEndpoints = viewerKeyEndpoints;

  /**
   * adminSig track (design §7): instead of the adminToken, a registered, admin-flagged,
   * non-revoked viewer signs the management frame with its VIK. The signed payload is
   * pinned in pairing.adminPayload and documented in protocol/v4.json (crypto.auth).
   * A connection already bound to a viewerId may only sign as that viewer.
   */
  const adminSigAuthorized = (socket, frame) => {
    if (typeof frame.adminSig !== "string" || !frame.adminSig) return false;
    // The signer is named by the dedicated adminBy field, falling back to the
    // connection's bound viewerId. frame.viewerId is never the signer: on
    // viewer_revoke it names the revocation target instead.
    const bound = socket._state && socket._state.viewerId ? socket._state.viewerId : "";
    const claimed = typeof frame.adminBy === "string" ? frame.adminBy.trim() : "";
    const signerId = claimed || bound;
    if (!signerId || (bound && signerId !== bound)) return false;
    const row = viewerRowSafe(signerId);
    if (!row || row.admin !== true || row.revokedAt || !row.signPub) return false;
    return verifyP256(row.signPub, adminPayload(frame), frame.adminSig);
  };

  /** Dual-track admin gate for management frames: adminToken OR adminSig. On failure
   *  the ack shape and code are exactly the token track's (admin_required). */
  const rejectAdminAny = (socket, frame) => {
    if (adminAuthorized(config, frame) || adminSigAuthorized(socket, frame)) return false;
    const origId = frame.id ? String(frame.id) : null;
    log("管理员命令被拒（adminToken/adminSig 均未通过）:", frame.type);
    send(socket, ackFrame(origId, false, { error: ADMIN_REQUIRED_TEXT, code: ADMIN_REQUIRED }), config);
    return true;
  };
  // 配置层已检查过同一份 config 时不重复告警；直接 startRelay 的调用方在这里补上。
  warnAdminTokenSeparation(config);
  const serveWeb = makeServeWeb(config.webRoot || path.join(ROOT, "web"));
  // /healthz 不要 token（部署脚本回环验证、监控用），其余路径照旧是静态页面
  const server = http.createServer((request, response) => {
    if (request.method === "GET" || request.method === "HEAD") {
      let pathname = "";
      try {
        pathname = new URL(request.url, "http://127.0.0.1").pathname;
      } catch {}
      if (pathname === "/healthz") {
        const body = JSON.stringify(healthBody(rooms, relayContext.startedAt, config.serverName));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
    }
    serveWeb(request, response);
  });
  const deflate = config.perMessageDeflate
    ? {
        threshold: 1024,
        zlibDeflateOptions: { level: 1, memLevel: 7 },
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        concurrencyLimit: 8,
      }
    : false;
  const wss = new WebSocketServer({ server, maxPayload: config.maxPayloadBytes, perMessageDeflate: deflate });
  // 启动失败（端口占用等）交给 startRelay 统一 reject；无 onError 的调用方保持旧行为。
  server.on("error", (serverError) => {
    console.error("[relay] viewer 通道失败:", serverError.message);
    if (typeof onError === "function") onError(serverError);
    else if (config.exitOnListenError !== false) process.exit(1);
  });
  wss.on("error", (socketError) => {
    console.error("[relay] viewer ws 失败:", socketError.message);
    if (typeof onError === "function") onError(socketError);
    else if (config.exitOnListenError !== false) process.exit(1);
  });
  server.listen({ port: config.viewerPort, host: config.viewerHost || "0.0.0.0" }, () => {
    log(`viewer 通道监听 :${server.address().port}`);
    if (onListening) onListening(server.address().port);
  });

  const fullSnapshotBody = (room) =>
    rooms.snapshotBody(room.id, () => snapshotBodyFrom(store.snapshot(room.id, { limit: config.maxSnapshotRecords, maxBytes: config.maxSnapshotBytes })));

  /** O2 应答回执对号序号（进程内单调递增即可，aid 只在 relay 内存里活一小会儿） */
  let dialogAnswerSeq = 0;

  /* ---------------- viewer 认证防护（按来源） ----------------
   * 7002 的 token 写在页面里，在线爆破只需要反复建连。失败按来源记，短时锁定；
   * 成功认证立刻清掉该来源的失败记录，所以正常断线重连（哪怕之前重试错过）不会被误锁。
   * 来源规则复用 pairing.requestSource：对端是回环才信 XFF，且取最后一跳。 */
  const authFailMax = positiveInt(config.viewerAuthFailMax, DEFAULT_CONFIG.viewerAuthFailMax);
  const authFailWindowMs = positiveInt(config.viewerAuthFailWindowMs, DEFAULT_CONFIG.viewerAuthFailWindowMs);
  const authLockMs = positiveInt(config.viewerAuthLockMs, DEFAULT_CONFIG.viewerAuthLockMs);
  const maxUnauthenticated = positiveInt(config.maxUnauthenticatedViewers, DEFAULT_CONFIG.maxUnauthenticatedViewers);
  const authFailures = new Map(); // source -> { times: number[], lockedUntil, lastLog, lastLockLog }
  let unauthenticated = 0;
  let lastCapLog = 0;

  /** 锁定剩余毫秒；锁已过期就把整条记录删掉，让来源重新获得完整失败额度。 */
  function authLockLeft(source) {
    const record = authFailures.get(source);
    if (!record || !record.lockedUntil) return 0;
    const left = record.lockedUntil - Date.now();
    if (left > 0) return left;
    authFailures.delete(source);
    return 0;
  }

  function noteAuthFailure(source) {
    const now = Date.now();
    let record = authFailures.get(source);
    if (!record) record = { times: [], lockedUntil: 0, lastLog: 0, lastLockLog: 0 };
    else authFailures.delete(source); // 重新插到 Map 末尾 = 最近有活动的来源最后被挤掉
    record.times = record.times.filter((failedAt) => failedAt > now - authFailWindowMs);
    record.times.push(now);
    if (record.times.length >= authFailMax) {
      record.times = [];
      record.lockedUntil = now + authLockMs;
      log("viewer 认证失败次数超限，按来源锁定:", source, "时长(ms):", authLockMs);
    } else if (!record.lastLog || now - record.lastLog > 5000) {
      record.lastLog = now;
      log("viewer 认证失败:", source, "窗口内第", record.times.length, "次");
    }
    authFailures.set(source, record);
    while (authFailures.size > AUTH_FAIL_SOURCES_MAX) authFailures.delete(authFailures.keys().next().value);
  }

  function noteAuthSuccess(source) {
    authFailures.delete(source);
  }

  function noteLockedReject(source, left) {
    const now = Date.now();
    const record = authFailures.get(source);
    if (!record) return;
    if (record.lastLockLog && now - record.lastLockLog <= 5000) return;
    record.lastLockLog = now;
    log("viewer 认证来源仍在锁定中，拒绝连接:", source, "剩余(ms):", left);
  }

  /**
   * 转发一条没有 command 结果通道的帧（message / abort）。send() 返回 false 表示对端已断开，
   * 或本机通道积压到硬顶（wire.send 会 terminate）。这两种情况都不能回 ok：
   * 离线回 room_offline、积压回 busy（都在码表里且可重试），详细原因只进日志。
   * @returns {boolean} true 表示已交给本机，调用方才回成功 ack。
   */
  function forwardToLocal(socket, room, outboundFrame, requestFrame, failText) {
    const local = room.local;
    if (!local || local.readyState !== 1) {
      send(socket, ackFrame(requestFrame.id, false, { room: room.id, error: failText.offline, code: "room_offline" }), config);
      return false;
    }
    const max = (config && config.viewerMaxBufferBytes) || DEFAULT_CONFIG.viewerMaxBufferBytes;
    const backlogged = Number(local.bufferedAmount) > max;
    if (send(local, outboundFrame, config)) return true;
    // 失败时 readyState 可能已被 wire.send 或对端改变：自己积压到硬顶算 busy，连接确实断了才算离线。
    const offline = local.readyState !== 1;
    const reason = offline && !backlogged ? "peer_offline" : "peer_backpressure";
    log(reason === "peer_offline" ? "本机通道已断开，未转发:" : "本机通道积压，未转发:", room.id, outboundFrame.type);
    if (reason === "peer_offline") {
      send(socket, ackFrame(requestFrame.id, false, { room: room.id, error: failText.offline, code: "room_offline" }), config);
    } else {
      send(socket, ackFrame(requestFrame.id, false, { room: room.id, error: failText.backpressure, code: "busy" }), config);
    }
    return false;
  }

  /**
   * viewer 断线后，无 key 的在飞命令不能从 commandWaiters 摘掉：本机还在执行，
   * 结果回来时 local.js 靠这条 entry 才能跑 onResult（删除会话的服务器副本清理）。
   * 但等待者的定时器已经清了，这里补一个兜底定时器，本机一直不回结果时也能收尾。
   */
  function armOrphanCleanup(entry, rooms) {
    if (entry._orphanTimer || entry._settled) return;
    // 低-20：断线不等于设备停止执行。保留到"超时 + 对账窗口"，让迟到结果仍能触发 onResult，
    // 而不是在命令超时那一刻把条目删掉。
    const delayMs = Math.max(1000, Number(entry.timeoutMs) || 0) + COMMAND_RECONCILE_GRACE_MS;
    entry._orphanTimer = setTimeout(() => {
      entry._orphanTimer = null;
      if (entry.done) return;
      log("命令无等待者且对账窗口结束，清理:", entry.room && entry.room.id, entry.wireId, entry.command);
      settleEntry(entry);
      rooms.commandWaiters.delete(entry.wireId);
      if (entry.key && rooms.dedupe.get(entry.key) === entry) rooms.dedupe.delete(entry.key);
    }, delayMs);
    if (entry._orphanTimer.unref) entry._orphanTimer.unref();
  }

  /** 把一条 viewer 命令交给指定 local。room 可以是真实房间，也可以是 harness 用的 {id:""} 占位。 */
  function runCommand(socket, frame, room, local, extra = {}) {
    const origId = frame.id ? String(frame.id) : null;
    const cmdName = String(frame.command || "");
    const commandArgs = frame.args && typeof frame.args === "object" ? frame.args : {};
    const timeoutMs = extra.timeoutMs || commandTimeoutMs(cmdName, commandArgs, config.harnessStartTimeoutMs);
    const scope = extra.dedupeScope || (room && room.id) || "";
    const dedupeKey = typeof frame.dedupeKey === "string" && frame.dedupeKey && frame.dedupeKey.length <= 128
      ? dedupeKeyOf(scope, cmdName, commandArgs, frame.dedupeKey)
      : null;
    const ackExtra = { room: room && room.id, deviceId: extra.deviceId };
    if (MESSAGE_COMMANDS.has(cmdName) && commandArgs.cid != null && !cleanCid(commandArgs.cid)) {
      send(socket, ackFrame(origId, false, { ...ackExtra, error: "cid 不合法", code: "bad_args" }), config);
      return;
    }
    if (dedupeKey) {
      pruneDedupe(rooms, config);
      const dedupedEntry = rooms.dedupe.get(dedupeKey);
      if (dedupedEntry) {
        if (dedupedEntry.done) {
          log("命令重发命中去重表，回放结果:", scope, dedupedEntry.wireId, cmdName);
          send(socket, ackFrame(origId, dedupedEntry.result.ok, {
            ...ackExtra,
            dedup: true,
            ...(dedupedEntry.result.ok ? { data: dedupedEntry.result.data } : { error: dedupedEntry.result.error, code: dedupedEntry.result.code }),
          }), config);
          return;
        }
        log("命令重发命中在飞请求，合并等待:", scope, dedupedEntry.wireId, cmdName);
        const waiter = { ws: socket, origId, timer: null };
        dedupedEntry.waiters.push(waiter);
        armWaiter(rooms, dedupedEntry, waiter, config);
        send(socket, { type: "command_accepted", id: origId, room: room && room.id ? room.id : undefined, deviceId: extra.deviceId, timeoutMs: dedupedEntry.timeoutMs, dedup: true }, config);
        return;
      }
    }
    if (!local || local.readyState !== 1) {
      send(socket, ackFrame(origId, false, { ...ackExtra, error: "本机未连接，无法执行", code: extra.offlineCode || "room_offline" }), config);
      if (extra.onSettle) extra.onSettle();
      return;
    }
    if (extra.onForward) extra.onForward();
    const wireId = "w_" + crypto.randomBytes(8).toString("hex");
    log("命令转发:", scope || (room && room.id), wireId, cmdName, "timeout=" + timeoutMs);
    const entry = {
      wireId,
      room: room || { id: "" },
      command: cmdName,
      local,
      timeoutMs,
      waiters: [],
      done: false,
      result: null,
      at: Date.now(),
      key: dedupeKey,
      deviceId: extra.deviceId,
      onSettle: extra.onSettle,
      // P9 B：结果落定后、给网页回执前的钩子（删除成功先清服务器副本，网页收到回执时已经清完）
      onResult: extra.onResult,
    };
    const waiter = { ws: socket, origId, timer: null };
    entry.waiters.push(waiter);
    armWaiter(rooms, entry, waiter, config);
    rooms.commandWaiters.set(wireId, entry);
    if (dedupeKey) rooms.dedupe.set(dedupeKey, entry);
    send(socket, { type: "command_accepted", id: origId, room: room && room.id ? room.id : undefined, deviceId: extra.deviceId, timeoutMs }, config);
    const outboundFrame = { type: "command", id: wireId, command: cmdName, args: commandArgs, timeoutMs };
    if (room && room.id) outboundFrame.room = room.id;
    if (extra.deviceId) outboundFrame.deviceId = extra.deviceId;
    send(local, outboundFrame, config);
  }

  function onlineRoomByCwd(deviceId, cwd, platform = "", activeRoomId = null) {
    const want = normPath(cwd, platform);
    // D-4: registration no longer renews lastActivity, so "most recently
    // active" is no longer a safe proxy for "the room the device is
    // actually in". Callers asking "which room is running in this cwd"
    // (harness_start's already_running pre-check) pass the device's
    // declared active room (noteActive at registration) and it wins when
    // it checks out. The session-file-op callers deliberately keep the
    // plain scan: spec D8 (P2-1) pins cwd-match first with the active
    // room as their explicit fallback right after the call.
    if (activeRoomId) {
      const active = rooms.peek(activeRoomId);
      if (active && active.online && active.deviceId === deviceId &&
          normPath(active.cwd || "", platform) === want) return active;
    }
    let best = null;
    for (const room of rooms.map.values()) {
      if (!room.online || room.deviceId !== deviceId) continue;
      if (normPath(room.cwd || "", platform) !== want) continue;
      if (!best || (room.lastActivity || 0) >= (best.lastActivity || 0)) best = room;
    }
    return best;
  }

  function routeHarness(socket, frame, deviceRecord, harnessArgs) {
    const origId = frame.id ? String(frame.id) : null;
    const cwd = typeof harnessArgs.cwd === "string" ? harnessArgs.cwd : "";
    const sessionId = typeof harnessArgs.sessionId === "string" ? harnessArgs.sessionId : "";
    const hasCwd = !!cwd;
    const hasSid = !!sessionId;
    if (hasCwd === hasSid) {
      send(socket, ackFrame(origId, false, { error: HARNESS_ARGS, code: "bad_args", deviceId: deviceRecord.id }), config);
      return;
    }
    if (hasCwd) {
      // P9 C：cwd 在白名单里，或者在设备的浏览根目录下面都放行（relay 只粗查，attach 按真实路径复查）
      const allowed = cwdAllowed(deviceRecord.projects, cwd, deviceRecord.platform) ||
        (hasCap(deviceRecord.conn, "fs.browse") && underRoots(deviceRecord.browseRoots, cwd, deviceRecord.platform));
      if (!allowed) {
        send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.cwd_not_allowed, code: "cwd_not_allowed", deviceId: deviceRecord.id }), config);
        return;
      }
      const running = onlineRoomByCwd(deviceRecord.id, cwd, deviceRecord.platform, deviceRecord.activeRoomId);
      if (running) {
        send(socket, ackFrame(origId, true, { deviceId: deviceRecord.id, data: { status: "already_running", roomId: running.id } }), config);
        return;
      }
    } else {
      let row = null;
      try { row = index.getSession(deviceRecord.accountId || DEFAULT_ACCOUNT, deviceRecord.id, sessionId); } catch { row = null; }
      if (!row || row.deleted) {
        send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.session_not_found, code: "session_not_found", deviceId: deviceRecord.id }), config);
        return;
      }
      const live = rooms.peek(sessionId);
      if (live && live.online) {
        send(socket, ackFrame(origId, true, { deviceId: deviceRecord.id, data: { status: "already_running", roomId: live.id } }), config);
        return;
      }
    }
    const dedupeKey = typeof frame.dedupeKey === "string" && frame.dedupeKey && frame.dedupeKey.length <= 128
      ? dedupeKeyOf(deviceRecord.id, "harness_start", harnessArgs, frame.dedupeKey)
      : null;
    if (deviceRecord.startInFlight) {
      const dedupedEntry = dedupeKey && rooms.dedupe.get(dedupeKey);
      if (!(dedupedEntry && !dedupedEntry.done && dedupedEntry.command === "harness_start")) {
        send(socket, ackFrame(origId, false, { error: HARNESS_BUSY, code: "harness_busy", deviceId: deviceRecord.id }), config);
        return;
      }
    }
    runCommand(socket, frame, { id: "" }, deviceRecord.conn, {
      timeoutMs: config.harnessStartTimeoutMs || 10000,
      dedupeScope: deviceRecord.id,
      deviceId: deviceRecord.id,
      offlineCode: "device_offline",
      onForward: () => { deviceRecord.startInFlight = true; },
      onSettle: () => { deviceRecord.startInFlight = false; },
    });
  }

  function routeDeviceCommand(socket, frame) {
    const origId = frame.id ? String(frame.id) : null;
    const deviceId = String(frame.deviceId).trim();
    const cmdName = String(frame.command || "");
    const commandArgs = frame.args && typeof frame.args === "object" ? frame.args : {};
    const accountId = typeof frame.accountId === "string" && frame.accountId.trim() ? frame.accountId.trim() : normalizeAccount(config.accountId);
    const deviceRecord = devices.get(deviceId);
    const dev = deviceRecord; // 锚点形状：relay/viewer.js 的文件级命令路由（ui-sync.test.mjs 钉住）
    let known = !!deviceRecord;
    if (!known) {
      try { known = !!index.getDeviceRow(accountId, deviceId); } catch { known = false; }
    }
    if (!known) {
      send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.no_device, code: "no_device", deviceId }), config);
      return;
    }
    if (!deviceRecord || !deviceRecord.online || !deviceRecord.conn || deviceRecord.conn.readyState !== 1) {
      send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.device_offline, code: "device_offline", deviceId }), config);
      return;
    }
    if (cmdName === "harness_start") {
      routeHarness(socket, frame, deviceRecord, commandArgs);
      return;
    }
    if (cmdName === "list_dirs") {
      // P9 C：目录浏览只能交给声明了 fs.browse 的 attach。必须在这里短路，
      // 否则会落进下面「交给扩展房间」的分支（扩展不认这个命令，网页干等超时）。
      if (!hasCap(deviceRecord.conn, "fs.browse")) {
        send(socket, ackFrame(origId, false, { error: PROTOCOL.errors.device_update_required.message, code: "device_update_required", deviceId }), config);
        return;
      }
      runCommand(socket, frame, null, deviceRecord.conn, { dedupeScope: deviceId, deviceId });
      return;
    }
    // 文件级会话操作不需要“目标会话”是活动房间，但命令必须交给**扩展**连接（deviceRecord.conn 是
    // attach 窗口，只处理 harness_start）。P2-1（spec D8）：先按索引里目标会话的 cwd 选
    // 同目录的在线房间——会话在别的项目时，交给活动房间会报「会话路径越界」；索引里查不到
    // 或那个目录没有在线房间时，退回原来的「活动房间 → 任一在线房间」逻辑。
    if (INACTIVE_SESSION_COMMANDS.has(cmdName) && DEVICE_COMMANDS.has(cmdName)) {
      const ws = socket; // 锚点形状：ui-sync.test.mjs 钉住 runCommand(ws, msg, targetRoom, local, extra)
      const msg = frame; // 同一锚点：这里的 msg 就是进来的请求帧
      const targetPath = typeof commandArgs.sessionPath === "string" ? commandArgs.sessionPath : "";
      const targetId = typeof commandArgs.sessionId === "string" && commandArgs.sessionId.trim()
        ? commandArgs.sessionId.trim()
        : sessionIdFromPath(targetPath);
      let row = null;
      if (targetId) {
        try { row = index.getSession(boundAccount(index, devices, deviceId, config.accountId), deviceId, targetId); } catch { row = null; }
      }
      let local = null;
      let targetRoom = null;
      if (row && row.cwd) {
        targetRoom = onlineRoomByCwd(deviceId, row.cwd, dev.platform || "");
        if (targetRoom && targetRoom.local && targetRoom.local.readyState === 1) local = targetRoom.local;
      }
      if (!local) {
        const active = dev.activeRoomId ? rooms.peek(dev.activeRoomId) : null;
        if (active && active.online && active.deviceId === deviceId && active.local && active.local.readyState === 1) {
          targetRoom = active;
          local = active.local;
        }
      }
      if (!local) {
        for (const candidate of rooms.map.values()) {
          if (candidate.deviceId === deviceId && candidate.local && candidate.local.readyState === 1) {
            targetRoom = candidate;
            local = candidate.local;
            break;
          }
        }
      }
      if (!local) {
        // attach 窗口只认 harness_start；没有扩展房间连接时直接报“没有在跑的会话”，
        // 不让文件命令落到窗口连接上干等 30 秒超时。
        send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.device_no_active_session, code: "device_no_active_session", deviceId }), config);
        return;
      }
      const extra = { dedupeScope: deviceId, deviceId };
      // 改名成功后同步 deviceRecord.archives 里那一条的 name（P2-1）：设备在线时网页可能已经拿到过旧正文，
      // 不更新的话正文区的标题会一直停在旧名字，直到 attach 下次重推。
      if (cmdName === "rename_session_file") {
        const archiveId = targetId;
        const fallbackName = typeof commandArgs.name === "string" ? commandArgs.name : "";
        extra.onResult = (result) => {
          if (!result || !result.ok || !archiveId) return;
          const archives = deviceRecord.archives;
          const body = archives && archives.get(archiveId);
          if (!body) return;
          const name = (result.data && typeof result.data.name === "string" && result.data.name) || fallbackName;
          if (name) body.name = String(name).slice(0, 200);
        };
      }
      // Body search routed at an enc room answers the same explicit unsupported
      // marker as the room-addressed path (never a silent omission).
      if (cmdName === "search_session_bodies" && targetRoom && store.encInfo(targetRoom.id)) {
        send(socket, ackFrame(origId, false, { error: "该会话已加密，正文搜索不支持", code: "unsupported", room: targetRoom.id, data: { unsupported: true, reason: "room_encrypted", roomId: targetRoom.id } }), config);
        return;
      }
      runCommand(ws, msg, targetRoom, local, extra);
      return;
    }
    const room = deviceRecord.activeRoomId ? rooms.peek(deviceRecord.activeRoomId) : null;
    const roomReady = !!(room && room.online && room.deviceId === deviceId);
    if (!roomReady) {
      if (deviceRecord.activeRoomId) deviceRecord.activeRoomId = null;
      // B-4：只读设备命令不要求活动会话——诊断/文件回程正是没会话时最需要。
      // 仍受 DEVICE_COMMANDS 白名单和设备在线/连接检查约束；发消息类永远走房间。
      if (READONLY_DEVICE_COMMANDS.has(cmdName) && DEVICE_COMMANDS.has(cmdName)) {
        runCommand(socket, frame, null, deviceRecord.conn, { dedupeScope: deviceId, deviceId });
        return;
      }
      send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.device_no_active_session, code: "device_no_active_session", deviceId }), config);
      return;
    }
    if (!DEVICE_COMMANDS.has(cmdName)) {
      send(socket, ackFrame(origId, false, { error: "该命令必须指定房间", code: "bad_args", deviceId }), config);
      return;
    }
    rooms.touch(room);
    // Same enc-search marker on the active-room fallback path.
    if (cmdName === "search_session_bodies" && store.encInfo(room.id)) {
      send(socket, ackFrame(origId, false, { error: "该会话已加密，正文搜索不支持", code: "unsupported", room: room.id, data: { unsupported: true, reason: "room_encrypted", roomId: room.id } }), config);
      return;
    }
    runCommand(socket, frame, room, room.local, { dedupeScope: deviceId, deviceId });
  }

  /**
   * 设备级删除（P9 B）：网页发 `{type:"command", deviceId, command:"delete_session", args:{sessionId}}`。
   * 路由顺序（原因是 attach 不在线时 routeDeviceCommand 会先报 device_offline，而那时扩展房间可能还在线）：
   *   1. attach 在线且声明 session.files → 交给 attach 在设备整个会话根目录里按 id 找并删
   *      （会话在别的项目也能删；索引里有路径时带 pathHint，attach 用它判断"文件在根目录外"）
   *   2. 否则按目标会话的 cwd 找同目录的在线房间 → 交给那个扩展删（R25 老路）
   *   3. 都不行：设备在线但 attach 太旧 → device_update_required；设备离线 → device_offline
   * 只有确实已有墓碑（row && row.deleted）才回 already_deleted 并做幂等清理；索引里查不到
   * （!row）不等于设备上删了——照常交给 attach 按 id 去找，找不到 attach 就回 session_not_found，
   * 绝不动服务器副本（第 1 轮审查 P1-2/P1-3：否则设备上文件还在、服务器却清了）。
   * 删除成功（onResult.ok）后先清服务器副本再回执，网页拿到回执时服务器已经干净。
   */
  function routeDeleteSession(socket, frame) {
    const origId = frame.id ? String(frame.id) : null;
    const deviceId = String(frame.deviceId).trim();
    const sessionId = String((frame.args && frame.args.sessionId) || "").trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
      send(socket, ackFrame(origId, false, { error: "会话 id 不合法", code: "bad_args", deviceId }), config);
      return;
    }
    const deviceRecord = devices.get(deviceId);
    // 账号由服务端绑定（与按房间删除的旧路径同一口径）：设备离线、内存里没有这条设备时
    // 不能退化成 config.accountId，否则查错账号会把"查不到"误判成"已删除"（审查 P1-2）
    const accountId = boundAccount(index, devices, deviceId, config.accountId);
    // 在线房间 = 会话正在运行：不删（与网页侧置灰口径一致）
    const live = rooms.peek(sessionId);
    if (live && live.online) {
      send(socket, ackFrame(origId, false, { error: "会话正在运行，不能删除", code: "session_running", deviceId }), config);
      return;
    }
    let row = null;
    try { row = index.getSession(accountId, deviceId, sessionId); } catch { row = null; }
    const purge = (result) => {
      if (result && result.ok) purgeSessions({ accountId, deviceId, ids: [sessionId], rooms, store, devices, index, config });
    };
    if (row && row.deleted) {
      // 确实已有墓碑（设备上先删过/重复点）：把残留副本清掉，回成功（幂等）
      purge({ ok: true });
      send(socket, ackFrame(origId, true, { deviceId, data: { status: "already_deleted", method: null } }), config);
      return;
    }
    const attachOk = deviceRecord && deviceRecord.online && deviceRecord.conn && deviceRecord.conn.readyState === 1 && hasCap(deviceRecord.conn, "session.files");
    if (!row && !attachOk) {
      // 索引里没有、又没有能按 id 在设备上找文件的 attach：无从证明设备上删了，不清副本
      send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.session_not_found, code: "session_not_found", deviceId }), config);
      return;
    }
    if (attachOk) {
      const deleteArgs = { sessionId };
      // P1-3：索引里的路径作提示，attach 找不到文件时据此区分"根目录外"与"真删了"
      if (row && typeof row.path === "string" && row.path) deleteArgs.pathHint = row.path;
      runCommand(socket, { ...frame, args: deleteArgs }, null, deviceRecord.conn, { dedupeScope: deviceId, deviceId, onResult: purge });
      return;
    }
    // row 存在但没有 attach：同目录在线房间 → 扩展删（R25 老路：扩展只删自己会话目录里的文件）
    const room = row.cwd ? onlineRoomByCwd(deviceId, row.cwd, deviceRecord ? deviceRecord.platform : "") : null;
    if (room && room.local && room.local.readyState === 1) {
      runCommand(socket, { ...frame, args: { sessionPath: row.path } }, room, room.local, { dedupeScope: deviceId, deviceId, onResult: purge });
      return;
    }
    const code = deviceRecord && deviceRecord.online ? "device_update_required" : "device_offline";
    send(socket, ackFrame(origId, false, {
      error: code === "device_offline" ? "设备未连接，连上后才能删除" : "这台设备的连接窗口（attach）需要更新",
      code,
      deviceId,
    }), config);
  }

  wss.on("connection", (socket, req) => {
    const source = requestSource(req);
    // 锁定中的来源在建连后立刻拒绝：不占未认证连接名额，也拿不到 10 秒的认证窗口反复试 token。
    const lockLeft = authLockLeft(source);
    if (lockLeft > 0) {
      noteLockedReject(source, lockLeft);
      // 不发明文帧：auth_result 会让观看端清掉本地 token，error 提示又会在恢复后残留。
      // 1013（Try Again Later）让客户端按退避重连，锁定到期后自动恢复。
      try { socket.close(1013, "auth rate limited"); } catch {}
      return;
    }
    if (unauthenticated >= maxUnauthenticated) {
      const now = Date.now();
      if (!lastCapLog || now - lastCapLog > 5000) {
        lastCapLog = now;
        log("viewer 未认证连接数达到上限，拒绝新连接:", unauthenticated, "/", maxUnauthenticated, "来源:", source);
      }
      try { socket.close(1013, "unauthenticated limit"); } catch {}
      return;
    }
    unauthenticated++;
    let unauthReleased = false;
    const releaseUnauthenticated = () => {
      if (unauthReleased) return;
      unauthReleased = true;
      unauthenticated = Math.max(0, unauthenticated - 1);
    };
    socket.on("close", releaseUnauthenticated);

    attachCommon(socket, config, {
      onMessage(frame) {
        const state = socket._state;
        if (!state.authed) {
          // Viewer challenge-response auth (crypto Phase 2, design §3.3): an auth frame
          // carrying keyFp starts a challenge, auth_response completes it. Isomorphic to
          // the local channel: the nonce lives only in connection memory and is deleted
          // on first use whatever the outcome, and the shared 10s unauthenticated
          // deadline (attachCommon's authTimer) is never extended by the challenge.
          const failKeyAuth = (code, error) => {
            noteAuthFailure(source);
            send(socket, { type: "auth_result", ok: false, error: error || PROTOCOL.errors[code].message, code }, config);
            try { socket.close(4003, "unauthorized"); } catch {}
          };
          if (frame.type === "auth_response") {
            const pend = state.viewerKeyAuth;
            delete state.viewerKeyAuth;
            if (!pend) { failKeyAuth("auth_failed", "没有待验签的挑战，请重新发起 auth"); return; }
            if (Date.now() > pend.expiresAt) { failKeyAuth("auth_failed", "鉴权挑战已过期，请重连后重试"); return; }
            const row = viewerRowSafe(pend.viewerId);
            if (row && row.revokedAt) { failKeyAuth("device_revoked"); return; }
            if (!row || !row.signPub || keyFingerprint(row.signPub) !== pend.keyFp) { failKeyAuth("device_mismatch"); return; }
            // The VIK is P-256: WebCrypto signatures are ECDSA/SHA-256 in IEEE P1363
            // form; the payload is the shared auth payload with viewerId as identity.
            if (!verifyP256(row.signPub, authPayload(pend.viewerId, pend.nonce, pend.clientNonce), frame.sig)) {
              log("观看端钥鉴权验签失败:", pend.viewerId);
              failKeyAuth("auth_failed", "签名不正确");
              return;
            }
            const protoError = helloVersionError(pend.hello);
            if (protoError) {
              log("viewer 协议版本过低，拒绝握手:", protoError.message, "来源:", source);
              send(socket, {
                type: "auth_result",
                ok: false,
                code: protoError.code,
                error: protoError.message,
                proto: PROTOCOL.proto,
                minProto: PROTOCOL.minProto,
              }, config);
              try { socket.close(4003, "unsupported protocol"); } catch {}
              return;
            }
            noteAuthSuccess(source);
            releaseUnauthenticated();
            state.authed = true;
            Object.assign(state, parseHello(pend.hello));
            clearTimeout(state.authTimer);
            rooms.viewers.add(socket);
            state.auth = "key";
            state.viewerId = pend.viewerId;
            // New key-auth surface only: auth:"key", the bound viewerId, and the
            // account's agreed ackFp (null while unknown or diverged, §7). The token
            // path's auth_result below stays byte-identical for existing clients.
            const authResult = { type: "auth_result", ok: true, proto: PROTOCOL.proto, caps: RELAY_CAPS, boot: rooms.boot, rooms: rooms.listFor(socket), devices: devicesViewFor(socket, rooms.deviceSnapshot()), auth: "key", viewerId: pend.viewerId, ackFp: ackTrackerOf(relayContext).knownAckFp(viewerAccount()) };
            if (config.serverName) authResult.serverName = config.serverName;
            if (hasCap(socket, "prefs.sync")) {
              const prefsRecord = prefsStore.get(viewerAccount());
              authResult.prefs = prefsRecord ? { subset: prefsRecord.subset, rev: prefsRecord.rev, updatedAt: prefsRecord.updatedAt } : null;
            }
            if (hasCap(socket, "room.inbox")) {
              authResult.inbox = rooms.inboxSnapshotFor(socket);
            }
            send(socket, authResult, config);
            replaySessionArchives(socket, devices, config);
            log("viewer 已认证 key", pend.viewerId, helloText(state));
            return;
          }
          if (frame.type === "auth" && frame.role === "viewer" && typeof frame.keyFp === "string" && frame.keyFp) {
            const viewerId = typeof frame.viewerId === "string" ? frame.viewerId.trim() : "";
            if (!viewerId || !safeId(viewerId)) { failKeyAuth("device_mismatch", "钥鉴权需要合法的 viewerId"); return; }
            const row = viewerRowSafe(viewerId);
            if (row && row.revokedAt) { failKeyAuth("device_revoked"); return; }
            if (!row || !row.signPub) { failKeyAuth("device_mismatch", "该观看端没有登记公钥，无法用密钥登录（先完成观看端登记）"); return; }
            if (!p256PubKey(row.signPub)) { failKeyAuth("device_mismatch", "名册中的观看端签名公钥不合规"); return; }
            if (keyFingerprint(row.signPub) !== frame.keyFp) { failKeyAuth("device_mismatch", "出示的钥指纹与名册登记不一致"); return; }
            const clientNonce = b64buf(frame.clientNonce);
            if (!clientNonce || clientNonce.length < 16 || clientNonce.length > 64) { failKeyAuth("auth_failed", "clientNonce 不合规（需 16–64 字节的 base64）"); return; }
            const nonce = crypto.randomBytes(PROTOCOL.limits.authNonceBytes);
            state.viewerKeyAuth = { viewerId, keyFp: frame.keyFp, nonce, clientNonce, hello: frame, expiresAt: Date.now() + 10000 };
            send(socket, { type: "auth_challenge", nonce: nonce.toString("base64"), expiresAt: state.viewerKeyAuth.expiresAt }, config);
            return;
          }
          if (frame.type === "auth" && frame.role === "viewer" && config.viewerToken && safeEqual(frame.token, config.viewerToken)) {
            // 低-12：显式声明了过低协议版本的握手要明确拒绝，不能静默按 minProto 放行。
            // 不带 proto 的老客户端仍走兼容期 v3（既有测试/旧前端都依赖这一行为）。
            const protoError = helloVersionError(frame);
            if (protoError) {
              log("viewer 协议版本过低，拒绝握手:", protoError.message, "来源:", source);
              send(socket, {
                type: "auth_result",
                ok: false,
                code: protoError.code,
                error: protoError.message,
                proto: PROTOCOL.proto,
                minProto: PROTOCOL.minProto,
              }, config);
              try { socket.close(4003, "unsupported protocol"); } catch {}
              return;
            }
            noteAuthSuccess(source);
            releaseUnauthenticated();
            state.authed = true;
            Object.assign(state, parseHello(frame));
            clearTimeout(state.authTimer);
            rooms.viewers.add(socket);
            const authResult = { type: "auth_result", ok: true, proto: PROTOCOL.proto, caps: RELAY_CAPS, boot: rooms.boot, rooms: rooms.listFor(socket), devices: devicesViewFor(socket, rooms.deviceSnapshot()) };
            if (config.serverName) authResult.serverName = config.serverName;
            // 偏好同步快照（R4-1，新面按 cap 剥离）：声明了 prefs.sync 才带 prefs 字段
            // （有记录给 {subset, rev, updatedAt}，无记录给 null——UI 据此播种第一版）；
            // 未声明的旧端 auth_result 里根本没有这个字段，既有面一律不动。
            if (hasCap(socket, "prefs.sync")) {
              const prefsRecord = prefsStore.get(viewerAccount());
              authResult.prefs = prefsRecord ? { subset: prefsRecord.subset, rev: prefsRecord.rev, updatedAt: prefsRecord.updatedAt } : null;
            }
            // 收件箱账本快照（设计 D §1，新面按 cap 剥离）：声明了 room.inbox 才带 inbox 字段；
            // 未声明的旧端 auth_result 里根本没有这个字段，既有面一律不动。
            if (hasCap(socket, "room.inbox")) {
              authResult.inbox = rooms.inboxSnapshotFor(socket);
            }
            send(socket, authResult, config);
            replaySessionArchives(socket, devices, config);
            log("viewer 已认证（当前房间", rooms.list().length, "个）", helloText(state));
          } else {
            // 业务帧/坏帧在未认证阶段一律按认证失败处理：不进入下面的 switch，不产生订阅、命令等副作用。
            noteAuthFailure(source);
            send(socket, { type: "auth_result", ok: false, error: "token 不正确", code: "auth_failed" }, config);
            socket.close(4003, "unauthorized");
          }
          return;
        }
        switch (frame.type) {
          case "usage_get": {
            // P10：使用活动（只读聚合；viewer 只能取本账号设备；无数据/旧端走空态帧，不报错）
            if (!relayContext.usage) { send(socket, { type: "usage_snapshot", deviceId: typeof frame.deviceId === "string" ? frame.deviceId : "", available: false, reason: "unsupported", requestId: typeof frame.requestId === "string" ? frame.requestId : undefined }, config); break; }
            relayContext.usage.handleGet(socket, frame, viewerAccount());
            break;
          }
          case "list_rooms": {
            const listFrame = { type: "room_list", devices: devicesViewFor(socket, rooms.deviceSnapshot()), rooms: rooms.listFor(socket) };
            // 收件箱账本快照（设计 D §1）：与 auth_result 同口径，按 cap 附带，未声明不带字段。
            if (hasCap(socket, "room.inbox")) listFrame.inbox = rooms.inboxSnapshotFor(socket);
            send(socket, listFrame, config);
            break;
          }
          case "inbox_dismiss": {
            // 收件箱手动清除（设计 D §1）：relay 本地命令，不转发桥；只清 done/error，
            // waiting 拒清在账本层裁决（防假清零）。结果经 inbox_update 广播对齐各端（含发送端），
            // 本命令不单独回执（与 dialog_answer_switch 的无回执下达同姿势）。
            if (!hasCap(socket, "room.inbox")) {
              send(socket, errorFrame("unsupported", "此端未声明 room.inbox 能力", { id: frame.id ? String(frame.id) : null }), config);
              return;
            }
            rooms.dismissInbox(typeof frame.key === "string" ? frame.key : "");
            break;
          }
          case "schedule_create": {
            // 定时/心跳排期（设计 D §3）：relay 本地命令，绝不转发桥——计时器归 relay，
            // 到点由 relay 经既有命令通道下发 prompt。与 prompt 同一鉴权面（本连接已
            // 通过 viewer 鉴权）。校验/上限在引擎裁决；成功回执带新条目，清单变化另经
            // schedule_update 广播对齐各端。
            const origId = frame.id ? String(frame.id) : null;
            if (!hasCap(socket, "room.schedule")) {
              send(socket, errorFrame("unsupported", "此端未声明 room.schedule 能力", { id: origId }), config);
              return;
            }
            const roomId = typeof frame.roomId === "string" ? frame.roomId : "";
            const room = rooms.peek(roomId);
            if (!room) {
              send(socket, ackFrame(origId, false, { room: roomId || undefined, error: "会话不存在", code: "no_room" }), config);
              return;
            }
            const scheduleResult = rooms.createSchedule(viewerAccount(), { ...frame, roomId: room.id });
            if (!scheduleResult.entry) {
              send(socket, ackFrame(origId, false, { room: room.id, error: scheduleResult.error, code: scheduleResult.code }), config);
              return;
            }
            send(socket, ackFrame(origId, true, { room: room.id, data: scheduleResult.entry }), config);
            break;
          }
          case "schedule_cancel": {
            // 取消一条 armed 排期（终态条目取消无意义，回 no_schedule）。排期 id 走
            // scheduleId 字段：帧的 id 是回执对号位，不能占用。
            const origId = frame.id ? String(frame.id) : null;
            if (!hasCap(socket, "room.schedule")) {
              send(socket, errorFrame("unsupported", "此端未声明 room.schedule 能力", { id: origId }), config);
              return;
            }
            const entry = rooms.cancelSchedule(viewerAccount(), typeof frame.scheduleId === "string" ? frame.scheduleId : "");
            if (!entry) {
              send(socket, ackFrame(origId, false, { error: "定时消息不存在或已结束", code: "not_found" }), config);
              return;
            }
            send(socket, ackFrame(origId, true, { room: entry.roomId, data: entry }), config);
            break;
          }
          case "schedule_list": {
            // 单房排期清单直查：与 room_list 条目内 schedules / schedule_update 同一数据源。
            const origId = frame.id ? String(frame.id) : null;
            if (!hasCap(socket, "room.schedule")) {
              send(socket, errorFrame("unsupported", "此端未声明 room.schedule 能力", { id: origId }), config);
              return;
            }
            const roomId = typeof frame.roomId === "string" ? frame.roomId : "";
            send(socket, ackFrame(origId, true, { room: roomId || undefined, data: { schedules: rooms.scheduleList(viewerAccount(), roomId) } }), config);
            break;
          }
          case "schedule_text": {
            // One schedule's full text on demand: room lists carry only a
            // preview, so a viewer that needs the text asks for it by id and
            // is the only one that receives it. Same cap gate as schedule_list.
            const origId = frame.id ? String(frame.id) : null;
            if (!hasCap(socket, "room.schedule")) {
              send(socket, errorFrame("unsupported", "此端未声明 room.schedule 能力", { id: origId }), config);
              return;
            }
            const found = rooms.scheduleText(viewerAccount(), typeof frame.scheduleId === "string" ? frame.scheduleId : "");
            if (!found) {
              send(socket, ackFrame(origId, false, { error: "定时消息不存在", code: "not_found" }), config);
              return;
            }
            send(socket, ackFrame(origId, true, { room: found.roomId, data: { id: found.id, text: found.text } }), config);
            break;
          }
          case "get_sessions": {
            const origId = frame.id ? String(frame.id) : null;
            const deviceId = typeof frame.deviceId === "string" ? frame.deviceId.trim() : "";
            // R-5：账号只认本连接的握手口径（viewerAccount），忽略 frame.accountId
            // ——与文件头口径及 prefs/usage 的做法一致，客户端上报不作数。
            const accountId = viewerAccount();
            if (origId) {
              const key = queryKey(socket, origId);
              // 同一个 (连接, id) 重复查询（前端重试/连点）会覆盖 map 条目：必须先撤掉旧定时器，
              // 否则旧定时器到点后发现 key 还在（那已是新条目），就会删掉新查询并发一条假超时，把新查询冤杀。
              const stale = rooms.viewerQueries.get(key);
              if (stale) clearTimeout(stale.timer);
              const timer = setTimeout(() => {
                if (!rooms.viewerQueries.has(key)) return;
                rooms.viewerQueries.delete(key);
                send(socket, errorFrame("timeout", "查询超时", { id: origId, deviceId }), config);
              }, 10000);
              timer.unref();
              rooms.viewerQueries.set(key, { socket, timer });
            }
            const finishQuery = () => {
              const query = origId && rooms.viewerQueries.get(queryKey(socket, origId));
              if (!query) return;
              clearTimeout(query.timer);
              rooms.viewerQueries.delete(queryKey(socket, origId));
            };
            try {
              let row = null;
              if (deviceId) {
                try { row = index.getDeviceRow(accountId, deviceId); } catch (rosterError) { log("get_sessions 读名册失败:", rosterError.message); }
              }
              if (!deviceId || !row) {
                send(socket, errorFrame("no_device", DEVICE_ERRORS.no_device, { id: origId, deviceId }), config);
                return;
              }
              const limit = config.maxSessionsListed || 200;
              const listed = index.listSessions(accountId, deviceId, { limit });
              const sessions = listed.sessions.map((listedSession) => {
                const room = rooms.peek(listedSession.id);
                return {
                  id: listedSession.id,
                  name: listedSession.name || "",
                  path: listedSession.path || "",
                  // fork 谱系（R3-3）：父指针经 AccountIndex 落盘后必须在这一跳也透传，
                  // 漏了 UI 的 parseSessionList 永远拿到 null、"源自 X"整体落空（第 3 轮审查 C-1）。
                  parentSession: listedSession.parentSession || null,
                  // Crypto Phase 3: a sealed preview envelope stored on the
                  // index row is served inside firstMessage -- the form the
                  // web session parser reads (firstMessageEncOf) -- so the
                  // device library list can decrypt it; plaintext rows are
                  // served exactly as before.
                  firstMessage: listedSession.firstMessage ? listedSession.firstMessage : (listedSession.firstMessageEnc || null),
                  // 索引里旧行可能还是 D:/x（旧扩展写的）：下发时按设备平台统一写法，不改落盘数据
                  cwd: canonicalCwd(listedSession.cwd || "", row.platform),
                  messageCount: listedSession.messageCount || 0,
                  sizeBytes: listedSession.sizeBytes || 0,
                  updatedAt: listedSession.updatedAt || 0,
                  active: !!listedSession.active,
                  online: !!(room && room.online),
                  deleted: false,
                };
              });
              send(socket, { type: "session_list", id: origId, deviceId, sessions, truncated: !!listed.truncated }, config);
            } catch (queryError) {
              log("get_sessions 失败:", queryError.message);
              send(socket, errorFrame("server_error", "读取会话清单失败", { id: origId }), config);
            } finally {
              finishQuery();
            }
            break;
          }
          case "subscribe": {
            const rid = String(frame.room || "");
            // 真实房间 = 在注册表里，或存储有文件（离线可回看）；都不沾 → 明确报错，不建幻影房
            if (!rooms.peek(rid) && !store.exists(rid)) {
              send(socket, errorFrame("no_room", "会话不存在", { room: rid }), config);
              return;
            }
            // Enc gate (design section 7): a viewer without crypto.content gets
            // crypto_required and NO snapshot — ciphertext is never delivered
            // as if it were messages. A stale pre-encryption subscription on
            // this connection is dropped here as well.
            const subEnc = store.encInfo(rid);
            if (subEnc && !hasCap(socket, "crypto.content")) {
              if (socket._room && socket._room.id === rid) {
                socket._room.viewers.delete(socket);
                socket._room = null;
              }
              send(socket, errorFrame("crypto_required", "该会话已加密，需要支持正文加密的客户端", { room: rid }), config);
              return;
            }
            // Plaintext policy (design section 5): "deny" refuses reads too.
            if (!subEnc && ((config && config.cryptoPlaintextRooms) || "allow") === "deny") {
              send(socket, errorFrame("unsupported", "plaintext rooms are disabled by the cryptoPlaintextRooms policy", { room: rid }), config);
              return;
            }
            const room = rooms.get(rid);
            const already = room.viewers.has(socket);
            // 低-19：先完成新订阅（含容量校验），成功后再摘旧房。旧实现先摘旧房再判
            // room_full，切到一个满房失败时会把当前会话的订阅也弄丢。
            if (!already) {
              if (room.viewers.size >= config.maxViewersPerRoom) {
                send(socket, errorFrame("room_full", "该会话观看人数已满", { room: rid }), config);
                return;
              }
              room.viewers.add(socket);
              pushDialogGate(room, config);
            }
            if (socket._room && socket._room !== room) {
              const oldRoom = socket._room;
              oldRoom.viewers.delete(socket);
              if (oldRoom.resendWaiters) oldRoom.resendWaiters = oldRoom.resendWaiters.filter((waiter) => waiter !== socket);
              pushDialogGate(oldRoom, config);
            }
            socket._room = room;
            // 注意力恢复通道（R3-1）：订阅进房即已读——由 relay 清该房回合摘要并广播
            // room_attention{null}（单用户多设备：一端看过即全端已读）。在 subscribed
            // 之前落，让随后到的 room_list 快照与本帧口径一致（都已清）。
            if (clearRoomTurnEnd(room)) broadcastRoomAttention(rooms, room, config);
            const subscribedFrame = { type: "subscribed", room: room.id, online: room.online, busy: room.busy };
            if (room.online && room.turnStopped) subscribedFrame.turnStopped = true;
            send(socket, subscribedFrame, config);
            // 断线重连：带 since={rev,seq} 且存储世代未变 → 只送 seq 之后的增量；否则全量
            const since = frame.since && typeof frame.since === "object" ? { rev: String(frame.since.rev || ""), seq: Number(frame.since.seq) } : null;
            // 正文默认不落盘：在线房间内存里没有快照时，请扩展重推，3s 兜底空快照
            const freshSnap = room.snap && room.snap.body && room.snap.at + config.snapshotCacheTtlMs > Date.now();
            if (!config.persistTranscripts && room.online && room.local && !freshSnap) {
              let mem = null;
              try {
                mem = store.snapshot(room.id, { limit: config.maxSnapshotRecords, maxBytes: config.maxSnapshotBytes });
              } catch {
                mem = null;
              }
              const hasMem = !!(mem && Array.isArray(mem.items) && mem.items.length);
              if (!hasMem) {
                // 增量重连本就带着 since：存储世代没变就先给增量，不必再等一次本机全量快照
                if (since && since.rev) {
                  let delta = null;
                  try {
                    const snapshot = store.snapshot(room.id, { limit: config.maxSnapshotRecords, maxBytes: config.maxSnapshotBytes, since });
                    if (snapshot && snapshot.delta) delta = snapshot;
                  } catch {}
                  if (delta) {
                    send(socket, snapshotFrame(room, snapshotBodyWithFinalFrames(snapshotBodyFrom(delta), room)), config);
                    if (room.usage) send(socket, { type: "usage_state", room: room.id, usage: room.usage }, config);
                    sendCachedQueue(socket, room, config);
                    sendCachedRemoteQueue(socket, room, config);
                    sendCachedTaskList(socket, room, config);
                    sendCachedAgentState(socket, room, config);
                    // since 增量不补还在写的助手正文和工具参数
                    sendCachedTools(socket, room, config);
                    sendCachedToolEnds(socket, room, config);
                    sendCachedAutoRetry(socket, room, config);
                    sendCachedUiPrompt(socket, room, config);
                    sendCachedDialogs(socket, room, config);
                    sendCachedExtStatus(socket, room, config);
                    sendCachedCompaction(socket, room, config);
                    if (!already) {
                      rooms.broadcastRoomList();
                      log("viewer 订阅:", room.id, "(增量，不等本机快照)");
                    }
                    break;
                  }
                }
                if (!room.resendWaiters) room.resendWaiters = [];
                if (!room.resendWaiters.includes(socket)) room.resendWaiters.push(socket);
                if (!room.resendTimer) {
                  send(room.local, { type: "resend_snapshot", room: room.id }, config);
                  room.resendTimer = setTimeout(() => {
                    room.resendTimer = null;
                    const waiters = room.resendWaiters || [];
                    room.resendWaiters = [];
                    for (const waiter of waiters) {
                      send(waiter, snapshotFrame(room, resendFallbackBody(config, store, room)), config);
                      sendCachedTaskList(waiter, room, config);
                      sendCachedAgentState(waiter, room, config);
                      sendCachedRemoteQueue(waiter, room, config);
                      sendCachedAssistant(waiter, room, config, store);
                      sendCachedTools(waiter, room, config);
                      sendCachedToolEnds(waiter, room, config);
                      sendCachedAutoRetry(waiter, room, config);
                      sendCachedUiPrompt(waiter, room, config);
                      sendCachedDialogs(waiter, room, config);
                      sendCachedExtStatus(waiter, room, config);
                      sendCachedCompaction(waiter, room, config);
                    }
                  }, config.resendSnapshotWaitMs || 3000);
                  room.resendTimer.unref();
                }
                if (room.usage) send(socket, { type: "usage_state", room: room.id, usage: room.usage }, config);
                sendCachedQueue(socket, room, config);
                sendCachedRemoteQueue(socket, room, config);
                sendCachedTaskList(socket, room, config);
                sendCachedAgentState(socket, room, config);
                // 还没有全量快照，不补还在写的助手正文和工具参数
                sendCachedTools(socket, room, config);
                sendCachedToolEnds(socket, room, config);
                sendCachedAutoRetry(socket, room, config);
                sendCachedUiPrompt(socket, room, config);
                sendCachedDialogs(socket, room, config);
                sendCachedExtStatus(socket, room, config);
                sendCachedCompaction(socket, room, config);
                if (!already) {
                  rooms.broadcastRoomList();
                  log("viewer 订阅:", room.id, "(等待本机快照)");
                }
                break;
              }
            }
            let body = null;
            if (since && since.rev) {
              const snap = store.snapshot(room.id, { limit: config.maxSnapshotRecords, maxBytes: config.maxSnapshotBytes, since });
              if (snap && snap.delta) body = snapshotBodyFrom(snap);
            }
            const snapBody = body || fullSnapshotBody(room);
            send(socket, snapshotFrame(room, snapBody), config);
            if (room.usage) send(socket, { type: "usage_state", room: room.id, usage: room.usage }, config);
            sendCachedQueue(socket, room, config);
            sendCachedRemoteQueue(socket, room, config);
            // 任务清单与快照是否全量无关：缓存里有就补，重连/新观众都不会丢当前清单
            sendCachedTaskList(socket, room, config);
            sendCachedAgentState(socket, room, config);
            // 全量才补。工具参数 message_update 在 sendCachedAssistant 里，紧跟 message_start、位于工具执行补发之前。since 增量不补。
            if (!body) sendCachedAssistant(socket, room, config, store);
            sendCachedTools(socket, room, config);
            sendCachedToolEnds(socket, room, config);
            sendCachedAutoRetry(socket, room, config);
            sendCachedUiPrompt(socket, room, config);
            sendCachedDialogs(socket, room, config);
            sendCachedExtStatus(socket, room, config);
            sendCachedCompaction(socket, room, config);
            // 只有观众数真变了才广播：否则"订阅→room_list→再订阅"会在客户端形成自循环
            if (!already) {
              rooms.broadcastRoomList();
              log("viewer 订阅:", room.id, body ? "(增量)" : "");
            }
            break;
          }
          case "unsubscribe": {
            const room = socket._room;
            if (room) {
              room.viewers.delete(socket);
              socket._room = null;
              pushDialogGate(room, config);
              // 退订就要从兜底快照的等待名单里摘掉：否则 3s 后仍会给已经离开的 viewer 推一条空快照
              if (room.resendWaiters) room.resendWaiters = room.resendWaiters.filter((waiter) => waiter !== socket);
              rooms.broadcastRoomList();
            }
            break;
          }
          case "history": {
            // 分页已废弃（完整镜像语义）——明确报错而不是静默吞掉
            send(socket, ackFrame(frame.id, false, { error: "history 分页已废弃，请以 subscribe 时的 snapshot 为准", code: "unsupported" }), config);
            break;
          }
          case "message": {
            const room = rooms.touch(rooms.peek(String(frame.room || "")));
            if (!room) {
              send(socket, ackFrame(frame.id, false, { error: "会话不存在", code: "no_room" }), config);
              return;
            }
            const cid = cleanCid(frame.cid);
            if (frame.cid != null && !cid) {
              send(socket, ackFrame(frame.id, false, { room: room.id, error: "cid 不合法", code: "bad_args" }), config);
              return;
            }
            // Enc rooms (design sections 4.1/7): the viewer sends the envelope
            // form {enc:{ct,h}} instead of text; the relay forwards it verbatim
            // and never sees the plaintext. A plaintext text aimed at an enc
            // room is rejected, as is an envelope aimed at a plaintext room.
            if (store.encInfo(room.id)) {
              if (!hasCap(socket, "crypto.content")) {
                send(socket, ackFrame(frame.id, false, { room: room.id, error: "该会话已加密，需要支持正文加密的客户端", code: "crypto_required" }), config);
                return;
              }
              // Two spellings: nested {enc:{ct, h}} or flat {enc:1, ct, h}.
              const enc = frame.enc && typeof frame.enc === "object" ? frame.enc : (frame.enc === 1 ? frame : null);
              if (!enc || typeof enc.ct !== "string" || !enc.ct || typeof enc.h !== "string" || !/^[0-9a-f]{64}$/.test(enc.h)) {
                send(socket, ackFrame(frame.id, false, { room: room.id, error: "加密消息缺少合法的 enc 信封（ct/h）", code: "bad_args" }), config);
                return;
              }
              const encFrame = { type: "message", room: room.id, enc: 1, ct: enc.ct, h: enc.h };
              if (cid && hasCap(room.local, "msg.cid")) encFrame.cid = cid;
              if (!forwardToLocal(socket, room, encFrame, frame, {
                offline: "本机未连接，消息无法送达",
                backpressure: "本机消息通道积压，消息未能送出，请稍后重试",
              })) return;
              send(socket, ackFrame(frame.id, true, { room: room.id }), config);
              return;
            }
            if (frame.enc != null) {
              send(socket, ackFrame(frame.id, false, { room: room.id, error: "该会话未加密，不能发送 enc 信封", code: "bad_args" }), config);
              return;
            }
            // 不再静默截断：截断后的半句话会被当成完整指令注入（单帧上限 maxPayloadBytes 已兜住体积）
            const text = String(frame.text ?? "");
            if (!text.trim()) {
              send(socket, ackFrame(frame.id, false, { room: room.id, error: "消息为空", code: "bad_args" }), config);
              return;
            }
            // 带上 room：会话切换窗口内旧房间仍 online，扩展可据此拒绝注入到已离开的会话
            const outboundFrame = { type: "message", room: room.id, text };
            if (cid && hasCap(room.local, "msg.cid")) outboundFrame.cid = cid;
            if (!forwardToLocal(socket, room, outboundFrame, frame, {
              offline: "本机未连接，消息无法送达",
              backpressure: "本机消息通道积压，消息未能送出，请稍后重试",
            })) return;
            send(socket, ackFrame(frame.id, true, { room: room.id }), config);
            break;
          }
          case "command": {
            // deviceId 替代 room 寻址；不带 deviceId 的命令仍按房间走
            if (frame.deviceId != null && String(frame.deviceId).trim()) {
              // P9 B：设备级删除走专用路由（四路由顺序见 routeDeleteSession）——不能直接交给
              // routeDeviceCommand：attach 不在线时它一上来就报 device_offline，可那时扩展房间可能还在线。
              if (String(frame.command || "") === "delete_session") routeDeleteSession(socket, frame);
              else routeDeviceCommand(socket, frame);
              break;
            }
            const room = rooms.touch(rooms.peek(String(frame.room || "")));
            const origId = frame.id ? String(frame.id) : null;
            if (!room) { send(socket, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), config); return; }
            // P9 B：旧网页按房间寻址的 delete_session，成功后同样清服务器副本。
            // 会话 id 从 sessionPath 反推（文件名最后一个 _ 之后、.jsonl 之前），索引键用服务端绑定的设备/账号。
            const extra = {};
            if (String(frame.command || "") === "delete_session") {
              const sessionId = sessionIdFromPath(frame.args && frame.args.sessionPath);
              if (sessionId) {
                const deviceId = String(room.deviceId || UNREGISTERED_DEVICE);
                const accountId = boundAccount(index, devices, deviceId, config.accountId);
                extra.onResult = (result) => {
                  if (result && result.ok) purgeSessions({ accountId, deviceId, ids: [sessionId], rooms, store, devices, index, config });
                };
              }
            }
            // Body search over an enc room (design section 4.1): the relay cannot
            // read ciphertext and the extension-side scan would have to decrypt
            // per viewer — the room answers with an explicit unsupported marker
            // instead of being silently omitted from the results.
            if (String(frame.command || "") === "search_session_bodies" && store.encInfo(room.id)) {
              send(socket, ackFrame(origId, false, { error: "该会话已加密，正文搜索不支持", code: "unsupported", room: room.id, data: { unsupported: true, reason: "room_encrypted", roomId: room.id } }), config);
              break;
            }
            runCommand(socket, frame, room, room.local, extra);
            break;
          }
          case "dialog_answer_switch": {
            // O2 开关下达（UI→relay→桥）：relay 存当前值（桥重连时按存值重下达），在线桥即时转发
            const room = rooms.touch(rooms.peek(String(frame.room || "")));
            const origId = frame.id ? String(frame.id) : null;
            if (!room) { send(socket, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), config); return; }
            const enabled = frame.enabled === true;
            // The trio is presented as one global set in settings, so an
            // explicit set lands on every room, not just the addressed
            // one; the account record covers rooms that register later
            // (register-time fallback in local.js).
            rooms.accountSwitches.dialogRemoteAnswer = enabled;
            for (const anyRoom of rooms.map.values()) {
              anyRoom.dialogRemoteAnswer = enabled;
              if (anyRoom.local) send(anyRoom.local, { type: "dialog_answer_switch", room: anyRoom.id, enabled }, config);
            }
            send(socket, ackFrame(origId, true, { room: room.id }), config);
            break;
          }
          case "ask_user_switch": {
            // G1 开关下达（与 dialog_answer_switch 同路同纪律）：relay 存当前值，桥重连按存值重下达
            const room = rooms.touch(rooms.peek(String(frame.room || "")));
            const origId = frame.id ? String(frame.id) : null;
            if (!room) { send(socket, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), config); return; }
            const enabled = frame.enabled === true;
            // Account-wide application, same as dialog_answer_switch above.
            rooms.accountSwitches.askUserEnabled = enabled;
            for (const anyRoom of rooms.map.values()) {
              anyRoom.askUserEnabled = enabled;
              if (anyRoom.local) send(anyRoom.local, { type: "ask_user_switch", room: anyRoom.id, enabled }, config);
            }
            send(socket, ackFrame(origId, true, { room: room.id }), config);
            break;
          }
          case "approval_gate_switch": {
            // G2 开关下达（同上）：存整份配置（enabled + 合法 tier + 名单），重下达时原样发回；
            // tier/tools 不合法就不带——桥侧只在合法时采纳，缺省即保持桥当前值
            const room = rooms.touch(rooms.peek(String(frame.room || "")));
            const origId = frame.id ? String(frame.id) : null;
            if (!room) { send(socket, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), config); return; }
            const stored = { enabled: frame.enabled === true };
            if (APPROVAL_GATE_TIERS.includes(frame.tier)) stored.tier = frame.tier;
            if (Array.isArray(frame.tools)) {
              stored.tools = frame.tools.filter((toolName) => typeof toolName === "string" && toolName && toolName.length <= 128).slice(0, 64);
            }
            // Account-wide application, same as dialog_answer_switch above.
            rooms.accountSwitches.approvalGateSwitch = stored;
            for (const anyRoom of rooms.map.values()) {
              anyRoom.approvalGateSwitch = stored;
              if (anyRoom.local) send(anyRoom.local, { type: "approval_gate_switch", room: anyRoom.id, ...stored }, config);
            }
            send(socket, ackFrame(origId, true, { room: room.id }), config);
            break;
          }
          case "prefs_set": {
            // 主题偏好同步（R4-1）：viewer 上行一份外观子集，relay 按到达顺序裁决（LWW），
            // rev+1 后回执发送端（prefs_saved，只给发送端对齐用）、广播其他声明了
            // prefs.sync 的 viewer（prefs_changed，发送端不收，防回声从通道层断掉）。
            // baseRev 只作信息：落后不拒绝（单用户冲突概率极低），发送端以回带 rev 为准。
            // 低-25：relay 侧按字段合并子集（客户端可只上行变化字段），baseRev 用于日志诊断。
            // Storm backstops (design-debt item C): a per-connection token
            // bucket below, plus the store's no-change short-circuit further
            // down — an unchanged subset still earns the sender its
            // prefs_saved receipt but no longer bumps rev, writes disk, or
            // broadcasts prefs_changed.
            const origId = frame.id ? String(frame.id) : null;
            if (!hasCap(socket, "prefs.sync")) {
              send(socket, errorFrame("unsupported", "此端未声明 prefs.sync 能力", { id: origId }), config);
              return;
            }
            if (!takePrefsSetToken(socket, Date.now())) {
              send(socket, errorFrame("rate_limited", "偏好同步太频繁，请稍后再试", { id: origId }), config);
              return;
            }
            const maxBytes = (PROTOCOL.limits && PROTOCOL.limits.prefsSubsetMaxBytes) || 2048;
            let rawBytes = 0;
            try { rawBytes = Buffer.byteLength(JSON.stringify(frame.subset ?? null)); } catch { rawBytes = maxBytes + 1; }
            if (rawBytes > maxBytes) {
              send(socket, errorFrame("payload_too_large", "偏好子集帧太大", { id: origId }), config);
              return;
            }
            const subset = cleanPrefsSubset(frame.subset);
            if (!subset) {
              send(socket, errorFrame("bad_args", "偏好子集不合法（只收 theme/chrome/font/size/mono + mobileNav）", { id: origId }), config);
              return;
            }
            const baseRev = Number.isSafeInteger(frame.baseRev) && frame.baseRev >= 0 ? frame.baseRev : null;
            const prefsRecord = prefsStore.set(viewerAccount(), subset, Date.now(), baseRev);
            send(socket, { type: "prefs_saved", rev: prefsRecord.rev, updatedAt: prefsRecord.updatedAt }, config);
            // changed:false means the subset was already current: the sender
            // still gets its receipt for rev alignment, but nobody else is
            // woken up for a value they already hold.
            if (prefsRecord.changed !== false) {
              broadcast([...rooms.viewers].filter((viewerConnection) => viewerConnection !== socket && hasCap(viewerConnection, "prefs.sync")), {
                type: "prefs_changed",
                subset: prefsRecord.subset,
                rev: prefsRecord.rev,
                updatedAt: prefsRecord.updatedAt,
              }, config);
            }
            break;
          }
          case "dialog_answer": {
            // O2 应答（先答广播）：relay 只做校验+转发+回执对号，裁决在桥（首达 resolve）。
            // dialog 不在缓存槽里（已关闭/从未接管）→ 直接 dialog_gone，不惊动桥。
            const room = rooms.touch(rooms.peek(String(frame.room || "")));
            const origId = frame.id ? String(frame.id) : null;
            if (!room) { send(socket, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), config); return; }
            // 应答面按 cap 门控（A-6）：未声明 dialog.respond 的（旧）端不许应答，按
            // "已关闭"回绝，不转发、不建 waiter。观察形态的 dialog 卡不受此限——
            // 补发/直播只剥 answerable 字段，卡片照常只读展示。
            if (!hasCap(socket, "dialog.respond")) {
              send(socket, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), config);
              return;
            }
            const dialogId = typeof frame.dialogId === "string" ? frame.dialogId.slice(0, 64) : "";
            const slot = dialogId && room.dialogs ? room.dialogs[dialogId] : null;
            if (!slot || slot.answerable !== true || !room.online || !room.local) {
              send(socket, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), config);
              return;
            }
            // 多选槽（G3）再加一道 cap：未声明 dialog.multiselect 的端从未拿到可答卡，
            // 其应答同样按"已关闭"回绝、不转发（与 A-6 的 respond 门控同姿势）。
            if (slot.kind === "multiselect" && !hasCap(socket, "dialog.multiselect")) {
              send(socket, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), config);
              return;
            }
            const action = frame.action === "allow" || frame.action === "submit" || frame.action === "deny" ? frame.action : null;
            if (!action) {
              send(socket, errorFrame("bad_args", "action 只能是 allow / submit / deny", { id: origId, room: room.id }), config);
              return;
            }
            // (b+) answer-form check (crypto.dialog, design 3.4): the answer
            // must follow the slot's form. A sealed slot takes only *Enc
            // fields -- any plaintext value/values/note present is bad_args
            // and nothing is forwarded. A plaintext slot rejects any *Enc
            // field the same way. Sealed fields are shape-checked only:
            // a bare ct string, or an {enc:1, ct} envelope, with the ct
            // capped like textEnc (dialogTextEncMax). The relay never
            // decrypts; the bridge adjudicates after opening.
            const encMax = (PROTOCOL.limits || {}).dialogTextEncMax || 12288;
            const cleanAnswerEnc = (answerValue) => {
              if (typeof answerValue === "string") return answerValue && answerValue.length <= encMax ? answerValue : null;
              if (answerValue && typeof answerValue === "object" && !Array.isArray(answerValue) && answerValue.enc === 1 && typeof answerValue.ct === "string" && answerValue.ct && answerValue.ct.length <= encMax) return { enc: 1, ct: answerValue.ct };
              return null;
            };
            const encGiven = {};
            let encPresent = false;
            let formBad = false;
            for (const field of ["valueEnc", "valuesEnc", "noteEnc"]) {
              if (frame[field] === undefined) continue;
              encPresent = true;
              const cleaned = cleanAnswerEnc(frame[field]);
              if (cleaned === null) formBad = true;
              else encGiven[field] = cleaned;
            }
            if (slot.sealed === true) {
              if (frame.value !== undefined || frame.values !== undefined || frame.note !== undefined) formBad = true;
            } else if (encPresent) {
              formBad = true;
            }
            if (formBad) {
              send(socket, errorFrame("bad_args", "应答形态与弹窗形态不一致", { id: origId, room: room.id }), config);
              return;
            }
            const answerFrame = { type: "dialog_answer", room: room.id, dialogId, action };
            // Plaintext free-text answers are length-clamped on forward,
            // like values/note already were (INVENTORY 7.3): the dialog
            // family's free-text cap is dialogTextMax.
            if (typeof frame.value === "string") answerFrame.value = frame.value.slice(0, (PROTOCOL.limits || {}).dialogTextMax || 500);
            if (encGiven.valueEnc !== undefined) answerFrame.valueEnc = encGiven.valueEnc;
            if (encGiven.valuesEnc !== undefined) answerFrame.valuesEnc = encGiven.valuesEnc;
            // 多选应答的 values 数组：按 limits 钳制后转发，逐项裁决（过滤伪造/去重/min-max）在桥
            if (Array.isArray(frame.values)) {
              const limits = PROTOCOL.limits || {};
              answerFrame.values = frame.values.slice(0, limits.dialogOptionsMax || 20).map((option) => String(option ?? "").slice(0, limits.dialogOptionChars || 80));
            }
            if (action === "deny" && typeof frame.note === "string" && frame.note.trim()) {
              answerFrame.note = frame.note.slice(0, (PROTOCOL.limits && PROTOCOL.limits.dialogNoteMax) || 500);
            }
            // (b+) a sealed deny reason forwards verbatim (shape already
            // checked above); the bridge passes it through to dialog_close.
            if (action === "deny" && encGiven.noteEnc !== undefined) {
              answerFrame.noteEnc = encGiven.noteEnc;
            }
            const aid = "ans-" + (++dialogAnswerSeq);
            answerFrame.aid = aid;
            const waiter = { ws: socket, origId, room, dialogId, local: room.local, timer: null };
            waiter.timer = setTimeout(() => {
              if (!rooms.dialogAnswerWaiters.delete(aid)) return;
              send(socket, errorFrame("timeout", "本机没有回应应答结果，请重试", { id: origId, room: room.id }), config);
            }, DIALOG_ANSWER_RESULT_TIMEOUT_MS);
            waiter.timer.unref();
            rooms.dialogAnswerWaiters.set(aid, waiter);
            if (!send(room.local, answerFrame, config)) {
              rooms.dialogAnswerWaiters.delete(aid);
              clearTimeout(waiter.timer);
              send(socket, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), config);
            }
            break;
          }
          case "abort": {
            const room = rooms.touch(rooms.peek(String(frame.room || "")));
            if (!room) {
              send(socket, ackFrame(frame.id, false, { error: "会话不存在", code: "no_room" }), config);
              return;
            }
            if (!forwardToLocal(socket, room, { type: "abort", room: room.id }, frame, {
              offline: "本机未连接，无法中断",
              backpressure: "本机消息通道积压，中断请求未能送出，请稍后重试",
            })) return;
            send(socket, ackFrame(frame.id, true, { room: room.id }), config);
            break;
          }
          case "pair_create": {
            // 生成配对码是管理员操作：adminToken/adminSig 都不过都在这里返回，不生成码
            if (rejectAdminAny(socket, frame)) break;
            // 配对码只在内存里、只能用一次；日志不打印码本身
            const origId = frame.id ? String(frame.id) : null;
            const now = Date.now();
            for (const [code, pairEntry] of relayContext.pairCodes) if (pairEntry.expiresAt <= now) relayContext.pairCodes.delete(code);
            if (relayContext.pairCodes.size >= PAIR_CODES_MAX) {
              send(socket, ackFrame(origId, false, { error: "未使用的配对码太多，等旧的过期后再生成", code: "rate_limited" }), config);
              return;
            }
            const code = newPairCode(relayContext.pairCodes);
            const name = typeof frame.name === "string" ? frame.name.trim().slice(0, MAX_DEVICE_NAME) : "";
            const expiresAt = now + (config.pairCodeTtlMs || PROTOCOL.limits.pairCodeTtlMs);
            relayContext.pairCodes.set(code, { accountId: normalizeAccount(config.accountId), name, expiresAt });
            log("生成配对码:", name || "-", "有效至", new Date(expiresAt).toISOString());
            send(socket, ackFrame(origId, true, { data: { code: formatPairCode(code), expiresAt } }), config);
            break;
          }
          case "pair_lookup": {
            // 二维码链接确认页拉待链接设备信息：只对 pending 条目（pair_request 申请、连接还活着的）
            // 回非秘密元数据；普通手输码、不存在、已过期的码一律失败，失败按来源计入配对限速记账。
            const origId = frame.id ? String(frame.id) : null;
            const now = Date.now();
            if (pairSourceBlocked(relayContext.pairFailures, source, now)) {
              send(socket, errorFrame("rate_limited", "配对尝试太频繁，请一分钟后再试", { id: origId }), config);
              return;
            }
            const code = normalizePairCode(frame.code);
            const entry = code ? relayContext.pairCodes.get(code) : null;
            const expired = !!entry && entry.expiresAt <= now;
            if (!entry || !entry.pending || expired) {
              notePairFailure(relayContext.pairFailures, source, now);
              if (expired) relayContext.pairCodes.delete(code);
              log("pair_lookup 失败:", source, expired ? "配对码过期" : "配对码无效或不是待链接码");
              send(socket, errorFrame(expired ? "pair_expired" : "pair_invalid", undefined, { id: origId }), config);
              return;
            }
            // 带钥申请的核对字是 SAS v2（绑握手记录，§3.2），并多带 keyFp 供确认页人工核对
            // 「将要批准的设备钥指纹」（§7）；未带钥的旧申请仍是 v1 核对字、无 keyFp，逐字节不变。
            const pendingKeys = entry.pending.keys || null;
            const found = {
              type: "pair_lookup_result",
              name: entry.pending.device.name,
              platform: entry.pending.device.platform,
              expiresAt: entry.expiresAt,
              checkDigits: pendingKeys ? pairCheckDigitsV2(code, pendingKeys.signPub, pendingKeys.boxPub) : pairCheckDigits(code),
            };
            if (pendingKeys) found.keyFp = keyFingerprint(pendingKeys.signPub);
            // boxPub rides along so the approving web end can wrap the account content
            // key to the pending device (contentKeyGrant on pair_approve, design 3.2);
            // it is public key material and the SAS v2 check digits already bind it.
            if (pendingKeys) found.boxPub = pendingKeys.boxPub;
            if (origId) found.id = origId;
            send(socket, found, config);
            // 通知等待端「码已被扫/被查」：窗口切处理中態。只发一次（重复 lookup 不重发），
            // 等待端不依赖这帧完成主链路（pair_result 才是结果），发不出去也不影响批准流程。
            if (!entry.pending.claimed && entry.pending.ws && entry.pending.ws.readyState === 1) {
              entry.pending.claimed = true;
              try { send(entry.pending.ws, { type: "pair_claimed" }, config); } catch {}
            }
            break;
          }
          case "pair_approve": {
            // 手机端批准二维码链接：先过管理员门（与 pair_create 同门），再走 local 侧的共用签发段，
            // 结果沿 pending 的等待连接回 pair_result；本端只回 ack，不经手设备令牌明文之外的东西。
            if (rejectAdminAny(socket, frame)) break;
            const origId = frame.id ? String(frame.id) : null;
            const now = Date.now();
            if (pairSourceBlocked(relayContext.pairFailures, source, now)) {
              send(socket, ackFrame(origId, false, { error: "配对尝试太频繁，请一分钟后再试", code: "rate_limited" }), config);
              return;
            }
            const code = normalizePairCode(frame.code);
            const entry = code ? relayContext.pairCodes.get(code) : null;
            const expired = !!entry && entry.expiresAt <= now;
            if (!entry || !entry.pending || expired) {
              notePairFailure(relayContext.pairFailures, source, now);
              if (expired) relayContext.pairCodes.delete(code);
              log("pair_approve 失败:", source, expired ? "配对码过期" : "配对码无效或不是待链接码");
              send(socket, ackFrame(origId, false, { code: expired ? "pair_expired" : "pair_invalid" }), config);
              return;
            }
            const pendingWs = entry.pending.ws;
            if (!pendingWs || pendingWs.readyState !== 1) {
              // 等待端已经断开（其 close 处理通常已删码，这里兜底）：删码并告知批准端重跑 attach --link
              relayContext.pairCodes.delete(code);
              log("pair_approve 失败：等待连接已断开");
              send(socket, ackFrame(origId, false, { error: "设备等待连接已断开，请在设备上重新运行 attach --link", code: "offline" }), config);
              return;
            }
            if (typeof relayContext.issuePairEntry !== "function") {
              send(socket, ackFrame(origId, false, { error: "relay 内部未就绪", code: "server_error" }), config);
              return;
            }
            const issuedPair = relayContext.issuePairEntry({ code, entry, cleaned: entry.pending.device, presentedToken: entry.pending.deviceToken, exceptWs: pendingWs, keys: entry.pending.keys || undefined });
            if (!issuedPair.ok) {
              // 签发被拒（如重新配对旧令牌不达标）：等待端同步收到失败，别让它干等到过期；
              // 本次申请到此为止，删码关连接，设备想再试要重新 attach --link。
              send(pendingWs, { type: "pair_result", ok: false, code: issuedPair.code, error: issuedPair.error }, config);
              try { pendingWs.close(1000, "pair done"); } catch {}
              relayContext.pairCodes.delete(code);
              send(socket, ackFrame(origId, false, { error: issuedPair.error, code: issuedPair.code }), config);
              return;
            }
            if (issuedPair.keyRegistered) {
              // 钥设备：不经手令牌（根本没签发）；批准端算好的 ACK 包裹（contentKeyGrant）
              // 只做形状清洗后原样透传进 pair_result，不解析、不落盘（设计 §3.2/§7）。
              // 本阶段观看端尚无钥（阶段 2 才有发送方），字段多半缺席，清洗别挡正常批准的路。
              const pairResult = { type: "pair_result", ok: true, accountId: issuedPair.accountId, deviceId: issuedPair.deviceId, keyRegistered: true, hasKeyHolder: !!issuedPair.hasKeyHolder };
              const grant = frame.contentKeyGrant != null && typeof relayContext.cleanKeyGrant === "function" ? relayContext.cleanKeyGrant(frame.contentKeyGrant) : null;
              if (grant) pairResult.contentKeyGrant = grant;
              else if (frame.contentKeyGrant != null) log("pair_approve 的 contentKeyGrant 形状不合规，已忽略（批准照常）");
              send(pendingWs, pairResult, config);
            } else {
              send(pendingWs, { type: "pair_result", ok: true, accountId: issuedPair.accountId, deviceId: issuedPair.deviceId, deviceToken: issuedPair.deviceToken }, config);
            }
            try { pendingWs.close(1000, "pair done"); } catch {}
            log("二维码链接批准完成:", issuedPair.accountId, issuedPair.deviceId);
            send(socket, ackFrame(origId, true, { deviceId: issuedPair.deviceId, data: { deviceId: issuedPair.deviceId, name: entry.pending.device.name } }), config);
            break;
          }
          case "device_revoke": {
            // 撤销设备是管理员操作：先过管理员门（adminToken/adminSig），未通过时连设备是否存在都不查、不撤令牌、不断连接
            if (rejectAdminAny(socket, frame)) break;
            const origId = frame.id ? String(frame.id) : null;
            const deviceId = typeof frame.deviceId === "string" ? frame.deviceId.trim() : "";
            if (!deviceId) {
              send(socket, ackFrame(origId, false, { error: "缺少 deviceId", code: "bad_args" }), config);
              return;
            }
            const accountId = boundAccount(index, devices, deviceId, config.accountId);
            let revoked = 0;
            try {
              const known = devices.has(deviceId) || !!index.getDeviceRow(accountId, deviceId) || index.hasDeviceToken(accountId, deviceId);
              if (!known) {
                send(socket, ackFrame(origId, false, { error: DEVICE_ERRORS.no_device, code: "no_device", deviceId }), config);
                return;
              }
              revoked = index.revokeDeviceTokens(accountId, deviceId);
              // 设备身份钥一并作废（设计 §3.5）：keys.sign 写 revokedAt，此后该 deviceId 的
              // 挑战鉴权一律 device_revoked；设备要回来只能重新配对生成新钥（旧指纹转 prevKeyFps）。
              const row = index.getDeviceRow(accountId, deviceId);
              if (row && row.keys && row.keys.sign && typeof row.keys.sign.pub === "string" && row.keys.sign.pub && !row.keys.sign.revokedAt) {
                index.upsertDevice(accountId, {
                  id: deviceId,
                  keys: { ...row.keys, sign: { ...row.keys.sign, revokedAt: Date.now() } },
                });
              }
            } catch (revokeError) {
              log("撤销设备令牌失败:", deviceId, revokeError.message);
              send(socket, ackFrame(origId, false, { error: "撤销失败：令牌文件写不进去", code: "server_error", deviceId }), config);
              return;
            }
            const closed = relayContext.dropDevice(deviceId);
            log("撤销设备:", accountId, deviceId, "作废令牌", revoked, "断开连接", closed);
            send(socket, ackFrame(origId, true, { deviceId, data: { revoked, closed } }), config);
            rooms.broadcastRoomList();
            break;
          }
          case "viewer_register": {
            // Viewer identity registration (crypto Phase 2, design §3.2 / §7): first
            // registration is an admin operation on the dual-track gate. Keys may ride
            // at the frame top level or nested under `keys`. The roster row written
            // here is the only authority for key auth and grant stamping afterwards.
            if (rejectAdminAny(socket, frame)) break;
            const origId = frame.id ? String(frame.id) : null;
            const viewerId = typeof frame.viewerId === "string" ? frame.viewerId.trim() : "";
            if (!viewerId || !safeId(viewerId)) {
              send(socket, ackFrame(origId, false, { error: "viewerId 不合规", code: "bad_args" }), config);
              return;
            }
            const pubs = cleanViewerPubKeys(frame.keys && typeof frame.keys === "object" ? frame.keys : frame);
            if (!pubs) {
              send(socket, ackFrame(origId, false, { error: "公钥不合规：signPub/boxPub 都必须是 P-256 spki 公钥（base64）", code: "bad_args" }), config);
              return;
            }
            const existingViewer = viewerRowSafe(viewerId);
            if (existingViewer && !existingViewer.revokedAt && (existingViewer.signPub !== pubs.signPub || existingViewer.boxPub !== pubs.boxPub)) {
              // Re-keying an active viewerId in place would silently swap identities;
              // the only path is revoke-then-register with fresh keys.
              send(socket, ackFrame(origId, false, { error: "该 viewerId 已登记其他公钥；换钥请先撤销旧登记再重新登记", code: "device_mismatch" }), config);
              return;
            }
            if (existingViewer && existingViewer.revokedAt && existingViewer.signPub === pubs.signPub) {
              // A revoked signing key stays dead even if the same viewerId returns.
              send(socket, ackFrame(origId, false, { error: "这把签名公钥已被撤销，请生成新钥后重新登记", code: "device_revoked" }), config);
              return;
            }
            const row = { viewerId, signPub: pubs.signPub, boxPub: pubs.boxPub };
            const name = typeof frame.name === "string" ? frame.name.trim().slice(0, MAX_DEVICE_NAME) : "";
            if (name) row.name = name;
            if (typeof frame.admin === "boolean") row.admin = frame.admin;
            else if (!existingViewer) row.admin = false;
            // Re-registration after a revoke (necessarily with new keys, per the check
            // above) clears the revocation.
            if (existingViewer && existingViewer.revokedAt) row.revokedAt = null;
            try {
              index.upsertViewer(viewerAccount(), row);
            } catch (registerError) {
              log("观看端登记失败:", viewerId, registerError.message);
              send(socket, ackFrame(origId, false, { error: "登记失败：名册文件写不进去", code: "server_error" }), config);
              return;
            }
            const saved = viewerRowSafe(viewerId);
            log("登记观看端身份钥:", viewerId, "指纹", keyFingerprint(pubs.signPub), saved && saved.admin ? "(admin)" : "");
            send(socket, ackFrame(origId, true, { data: { viewerId, keyFp: keyFingerprint(pubs.signPub), admin: !!(saved && saved.admin) } }), config);
            break;
          }
          case "list_viewers": {
            // Viewer roster listing (crypto Phase 2, design §7): admin-gated. Rows
            // expose no key material beyond the fingerprint, plus live online state.
            if (rejectAdminAny(socket, frame)) break;
            const origId = frame.id ? String(frame.id) : null;
            const online = new Set(viewerKeyEndpoints(viewerAccount()).map((endpoint) => endpoint.viewerId));
            let rows = [];
            try {
              rows = index.listViewers(viewerAccount());
            } catch {
              rows = [];
            }
            const viewerListFrame = {
              type: "viewer_list",
              viewers: rows.map((viewerRow) => ({
                viewerId: viewerRow.viewerId,
                name: typeof viewerRow.name === "string" ? viewerRow.name : "",
                keyFp: viewerRow.signPub ? keyFingerprint(viewerRow.signPub) : null,
                admin: viewerRow.admin === true,
                createdAt: Number(viewerRow.createdAt) || 0,
                revokedAt: viewerRow.revokedAt || null,
                online: online.has(viewerRow.viewerId),
              })),
            };
            if (origId) viewerListFrame.id = origId;
            send(socket, viewerListFrame, config);
            break;
          }
          case "viewer_revoke": {
            // Revoke a viewer identity (crypto Phase 2, design §3.5): admin-gated.
            // Writes revokedAt and drops that viewer's live connections. The ack must
            // carry the rotation hint: revocation closes the access layer only — the
            // revoked viewer still holds its ACK copy, so cryptographic removal
            // requires rotating the ACK and re-distributing it to the kept ends.
            if (rejectAdminAny(socket, frame)) break;
            const origId = frame.id ? String(frame.id) : null;
            const viewerId = typeof frame.viewerId === "string" ? frame.viewerId.trim() : "";
            if (!viewerId) {
              send(socket, ackFrame(origId, false, { error: "缺少 viewerId", code: "bad_args" }), config);
              return;
            }
            if (!viewerRowSafe(viewerId)) {
              send(socket, ackFrame(origId, false, { error: "观看端不存在", code: "not_found", viewerId }), config);
              return;
            }
            try {
              index.upsertViewer(viewerAccount(), { viewerId, revokedAt: Date.now() });
            } catch (revokeError) {
              log("撤销观看端失败:", viewerId, revokeError.message);
              send(socket, ackFrame(origId, false, { error: "撤销失败：名册文件写不进去", code: "server_error", viewerId }), config);
              return;
            }
            ackTrackerOf(relayContext).forget(viewerAccount(), "viewer:" + viewerId);
            let closed = 0;
            for (const viewerConnection of [...rooms.viewers]) {
              const state = viewerConnection._state;
              if (!state || state.viewerId !== viewerId) continue;
              send(viewerConnection, errorFrame("device_revoked"), config);
              try { viewerConnection.close(4003, "viewer revoked"); } catch {}
              closed++;
            }
            log("撤销观看端:", viewerId, "断开连接", closed);
            send(socket, ackFrame(origId, true, {
              viewerId,
              data: {
                viewerId,
                closed,
                ackRotationRequired: true,
                hint: "撤销只关掉接入层：这台观看端仍留有本账号内容钥（ACK）的副本，密码学上并未移除。要彻底移除，必须轮换 ACK——让任一在线持钥端生成新 ACK 并重新分发给保留的端，被撤销的端不要再收到新钥。",
              },
            }), config);
            break;
          }
          case "content_key_request": {
            // Content-key delivery request from a keyed viewer (crypto Phase 2,
            // design §7): the sender must be key-authed with an active roster row.
            // The relay stamps `from`/`fromBoxPub` from the roster (never from the
            // frame) and forwards to every other keyed end of the account.
            if (state.auth !== "key" || !state.viewerId) {
              send(socket, errorFrame("device_mismatch", "只有完成密钥登录的观看端能请求内容钥交付"), config);
              return;
            }
            const row = viewerRowSafe(state.viewerId);
            if (!row || row.revokedAt || !row.signPub || !row.boxPub) {
              send(socket, errorFrame("device_mismatch", "观看端名册钥不可用，不能请求内容钥交付"), config);
              return;
            }
            const accountId = viewerAccount();
            const requestFrame = { type: "content_key_request", from: keyFingerprint(row.signPub), fromBoxPub: row.boxPub, accountId };
            let delivered = 0;
            if (typeof relayContext.localKeyEndpoints === "function") {
              for (const endpoint of relayContext.localKeyEndpoints(accountId)) {
                if (send(endpoint.ws, requestFrame, config)) delivered++;
              }
            }
            for (const endpoint of viewerKeyEndpoints(accountId)) {
              if (endpoint.ws === socket) continue;
              if (send(endpoint.ws, requestFrame, config)) delivered++;
            }
            if (!delivered) {
              send(socket, errorFrame("offline", "本账号当前没有其他在线的持钥端，内容钥交付要等持钥设备上线后再请求"), config);
            }
            break;
          }
          case "content_key_grant": {
            // Content-key delivery from a keyed viewer (crypto Phase 2, design §7):
            // shape-cleaned by the shared cleaner, stamped from the roster (a
            // sender-supplied from/fromBoxPub inside the blob is never trusted), then
            // routed by target fingerprint to devices and viewers alike.
            if (state.auth !== "key" || !state.viewerId) {
              send(socket, errorFrame("device_mismatch", "只有完成密钥登录的观看端能发送内容钥交付"), config);
              return;
            }
            if (typeof relayContext.cleanKeyGrant !== "function" || typeof relayContext.routeContentKeyGrant !== "function") {
              send(socket, errorFrame("server_error", "relay 内部未就绪"), config);
              return;
            }
            const grant = relayContext.cleanKeyGrant(frame);
            if (!grant) {
              send(socket, errorFrame("bad_args", "content_key_grant 字段不合规（需要 to 指纹、nonce 与 ct 包裹）"), config);
              return;
            }
            const row = viewerRowSafe(state.viewerId);
            if (!row || row.revokedAt || !row.signPub || !row.boxPub) {
              send(socket, errorFrame("device_mismatch", "观看端名册钥不可用，不能发送内容钥交付"), config);
              return;
            }
            const grantFrame = { type: "content_key_grant", ...grant, from: keyFingerprint(row.signPub), fromBoxPub: row.boxPub };
            if (!relayContext.routeContentKeyGrant(viewerAccount(), grant.to, grantFrame)) {
              send(socket, errorFrame("offline", "目标端不在线，内容钥未能送达（relay 不缓存交付，请待其上线后重发）"), config);
            }
            break;
          }
          case "ack_report": {
            // ackFp reconciliation (design §3.5 / §7): same contract as the local
            // channel — fingerprints only, never the key itself.
            if (state.auth !== "key" || !state.viewerId) return;
            if (!isAckFp(frame.ackFp)) {
              send(socket, errorFrame("bad_args", "ackFp 必须是 16 位小写十六进制指纹"), config);
              return;
            }
            ackTrackerOf(relayContext).report(viewerAccount(), "viewer:" + state.viewerId, frame.ackFp, (reportFrame) => send(socket, reportFrame, config));
            break;
          }
          case "ping":
            send(socket, { type: "pong" }, config);
            break;
          default:
            send(socket, errorFrame("unknown_type", `未知消息类型：${frame.type}`, { id: typeof frame.id === "string" ? frame.id : undefined }), config);
        }
      },
    });

    socket.on("close", () => {
      // A disconnected keyed viewer no longer counts in ackFp reconciliation.
      const state = socket._state;
      if (state && state.authed && state.auth === "key" && state.viewerId) {
        try { ackTrackerOf(relayContext).forget(viewerAccount(), "viewer:" + state.viewerId); } catch {}
      }
      const wasViewer = rooms.viewers.delete(socket);
      const room = socket._room;
      if (room) {
        room.viewers.delete(socket);
        pushDialogGate(room, config);
        if (room.resendWaiters) room.resendWaiters = room.resendWaiters.filter((waiter) => waiter !== socket);
      }
      // O2 应答回执：这条连接在等的回执随它一起作废（桥的迟到回执到时 waiter 已不存在，自然丢弃）
      for (const [aid, waiter] of rooms.dialogAnswerWaiters) {
        if (waiter.ws !== socket) continue;
        rooms.dialogAnswerWaiters.delete(aid);
        if (waiter.timer) clearTimeout(waiter.timer);
      }
      for (const [queryId, query] of rooms.viewerQueries) {
        if (query.ws !== socket) continue;
        clearTimeout(query.timer);
        rooms.viewerQueries.delete(queryId);
      }
      // 该连接在等的命令：摘掉它的 waiter（命令本身照常执行完，结果留在去重表里供重连后重发取回）
      // harness_start 即使没人等也留到结果或超时，避免串行锁被提前放开后又起一份
      for (const entry of rooms.commandWaiters.values()) {
        const before = entry.waiters.length;
        entry.waiters = entry.waiters.filter((waiter) => {
          if (waiter.ws !== socket) return true;
          // harness_start 的定时器必须留着：查看端断开不能把唯一的超时清掉，否则 startInFlight 永远不放开
          if (entry.command === "harness_start" && !entry._settled) return true;
          finishWaiter(waiter);
          return false;
        });
        if (!before || entry.waiters.length) continue;
        if (entry.command === "harness_start" && !entry._settled) continue;
        if (entry.key || entry.done) continue;
        // 无 key 的在飞命令：本机还在跑，entry 必须留到结果到达（否则 onResult 钩子随 entry 一起丢，
        // 删除会话的服务器副本清理永远不执行，被删会话重启后复活——报告 relay 中-16）。
        armOrphanCleanup(entry, rooms);
      }
      if (wasViewer || room) rooms.broadcastRoomList();
    });
  });

  // 心跳定时器挂到 wss 上：close() 要清掉，否则每次测试/重启都漏一个 30s interval
  wss._keepalive = keepalive(wss);
  return { server, wss };
}

module.exports = { startViewerServer };
