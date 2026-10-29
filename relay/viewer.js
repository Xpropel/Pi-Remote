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
const { MAX_DEVICE_NAME, UNREGISTERED_DEVICE, normPath, cwdAllowed, underRoots, boundAccount } = require("./devices");
const { replaySessionArchives } = require("./sessionArchive");
const { purgeSessions } = require("./purge");
const { resendFallbackBody, queryKey, sendCachedAssistant, sendCachedAutoRetry, sendCachedUiPrompt, sendCachedDialogs, sendCachedExtStatus, sendCachedCompaction, sendCachedTools, sendCachedToolEnds, sendCachedTaskList, sendCachedAgentState, sendCachedRemoteQueue, pushDialogGate, clearRoomTurnEnd, broadcastRoomAttention, devicesViewFor } = require("./rooms");
const { makeServeWeb, healthBody } = require("./web");

// 认证失败记账的来源数上限（只在内存里）。满了挤掉最久没有活动的来源；正常部署远到不了这个数。
const AUTH_FAIL_SOURCES_MAX = 1000;

/** O2 应答回执等待上限：桥正常都即时回 dialog_answer_result；超过这个数按 timeout 结案，不让答题端干挂。 */
const DIALOG_ANSWER_RESULT_TIMEOUT_MS = 15000;

/** G2 审批门档位（与桥侧 APPROVAL_GATE_TIERS 同值）：relay 只转发合法档位，非法值不带（桥保持当前值）。 */
const APPROVAL_GATE_TIERS = ["high-risk", "all-non-readonly", "list"];

const ADMIN_REQUIRED = "admin_required";
const ADMIN_REQUIRED_TEXT = "需要管理员令牌";

/**
 * 管理命令（pair_create / device_revoke）的独立口令校验。
 * 未配置 adminToken 时一律拒绝；配置了才做常量时间比较。错误响应和日志都不透露“是否已配置”。
 */
function adminAuthorized(cfg, msg) {
  if (!cfg || !cfg.adminToken) return false;
  const supplied = typeof msg.adminToken === "string" ? msg.adminToken : "";
  return !!supplied && safeEqual(supplied, cfg.adminToken);
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
  const i = stem.lastIndexOf("_");
  const id = i >= 0 ? stem.slice(i + 1) : stem;
  return /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : null;
}

/** 订阅成功后，把房间上已缓存的待发队列只补给这一条连接。
 *  没有缓存不编造空队列。序列化后超过 maxPayloadBytes 就记一行日志并跳过，不断开。不带 seq / rev。 */
function sendCachedQueue(ws, room, cfg) {
  // 离线房间不补发旧队列：与 sendCachedUiPrompt/sendCachedTaskList 对齐，晚来的观众只看当前会话状态。
  if (!room || !room.online || !room.queue) return;
  const event = { type: "queue_update" };
  const cached = room.queue;
  if (Object.prototype.hasOwnProperty.call(cached, "steering")) event.steering = cached.steering;
  if (Object.prototype.hasOwnProperty.call(cached, "followUp")) event.followUp = cached.followUp;
  // 缓存时间戳与 taskList 对齐：前端可据此判断这份队列是哪个时刻的快照。
  if (typeof cached.at === "number" && Number.isFinite(cached.at)) event.at = cached.at;
  const frame = JSON.stringify({ type: "room_event", room: room.id, event });
  const limit = (cfg && cfg.maxPayloadBytes) || 256 * 1024;
  if (Buffer.byteLength(frame) > limit) {
    log("待发队列补发超过 maxPayloadBytes，跳过:", room.id, Buffer.byteLength(frame));
    return;
  }
  send(ws, frame, cfg);
}

