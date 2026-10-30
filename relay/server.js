"use strict";
/**
 * pi-remote relay —— 纯分发/中转服务器。
 *
 * 两个独立端口，两种角色，物理隔离：
 *   7001 local  通道：只接受本机 pi 扩展的连接（写权限：收事件、被注入消息）
 *   7002 viewer 通道：电脑/手机页面（web/）+ WebSocket（读+发消息+中断，无文件传输）
 *
 * 数据接口纪律：
 *   - 只讲一种协议：JSON over WebSocket；二进制帧直接拒
 *   - viewer 单条消息 ≤ maxPayloadBytes（默认 256KB），超限断开；local 通道 16MB
 *   - viewer 每连接限速（默认 20 msg/s，突发 60）；已认证的 local 连接不限速（本机扩展的事件流是可信的，
 *     限速只会丢 delta / 收尾信号）
 *   - 认证超时 10s；30s 心跳；无任何文件上传/下载/路径类接口
 *   - 对话正文默认不写入 data/rooms（PI_REMOTE_PERSIST_TRANSCRIPTS=1 才落盘）。
 *     活跃会话仍在内存热缓存里转发；快照安全阀 maxSnapshotRecords / maxSnapshotBytes。
 *     名册与会话清单在 data/accounts（relay/index.js）。
 *   - 增量：存储记录带 seq、房间带 rev；viewer 断线重连带 {rev, seq} 只收增量，
 *     扩展重连先拿 room_registered 里的锚点，只上传尾部（append）
 *   - 背压：落后的 viewer 只跳过可丢的流式 delta，关键帧照发；缓冲超过硬顶才断开
 *   - remote 回显被同文本 user 消息取代后读时过滤
 *
 * 代码按职责分文件，server.js 只管装配与启动：
 *   config 配置 · wire 协议 v4 与发帧 · conn 连接通用（认证超时/限速/心跳）· commands 命令超时与路由
 *   devices 设备名册 · pairing 配对与设备令牌 · rooms 房间 · local 7001 通道 · viewer 7002 通道
 *   web 静态页面与 /healthz · store 会话存储 · index 账号/设备/会话索引 · util 日志等小工具
 */
const fs = require("node:fs");
const path = require("node:path");
const { RoomStore } = require("./store");
const { AccountIndex } = require("./index");
const { setQuiet, log } = require("./util");
const { LOG_DIR, DEFAULT_CONFIG, loadConfig, normalizeAccount } = require("./config");
const { RELAY_VERSION } = require("./wire");
const { PAIR_FAIL_WINDOW_MS, requestSource } = require("./pairing");
const { commandTimeoutMs, pruneDedupe } = require("./commands");
const { normalizePlatform, normPath, cwdAllowed, cleanProjects, buildDeviceList } = require("./devices");
const { cancelResend, Rooms, shrinkImagesDeep } = require("./rooms");
const { ackTrackerOf } = require("./acktrack");
const { InboxStore } = require("./inbox");
const { ScheduleStore, ScheduleEngine } = require("./schedule");
const { startLocalServer } = require("./local");
const { startViewerServer } = require("./viewer");
const { UsageBroker } = require("./usage");

/* ---------------- 数据目录进程锁（低-5） ----------------
 * 两个 relay 共用 data/rooms 会互相覆盖房间文件、清对方的索引/缓存。用一个原子创建的
 * 锁文件把"同一份数据目录同时只有一个 relay 进程"变成启动前置条件；锁里只放 pid/时间，
 * 不含令牌或正文。正常 close 时删除；进程被 kill -9 留下的锁由下一次启动按 pid 存活探测回收。
 */
const DATA_DIR_LOCK_FILE = ".relay.lock";
/** resolved dataDir → lock（同一进程内重复启动同一目录也要报错，不靠 pid 自比） */
const heldDataDirLocks = new Map();

function readLockPid(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const first = String(raw).split("\n", 1)[0].trim();
    let pid = Number(first);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      // 兼容纯文本 pid 锁 / 早期无版本锁
      const obj = JSON.parse(first);
      pid = Number(obj && obj.pid);
    }
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但不属于当前用户；仍然算占用。
    return !!(e && e.code === "EPERM");
  }
}

function acquireDataDirLock(dataDir) {
  const dir = path.resolve(String(dataDir || ""));
  if (!dir) throw new Error("dataDir 不能为空");
  if (heldDataDirLocks.has(dir)) {
    throw new Error(`数据目录 ${dir} 已被本进程里的另一个 relay 实例使用；同一数据目录不能开两个 relay`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, DATA_DIR_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), v: 1 }) + "\n", "utf8");
      try { fs.fsyncSync(fd); } catch {}
      fs.closeSync(fd);
      fd = null;
      const lock = { dir, file, pid: process.pid };
      heldDataDirLocks.set(dir, lock);
      return lock;
    } catch (e) {
      if (fd !== null && fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
        fd = null;
      }
      if (!e || e.code !== "EEXIST") throw new Error(`数据目录锁创建失败（${file}）：${e && e.message ? e.message : e}`);
      const pid = readLockPid(file);
      // 同进程且登记在 heldDataDirLocks 的情况上面已拦掉；这里同 pid 只可能是 PID 复用留下的旧锁。
      if (pid && pid !== process.pid && pidAlive(pid)) {
        throw new Error(`数据目录 ${dir} 已被另一个 relay 进程占用（pid ${pid}）。请先停掉那个实例，或改用不同的 dataDir；同一数据目录开两个 relay 会互相覆盖房间文件。`);
      }
      // 陈旧锁：先用 rename 独占改名再删，两个进程同时回收时只有一个能成功，避免双开竞态。
      const stale = file + ".stale-" + process.pid + "-" + Date.now();
      try {
        fs.renameSync(file, stale);
        try { fs.unlinkSync(stale); } catch {}
      } catch (e2) {
        if (!e2 || e2.code !== "ENOENT") throw new Error(`数据目录锁回收失败（${file}）：${e2 && e2.message ? e2.message : e2}`);
      }
    }
  }
  throw new Error(`数据目录锁获取失败（${file}）：另一个 relay 正在同时启动，请稍后重试`);
}

function releaseDataDirLock(lock) {
  if (!lock) return false;
  heldDataDirLocks.delete(lock.dir);
  try {
    const pid = readLockPid(lock.file);
    if (pid && pid !== process.pid) return false; // 锁已被别人接管（异常路径），不能删别人的
    fs.unlinkSync(lock.file);
    return true;
  } catch (e) {
    if (!e || e.code !== "ENOENT") log("数据目录锁释放失败（锁文件可能残留，重启时会按 pid 回收）:", lock.file, e && e.message);
    return false;
  }
}

/**
 * 关闭 viewer 的 HTTP 服务（低-14）。Node 的 server.close() 只停止 accept，不主动断开
 * keep-alive/半开连接：浏览器留着的 HTTP 长连接会让关闭回调一直等到超时。
 * 先关空闲连接；宽限期后强制断开全部连接；最后用看门狗保证 close() 一定能在秒级完成。
 */
function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    let done = false;
    let forceTimer = null;
    let watchdog = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (watchdog) clearTimeout(watchdog);
      resolve();
    };
    try {
      server.close(finish);
    } catch {
      return finish();
    }
    try { if (typeof server.closeIdleConnections === "function") server.closeIdleConnections(); } catch {}
    forceTimer = setTimeout(() => {
      try { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); } catch {}
    }, 250);
    if (forceTimer.unref) forceTimer.unref();
    watchdog = setTimeout(() => {
      try { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); } catch {}
      log("viewer HTTP 连接未在宽限期内关闭，已强制断开");
      finish();
    }, 1500);
    if (watchdog.unref) watchdog.unref();
  });
}


/**
 * 启动 relay（可编程：测试用 port 0 + 临时数据目录）。
 * 返回 Promise<{cfg, rooms, store, localPort, viewerPort, close()}>；启动失败（端口占用/目录不可写等）
 * 会 reject，并先清理已建好的另一个通道，避免留下半启动的监听（报告 relay 中-11）。
 */