/* ---------------- viewer 通道（7002）：页面 + WebSocket ---------------- */
function startViewerServer(cfg, rooms, store, ctx, onListening, onError) {
  const index = ctx.index;
  const devices = ctx.devices;
  // 主题偏好同步（R4-1）：per-account 托管存储，与名册同根落盘（index.dir = data/accounts）
  const prefsStore = new PrefsStore(index.dir);
  // viewer 通道只有一个账号口径（握手令牌即账号），客户端上报的 accountId 不作数
  const viewerAccount = () => normalizeAccount(cfg.accountId);

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
    for (const c of rooms.viewers) {
      const s = c._state;
      if (!s || !s.authed || s.auth !== "key" || !s.viewerId || c.readyState !== 1) continue;
      const row = viewerRowSafe(s.viewerId);
      if (!row || row.revokedAt || !row.signPub || !row.boxPub) continue;
      out.push({ ws: c, viewerId: s.viewerId, keyFp: keyFingerprint(row.signPub), boxPub: row.boxPub });
    }
    return out;
  };
  // The local channel consults this provider when routing content_key_grant frames
  // and when broadcasting content_key_request frames to every keyed end.
  ctx.viewerKeyEndpoints = viewerKeyEndpoints;

  /**
   * adminSig track (design §7): instead of the adminToken, a registered, admin-flagged,
   * non-revoked viewer signs the management frame with its VIK. The signed payload is
   * pinned in pairing.adminPayload and documented in protocol/v4.json (crypto.auth).
   * A connection already bound to a viewerId may only sign as that viewer.
   */
  const adminSigAuthorized = (ws, msg) => {
    if (typeof msg.adminSig !== "string" || !msg.adminSig) return false;
    // The signer is named by the dedicated adminBy field, falling back to the
    // connection's bound viewerId. msg.viewerId is never the signer: on
    // viewer_revoke it names the revocation target instead.
    const bound = ws._state && ws._state.viewerId ? ws._state.viewerId : "";
    const claimed = typeof msg.adminBy === "string" ? msg.adminBy.trim() : "";
    const signerId = claimed || bound;
    if (!signerId || (bound && signerId !== bound)) return false;
    const row = viewerRowSafe(signerId);
    if (!row || row.admin !== true || row.revokedAt || !row.signPub) return false;
    return verifyP256(row.signPub, adminPayload(msg), msg.adminSig);
  };

  /** Dual-track admin gate for management frames: adminToken OR adminSig. On failure
   *  the ack shape and code are exactly the token track's (admin_required). */
  const rejectAdminAny = (ws, msg) => {
    if (adminAuthorized(cfg, msg) || adminSigAuthorized(ws, msg)) return false;
    const origId = msg.id ? String(msg.id) : null;
    log("管理员命令被拒（adminToken/adminSig 均未通过）:", msg.type);
    send(ws, ackFrame(origId, false, { error: ADMIN_REQUIRED_TEXT, code: ADMIN_REQUIRED }), cfg);
    return true;
  };
  // 配置层已检查过同一份 cfg 时不重复告警；直接 startRelay 的调用方在这里补上。
  warnAdminTokenSeparation(cfg);
  const serveWeb = makeServeWeb(cfg.webRoot || path.join(ROOT, "web"));
  // /healthz 不要 token（部署脚本回环验证、监控用），其余路径照旧是静态页面
  const server = http.createServer((req, res) => {
    if (req.method === "GET" || req.method === "HEAD") {
      let pathname = "";
      try {
        pathname = new URL(req.url, "http://127.0.0.1").pathname;
      } catch {}
      if (pathname === "/healthz") {
        const body = JSON.stringify(healthBody(rooms, ctx.startedAt, cfg.serverName));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
    }
    serveWeb(req, res);
  });
  const deflate = cfg.perMessageDeflate
    ? {
        threshold: 1024,
        zlibDeflateOptions: { level: 1, memLevel: 7 },
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        concurrencyLimit: 8,
      }
    : false;
  const wss = new WebSocketServer({ server, maxPayload: cfg.maxPayloadBytes, perMessageDeflate: deflate });
  // 启动失败（端口占用等）交给 startRelay 统一 reject；无 onError 的调用方保持旧行为。
  server.on("error", (e) => {
    console.error("[relay] viewer 通道失败:", e.message);
    if (typeof onError === "function") onError(e);
    else if (cfg.exitOnListenError !== false) process.exit(1);
  });
  wss.on("error", (e) => {
    console.error("[relay] viewer ws 失败:", e.message);
    if (typeof onError === "function") onError(e);
    else if (cfg.exitOnListenError !== false) process.exit(1);
  });
  server.listen({ port: cfg.viewerPort, host: cfg.viewerHost || "0.0.0.0" }, () => {
    log(`viewer 通道监听 :${server.address().port}`);
    if (onListening) onListening(server.address().port);
  });

  const fullSnapshotBody = (room) =>
    rooms.snapshotBody(room.id, () => snapshotBodyFrom(store.snapshot(room.id, { limit: cfg.maxSnapshotRecords, maxBytes: cfg.maxSnapshotBytes })));

  /** O2 应答回执对号序号（进程内单调递增即可，aid 只在 relay 内存里活一小会儿） */
  let dialogAnswerSeq = 0;

  /* ---------------- viewer 认证防护（按来源） ----------------
   * 7002 的 token 写在页面里，在线爆破只需要反复建连。失败按来源记，短时锁定；
   * 成功认证立刻清掉该来源的失败记录，所以正常断线重连（哪怕之前重试错过）不会被误锁。
   * 来源规则复用 pairing.requestSource：对端是回环才信 XFF，且取最后一跳。 */
  const authFailMax = positiveInt(cfg.viewerAuthFailMax, DEFAULT_CONFIG.viewerAuthFailMax);
  const authFailWindowMs = positiveInt(cfg.viewerAuthFailWindowMs, DEFAULT_CONFIG.viewerAuthFailWindowMs);
  const authLockMs = positiveInt(cfg.viewerAuthLockMs, DEFAULT_CONFIG.viewerAuthLockMs);
  const maxUnauthenticated = positiveInt(cfg.maxUnauthenticatedViewers, DEFAULT_CONFIG.maxUnauthenticatedViewers);
  const authFailures = new Map(); // source -> { times: number[], lockedUntil, lastLog, lastLockLog }
  let unauthenticated = 0;
  let lastCapLog = 0;

  /** 锁定剩余毫秒；锁已过期就把整条记录删掉，让来源重新获得完整失败额度。 */
  function authLockLeft(source) {
    const e = authFailures.get(source);
    if (!e || !e.lockedUntil) return 0;
    const left = e.lockedUntil - Date.now();
    if (left > 0) return left;
    authFailures.delete(source);
    return 0;
  }

  function noteAuthFailure(source) {
    const now = Date.now();
    let e = authFailures.get(source);
    if (!e) e = { times: [], lockedUntil: 0, lastLog: 0, lastLockLog: 0 };
    else authFailures.delete(source); // 重新插到 Map 末尾 = 最近有活动的来源最后被挤掉
    e.times = e.times.filter((t) => t > now - authFailWindowMs);
    e.times.push(now);
    if (e.times.length >= authFailMax) {
      e.times = [];
      e.lockedUntil = now + authLockMs;
      log("viewer 认证失败次数超限，按来源锁定:", source, "时长(ms):", authLockMs);
    } else if (!e.lastLog || now - e.lastLog > 5000) {
      e.lastLog = now;
      log("viewer 认证失败:", source, "窗口内第", e.times.length, "次");
    }
    authFailures.set(source, e);
    while (authFailures.size > AUTH_FAIL_SOURCES_MAX) authFailures.delete(authFailures.keys().next().value);
  }

  function noteAuthSuccess(source) {
    authFailures.delete(source);
  }

  function noteLockedReject(source, left) {
    const now = Date.now();
    const e = authFailures.get(source);
    if (!e) return;
    if (e.lastLockLog && now - e.lastLockLog <= 5000) return;
    e.lastLockLog = now;
    log("viewer 认证来源仍在锁定中，拒绝连接:", source, "剩余(ms):", left);
  }

  /**
   * 转发一条没有 command 结果通道的帧（message / abort）。send() 返回 false 表示对端已断开，
   * 或本机通道积压到硬顶（wire.send 会 terminate）。这两种情况都不能回 ok：
   * 离线回 room_offline、积压回 busy（都在码表里且可重试），详细原因只进日志。
   * @returns {boolean} true 表示已交给本机，调用方才回成功 ack。
   */
  function forwardToLocal(ws, room, frame, msg, failText) {
    const local = room.local;
    if (!local || local.readyState !== 1) {
      send(ws, ackFrame(msg.id, false, { room: room.id, error: failText.offline, code: "room_offline" }), cfg);
      return false;
    }
    const max = (cfg && cfg.viewerMaxBufferBytes) || DEFAULT_CONFIG.viewerMaxBufferBytes;
    const backlogged = Number(local.bufferedAmount) > max;
    if (send(local, frame, cfg)) return true;
    // 失败时 readyState 可能已被 wire.send 或对端改变：自己积压到硬顶算 busy，连接确实断了才算离线。
    const offline = local.readyState !== 1;
    const reason = offline && !backlogged ? "peer_offline" : "peer_backpressure";
    log(reason === "peer_offline" ? "本机通道已断开，未转发:" : "本机通道积压，未转发:", room.id, frame.type);
    if (reason === "peer_offline") {
      send(ws, ackFrame(msg.id, false, { room: room.id, error: failText.offline, code: "room_offline" }), cfg);
    } else {
      send(ws, ackFrame(msg.id, false, { room: room.id, error: failText.backpressure, code: "busy" }), cfg);
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
    const ms = Math.max(1000, Number(entry.timeoutMs) || 0) + COMMAND_RECONCILE_GRACE_MS;
    entry._orphanTimer = setTimeout(() => {
      entry._orphanTimer = null;
      if (entry.done) return;
      log("命令无等待者且对账窗口结束，清理:", entry.room && entry.room.id, entry.wireId, entry.command);
      settleEntry(entry);
      rooms.commandWaiters.delete(entry.wireId);
      if (entry.key && rooms.dedupe.get(entry.key) === entry) rooms.dedupe.delete(entry.key);
    }, ms);
    if (entry._orphanTimer.unref) entry._orphanTimer.unref();
  }

  /** 把一条 viewer 命令交给指定 local。room 可以是真实房间，也可以是 harness 用的 {id:""} 占位。 */
  function runCommand(ws, msg, room, local, extra = {}) {
    const origId = msg.id ? String(msg.id) : null;
    const cmdName = String(msg.command || "");
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    const timeoutMs = extra.timeoutMs || commandTimeoutMs(cmdName, args, cfg.harnessStartTimeoutMs);
    const scope = extra.dedupeScope || (room && room.id) || "";
    const dk = typeof msg.dedupeKey === "string" && msg.dedupeKey && msg.dedupeKey.length <= 128
      ? dedupeKeyOf(scope, cmdName, args, msg.dedupeKey)
      : null;
    const ackExtra = { room: room && room.id, deviceId: extra.deviceId };
    if (MESSAGE_COMMANDS.has(cmdName) && args.cid != null && !cleanCid(args.cid)) {
      send(ws, ackFrame(origId, false, { ...ackExtra, error: "cid 不合法", code: "bad_args" }), cfg);
      return;
    }
    if (dk) {
      pruneDedupe(rooms, cfg);
      const prev = rooms.dedupe.get(dk);
      if (prev) {
        if (prev.done) {
          log("命令重发命中去重表，回放结果:", scope, prev.wireId, cmdName);
          send(ws, ackFrame(origId, prev.result.ok, {
            ...ackExtra,
            dedup: true,
            ...(prev.result.ok ? { data: prev.result.data } : { error: prev.result.error, code: prev.result.code }),
          }), cfg);
          return;
        }
        log("命令重发命中在飞请求，合并等待:", scope, prev.wireId, cmdName);
        const w = { ws, origId, timer: null };
        prev.waiters.push(w);
        armWaiter(rooms, prev, w, cfg);
        send(ws, { type: "command_accepted", id: origId, room: room && room.id ? room.id : undefined, deviceId: extra.deviceId, timeoutMs: prev.timeoutMs, dedup: true }, cfg);
        return;
      }
    }
    if (!local || local.readyState !== 1) {
      send(ws, ackFrame(origId, false, { ...ackExtra, error: "本机未连接，无法执行", code: extra.offlineCode || "room_offline" }), cfg);
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
      key: dk,
      deviceId: extra.deviceId,
      onSettle: extra.onSettle,
      // P9 B：结果落定后、给网页回执前的钩子（删除成功先清服务器副本，网页收到回执时已经清完）
      onResult: extra.onResult,
    };
    const w = { ws, origId, timer: null };
    entry.waiters.push(w);
    armWaiter(rooms, entry, w, cfg);
    rooms.commandWaiters.set(wireId, entry);
    if (dk) rooms.dedupe.set(dk, entry);
    send(ws, { type: "command_accepted", id: origId, room: room && room.id ? room.id : undefined, deviceId: extra.deviceId, timeoutMs }, cfg);
    const frame = { type: "command", id: wireId, command: cmdName, args, timeoutMs };
    if (room && room.id) frame.room = room.id;
    if (extra.deviceId) frame.deviceId = extra.deviceId;
    send(local, frame, cfg);
  }

  function onlineRoomByCwd(deviceId, cwd, platform = "") {
    const want = normPath(cwd, platform);
    let best = null;
    for (const r of rooms.map.values()) {
      if (!r.online || r.deviceId !== deviceId) continue;
      if (normPath(r.cwd || "", platform) !== want) continue;
      if (!best || (r.lastActivity || 0) >= (best.lastActivity || 0)) best = r;
    }
    return best;
  }

  function routeHarness(ws, msg, dev, args) {
    const origId = msg.id ? String(msg.id) : null;
    const cwd = typeof args.cwd === "string" ? args.cwd : "";
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    const hasCwd = !!cwd;
    const hasSid = !!sessionId;
    if (hasCwd === hasSid) {
      send(ws, ackFrame(origId, false, { error: HARNESS_ARGS, code: "bad_args", deviceId: dev.id }), cfg);
      return;
    }
    if (hasCwd) {
      // P9 C：cwd 在白名单里，或者在设备的浏览根目录下面都放行（relay 只粗查，attach 按真实路径复查）
      const allowed = cwdAllowed(dev.projects, cwd, dev.platform) ||
        (hasCap(dev.conn, "fs.browse") && underRoots(dev.browseRoots, cwd, dev.platform));
      if (!allowed) {
        send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.cwd_not_allowed, code: "cwd_not_allowed", deviceId: dev.id }), cfg);
        return;
      }
      const running = onlineRoomByCwd(dev.id, cwd, dev.platform);
      if (running) {
        send(ws, ackFrame(origId, true, { deviceId: dev.id, data: { status: "already_running", roomId: running.id } }), cfg);
        return;
      }
    } else {
      let row = null;
      try { row = index.getSession(dev.accountId || DEFAULT_ACCOUNT, dev.id, sessionId); } catch { row = null; }
      if (!row || row.deleted) {
        send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.session_not_found, code: "session_not_found", deviceId: dev.id }), cfg);
        return;
      }
      const live = rooms.peek(sessionId);
      if (live && live.online) {
        send(ws, ackFrame(origId, true, { deviceId: dev.id, data: { status: "already_running", roomId: live.id } }), cfg);
        return;
      }
    }
    const dk = typeof msg.dedupeKey === "string" && msg.dedupeKey && msg.dedupeKey.length <= 128
      ? dedupeKeyOf(dev.id, "harness_start", args, msg.dedupeKey)
      : null;
    if (dev.startInFlight) {
      const prev = dk && rooms.dedupe.get(dk);
      if (!(prev && !prev.done && prev.command === "harness_start")) {
        send(ws, ackFrame(origId, false, { error: HARNESS_BUSY, code: "harness_busy", deviceId: dev.id }), cfg);
        return;
      }
    }
    runCommand(ws, msg, { id: "" }, dev.conn, {
      timeoutMs: cfg.harnessStartTimeoutMs || 10000,
      dedupeScope: dev.id,
      deviceId: dev.id,
      offlineCode: "device_offline",
      onForward: () => { dev.startInFlight = true; },
      onSettle: () => { dev.startInFlight = false; },
    });
  }

  function routeDeviceCommand(ws, msg) {
    const origId = msg.id ? String(msg.id) : null;
    const deviceId = String(msg.deviceId).trim();
    const cmdName = String(msg.command || "");
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    const accountId = typeof msg.accountId === "string" && msg.accountId.trim() ? msg.accountId.trim() : normalizeAccount(cfg.accountId);
    const dev = devices.get(deviceId);
    let known = !!dev;
    if (!known) {
      try { known = !!index.getDeviceRow(accountId, deviceId); } catch { known = false; }
    }
    if (!known) {
      send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.no_device, code: "no_device", deviceId }), cfg);
      return;
    }
    if (!dev || !dev.online || !dev.conn || dev.conn.readyState !== 1) {
      send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.device_offline, code: "device_offline", deviceId }), cfg);
      return;
    }
    if (cmdName === "harness_start") {
      routeHarness(ws, msg, dev, args);
      return;
    }
    if (cmdName === "list_dirs") {
      // P9 C：目录浏览只能交给声明了 fs.browse 的 attach。必须在这里短路，
      // 否则会落进下面「交给扩展房间」的分支（扩展不认这个命令，网页干等超时）。
      if (!hasCap(dev.conn, "fs.browse")) {
        send(ws, ackFrame(origId, false, { error: PROTOCOL.errors.device_update_required.message, code: "device_update_required", deviceId }), cfg);
        return;
      }
      runCommand(ws, msg, null, dev.conn, { dedupeScope: deviceId, deviceId });
      return;
    }
    // 文件级会话操作不需要“目标会话”是活动房间，但命令必须交给**扩展**连接（dev.conn 是
    // attach 窗口，只处理 harness_start）。P2-1（spec D8）：先按索引里目标会话的 cwd 选
    // 同目录的在线房间——会话在别的项目时，交给活动房间会报「会话路径越界」；索引里查不到
    // 或那个目录没有在线房间时，退回原来的「活动房间 → 任一在线房间」逻辑。
    if (INACTIVE_SESSION_COMMANDS.has(cmdName) && DEVICE_COMMANDS.has(cmdName)) {
      const targetPath = typeof args.sessionPath === "string" ? args.sessionPath : "";
      const targetId = typeof args.sessionId === "string" && args.sessionId.trim()
        ? args.sessionId.trim()
        : sessionIdFromPath(targetPath);
      let row = null;
      if (targetId) {
        try { row = index.getSession(boundAccount(index, devices, deviceId, cfg.accountId), deviceId, targetId); } catch { row = null; }
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
        send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.device_no_active_session, code: "device_no_active_session", deviceId }), cfg);
        return;
      }
      const extra = { dedupeScope: deviceId, deviceId };
      // 改名成功后同步 dev.archives 里那一条的 name（P2-1）：设备在线时网页可能已经拿到过旧正文，
      // 不更新的话正文区的标题会一直停在旧名字，直到 attach 下次重推。
      if (cmdName === "rename_session_file") {
        const archiveId = targetId;
        const fallbackName = typeof args.name === "string" ? args.name : "";
        extra.onResult = (result) => {
          if (!result || !result.ok || !archiveId) return;
          const archives = dev.archives;
          const body = archives && archives.get(archiveId);
          if (!body) return;
          const name = (result.data && typeof result.data.name === "string" && result.data.name) || fallbackName;
          if (name) body.name = String(name).slice(0, 200);
        };
      }
      // Body search routed at an enc room answers the same explicit unsupported
      // marker as the room-addressed path (never a silent omission).
      if (cmdName === "search_session_bodies" && targetRoom && store.encInfo(targetRoom.id)) {
        send(ws, ackFrame(origId, false, { error: "该会话已加密，正文搜索不支持", code: "unsupported", room: targetRoom.id, data: { unsupported: true, reason: "room_encrypted", roomId: targetRoom.id } }), cfg);
        return;
      }
      runCommand(ws, msg, targetRoom, local, extra);
      return;
    }
    const room = dev.activeRoomId ? rooms.peek(dev.activeRoomId) : null;
    const roomReady = !!(room && room.online && room.deviceId === deviceId);
    if (!roomReady) {
      if (dev.activeRoomId) dev.activeRoomId = null;
      // B-4：只读设备命令不要求活动会话——诊断/文件回程正是没会话时最需要。
      // 仍受 DEVICE_COMMANDS 白名单和设备在线/连接检查约束；发消息类永远走房间。
      if (READONLY_DEVICE_COMMANDS.has(cmdName) && DEVICE_COMMANDS.has(cmdName)) {
        runCommand(ws, msg, null, dev.conn, { dedupeScope: deviceId, deviceId });
        return;
      }
      send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.device_no_active_session, code: "device_no_active_session", deviceId }), cfg);
      return;
    }
    if (!DEVICE_COMMANDS.has(cmdName)) {
      send(ws, ackFrame(origId, false, { error: "该命令必须指定房间", code: "bad_args", deviceId }), cfg);
      return;
    }
    rooms.touch(room);
    // Same enc-search marker on the active-room fallback path.
    if (cmdName === "search_session_bodies" && store.encInfo(room.id)) {
      send(ws, ackFrame(origId, false, { error: "该会话已加密，正文搜索不支持", code: "unsupported", room: room.id, data: { unsupported: true, reason: "room_encrypted", roomId: room.id } }), cfg);
      return;
    }
    runCommand(ws, msg, room, room.local, { dedupeScope: deviceId, deviceId });
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
  function routeDeleteSession(ws, msg) {
    const origId = msg.id ? String(msg.id) : null;
    const deviceId = String(msg.deviceId).trim();
    const sessionId = String((msg.args && msg.args.sessionId) || "").trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
      send(ws, ackFrame(origId, false, { error: "会话 id 不合法", code: "bad_args", deviceId }), cfg);
      return;
    }
    const dev = devices.get(deviceId);
    // 账号由服务端绑定（与按房间删除的旧路径同一口径）：设备离线、内存里没有这条设备时
    // 不能退化成 cfg.accountId，否则查错账号会把"查不到"误判成"已删除"（审查 P1-2）
    const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
    // 在线房间 = 会话正在运行：不删（与网页侧置灰口径一致）
    const live = rooms.peek(sessionId);
    if (live && live.online) {
      send(ws, ackFrame(origId, false, { error: "会话正在运行，不能删除", code: "session_running", deviceId }), cfg);
      return;
    }
    let row = null;
    try { row = index.getSession(accountId, deviceId, sessionId); } catch { row = null; }
    const purge = (result) => {
      if (result && result.ok) purgeSessions({ accountId, deviceId, ids: [sessionId], rooms, store, devices, index, cfg });
    };
    if (row && row.deleted) {
      // 确实已有墓碑（设备上先删过/重复点）：把残留副本清掉，回成功（幂等）
      purge({ ok: true });
      send(ws, ackFrame(origId, true, { deviceId, data: { status: "already_deleted", method: null } }), cfg);
      return;
    }
    const attachOk = dev && dev.online && dev.conn && dev.conn.readyState === 1 && hasCap(dev.conn, "session.files");
    if (!row && !attachOk) {
      // 索引里没有、又没有能按 id 在设备上找文件的 attach：无从证明设备上删了，不清副本
      send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.session_not_found, code: "session_not_found", deviceId }), cfg);
      return;
    }
    if (attachOk) {
      const args = { sessionId };
      // P1-3：索引里的路径作提示，attach 找不到文件时据此区分"根目录外"与"真删了"
      if (row && typeof row.path === "string" && row.path) args.pathHint = row.path;
      runCommand(ws, { ...msg, args }, null, dev.conn, { dedupeScope: deviceId, deviceId, onResult: purge });
      return;
    }
    // row 存在但没有 attach：同目录在线房间 → 扩展删（R25 老路：扩展只删自己会话目录里的文件）
    const room = row.cwd ? onlineRoomByCwd(deviceId, row.cwd, dev ? dev.platform : "") : null;
    if (room && room.local && room.local.readyState === 1) {
      runCommand(ws, { ...msg, args: { sessionPath: row.path } }, room, room.local, { dedupeScope: deviceId, deviceId, onResult: purge });
      return;
    }
    const code = dev && dev.online ? "device_update_required" : "device_offline";
    send(ws, ackFrame(origId, false, {
      error: code === "device_offline" ? "设备未连接，连上后才能删除" : "这台设备的连接窗口（attach）需要更新",
      code,
      deviceId,
    }), cfg);
  }

  wss.on("connection", (ws, req) => {
    const source = requestSource(req);
    // 锁定中的来源在建连后立刻拒绝：不占未认证连接名额，也拿不到 10 秒的认证窗口反复试 token。
    const lockLeft = authLockLeft(source);
    if (lockLeft > 0) {
      noteLockedReject(source, lockLeft);
      // 不发明文帧：auth_result 会让观看端清掉本地 token，error 提示又会在恢复后残留。
      // 1013（Try Again Later）让客户端按退避重连，锁定到期后自动恢复。
      try { ws.close(1013, "auth rate limited"); } catch {}
      return;
    }
    if (unauthenticated >= maxUnauthenticated) {
      const now = Date.now();
      if (!lastCapLog || now - lastCapLog > 5000) {
        lastCapLog = now;
        log("viewer 未认证连接数达到上限，拒绝新连接:", unauthenticated, "/", maxUnauthenticated, "来源:", source);
      }
      try { ws.close(1013, "unauthenticated limit"); } catch {}
      return;
    }
    unauthenticated++;
    let unauthReleased = false;
    const releaseUnauthenticated = () => {
      if (unauthReleased) return;
      unauthReleased = true;
      unauthenticated = Math.max(0, unauthenticated - 1);
    };
    ws.on("close", releaseUnauthenticated);

    attachCommon(ws, cfg, {
      onMessage(msg) {
        const s = ws._state;
        if (!s.authed) {
          // Viewer challenge-response auth (crypto Phase 2, design §3.3): an auth frame
          // carrying keyFp starts a challenge, auth_response completes it. Isomorphic to
          // the local channel: the nonce lives only in connection memory and is deleted
          // on first use whatever the outcome, and the shared 10s unauthenticated
          // deadline (attachCommon's authTimer) is never extended by the challenge.
          const failKeyAuth = (code, error) => {
            noteAuthFailure(source);
            send(ws, { type: "auth_result", ok: false, error: error || PROTOCOL.errors[code].message, code }, cfg);
            try { ws.close(4003, "unauthorized"); } catch {}
          };
          if (msg.type === "auth_response") {
            const pend = s.viewerKeyAuth;
            delete s.viewerKeyAuth;
            if (!pend) { failKeyAuth("auth_failed", "没有待验签的挑战，请重新发起 auth"); return; }
            if (Date.now() > pend.expiresAt) { failKeyAuth("auth_failed", "鉴权挑战已过期，请重连后重试"); return; }
            const row = viewerRowSafe(pend.viewerId);
            if (row && row.revokedAt) { failKeyAuth("device_revoked"); return; }
            if (!row || !row.signPub || keyFingerprint(row.signPub) !== pend.keyFp) { failKeyAuth("device_mismatch"); return; }
            // The VIK is P-256: WebCrypto signatures are ECDSA/SHA-256 in IEEE P1363
            // form; the payload is the shared auth payload with viewerId as identity.
            if (!verifyP256(row.signPub, authPayload(pend.viewerId, pend.nonce, pend.clientNonce), msg.sig)) {
              log("观看端钥鉴权验签失败:", pend.viewerId);
              failKeyAuth("auth_failed", "签名不正确");
              return;
            }
            const protoError = helloVersionError(pend.hello);
            if (protoError) {
              log("viewer 协议版本过低，拒绝握手:", protoError.message, "来源:", source);
              send(ws, {
                type: "auth_result",
                ok: false,
                code: protoError.code,
                error: protoError.message,
                proto: PROTOCOL.proto,
                minProto: PROTOCOL.minProto,
              }, cfg);
              try { ws.close(4003, "unsupported protocol"); } catch {}
              return;
            }
            noteAuthSuccess(source);
            releaseUnauthenticated();
            s.authed = true;
            Object.assign(s, parseHello(pend.hello));
            clearTimeout(s.authTimer);
            rooms.viewers.add(ws);
            s.auth = "key";
            s.viewerId = pend.viewerId;
            // New key-auth surface only: auth:"key", the bound viewerId, and the
            // account's agreed ackFp (null while unknown or diverged, §7). The token
            // path's auth_result below stays byte-identical for existing clients.
            const authResult = { type: "auth_result", ok: true, proto: PROTOCOL.proto, caps: RELAY_CAPS, boot: rooms.boot, rooms: rooms.listFor(ws), devices: devicesViewFor(ws, rooms.deviceSnapshot()), auth: "key", viewerId: pend.viewerId, ackFp: ackTrackerOf(ctx).knownAckFp(viewerAccount()) };
            if (cfg.serverName) authResult.serverName = cfg.serverName;
            if (hasCap(ws, "prefs.sync")) {
              const rec = prefsStore.get(viewerAccount());
              authResult.prefs = rec ? { subset: rec.subset, rev: rec.rev, updatedAt: rec.updatedAt } : null;
            }
            if (hasCap(ws, "room.inbox")) {
              authResult.inbox = rooms.inboxSnapshot();
            }
            send(ws, authResult, cfg);
            replaySessionArchives(ws, devices, cfg);
            log("viewer 已认证 key", pend.viewerId, helloText(s));
            return;
          }
          if (msg.type === "auth" && msg.role === "viewer" && typeof msg.keyFp === "string" && msg.keyFp) {
            const viewerId = typeof msg.viewerId === "string" ? msg.viewerId.trim() : "";
            if (!viewerId || !safeId(viewerId)) { failKeyAuth("device_mismatch", "钥鉴权需要合法的 viewerId"); return; }
            const row = viewerRowSafe(viewerId);
            if (row && row.revokedAt) { failKeyAuth("device_revoked"); return; }
            if (!row || !row.signPub) { failKeyAuth("device_mismatch", "该观看端没有登记公钥，无法用密钥登录（先完成观看端登记）"); return; }
            if (!p256PubKey(row.signPub)) { failKeyAuth("device_mismatch", "名册中的观看端签名公钥不合规"); return; }
            if (keyFingerprint(row.signPub) !== msg.keyFp) { failKeyAuth("device_mismatch", "出示的钥指纹与名册登记不一致"); return; }
            const clientNonce = b64buf(msg.clientNonce);
            if (!clientNonce || clientNonce.length < 16 || clientNonce.length > 64) { failKeyAuth("auth_failed", "clientNonce 不合规（需 16–64 字节的 base64）"); return; }
            const nonce = crypto.randomBytes(PROTOCOL.limits.authNonceBytes);
            s.viewerKeyAuth = { viewerId, keyFp: msg.keyFp, nonce, clientNonce, hello: msg, expiresAt: Date.now() + 10000 };
            send(ws, { type: "auth_challenge", nonce: nonce.toString("base64"), expiresAt: s.viewerKeyAuth.expiresAt }, cfg);
            return;
          }
          if (msg.type === "auth" && msg.role === "viewer" && cfg.viewerToken && safeEqual(msg.token, cfg.viewerToken)) {
            // 低-12：显式声明了过低协议版本的握手要明确拒绝，不能静默按 minProto 放行。
            // 不带 proto 的老客户端仍走兼容期 v3（既有测试/旧前端都依赖这一行为）。
            const protoError = helloVersionError(msg);
            if (protoError) {
              log("viewer 协议版本过低，拒绝握手:", protoError.message, "来源:", source);
              send(ws, {
                type: "auth_result",
                ok: false,
                code: protoError.code,
                error: protoError.message,
                proto: PROTOCOL.proto,
                minProto: PROTOCOL.minProto,
              }, cfg);
              try { ws.close(4003, "unsupported protocol"); } catch {}
              return;
            }
            noteAuthSuccess(source);
            releaseUnauthenticated();
            s.authed = true;
            Object.assign(s, parseHello(msg));
            clearTimeout(s.authTimer);
            rooms.viewers.add(ws);
            const authResult = { type: "auth_result", ok: true, proto: PROTOCOL.proto, caps: RELAY_CAPS, boot: rooms.boot, rooms: rooms.listFor(ws), devices: devicesViewFor(ws, rooms.deviceSnapshot()) };
            if (cfg.serverName) authResult.serverName = cfg.serverName;
            // 偏好同步快照（R4-1，新面按 cap 剥离）：声明了 prefs.sync 才带 prefs 字段
            // （有记录给 {subset, rev, updatedAt}，无记录给 null——UI 据此播种第一版）；
            // 未声明的旧端 auth_result 里根本没有这个字段，既有面一律不动。
            if (hasCap(ws, "prefs.sync")) {
              const rec = prefsStore.get(viewerAccount());
              authResult.prefs = rec ? { subset: rec.subset, rev: rec.rev, updatedAt: rec.updatedAt } : null;
            }
            // 收件箱账本快照（设计 D §1，新面按 cap 剥离）：声明了 room.inbox 才带 inbox 字段；
            // 未声明的旧端 auth_result 里根本没有这个字段，既有面一律不动。
            if (hasCap(ws, "room.inbox")) {
              authResult.inbox = rooms.inboxSnapshot();
            }
            send(ws, authResult, cfg);
            replaySessionArchives(ws, devices, cfg);
            log("viewer 已认证（当前房间", rooms.list().length, "个）", helloText(s));
          } else {
            // 业务帧/坏帧在未认证阶段一律按认证失败处理：不进入下面的 switch，不产生订阅、命令等副作用。
            noteAuthFailure(source);
            send(ws, { type: "auth_result", ok: false, error: "token 不正确", code: "auth_failed" }, cfg);
            ws.close(4003, "unauthorized");
          }
          return;
        }
        switch (msg.type) {
          case "usage_get": {
            // P10：使用活动（只读聚合；viewer 只能取本账号设备；无数据/旧端走空态帧，不报错）
            if (!ctx.usage) { send(ws, { type: "usage_snapshot", deviceId: typeof msg.deviceId === "string" ? msg.deviceId : "", available: false, reason: "unsupported", requestId: typeof msg.requestId === "string" ? msg.requestId : undefined }, cfg); break; }
            ctx.usage.handleGet(ws, msg, viewerAccount());
            break;
          }
          case "list_rooms": {
            const listFrame = { type: "room_list", devices: devicesViewFor(ws, rooms.deviceSnapshot()), rooms: rooms.listFor(ws) };
            // 收件箱账本快照（设计 D §1）：与 auth_result 同口径，按 cap 附带，未声明不带字段。
            if (hasCap(ws, "room.inbox")) listFrame.inbox = rooms.inboxSnapshot();
            send(ws, listFrame, cfg);
            break;
          }
          case "inbox_dismiss": {
            // 收件箱手动清除（设计 D §1）：relay 本地命令，不转发桥；只清 done/error，
            // waiting 拒清在账本层裁决（防假清零）。结果经 inbox_update 广播对齐各端（含发送端），
            // 本命令不单独回执（与 dialog_answer_switch 的无回执下达同姿势）。
            if (!hasCap(ws, "room.inbox")) {
              send(ws, errorFrame("unsupported", "此端未声明 room.inbox 能力", { id: msg.id ? String(msg.id) : null }), cfg);
              return;
            }
            rooms.dismissInbox(typeof msg.key === "string" ? msg.key : "");
            break;
          }
          case "schedule_create": {
            // 定时/心跳排期（设计 D §3）：relay 本地命令，绝不转发桥——计时器归 relay，
            // 到点由 relay 经既有命令通道下发 prompt。与 prompt 同一鉴权面（本连接已
            // 通过 viewer 鉴权）。校验/上限在引擎裁决；成功回执带新条目，清单变化另经
            // schedule_update 广播对齐各端。
            const origId = msg.id ? String(msg.id) : null;
            if (!hasCap(ws, "room.schedule")) {
              send(ws, errorFrame("unsupported", "此端未声明 room.schedule 能力", { id: origId }), cfg);
              return;
            }
            const roomId = typeof msg.roomId === "string" ? msg.roomId : "";
            const room = rooms.peek(roomId);
            if (!room) {
              send(ws, ackFrame(origId, false, { room: roomId || undefined, error: "会话不存在", code: "no_room" }), cfg);
              return;
            }
            const res = rooms.createSchedule(viewerAccount(), { ...msg, roomId: room.id });
            if (!res.entry) {
              send(ws, ackFrame(origId, false, { room: room.id, error: res.error, code: res.code }), cfg);
              return;
            }
            send(ws, ackFrame(origId, true, { room: room.id, data: res.entry }), cfg);
            break;
          }
          case "schedule_cancel": {
            // 取消一条 armed 排期（终态条目取消无意义，回 no_schedule）。排期 id 走
            // scheduleId 字段：帧的 id 是回执对号位，不能占用。
            const origId = msg.id ? String(msg.id) : null;
            if (!hasCap(ws, "room.schedule")) {
              send(ws, errorFrame("unsupported", "此端未声明 room.schedule 能力", { id: origId }), cfg);
              return;
            }
            const entry = rooms.cancelSchedule(viewerAccount(), typeof msg.scheduleId === "string" ? msg.scheduleId : "");
            if (!entry) {
              send(ws, ackFrame(origId, false, { error: "定时消息不存在或已结束", code: "not_found" }), cfg);
              return;
            }
            send(ws, ackFrame(origId, true, { room: entry.roomId, data: entry }), cfg);
            break;
          }
          case "schedule_list": {
            // 单房排期清单直查：与 room_list 条目内 schedules / schedule_update 同一数据源。
            const origId = msg.id ? String(msg.id) : null;
            if (!hasCap(ws, "room.schedule")) {
              send(ws, errorFrame("unsupported", "此端未声明 room.schedule 能力", { id: origId }), cfg);
              return;
            }
            const roomId = typeof msg.roomId === "string" ? msg.roomId : "";
            send(ws, ackFrame(origId, true, { room: roomId || undefined, data: { schedules: rooms.scheduleList(viewerAccount(), roomId) } }), cfg);
            break;
          }
          case "get_sessions": {
            const origId = msg.id ? String(msg.id) : null;
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            // R-5：账号只认本连接的握手口径（viewerAccount），忽略 msg.accountId
            // ——与文件头口径及 prefs/usage 的做法一致，客户端上报不作数。
            const accountId = viewerAccount();
            if (origId) {
              const key = queryKey(ws, origId);
              // 同一个 (连接, id) 重复查询（前端重试/连点）会覆盖 map 条目：必须先撤掉旧定时器，
              // 否则旧定时器到点后发现 key 还在（那已是新条目），就会删掉新查询并发一条假超时，把新查询冤杀。
              const stale = rooms.viewerQueries.get(key);
              if (stale) clearTimeout(stale.timer);
              const timer = setTimeout(() => {
                if (!rooms.viewerQueries.has(key)) return;
                rooms.viewerQueries.delete(key);
                send(ws, errorFrame("timeout", "查询超时", { id: origId, deviceId }), cfg);
              }, 10000);
              timer.unref();
              rooms.viewerQueries.set(key, { ws, timer });
            }
            const finishQuery = () => {
              const q = origId && rooms.viewerQueries.get(queryKey(ws, origId));
              if (!q) return;
              clearTimeout(q.timer);
              rooms.viewerQueries.delete(queryKey(ws, origId));
            };
            try {
              let row = null;
              if (deviceId) {
                try { row = index.getDeviceRow(accountId, deviceId); } catch (e) { log("get_sessions 读名册失败:", e.message); }
              }
              if (!deviceId || !row) {
                send(ws, errorFrame("no_device", DEVICE_ERRORS.no_device, { id: origId, deviceId }), cfg);
                return;
              }
              const limit = cfg.maxSessionsListed || 200;
              const listed = index.listSessions(accountId, deviceId, { limit });
              const sessions = listed.sessions.map((s) => {
                const room = rooms.peek(s.id);
                return {
                  id: s.id,
                  name: s.name || "",
                  path: s.path || "",
                  // fork 谱系（R3-3）：父指针经 AccountIndex 落盘后必须在这一跳也透传，
                  // 漏了 UI 的 parseSessionList 永远拿到 null、"源自 X"整体落空（第 3 轮审查 C-1）。
                  parentSession: s.parentSession || null,
                  // Crypto Phase 3: a sealed preview envelope stored on the
                  // index row is served inside firstMessage -- the form the
                  // web session parser reads (firstMessageEncOf) -- so the
                  // device library list can decrypt it; plaintext rows are
                  // served exactly as before.
                  firstMessage: s.firstMessage ? s.firstMessage : (s.firstMessageEnc || null),
                  cwd: s.cwd || "",
                  messageCount: s.messageCount || 0,
                  sizeBytes: s.sizeBytes || 0,
                  updatedAt: s.updatedAt || 0,
                  active: !!s.active,
                  online: !!(room && room.online),
                  deleted: false,
                };
              });
              send(ws, { type: "session_list", id: origId, deviceId, sessions, truncated: !!listed.truncated }, cfg);
            } catch (e) {
              log("get_sessions 失败:", e.message);
              send(ws, errorFrame("server_error", "读取会话清单失败", { id: origId }), cfg);
            } finally {
              finishQuery();
            }
            break;
          }
          case "subscribe": {
            const rid = String(msg.room || "");
            // 真实房间 = 在注册表里，或存储有文件（离线可回看）；都不沾 → 明确报错，不建幻影房
            if (!rooms.peek(rid) && !store.exists(rid)) {
              send(ws, errorFrame("no_room", "会话不存在", { room: rid }), cfg);
              return;
            }
            // Enc gate (design section 7): a viewer without crypto.content gets
            // crypto_required and NO snapshot — ciphertext is never delivered
            // as if it were messages. A stale pre-encryption subscription on
            // this connection is dropped here as well.
            const subEnc = store.encInfo(rid);
            if (subEnc && !hasCap(ws, "crypto.content")) {
              if (ws._room && ws._room.id === rid) {
                ws._room.viewers.delete(ws);
                ws._room = null;
              }
              send(ws, errorFrame("crypto_required", "该会话已加密，需要支持正文加密的客户端", { room: rid }), cfg);
              return;
            }
            // Plaintext policy (design section 5): "deny" refuses reads too.
            if (!subEnc && ((cfg && cfg.cryptoPlaintextRooms) || "allow") === "deny") {
              send(ws, errorFrame("unsupported", "plaintext rooms are disabled by the cryptoPlaintextRooms policy", { room: rid }), cfg);
              return;
            }
            const room = rooms.get(rid);
            const already = room.viewers.has(ws);
            // 低-19：先完成新订阅（含容量校验），成功后再摘旧房。旧实现先摘旧房再判
            // room_full，切到一个满房失败时会把当前会话的订阅也弄丢。
            if (!already) {
              if (room.viewers.size >= cfg.maxViewersPerRoom) {
                send(ws, errorFrame("room_full", "该会话观看人数已满", { room: rid }), cfg);
                return;
              }
              room.viewers.add(ws);
              pushDialogGate(room, cfg);
            }
            if (ws._room && ws._room !== room) {
              const oldRoom = ws._room;
              oldRoom.viewers.delete(ws);
              if (oldRoom.resendWaiters) oldRoom.resendWaiters = oldRoom.resendWaiters.filter((w) => w !== ws);
              pushDialogGate(oldRoom, cfg);
            }
            ws._room = room;
            // 注意力恢复通道（R3-1）：订阅进房即已读——由 relay 清该房回合摘要并广播
            // room_attention{null}（单用户多设备：一端看过即全端已读）。在 subscribed
            // 之前落，让随后到的 room_list 快照与本帧口径一致（都已清）。
            if (clearRoomTurnEnd(room)) broadcastRoomAttention(rooms, room, cfg);
            send(ws, { type: "subscribed", room: room.id, online: room.online, busy: room.busy }, cfg);
            // 断线重连：带 since={rev,seq} 且存储世代未变 → 只送 seq 之后的增量；否则全量
            const since = msg.since && typeof msg.since === "object" ? { rev: String(msg.since.rev || ""), seq: Number(msg.since.seq) } : null;
            // 正文默认不落盘：在线房间内存里没有快照时，请扩展重推，3s 兜底空快照
            const freshSnap = room.snap && room.snap.body && room.snap.at + cfg.snapshotCacheTtlMs > Date.now();
            if (!cfg.persistTranscripts && room.online && room.local && !freshSnap) {
              let mem = null;
              try {
                mem = store.snapshot(room.id, { limit: cfg.maxSnapshotRecords, maxBytes: cfg.maxSnapshotBytes });
              } catch {
                mem = null;
              }
              const hasMem = !!(mem && Array.isArray(mem.items) && mem.items.length);
              if (!hasMem) {
                // 增量重连本就带着 since：存储世代没变就先给增量，不必再等一次本机全量快照
                if (since && since.rev) {
                  let delta = null;
                  try {
                    const d = store.snapshot(room.id, { limit: cfg.maxSnapshotRecords, maxBytes: cfg.maxSnapshotBytes, since });
                    if (d && d.delta) delta = d;
                  } catch {}
                  if (delta) {
                    send(ws, snapshotFrame(room, snapshotBodyFrom(delta)), cfg);
                    if (room.usage) send(ws, { type: "usage_state", room: room.id, usage: room.usage }, cfg);
                    sendCachedQueue(ws, room, cfg);
                    sendCachedRemoteQueue(ws, room, cfg);
                    sendCachedTaskList(ws, room, cfg);
                    sendCachedAgentState(ws, room, cfg);
                    // since 增量不补还在写的助手正文和工具参数
                    sendCachedTools(ws, room, cfg);
                    sendCachedToolEnds(ws, room, cfg);
                    sendCachedAutoRetry(ws, room, cfg);
                    sendCachedUiPrompt(ws, room, cfg);
                    sendCachedDialogs(ws, room, cfg);
                    sendCachedExtStatus(ws, room, cfg);
                    sendCachedCompaction(ws, room, cfg);
                    if (!already) {
                      rooms.broadcastRoomList();
                      log("viewer 订阅:", room.id, "(增量，不等本机快照)");
                    }
                    break;
                  }
                }
                if (!room.resendWaiters) room.resendWaiters = [];
                if (!room.resendWaiters.includes(ws)) room.resendWaiters.push(ws);
                if (!room.resendTimer) {
                  send(room.local, { type: "resend_snapshot", room: room.id }, cfg);
                  room.resendTimer = setTimeout(() => {
                    room.resendTimer = null;
                    const waiters = room.resendWaiters || [];
                    room.resendWaiters = [];
                    for (const w of waiters) {
                      send(w, snapshotFrame(room, resendFallbackBody(cfg, store, room)), cfg);
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
                if (room.usage) send(ws, { type: "usage_state", room: room.id, usage: room.usage }, cfg);
                sendCachedQueue(ws, room, cfg);
                sendCachedRemoteQueue(ws, room, cfg);
                sendCachedTaskList(ws, room, cfg);
                sendCachedAgentState(ws, room, cfg);
                // 还没有全量快照，不补还在写的助手正文和工具参数
                sendCachedTools(ws, room, cfg);
                sendCachedToolEnds(ws, room, cfg);
                sendCachedAutoRetry(ws, room, cfg);
                sendCachedUiPrompt(ws, room, cfg);
                sendCachedDialogs(ws, room, cfg);
                sendCachedExtStatus(ws, room, cfg);
                sendCachedCompaction(ws, room, cfg);
                if (!already) {
                  rooms.broadcastRoomList();
                  log("viewer 订阅:", room.id, "(等待本机快照)");
                }
                break;
              }
            }
            let body = null;
            if (since && since.rev) {
              const snap = store.snapshot(room.id, { limit: cfg.maxSnapshotRecords, maxBytes: cfg.maxSnapshotBytes, since });
              if (snap && snap.delta) body = snapshotBodyFrom(snap);
            }
            const snapBody = body || fullSnapshotBody(room);
            send(ws, snapshotFrame(room, snapBody), cfg);
            if (room.usage) send(ws, { type: "usage_state", room: room.id, usage: room.usage }, cfg);
            sendCachedQueue(ws, room, cfg);
            sendCachedRemoteQueue(ws, room, cfg);
            // 任务清单与快照是否全量无关：缓存里有就补，重连/新观众都不会丢当前清单
            sendCachedTaskList(ws, room, cfg);
            sendCachedAgentState(ws, room, cfg);
            // 全量才补。工具参数 message_update 在 sendCachedAssistant 里，紧跟 message_start、位于工具执行补发之前。since 增量不补。
            if (!body) sendCachedAssistant(ws, room, cfg, store);
            sendCachedTools(ws, room, cfg);
            sendCachedToolEnds(ws, room, cfg);
            sendCachedAutoRetry(ws, room, cfg);
            sendCachedUiPrompt(ws, room, cfg);
            sendCachedDialogs(ws, room, cfg);
            sendCachedExtStatus(ws, room, cfg);
            sendCachedCompaction(ws, room, cfg);
            // 只有观众数真变了才广播：否则"订阅→room_list→再订阅"会在客户端形成自循环
            if (!already) {
              rooms.broadcastRoomList();
              log("viewer 订阅:", room.id, body ? "(增量)" : "");
            }
            break;
          }
          case "unsubscribe": {
            const room = ws._room;
            if (room) {
              room.viewers.delete(ws);
              ws._room = null;
              pushDialogGate(room, cfg);
              // 退订就要从兜底快照的等待名单里摘掉：否则 3s 后仍会给已经离开的 viewer 推一条空快照
              if (room.resendWaiters) room.resendWaiters = room.resendWaiters.filter((w) => w !== ws);
              rooms.broadcastRoomList();
            }
            break;
          }
          case "history": {
            // 分页已废弃（完整镜像语义）——明确报错而不是静默吞掉
            send(ws, ackFrame(msg.id, false, { error: "history 分页已废弃，请以 subscribe 时的 snapshot 为准", code: "unsupported" }), cfg);
            break;
          }
          case "message": {
            const room = rooms.touch(rooms.peek(String(msg.room || "")));
            if (!room) {
              send(ws, ackFrame(msg.id, false, { error: "会话不存在", code: "no_room" }), cfg);
              return;
            }
            const cid = cleanCid(msg.cid);
            if (msg.cid != null && !cid) {
              send(ws, ackFrame(msg.id, false, { room: room.id, error: "cid 不合法", code: "bad_args" }), cfg);
              return;
            }
            // Enc rooms (design sections 4.1/7): the viewer sends the envelope
            // form {enc:{ct,h}} instead of text; the relay forwards it verbatim
            // and never sees the plaintext. A plaintext text aimed at an enc
            // room is rejected, as is an envelope aimed at a plaintext room.
            if (store.encInfo(room.id)) {
              if (!hasCap(ws, "crypto.content")) {
                send(ws, ackFrame(msg.id, false, { room: room.id, error: "该会话已加密，需要支持正文加密的客户端", code: "crypto_required" }), cfg);
                return;
              }
              // Two spellings: nested {enc:{ct, h}} or flat {enc:1, ct, h}.
              const enc = msg.enc && typeof msg.enc === "object" ? msg.enc : (msg.enc === 1 ? msg : null);
              if (!enc || typeof enc.ct !== "string" || !enc.ct || typeof enc.h !== "string" || !/^[0-9a-f]{64}$/.test(enc.h)) {
                send(ws, ackFrame(msg.id, false, { room: room.id, error: "加密消息缺少合法的 enc 信封（ct/h）", code: "bad_args" }), cfg);
                return;
              }
              const encFrame = { type: "message", room: room.id, enc: 1, ct: enc.ct, h: enc.h };
              if (cid && hasCap(room.local, "msg.cid")) encFrame.cid = cid;
              if (!forwardToLocal(ws, room, encFrame, msg, {
                offline: "本机未连接，消息无法送达",
                backpressure: "本机消息通道积压，消息未能送出，请稍后重试",
              })) return;
              send(ws, ackFrame(msg.id, true, { room: room.id }), cfg);
              return;
            }
            if (msg.enc != null) {
              send(ws, ackFrame(msg.id, false, { room: room.id, error: "该会话未加密，不能发送 enc 信封", code: "bad_args" }), cfg);
              return;
            }
            // 不再静默截断：截断后的半句话会被当成完整指令注入（单帧上限 maxPayloadBytes 已兜住体积）
            const text = String(msg.text ?? "");
            if (!text.trim()) {
              send(ws, ackFrame(msg.id, false, { room: room.id, error: "消息为空", code: "bad_args" }), cfg);
              return;
            }
            // 带上 room：会话切换窗口内旧房间仍 online，扩展可据此拒绝注入到已离开的会话
            const frame = { type: "message", room: room.id, text };
            if (cid && hasCap(room.local, "msg.cid")) frame.cid = cid;
            if (!forwardToLocal(ws, room, frame, msg, {
              offline: "本机未连接，消息无法送达",
              backpressure: "本机消息通道积压，消息未能送出，请稍后重试",
            })) return;
            send(ws, ackFrame(msg.id, true, { room: room.id }), cfg);
            break;
          }
          case "command": {
            // deviceId 替代 room 寻址；不带 deviceId 的命令仍按房间走
            if (msg.deviceId != null && String(msg.deviceId).trim()) {
              // P9 B：设备级删除走专用路由（四路由顺序见 routeDeleteSession）——不能直接交给
              // routeDeviceCommand：attach 不在线时它一上来就报 device_offline，可那时扩展房间可能还在线。
              if (String(msg.command || "") === "delete_session") routeDeleteSession(ws, msg);
              else routeDeviceCommand(ws, msg);
              break;
            }
            const room = rooms.touch(rooms.peek(String(msg.room || "")));
            const origId = msg.id ? String(msg.id) : null;
            if (!room) { send(ws, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), cfg); return; }
            // P9 B：旧网页按房间寻址的 delete_session，成功后同样清服务器副本。
            // 会话 id 从 sessionPath 反推（文件名最后一个 _ 之后、.jsonl 之前），索引键用服务端绑定的设备/账号。
            const extra = {};
            if (String(msg.command || "") === "delete_session") {
              const sessionId = sessionIdFromPath(msg.args && msg.args.sessionPath);
              if (sessionId) {
                const deviceId = String(room.deviceId || UNREGISTERED_DEVICE);
                const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
                extra.onResult = (result) => {
                  if (result && result.ok) purgeSessions({ accountId, deviceId, ids: [sessionId], rooms, store, devices, index, cfg });
                };
              }
            }
            // Body search over an enc room (design section 4.1): the relay cannot
            // read ciphertext and the extension-side scan would have to decrypt
            // per viewer — the room answers with an explicit unsupported marker
            // instead of being silently omitted from the results.
            if (String(msg.command || "") === "search_session_bodies" && store.encInfo(room.id)) {
              send(ws, ackFrame(origId, false, { error: "该会话已加密，正文搜索不支持", code: "unsupported", room: room.id, data: { unsupported: true, reason: "room_encrypted", roomId: room.id } }), cfg);
              break;
            }
            runCommand(ws, msg, room, room.local, extra);
            break;
          }
          case "dialog_answer_switch": {
            // O2 开关下达（UI→relay→桥）：relay 存当前值（桥重连时按存值重下达），在线桥即时转发
            const room = rooms.touch(rooms.peek(String(msg.room || "")));
            const origId = msg.id ? String(msg.id) : null;
            if (!room) { send(ws, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), cfg); return; }
            const enabled = msg.enabled === true;
            room.dialogRemoteAnswer = enabled;
            if (room.local) send(room.local, { type: "dialog_answer_switch", room: room.id, enabled }, cfg);
            send(ws, ackFrame(origId, true, { room: room.id }), cfg);
            break;
          }
          case "ask_user_switch": {
            // G1 开关下达（与 dialog_answer_switch 同路同纪律）：relay 存当前值，桥重连按存值重下达
            const room = rooms.touch(rooms.peek(String(msg.room || "")));
            const origId = msg.id ? String(msg.id) : null;
            if (!room) { send(ws, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), cfg); return; }
            const enabled = msg.enabled === true;
            room.askUserEnabled = enabled;
            if (room.local) send(room.local, { type: "ask_user_switch", room: room.id, enabled }, cfg);
            send(ws, ackFrame(origId, true, { room: room.id }), cfg);
            break;
          }
          case "approval_gate_switch": {
            // G2 开关下达（同上）：存整份配置（enabled + 合法 tier + 名单），重下达时原样发回；
            // tier/tools 不合法就不带——桥侧只在合法时采纳，缺省即保持桥当前值
            const room = rooms.touch(rooms.peek(String(msg.room || "")));
            const origId = msg.id ? String(msg.id) : null;
            if (!room) { send(ws, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), cfg); return; }
            const stored = { enabled: msg.enabled === true };
            if (APPROVAL_GATE_TIERS.includes(msg.tier)) stored.tier = msg.tier;
            if (Array.isArray(msg.tools)) {
              stored.tools = msg.tools.filter((t) => typeof t === "string" && t && t.length <= 128).slice(0, 64);
            }
            room.approvalGateSwitch = stored;
            if (room.local) send(room.local, { type: "approval_gate_switch", room: room.id, ...stored }, cfg);
            send(ws, ackFrame(origId, true, { room: room.id }), cfg);
            break;
          }
          case "prefs_set": {
            // 主题偏好同步（R4-1）：viewer 上行一份外观子集，relay 按到达顺序裁决（LWW），
            // rev+1 后回执发送端（prefs_saved，只给发送端对齐用）、广播其他声明了
            // prefs.sync 的 viewer（prefs_changed，发送端不收，防回声从通道层断掉）。
            // baseRev 只作信息：落后不拒绝（单用户冲突概率极低），发送端以回带 rev 为准。
            // 低-25：relay 侧按字段合并子集（客户端可只上行变化字段），baseRev 用于日志诊断。
            const origId = msg.id ? String(msg.id) : null;
            if (!hasCap(ws, "prefs.sync")) {
              send(ws, errorFrame("unsupported", "此端未声明 prefs.sync 能力", { id: origId }), cfg);
              return;
            }
            const maxBytes = (PROTOCOL.limits && PROTOCOL.limits.prefsSubsetMaxBytes) || 2048;
            let rawBytes = 0;
            try { rawBytes = Buffer.byteLength(JSON.stringify(msg.subset ?? null)); } catch { rawBytes = maxBytes + 1; }
            if (rawBytes > maxBytes) {
              send(ws, errorFrame("payload_too_large", "偏好子集帧太大", { id: origId }), cfg);
              return;
            }
            const subset = cleanPrefsSubset(msg.subset);
            if (!subset) {
              send(ws, errorFrame("bad_args", "偏好子集不合法（只收 theme/chrome/font/size/mono + mobileNav）", { id: origId }), cfg);
              return;
            }
            const baseRev = Number.isSafeInteger(msg.baseRev) && msg.baseRev >= 0 ? msg.baseRev : null;
            const rec = prefsStore.set(viewerAccount(), subset, Date.now(), baseRev);
            send(ws, { type: "prefs_saved", rev: rec.rev, updatedAt: rec.updatedAt }, cfg);
            broadcast([...rooms.viewers].filter((v) => v !== ws && hasCap(v, "prefs.sync")), {
              type: "prefs_changed",
              subset: rec.subset,
              rev: rec.rev,
              updatedAt: rec.updatedAt,
            }, cfg);
            break;
          }
          case "dialog_answer": {
            // O2 应答（先答广播）：relay 只做校验+转发+回执对号，裁决在桥（首达 resolve）。
            // dialog 不在缓存槽里（已关闭/从未接管）→ 直接 dialog_gone，不惊动桥。
            const room = rooms.touch(rooms.peek(String(msg.room || "")));
            const origId = msg.id ? String(msg.id) : null;
            if (!room) { send(ws, ackFrame(origId, false, { error: "会话不存在", code: "no_room" }), cfg); return; }
            // 应答面按 cap 门控（A-6）：未声明 dialog.respond 的（旧）端不许应答，按
            // "已关闭"回绝，不转发、不建 waiter。观察形态的 dialog 卡不受此限——
            // 补发/直播只剥 answerable 字段，卡片照常只读展示。
            if (!hasCap(ws, "dialog.respond")) {
              send(ws, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), cfg);
              return;
            }
            const dialogId = typeof msg.dialogId === "string" ? msg.dialogId.slice(0, 64) : "";
            const slot = dialogId && room.dialogs ? room.dialogs[dialogId] : null;
            if (!slot || slot.answerable !== true || !room.online || !room.local) {
              send(ws, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), cfg);
              return;
            }
            // 多选槽（G3）再加一道 cap：未声明 dialog.multiselect 的端从未拿到可答卡，
            // 其应答同样按"已关闭"回绝、不转发（与 A-6 的 respond 门控同姿势）。
            if (slot.kind === "multiselect" && !hasCap(ws, "dialog.multiselect")) {
              send(ws, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), cfg);
              return;
            }
            const action = msg.action === "allow" || msg.action === "submit" || msg.action === "deny" ? msg.action : null;
            if (!action) {
              send(ws, errorFrame("bad_args", "action 只能是 allow / submit / deny", { id: origId, room: room.id }), cfg);
              return;
            }
            const frame = { type: "dialog_answer", room: room.id, dialogId, action };
            if (typeof msg.value === "string") frame.value = msg.value;
            // 多选应答的 values 数组：按 limits 钳制后转发，逐项裁决（过滤伪造/去重/min-max）在桥
            if (Array.isArray(msg.values)) {
              const L = PROTOCOL.limits || {};
              frame.values = msg.values.slice(0, L.dialogOptionsMax || 20).map((v) => String(v ?? "").slice(0, L.dialogOptionChars || 80));
            }
            if (action === "deny" && typeof msg.note === "string" && msg.note.trim()) {
              frame.note = msg.note.slice(0, (PROTOCOL.limits && PROTOCOL.limits.dialogNoteMax) || 500);
            }
            const aid = "ans-" + (++dialogAnswerSeq);
            frame.aid = aid;
            const waiter = { ws, origId, room, dialogId, local: room.local, timer: null };
            waiter.timer = setTimeout(() => {
              if (!rooms.dialogAnswerWaiters.delete(aid)) return;
              send(ws, errorFrame("timeout", "本机没有回应应答结果，请重试", { id: origId, room: room.id }), cfg);
            }, DIALOG_ANSWER_RESULT_TIMEOUT_MS);
            waiter.timer.unref();
            rooms.dialogAnswerWaiters.set(aid, waiter);
            if (!send(room.local, frame, cfg)) {
              rooms.dialogAnswerWaiters.delete(aid);
              clearTimeout(waiter.timer);
              send(ws, errorFrame("dialog_gone", undefined, { id: origId, room: room.id }), cfg);
            }
            break;
          }
          case "abort": {
            const room = rooms.touch(rooms.peek(String(msg.room || "")));
            if (!room) {
              send(ws, ackFrame(msg.id, false, { error: "会话不存在", code: "no_room" }), cfg);
              return;
            }
            if (!forwardToLocal(ws, room, { type: "abort", room: room.id }, msg, {
              offline: "本机未连接，无法中断",
              backpressure: "本机消息通道积压，中断请求未能送出，请稍后重试",
            })) return;
            send(ws, ackFrame(msg.id, true, { room: room.id }), cfg);
            break;
          }
          case "pair_create": {
            // 生成配对码是管理员操作：adminToken/adminSig 都不过都在这里返回，不生成码
            if (rejectAdminAny(ws, msg)) break;
            // 配对码只在内存里、只能用一次；日志不打印码本身
            const origId = msg.id ? String(msg.id) : null;
            const now = Date.now();
            for (const [k, e] of ctx.pairCodes) if (e.expiresAt <= now) ctx.pairCodes.delete(k);
            if (ctx.pairCodes.size >= PAIR_CODES_MAX) {
              send(ws, ackFrame(origId, false, { error: "未使用的配对码太多，等旧的过期后再生成", code: "rate_limited" }), cfg);
              return;
            }
            const code = newPairCode(ctx.pairCodes);
            const name = typeof msg.name === "string" ? msg.name.trim().slice(0, MAX_DEVICE_NAME) : "";
            const expiresAt = now + (cfg.pairCodeTtlMs || PROTOCOL.limits.pairCodeTtlMs);
            ctx.pairCodes.set(code, { accountId: normalizeAccount(cfg.accountId), name, expiresAt });
            log("生成配对码:", name || "-", "有效至", new Date(expiresAt).toISOString());
            send(ws, ackFrame(origId, true, { data: { code: formatPairCode(code), expiresAt } }), cfg);
            break;
          }
          case "pair_lookup": {
            // 二维码链接确认页拉待链接设备信息：只对 pending 条目（pair_request 申请、连接还活着的）
            // 回非秘密元数据；普通手输码、不存在、已过期的码一律失败，失败按来源计入配对限速记账。
            const origId = msg.id ? String(msg.id) : null;
            const now = Date.now();
            if (pairSourceBlocked(ctx.pairFailures, source, now)) {
              send(ws, errorFrame("rate_limited", "配对尝试太频繁，请一分钟后再试", { id: origId }), cfg);
              return;
            }
            const code = normalizePairCode(msg.code);
            const entry = code ? ctx.pairCodes.get(code) : null;
            const expired = !!entry && entry.expiresAt <= now;
            if (!entry || !entry.pending || expired) {
              notePairFailure(ctx.pairFailures, source, now);
              if (expired) ctx.pairCodes.delete(code);
              log("pair_lookup 失败:", source, expired ? "配对码过期" : "配对码无效或不是待链接码");
              send(ws, errorFrame(expired ? "pair_expired" : "pair_invalid", undefined, { id: origId }), cfg);
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
            send(ws, found, cfg);
            // 通知等待端「码已被扫/被查」：窗口切处理中態。只发一次（重复 lookup 不重发），
            // 等待端不依赖这帧完成主链路（pair_result 才是结果），发不出去也不影响批准流程。
            if (!entry.pending.claimed && entry.pending.ws && entry.pending.ws.readyState === 1) {
              entry.pending.claimed = true;
              try { send(entry.pending.ws, { type: "pair_claimed" }, cfg); } catch {}
            }
            break;
          }
          case "pair_approve": {
            // 手机端批准二维码链接：先过管理员门（与 pair_create 同门），再走 local 侧的共用签发段，
            // 结果沿 pending 的等待连接回 pair_result；本端只回 ack，不经手设备令牌明文之外的东西。
            if (rejectAdminAny(ws, msg)) break;
            const origId = msg.id ? String(msg.id) : null;
            const now = Date.now();
            if (pairSourceBlocked(ctx.pairFailures, source, now)) {
              send(ws, ackFrame(origId, false, { error: "配对尝试太频繁，请一分钟后再试", code: "rate_limited" }), cfg);
              return;
            }
            const code = normalizePairCode(msg.code);
            const entry = code ? ctx.pairCodes.get(code) : null;
            const expired = !!entry && entry.expiresAt <= now;
            if (!entry || !entry.pending || expired) {
              notePairFailure(ctx.pairFailures, source, now);
              if (expired) ctx.pairCodes.delete(code);
              log("pair_approve 失败:", source, expired ? "配对码过期" : "配对码无效或不是待链接码");
              send(ws, ackFrame(origId, false, { code: expired ? "pair_expired" : "pair_invalid" }), cfg);
              return;
            }
            const pendingWs = entry.pending.ws;
            if (!pendingWs || pendingWs.readyState !== 1) {
              // 等待端已经断开（其 close 处理通常已删码，这里兜底）：删码并告知批准端重跑 attach --link
              ctx.pairCodes.delete(code);
              log("pair_approve 失败：等待连接已断开");
              send(ws, ackFrame(origId, false, { error: "设备等待连接已断开，请在设备上重新运行 attach --link", code: "offline" }), cfg);
              return;
            }
            if (typeof ctx.issuePairEntry !== "function") {
              send(ws, ackFrame(origId, false, { error: "relay 内部未就绪", code: "server_error" }), cfg);
              return;
            }
            const r = ctx.issuePairEntry({ code, entry, cleaned: entry.pending.device, presentedToken: entry.pending.deviceToken, exceptWs: pendingWs, keys: entry.pending.keys || undefined });
            if (!r.ok) {
              // 签发被拒（如重新配对旧令牌不达标）：等待端同步收到失败，别让它干等到过期；
              // 本次申请到此为止，删码关连接，设备想再试要重新 attach --link。
              send(pendingWs, { type: "pair_result", ok: false, code: r.code, error: r.error }, cfg);
              try { pendingWs.close(1000, "pair done"); } catch {}
              ctx.pairCodes.delete(code);
              send(ws, ackFrame(origId, false, { error: r.error, code: r.code }), cfg);
              return;
            }
            if (r.keyRegistered) {
              // 钥设备：不经手令牌（根本没签发）；批准端算好的 ACK 包裹（contentKeyGrant）
              // 只做形状清洗后原样透传进 pair_result，不解析、不落盘（设计 §3.2/§7）。
              // 本阶段观看端尚无钥（阶段 2 才有发送方），字段多半缺席，清洗别挡正常批准的路。
              const result = { type: "pair_result", ok: true, accountId: r.accountId, deviceId: r.deviceId, keyRegistered: true, hasKeyHolder: !!r.hasKeyHolder };
              const grant = msg.contentKeyGrant != null && typeof ctx.cleanKeyGrant === "function" ? ctx.cleanKeyGrant(msg.contentKeyGrant) : null;
              if (grant) result.contentKeyGrant = grant;
              else if (msg.contentKeyGrant != null) log("pair_approve 的 contentKeyGrant 形状不合规，已忽略（批准照常）");
              send(pendingWs, result, cfg);
            } else {
              send(pendingWs, { type: "pair_result", ok: true, accountId: r.accountId, deviceId: r.deviceId, deviceToken: r.deviceToken }, cfg);
            }
            try { pendingWs.close(1000, "pair done"); } catch {}
            log("二维码链接批准完成:", r.accountId, r.deviceId);
            send(ws, ackFrame(origId, true, { deviceId: r.deviceId, data: { deviceId: r.deviceId, name: entry.pending.device.name } }), cfg);
            break;
          }
          case "device_revoke": {
            // 撤销设备是管理员操作：先过管理员门（adminToken/adminSig），未通过时连设备是否存在都不查、不撤令牌、不断连接
            if (rejectAdminAny(ws, msg)) break;
            const origId = msg.id ? String(msg.id) : null;
            const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
            if (!deviceId) {
              send(ws, ackFrame(origId, false, { error: "缺少 deviceId", code: "bad_args" }), cfg);
              return;
            }
            const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
            let revoked = 0;
            try {
              const known = devices.has(deviceId) || !!index.getDeviceRow(accountId, deviceId) || index.hasDeviceToken(accountId, deviceId);
              if (!known) {
                send(ws, ackFrame(origId, false, { error: DEVICE_ERRORS.no_device, code: "no_device", deviceId }), cfg);
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
            } catch (e) {
              log("撤销设备令牌失败:", deviceId, e.message);
              send(ws, ackFrame(origId, false, { error: "撤销失败：令牌文件写不进去", code: "server_error", deviceId }), cfg);
              return;
            }
            const closed = ctx.dropDevice(deviceId);
            log("撤销设备:", accountId, deviceId, "作废令牌", revoked, "断开连接", closed);
            send(ws, ackFrame(origId, true, { deviceId, data: { revoked, closed } }), cfg);
            rooms.broadcastRoomList();
            break;
          }
          case "viewer_register": {
            // Viewer identity registration (crypto Phase 2, design §3.2 / §7): first
            // registration is an admin operation on the dual-track gate. Keys may ride
            // at the frame top level or nested under `keys`. The roster row written
            // here is the only authority for key auth and grant stamping afterwards.
            if (rejectAdminAny(ws, msg)) break;
            const origId = msg.id ? String(msg.id) : null;
            const viewerId = typeof msg.viewerId === "string" ? msg.viewerId.trim() : "";
            if (!viewerId || !safeId(viewerId)) {
              send(ws, ackFrame(origId, false, { error: "viewerId 不合规", code: "bad_args" }), cfg);
              return;
            }
            const pubs = cleanViewerPubKeys(msg.keys && typeof msg.keys === "object" ? msg.keys : msg);
            if (!pubs) {
              send(ws, ackFrame(origId, false, { error: "公钥不合规：signPub/boxPub 都必须是 P-256 spki 公钥（base64）", code: "bad_args" }), cfg);
              return;
            }
            const prev = viewerRowSafe(viewerId);
            if (prev && !prev.revokedAt && (prev.signPub !== pubs.signPub || prev.boxPub !== pubs.boxPub)) {
              // Re-keying an active viewerId in place would silently swap identities;
              // the only path is revoke-then-register with fresh keys.
              send(ws, ackFrame(origId, false, { error: "该 viewerId 已登记其他公钥；换钥请先撤销旧登记再重新登记", code: "device_mismatch" }), cfg);
              return;
            }
            if (prev && prev.revokedAt && prev.signPub === pubs.signPub) {
              // A revoked signing key stays dead even if the same viewerId returns.
              send(ws, ackFrame(origId, false, { error: "这把签名公钥已被撤销，请生成新钥后重新登记", code: "device_revoked" }), cfg);
              return;
            }
            const row = { viewerId, signPub: pubs.signPub, boxPub: pubs.boxPub };
            const name = typeof msg.name === "string" ? msg.name.trim().slice(0, MAX_DEVICE_NAME) : "";
            if (name) row.name = name;
            if (typeof msg.admin === "boolean") row.admin = msg.admin;
            else if (!prev) row.admin = false;
            // Re-registration after a revoke (necessarily with new keys, per the check
            // above) clears the revocation.
            if (prev && prev.revokedAt) row.revokedAt = null;
            try {
              index.upsertViewer(viewerAccount(), row);
            } catch (e) {
              log("观看端登记失败:", viewerId, e.message);
              send(ws, ackFrame(origId, false, { error: "登记失败：名册文件写不进去", code: "server_error" }), cfg);
              return;
            }
            const saved = viewerRowSafe(viewerId);
            log("登记观看端身份钥:", viewerId, "指纹", keyFingerprint(pubs.signPub), saved && saved.admin ? "(admin)" : "");
            send(ws, ackFrame(origId, true, { data: { viewerId, keyFp: keyFingerprint(pubs.signPub), admin: !!(saved && saved.admin) } }), cfg);
            break;
          }
          case "list_viewers": {
            // Viewer roster listing (crypto Phase 2, design §7): admin-gated. Rows
            // expose no key material beyond the fingerprint, plus live online state.
            if (rejectAdminAny(ws, msg)) break;
            const origId = msg.id ? String(msg.id) : null;
            const online = new Set(viewerKeyEndpoints(viewerAccount()).map((e) => e.viewerId));
            let rows = [];
            try {
              rows = index.listViewers(viewerAccount());
            } catch {
              rows = [];
            }
            const frame = {
              type: "viewer_list",
              viewers: rows.map((r) => ({
                viewerId: r.viewerId,
                name: typeof r.name === "string" ? r.name : "",
                keyFp: r.signPub ? keyFingerprint(r.signPub) : null,
                admin: r.admin === true,
                createdAt: Number(r.createdAt) || 0,
                revokedAt: r.revokedAt || null,
                online: online.has(r.viewerId),
              })),
            };
            if (origId) frame.id = origId;
            send(ws, frame, cfg);
            break;
          }
          case "viewer_revoke": {
            // Revoke a viewer identity (crypto Phase 2, design §3.5): admin-gated.
            // Writes revokedAt and drops that viewer's live connections. The ack must
            // carry the rotation hint: revocation closes the access layer only — the
            // revoked viewer still holds its ACK copy, so cryptographic removal
            // requires rotating the ACK and re-distributing it to the kept ends.
            if (rejectAdminAny(ws, msg)) break;
            const origId = msg.id ? String(msg.id) : null;
            const viewerId = typeof msg.viewerId === "string" ? msg.viewerId.trim() : "";
            if (!viewerId) {
              send(ws, ackFrame(origId, false, { error: "缺少 viewerId", code: "bad_args" }), cfg);
              return;
            }
            if (!viewerRowSafe(viewerId)) {
              send(ws, ackFrame(origId, false, { error: "观看端不存在", code: "not_found", viewerId }), cfg);
              return;
            }
            try {
              index.upsertViewer(viewerAccount(), { viewerId, revokedAt: Date.now() });
            } catch (e) {
              log("撤销观看端失败:", viewerId, e.message);
              send(ws, ackFrame(origId, false, { error: "撤销失败：名册文件写不进去", code: "server_error", viewerId }), cfg);
              return;
            }
            ackTrackerOf(ctx).forget(viewerAccount(), "viewer:" + viewerId);
            let closed = 0;
            for (const c of [...rooms.viewers]) {
              const cs = c._state;
              if (!cs || cs.viewerId !== viewerId) continue;
              send(c, errorFrame("device_revoked"), cfg);
              try { c.close(4003, "viewer revoked"); } catch {}
              closed++;
            }
            log("撤销观看端:", viewerId, "断开连接", closed);
            send(ws, ackFrame(origId, true, {
              viewerId,
              data: {
                viewerId,
                closed,
                ackRotationRequired: true,
                hint: "撤销只关掉接入层：这台观看端仍留有本账号内容钥（ACK）的副本，密码学上并未移除。要彻底移除，必须轮换 ACK——让任一在线持钥端生成新 ACK 并重新分发给保留的端，被撤销的端不要再收到新钥。",
              },
            }), cfg);
            break;
          }
          case "content_key_request": {
            // Content-key delivery request from a keyed viewer (crypto Phase 2,
            // design §7): the sender must be key-authed with an active roster row.
            // The relay stamps `from`/`fromBoxPub` from the roster (never from the
            // frame) and forwards to every other keyed end of the account.
            if (s.auth !== "key" || !s.viewerId) {
              send(ws, errorFrame("device_mismatch", "只有完成密钥登录的观看端能请求内容钥交付"), cfg);
              return;
            }
            const row = viewerRowSafe(s.viewerId);
            if (!row || row.revokedAt || !row.signPub || !row.boxPub) {
              send(ws, errorFrame("device_mismatch", "观看端名册钥不可用，不能请求内容钥交付"), cfg);
              return;
            }
            const accountId = viewerAccount();
            const frame = { type: "content_key_request", from: keyFingerprint(row.signPub), fromBoxPub: row.boxPub, accountId };
            let delivered = 0;
            if (typeof ctx.localKeyEndpoints === "function") {
              for (const e of ctx.localKeyEndpoints(accountId)) {
                if (send(e.ws, frame, cfg)) delivered++;
              }
            }
            for (const e of viewerKeyEndpoints(accountId)) {
              if (e.ws === ws) continue;
              if (send(e.ws, frame, cfg)) delivered++;
            }
            if (!delivered) {
              send(ws, errorFrame("offline", "本账号当前没有其他在线的持钥端，内容钥交付要等持钥设备上线后再请求"), cfg);
            }
            break;
          }
          case "content_key_grant": {
            // Content-key delivery from a keyed viewer (crypto Phase 2, design §7):
            // shape-cleaned by the shared cleaner, stamped from the roster (a
            // sender-supplied from/fromBoxPub inside the blob is never trusted), then
            // routed by target fingerprint to devices and viewers alike.
            if (s.auth !== "key" || !s.viewerId) {
              send(ws, errorFrame("device_mismatch", "只有完成密钥登录的观看端能发送内容钥交付"), cfg);
              return;
            }
            if (typeof ctx.cleanKeyGrant !== "function" || typeof ctx.routeContentKeyGrant !== "function") {
              send(ws, errorFrame("server_error", "relay 内部未就绪"), cfg);
              return;
            }
            const grant = ctx.cleanKeyGrant(msg);
            if (!grant) {
              send(ws, errorFrame("bad_args", "content_key_grant 字段不合规（需要 to 指纹、nonce 与 ct 包裹）"), cfg);
              return;
            }
            const row = viewerRowSafe(s.viewerId);
            if (!row || row.revokedAt || !row.signPub || !row.boxPub) {
              send(ws, errorFrame("device_mismatch", "观看端名册钥不可用，不能发送内容钥交付"), cfg);
              return;
            }
            const frame = { type: "content_key_grant", ...grant, from: keyFingerprint(row.signPub), fromBoxPub: row.boxPub };
            if (!ctx.routeContentKeyGrant(viewerAccount(), grant.to, frame)) {
              send(ws, errorFrame("offline", "目标端不在线，内容钥未能送达（relay 不缓存交付，请待其上线后重发）"), cfg);
            }
            break;
          }
          case "ack_report": {
            // ackFp reconciliation (design §3.5 / §7): same contract as the local
            // channel — fingerprints only, never the key itself.
            if (s.auth !== "key" || !s.viewerId) return;
            if (!isAckFp(msg.ackFp)) {
              send(ws, errorFrame("bad_args", "ackFp 必须是 16 位小写十六进制指纹"), cfg);
              return;
            }
            ackTrackerOf(ctx).report(viewerAccount(), "viewer:" + s.viewerId, msg.ackFp, (frame) => send(ws, frame, cfg));
            break;
          }
          case "ping":
            send(ws, { type: "pong" }, cfg);
            break;
          default:
            send(ws, errorFrame("unknown_type", `未知消息类型：${msg.type}`, { id: typeof msg.id === "string" ? msg.id : undefined }), cfg);
        }
      },
    });

    ws.on("close", () => {
      // A disconnected keyed viewer no longer counts in ackFp reconciliation.
      const vst = ws._state;
      if (vst && vst.authed && vst.auth === "key" && vst.viewerId) {
        try { ackTrackerOf(ctx).forget(viewerAccount(), "viewer:" + vst.viewerId); } catch {}
      }
      const wasViewer = rooms.viewers.delete(ws);
      const room = ws._room;
      if (room) {
        room.viewers.delete(ws);
        pushDialogGate(room, cfg);
        if (room.resendWaiters) room.resendWaiters = room.resendWaiters.filter((w) => w !== ws);
      }
      // O2 应答回执：这条连接在等的回执随它一起作废（桥的迟到回执到时 waiter 已不存在，自然丢弃）
      for (const [aid, waiter] of rooms.dialogAnswerWaiters) {
        if (waiter.ws !== ws) continue;
        rooms.dialogAnswerWaiters.delete(aid);
        if (waiter.timer) clearTimeout(waiter.timer);
      }
      for (const [id, q] of rooms.viewerQueries) {
        if (q.ws !== ws) continue;
        clearTimeout(q.timer);
        rooms.viewerQueries.delete(id);
      }
      // 该连接在等的命令：摘掉它的 waiter（命令本身照常执行完，结果留在去重表里供重连后重发取回）
      // harness_start 即使没人等也留到结果或超时，避免串行锁被提前放开后又起一份
      for (const entry of rooms.commandWaiters.values()) {
        const before = entry.waiters.length;
        entry.waiters = entry.waiters.filter((w) => {
          if (w.ws !== ws) return true;
          // harness_start 的定时器必须留着：查看端断开不能把唯一的超时清掉，否则 startInFlight 永远不放开
          if (entry.command === "harness_start" && !entry._settled) return true;
          finishWaiter(w);
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