function startRelay(overrides = {}) {
  let dataDirLock = null;
  try {
    const cfg = { ...DEFAULT_CONFIG, ...overrides };
    // 低-13：两个通道配成同一个端口时先明确拒绝，不等到第二个 listen 才报 EADDRINUSE
    // （那条错误看不出是配置问题）。port 0 是测试/嵌入方的临时端口语义，不在此列。
    if (cfg.localPort !== 0 && cfg.viewerPort !== 0 && Number(cfg.localPort) === Number(cfg.viewerPort)) {
      throw new Error(`localPort 与 viewerPort 不能配成同一个端口（${cfg.localPort}）：local 与 viewer 是两个独立监听，请分别配置`);
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, "accountsDir")) {
      const resolved = path.resolve(cfg.dataDir);
      // 生产目录 data/rooms → 同级 data/accounts；其它数据目录（测试临时目录）把索引放进去，避免互相覆盖
      cfg.accountsDir = path.basename(resolved) === "rooms"
        ? path.join(path.dirname(resolved), "accounts")
        : path.join(resolved, "accounts");
    }
    // 低-5：同一数据目录只允许一个 relay 进程。放在建房间/存储之前，失败不留下半初始化状态。
    dataDirLock = acquireDataDirLock(cfg.dataDir);
    setQuiet(cfg.quiet);
    // 启动时的两条安全提醒：只警告，不改行为，老设备仍能连
    if (cfg.localToken && cfg.viewerToken && cfg.localToken === cfg.viewerToken) {
      log("警告：localToken 与 viewerToken 相同。viewer token 会发给手机/浏览器，共享 localToken 也会跟着扩散；建议轮换成两个不同的值。");
    }
    if (cfg.allowLegacyLocal && cfg.localHost && !["127.0.0.1", "::1", "localhost"].includes(String(cfg.localHost))) {
      log("警告：local 通道对公网开放，且仍接受共享 localToken（legacy）。所有设备完成配对后可设 PI_REMOTE_ALLOW_LEGACY_LOCAL=0。");
    }
    const rooms = new Rooms(cfg);
    const devices = new Map();
    const index = new AccountIndex(cfg.accountsDir);
    rooms.sessionLookup = (accountId, deviceId, sessionId) => {
      try { return index.getSession(accountId, deviceId, sessionId); } catch { return null; }
    };
    rooms.deviceSnapshot = () => buildDeviceList(index, devices, rooms, normalizeAccount(cfg.accountId));
    rooms.deviceConns = () => [...devices.values()].map((dev) => dev.conn).filter(Boolean);
    const store = new RoomStore(cfg.dataDir, {
      cacheSize: cfg.cacheSize,
      cacheMaxBytes: cfg.cacheMaxBytes,
      flushIntervalMs: cfg.flushIntervalMs,
      persist: !!cfg.persistTranscripts,
    });
    rooms.bindStore(store);
    // 收件箱账本（设计 D §1）：与 prefs 同根落盘（accounts 目录下 per-account inbox.json），
    // 只存元数据；prime 主账号让重启后的第一份 room_list 就带上恢复的未读条目。
    const inboxStore = new InboxStore(cfg.accountsDir);
    inboxStore.prime(normalizeAccount(cfg.accountId));
    rooms.bindInbox(inboxStore);
    // 定时排期（设计 D §3）：排期表与账本同根落盘（per-account schedules.json）；计时器
    // 是全局职责——primeAll 把所有账号的存量排期都读回来，重启后 armed 排期全部恢复
    // 算账，不等对应账号先有房间活动。引擎在两个通道监听就绪后再 start（见 ready）。
    const scheduleStore = new ScheduleStore(cfg.accountsDir);
    scheduleStore.primeAll();
    const scheduleEngine = new ScheduleEngine({
      store: scheduleStore,
      inbox: inboxStore,
      tickMs: cfg.scheduleTickMs,
      graceMs: cfg.scheduleOnceGraceMs,
      startGraceMs: cfg.scheduleStartGraceMs,
    });
    rooms.bindSchedule(scheduleEngine);
    // pairCodes：码 → {accountId, name, expiresAt}，只在内存；二维码链接（pair_request）申请的条目
    // 多带 pending:{ws, device, deviceToken?}，绑定申请连接、连接断开即删码；pairFailures：来源 → 它最近配对失败的时间戳
    const ctx = { index, devices, pairCodes: new Map(), pairFailures: new Map(), startedAt: Date.now(), usage: null };
    // Phase 4 T-1: room_list encReason derivation reads the account ackFp
    // consensus from the same tracker the local/viewer channels reconcile on.
    rooms.ackFpLookup = (accountId) => ackTrackerOf(ctx).knownAckFp(accountId);
    const usageBroker = new UsageBroker({ cfg, index, devices, rooms });
    ctx.usage = usageBroker;

    return new Promise((resolve, reject) => {
      let pending = 2;
      let settled = false;
      let evictTimer = null;
      let localWss = null;
      let viewer = null;
      let localPort = 0;
      let viewerPort = 0;

      /** 启动失败时把已经起来的一半收干净（监听、心跳、定时器、缓存），不留悬挂资源。 */
      const cleanup = () => {
        if (evictTimer) clearInterval(evictTimer);
        try { scheduleEngine.stop(); } catch {}
        try { usageBroker.dispose(); } catch {}
        try { for (const r of rooms.map.values()) cancelResend(r); } catch {}
        try { for (const q of rooms.viewerQueries.values()) clearTimeout(q.timer); } catch {}
        try { rooms.viewerQueries.clear(); } catch {}
        try {
          if (localWss) {
            if (localWss._keepalive) clearInterval(localWss._keepalive);
            for (const c of localWss.clients) c.terminate();
            localWss.close();
          }
        } catch {}
        try {
          if (viewer) {
            if (viewer.wss._keepalive) clearInterval(viewer.wss._keepalive);
            for (const c of viewer.wss.clients) c.terminate();
            viewer.wss.close();
            // 启动失败路径也要强制断开 keep-alive，否则 server.close 挂着、锁迟迟不释放。
            try { if (typeof viewer.server.closeIdleConnections === "function") viewer.server.closeIdleConnections(); } catch {}
            try { if (typeof viewer.server.closeAllConnections === "function") viewer.server.closeAllConnections(); } catch {}
            viewer.server.close();
          }
        } catch {}
        try { store.flushAll(); } catch {}
        releaseDataDirLock(dataDirLock);
        dataDirLock = null;
      };

      const fail = (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        if (settled) {
          // 已经启动完成后的通道异常：保持旧行为（默认退出让 systemd 重启），测试可关掉。
          log("通道错误:", err.message);
          if (cfg.exitOnListenError !== false) process.exit(1);
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      };

      const ready = () => {
        if (settled) return;
        if (--pending) return;
        settled = true;
        evictTimer = setInterval(() => {
          const a = rooms.evictIdle();
          const b = store.evictIdle(cfg.storeIdleEvictMs, (id) => {
            const r = rooms.peek(id);
            if (!r) return false;
            if (r.online || r.viewers.size) return true;
            // 正文保留时长与"房间还在列表里"对齐：离线 6h 内仍列着的房间，不能 30 分钟后点进去是空的
            return (r.lastActivity || 0) > Date.now() - cfg.roomIdleEvictMs;
          });
          pruneDedupe(rooms, cfg);
          for (const [k, e] of ctx.pairCodes) if (e.expiresAt <= Date.now()) ctx.pairCodes.delete(k);
          for (const [k, times] of ctx.pairFailures) if (times[times.length - 1] <= Date.now() - PAIR_FAIL_WINDOW_MS) ctx.pairFailures.delete(k);
          if (a || b) log("内存淘汰：房间", a, "个，存储热缓存", b, "个");
        }, Math.min(cfg.storeIdleEvictMs, 10 * 60 * 1000));
        evictTimer.unref();
        // 排期引擎在监听就绪后才起 tick：启动算账（含过期处理）与投递都以通道可用为前提。
        scheduleEngine.start();
        resolve({
          cfg,
          rooms,
          store,
          inbox: inboxStore,
          schedule: scheduleEngine,
          localPort,
          viewerPort,
          index,
          devices,
          close() {
            clearInterval(evictTimer);
            scheduleEngine.stop();
            if (localWss._keepalive) clearInterval(localWss._keepalive);
            if (viewer.wss._keepalive) clearInterval(viewer.wss._keepalive);
            for (const r of rooms.map.values()) cancelResend(r);
            for (const q of rooms.viewerQueries.values()) clearTimeout(q.timer);
            try { usageBroker.dispose(); } catch {}
            rooms.viewerQueries.clear();
            for (const c of localWss.clients) c.terminate();
            for (const c of viewer.wss.clients) c.terminate();
            try { store.flushAll(); } catch {}
            const lock = dataDirLock;
            const releaseLock = () => {
              if (dataDirLock === lock) dataDirLock = null;
              releaseDataDirLock(lock);
            };
            // 低-14：viewer 的 HTTP 长连接不能把 close() 挂住；closeHttpServer 会主动断空闲/半开连接。
            return Promise.all([
              new Promise((r) => localWss.close(() => r())),
              new Promise((r) => viewer.wss.close(() => r())),
              closeHttpServer(viewer.server),
            ]).finally(releaseLock);
          },
        });
      };

      try {
        localWss = startLocalServer(cfg, rooms, store, ctx, (p) => { localPort = p; ready(); }, fail);
        viewer = startViewerServer(cfg, rooms, store, ctx, (p) => { viewerPort = p; ready(); }, fail);
      } catch (e) {
        fail(e);
      }
    });
  } catch (e) {
    releaseDataDirLock(dataDirLock);
    dataDirLock = null;
    return Promise.reject(e);
  }
}

/* ---------------- web 物料检查（免服务器模式 §2.3） ----------------
 * webRoot 缺 index.html 时，手机/浏览器打开页面只会 404，看起来像 relay 坏了，其实是
 * 发布包没带 web/（或 ui 还没构建）。启动时明确告警并给解决办法，避免误诊；
 * 只告警、不拦启动——API 与 WebSocket 不依赖静态页面，照常工作。返回 true 表示物料齐全。
 */
function warnMissingWebRoot(cfg, logger = log) {
  const root = cfg && cfg.webRoot ? String(cfg.webRoot) : "";
  const indexFile = root ? path.join(root, "index.html") : "";
  let ok = false;
  try { ok = !!indexFile && fs.statSync(indexFile).isFile(); } catch { ok = false; }
  if (ok) return true;
  logger(`警告：web 页面物料缺失（${indexFile || "webRoot 未配置"} 不是可用的 index.html）——手机/浏览器打开页面会是 404，但 relay 的 API 与 WebSocket 照常工作。解决办法：重新安装完整的发布包（应包含 web/ 目录），或先在 ui/ 执行 npm run build 并把产物部署到 relay 的 web/ 目录。`);
  return false;
}

/* ---------------- main ---------------- */
async function main() {
  // 进程级逃逸兜底最先装：启动阶段（loadConfig/建目录/监听）抛出的异常也要留下日志、
  // 走同一条退出路径，不能裸奔打死进程（报告 relay 中-11）。
  process.on("uncaughtException", (e) => log("uncaughtException（已忽略，进程继续）:", e && e.message, e && e.stack ? String(e.stack).split("\n")[1] : ""));
  process.on("unhandledRejection", (e) => log("unhandledRejection（已忽略，进程继续）:", e && e.message ? e.message : e));

  let cfg;
  let relay;
  try {
    cfg = loadConfig();
    if (!cfg.localToken || !cfg.viewerToken) {
      console.error("[relay] 缺少 localToken / viewerToken（relay/config.json）");
      process.exit(1);
    }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    warnMissingWebRoot(cfg);
    relay = await startRelay(cfg);
  } catch (e) {
    console.error("[relay] 启动失败：", e && e.message ? e.message : e);
    process.exit(1);
  }
  const { rooms, store } = relay;
  log(`relay 启动完成（存储目录 ${cfg.dataDir}，快照安全阀 ${cfg.maxSnapshotRecords} 条 / ${Math.round(cfg.maxSnapshotBytes / 1048576)}MB）`);

  // 退出前刷盘（追加式写，最多丢一个 flush 周期）
  const shutdown = (sig) => {
    log(`收到 ${sig}，刷盘并退出`);
    try {
      store.flushAll();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 保留期清理：超期房间文件删除（防磁盘无限增长）
  const sweep = () => {
    const cutoff = Date.now() - cfg.retentionDays * 86400 * 1000;
    try {
      for (const f of fs.readdirSync(cfg.dataDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(cfg.dataDir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) {
          const id = f.replace(/\.jsonl$/, "");
          // 只读不刷新活跃度：在线或近期真实活跃的房间才保护
          const r = rooms.peek(id);
          if (r && (r.online || r.viewers.size || (r.lastActivity || 0) > cutoff)) continue;
          // 与 close 路径一致：删掉内存房间前先收掉 resend 兜底定时器，避免定时器晚到访问已删除房间。
          if (r) cancelResend(r);
          store.drop(id);
          rooms.map.delete(id);
          log("保留期清理:", f);
        }
      }
    } catch (e) {
      log("保留期清理异常:", e.message);
    }
  };
  sweep();
  setInterval(sweep, 24 * 3600 * 1000).unref();
}

if (require.main === module) main();
module.exports = { main, startRelay, warnMissingWebRoot, loadConfig, commandTimeoutMs, shrinkImagesDeep, normalizePlatform, normPath, cwdAllowed, cleanProjects, requestSource, DEFAULT_CONFIG, RELAY_VERSION };
