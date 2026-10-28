"use strict";
/**
 * RoomStore —— relay 的会话存储层。
 *
 * 解决四个问题：
 *   1. 服务器侧持久化：消息级记录追加落盘（data/rooms/<roomId>.jsonl），
 *      本机离线/relay 重启后历史仍读
 *   2. 缓存分级：落盘时热缓存只留最近 cacheSize 条且 ≤ cacheMaxBytes，快照再从磁盘补齐；
 *      不落盘时内存是唯一副本，只按 cacheMaxBytes 从最旧丢，条数上限不裁还放得下的会话；
 *      热缓存里存的是**已序列化的消息 JSON**，快照 = 字符串拼接，不再每次订阅全量 stringify
 *   3. 增量同步：每条记录有单调 seq，房间有 rev（存储世代，reset 后变化，持久化在文件首行）。
 *      viewer 带 {rev, seq} 重订阅时只交付 seq 之后的记录；扩展重连时只上传尾部（append）
 *   4. 服务器压力：批量落盘（flushIntervalMs 合并写入）、追加式写（无重写）、
 *      尾扫描读（O(交付量) 而非 O(file)）、空闲房间从内存淘汰
 *   5. 耐久点：每次 flush（200ms 定时、满 200 条、seed/尾部补传、空闲淘汰前、flushAll 关闭）
 *      在追加后 fsync；store 只写 message_end / remote_message 等非流式事件，不为 delta 滑盘。
 *      新建房文件首次落盘后再 fsync 数据目录（文件内容 fsync 不覆盖目录项，掉电可能丢文件名）。
 *      toolmeta 是不进消息历史的小记录且低频，写完立即 flush+fsync，不等 200ms 批。
 *      硬断电最多丢尚未 flush 的缓冲尾部（≤200ms）；进程崩溃不丢（已进内核页缓存）。
 *      追加写不是原子的：每次追加前先修掉残行；写到一半失败时按实际写入长度只重试没写完的行
 *      （已完整写入的行不重写、半截行截掉），绝不整批重写。落盘持续失败时缓冲有硬顶，
 *      削批钉住 meta 行不丢（否则 rev 漂移），丢弃条数经 info().dropped 暴露。
 *   6. 长房间重启：房文件里追加 {k:"ckpt"} 聚合行 + <room>.ckpt.json 偏移指针；指针有效时只读
 *      检查点之后的尾巴。旧文件首次全量扫一次后补检查点；构造器对"大且无检查点"的文件分块异步
 *      预热（setImmediate 让出事件循环），首次访问直接接管预热结果。预热索引有房间数上限和 TTL；
 *      检查点超过 16MB 被拒后有 60s 冷却，忙房间不会每个消息都重新整包序列化。
 *
 * 记录种类（每行一个 JSON）：
 *   {k:"meta", seq:0, rev, headTruncated?}  存储世代；reset/首次 seed 时写在文件首行
 *   {k:"msg", seq, m}                        message_end 的权威消息 / 扩展快照里的消息
 *   {k:"remote", seq, text, at, cid?}        remote_message 回显（cid = 网页生成的消息 id）
 *   {k:"drop", seq:0, ref}                   ref 号 remote 回显注入失败，回放时过滤
 *   {k:"ckpt", seq:0, maxSeq, rev, ...}      检查点聚合状态；seq 固定 0 供旧实现无痛忽略
 *   {k:"toolmeta", seq:0, toolCallId, ...}   tool_execution_end 的结束元数据（见下）
 * system 消息不落盘（体积大且 UI 不渲染；seedOrMerge 同样跳过）。
 *
 * ended-tool 元数据（终端胶囊历史重建用）：
 *   扩展的 tool_execution_end 帧顶层已带 exit_code / wall_time_seconds / termStatus / isError，
 *   这些字段不在 pi 的 toolResult 历史里（structuredContent 不落盘），晚到的 viewer 从消息快照
 *   重建时拿不到。这里按 toolCallId 单独记一条很小的记录，**不写进消息列表、不占 seq**：
 *     {k:"toolmeta", seq:0, toolCallId, isError?, exit_code?,
 *      wall_time_seconds?, termStatus?, endedAt}
 *   同 id 重复 end 幂等（只留一份，endedAt 不回退）；每房默认保留最近 2000 条（toolMetaMax
 *   可配），超出丢最旧——200 条的旧上限会让长会话早期终端历史整段滚出。
 *   检查点里带 toolMetas，重启只读尾巴也能补；检查点版本升到 2，v1 指针会回退一次全量扫描
 *   （旧实现不认识 toolmeta 行，会当未知记录忽略，所以回退/回滚都安全）。
 * remote 记录若随后被同文本的 user 消息取代（同文本多条时先进先出），标记 superseded，读时过滤；
 * 注入失败按 cid 摘掉对应那条，没有 cid 的旧扩展退回按文本。
 * pi 会把图片缩放/转码提示接在用户文本后面（"\\n\\n" + 若干行 "[Image ...]"），这仍算同一条。
 */
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const crypto = require("node:crypto");

const FLUSH_BUF_MAX_BYTES = 64 * 1024 * 1024; // 落盘失败时的缓冲硬顶（防 OOM）
const FLUSH_BUF_MAX_COUNT = 5000;         // 落盘失败时的缓冲条数硬顶（磁盘满时事件仍在灌入）
const FLUSH_BATCH = 200;
const INDEX_REMOTE_WINDOW = 2000; // 索引时只为最近 2000 条 remote 维护取代关系
const MSG_PREFIX = /^\{"k":"msg","seq":(\d+),"m":/;
const CID_RE = /^[A-Za-z0-9_-]{1,64}$/; // 与协议 limits.cidMax 一致
// ended-tool 元数据：很小，但也不能让一条坏帧/异常会话无限占内存。
// 默认每房保留最近 2000 条（旧的 200 条上限会让长会话的终端胶囊历史持续滚出）：
//  - 内存：约 2000 个几字段小对象/房间，随房间空闲淘汰一起释放；
//  - 检查点：2000 条约几百 KB，远低于 ckptPayloadMaxBytes(16MB)，且受 TOOLMETA_CKPT_MAX 硬顶保护；
//  - 磁盘：仍按追加行记录，不占消息 seq，随房间文件保留期（默认 30 天）一起清理。
const TOOLMETA_MAX = 2000;
const TOOLMETA_CKPT_MAX = 10000; // 检查点里 toolMetas 的条数硬顶（防损坏检查点把内存撑爆）
const TOOLMETA_ID_MAX = 200;     // toolCallId 长度上限；超长不截断（截断会错位），直接不记
const TOOLMETA_FIELDS = ["isError", "exit_code", "wall_time_seconds", "termStatus", "endedAt"];

// 目录项 fsync 失败后的重试退避：一次失败不能把房间永久标成"目录已同步"（耐久就没下文了）。
// 失败后 1s 起按 2 倍退避重试（上限 60s）：不支持目录 fsync 的平台仍有重试，但不会每次 flush 都付 syscall。
const DIR_FSYNC_RETRY_MIN_MS = 1000;
const DIR_FSYNC_RETRY_MAX_MS = 60 * 1000;
// 房文件本体硬上限（单房）：正文只追加不限制会吃光磁盘（保留期清理要等 30 天才有机会）。
// 到顶后停止落盘，内存热缓存继续服务实时流；快照按 distinct seq 缺口标记 truncated。
// 0 = 关闭上限。上限按"整批不越过"判：宁可直接丢掉这一批（内存还在），也不写出半条记录。
const ROOM_FILE_MAX_BYTES = 256 * 1024 * 1024;
// 检查点指针临时文件（<room>.ckpt.json.<pid>.<hex>.tmp）只在一次同步写路径内存活，
// 进程被强杀会留下孤儿；启动时只清理一小时以前的，避免误删另一个进程正在写的临时文件。
const CKPT_TMP_RE = /\.ckpt\.json\.\d+\.[0-9a-f]+\.tmp$/;
const CKPT_TMP_MAX_AGE_MS = 60 * 60 * 1000;

// ---------- 检查点（第二次审查第 1 条：长房间首次打开不再 O(file) 同步阻塞） ----------
// 房文件末尾追加 {k:"ckpt",...} 行，旁边 <room>.ckpt.json 存该行的偏移/长度/sha1。
// 指针有效时重启只从检查点行之后读到文件尾；指针缺失/损坏/文件截断/轮转则回退一次全量扫描并补检查点。
// 旧实现看到 ckpt 行：seq 是数字（0）不会计坏行，k 不是 msg/remote 不会交付，等价于忽略。
// v2 起检查点带 toolMetas；v1 指针一律判无效 → 旧文件首次升级会全量扫描一次（toolmeta 行同时被装载）。
const CKPT_VERSION = 2;
const CKPT_MIN_BYTES = 4 * 1024 * 1024;       // 文件小于此值不写检查点（长房间才有收益）
const CKPT_INTERVAL_BYTES = 4 * 1024 * 1024;  // 距上一个检查点再长这么多才写新的（限制重启尾读）
const PREWARM_MIN_BYTES = 8 * 1024 * 1024;    // 构造器只给"大且无有效检查点"的文件做异步预热
const PREWARM_CHUNK = 256 * 1024;             // 预热每块字节数：块间 setImmediate 让事件循环可调度
const CKPT_RECENT_MAX = 64;                   // 检查点内热缓存最多带多少条（重启后快照/尾 hash 用）
const CKPT_RECENT_MAX_BYTES = 512 * 1024;     // ...但至少保留最近 CKPT_RECENT_MIN_MSGS 条消息
const CKPT_RECENT_MIN_MSGS = 8;
const CKPT_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024; // pending/superseded 太大就放弃写检查点（继续全量扫描）
const CKPT_REJECT_COOLDOWN_MS = 60 * 1000;    // 检查点过大被拒后 60s 内不再整包序列化重试（忙房间防刷日志/CPU）
const PREWARM_MAX_ROOMS = 8;                  // 预热索引最多保留几个房间：每个最长 cacheMaxBytes，防大量超大房间占内存
const PREWARM_TTL_MS = 10 * 60 * 1000;        // 预热结果最多保留这么久；期间没被首次打开就丢弃，首次打开改回同步扫描
const SEQ_RANGE_MAX = 1000000;                // pack/unpack 共用：单个 [start,end] 最多覆盖多少个 seq
const SEQ_UNPACK_MAX = 5000000;               // 单个检查点展开后的 superseded 总数上限（防损坏检查点把内存撑爆）
// superseded 是无界长集合：每条被取代的回显都留一个 seq，长命房会线性膨胀，最终检查点超过
// ckptPayloadMaxBytes 被永久拒绝。这里按“最近多少个 seq”保留：默认 20000 覆盖默认快照窗口
// (maxSnapshotRecords=10000) 的两倍；超出后按 seq 从旧到新裁掉多余的（有容差，避免全量索引时
// 每条 drop 都排序）。注意：若部署把 maxSnapshotRecords 调到 20000 以上，被裁掉标志的旧回显
// 可能重新出现在全量快照里——这是“有界内存/检查点”换来的固定边界，默认配置不受影响。
const SUPERSEDED_MAX = 20000;
const SUPERSEDED_TRIM_SLACK = 500;
// 截断快照的兜底对齐门槛：只重叠 1~2 条时摘要/工具结果的 hash（不含时间戳）极易撞车，
// 会把异分支历史误判成“已对齐”。低于门槛一律 reset 重新种入（不合并）。
const TRUNC_FALLBACK_MIN_OVERLAP = 3;

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/** superseded 的 seq 集合压成 [start,end] 区间数组：连续 seq 很常见，落盘体积远小于逐个数字。
 *  单个区间不超过 SEQ_RANGE_MAX 就强制切段，保证 pack 的输出一定能通过 unpack 的上限校验。 */
function packSeqs(set) {
  const seqs = [];
  for (const s of set) if (Number.isInteger(s) && s > 0) seqs.push(s);
  seqs.sort((a, b) => a - b);
  const out = [];
  for (const s of seqs) {
    const last = out[out.length - 1];
    if (last && s === last[1] + 1 && last[1] - last[0] + 1 < SEQ_RANGE_MAX) last[1] = s;
    else out.push([s, s]);
  }
  return out;
}

/** 校验 packed superseded 的结构与规模；不分配 Set。maxSeq 用于拦越界 seq。
 *  与 packSeqs 的切段规则对称：本版本写出的检查点一定合法；旧版本/损坏的过大区间回退全量扫描。 */
function packedSeqsValid(packed, maxSeq = Infinity) {
  if (!Array.isArray(packed)) return false;
  let total = 0;
  for (const range of packed) {
    if (!Array.isArray(range) || range.length !== 2) return false;
    const [a, b] = range;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b < a || b > maxSeq) return false;
    const len = b - a + 1;
    if (len > SEQ_RANGE_MAX) return false;
    total += len;
    if (total > SEQ_UNPACK_MAX) return false;
  }
  return true;
}

/** 展开 packed superseded；非法/超限返回 null（由调用方回退全量扫描，绝不静默丢一部分）。 */
function unpackSeqs(packed, maxSeq = Infinity) {
  if (!packedSeqsValid(packed, maxSeq)) return null;
  const out = new Set();
  for (const [a, b] of packed) for (let s = a; s <= b; s++) out.add(s);
  return out;
}

/** 远程消息的客户端 id；不合法的当没带 */
function cleanCid(v) {
  return typeof v === "string" && CID_RE.test(v) ? v : null;
}

/**
 * ended-tool 元数据字段白名单（落盘记录与补发共用的规范形态）。
 * 只收扩展 end 帧里真实存在的结构化字段，不解析文本、不补默认值；非法/缺失字段直接不带。
 * 字段名沿用扩展帧：exit_code / wall_time_seconds（relay 发 `tool_end_meta` 时再转 camelCase）。
 */
function cleanToolMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.toolCallId;
  if (typeof id !== "string" || !id || id.length > TOOLMETA_ID_MAX) return null;
  const meta = { toolCallId: id };
  if (typeof raw.isError === "boolean") meta.isError = raw.isError;
  if (typeof raw.exit_code === "number" && Number.isFinite(raw.exit_code)) meta.exit_code = raw.exit_code;
  if (typeof raw.wall_time_seconds === "number" && Number.isFinite(raw.wall_time_seconds)) {
    meta.wall_time_seconds = raw.wall_time_seconds;
  }
  if (raw.termStatus === "timeout" || raw.termStatus === "aborted") meta.termStatus = raw.termStatus;
  if (typeof raw.endedAt === "number" && Number.isFinite(raw.endedAt) && raw.endedAt > 0) meta.endedAt = raw.endedAt;
  return meta;
}

/** 两条元数据的业务字段完全相同（toolCallId 由调用方保证相同）。 */
function toolMetaSame(a, b) {
  return TOOLMETA_FIELDS.every((k) => a[k] === b[k]);
}

/** room id 只允许安全字符（防路径穿越/怪文件名）；调用方（server）已校验，这里双保险 */
function safeRoomId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

function contentText(m) {
  const c = m && m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && b.type === "text" ? b.text || "" : b && b.type === "toolCall" ? `[tool:${b.name}]` : ""))
      .join("");
  }
  if (m && typeof m.summary === "string") return m.summary;
  if (m && typeof m.output === "string") return `${m.command || ""}\n${m.output}`;
  return "";
}

/** 只有这些角色的 timestamp 在实时 message_end 与会话条目里是同一个值（custom/摘要条目落盘时另取时间） */
const STAMPED_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

/** 内容指纹：sha1 前 12 位。扩展侧有逐字相同的实现（append 模式对齐用），改这里必须同步改扩展。
 *  只取文本前 2048 字符：超大消息过线时被截断（保留头部），指纹不能跟着变 */
function hashOf(m) {
  if (!m || typeof m !== "object") return "";
  const ts = STAMPED_ROLES.has(m.role) ? m.timestamp || "" : "";
  const raw = `${m.role}|${ts}|${contentText(m).slice(0, 2048)}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

/** hash 是否真的把时间戳算进去了：只有 STAMPED_ROLES 且 timestamp 非空才满足。
 *  截断快照兜底对齐要求重叠窗口里至少有一条这样的消息，否则同内容摘要/工具结果会撞 hash。 */
function hashPinsTimestamp(m) {
  return !!m && STAMPED_ROLES.has(m.role) && !!m.timestamp;
}

function newRev() {
  return crypto.randomBytes(6).toString("hex");
}

function remoteJson(text, at, cid) {
  const m = { role: "user", remote: true, content: [{ type: "text", text }], timestamp: at };
  if (cid) m.cid = cid;
  return JSON.stringify(m);
}

/** user 消息是否就是这条 remote 回显。精确相等，或只在末尾多了 pi 的图片提示。
 *  不能用裸 startsWith：短文本 "ok" 会把 "ok, 我来处理" 误判成已送达。 */
function remoteEchoMatches(remoteText, userText) {
  if (typeof remoteText !== "string" || typeof userText !== "string") return false;
  if (userText === remoteText) return true;
  if (!remoteText || !userText.startsWith(remoteText)) return false;
  const rest = userText.slice(remoteText.length);
  if (!rest.startsWith("\n\n")) return false;
  const lines = rest.slice(2).split("\n");
  return lines.length > 0 && lines.every((line) => line.startsWith("[Image"));
}

class RoomStore {
  /**
   * @param {string} dataDir 数据目录
   * @param {{cacheSize?:number, cacheMaxBytes?:number, flushIntervalMs?:number,
   *          toolMetaMax?:number,
   *          ckptMinBytes?:number, ckptIntervalBytes?:number, ckptPayloadMaxBytes?:number,
   *          ckptRejectCooldownMs?:number, prewarmMinBytes?:number, prewarmMaxRooms?:number,
   *          prewarmTtlMs?:number, prewarm?:boolean, now?:() => number}} opts
   */
  constructor(dataDir, opts = {}) {
    this.dir = dataDir;
    this.cacheSize = opts.cacheSize || 500;
    this.cacheMaxBytes = opts.cacheMaxBytes || 16 * 1024 * 1024;
    this.flushIntervalMs = opts.flushIntervalMs || 200;
    this.toolMetaMax = opts.toolMetaMax != null ? Math.max(1, Math.floor(opts.toolMetaMax)) : TOOLMETA_MAX;
    // 上限至少要盖住热缓存窗口：还留在 recent 里的 remote 被裁掉标志就会重新出现在快照里。
    this.supersededMax = opts.supersededMax != null
      ? Math.max(1, Math.floor(opts.supersededMax))
      : Math.max(SUPERSEDED_MAX, this.cacheSize * 2);
    // 默认不把对话正文写入 data/rooms。活跃会话仍在内存热缓存里转发；
    // persist=true（PI_REMOTE_PERSIST_TRANSCRIPTS）才追加落盘，行为与旧版一致。
    this.persist = !!opts.persist;
    this.ckptMinBytes = opts.ckptMinBytes != null ? opts.ckptMinBytes : CKPT_MIN_BYTES;
    this.ckptIntervalBytes = opts.ckptIntervalBytes != null ? opts.ckptIntervalBytes : CKPT_INTERVAL_BYTES;
    this.ckptPayloadMaxBytes = opts.ckptPayloadMaxBytes != null ? opts.ckptPayloadMaxBytes : CKPT_PAYLOAD_MAX_BYTES;
    this.ckptRejectCooldownMs = opts.ckptRejectCooldownMs != null ? opts.ckptRejectCooldownMs : CKPT_REJECT_COOLDOWN_MS;
    this.prewarmMinBytes = opts.prewarmMinBytes != null ? opts.prewarmMinBytes : PREWARM_MIN_BYTES;
    this.prewarmMaxRooms = opts.prewarmMaxRooms != null ? Math.max(1, opts.prewarmMaxRooms) : PREWARM_MAX_ROOMS;
    this.prewarmTtlMs = opts.prewarmTtlMs != null ? opts.prewarmTtlMs : PREWARM_TTL_MS;
    // 房文件本体上限：默认 256MB；0 关闭（测试/特殊部署可用）。
    this.maxRoomFileBytes = opts.maxRoomFileBytes != null
      ? Math.max(0, Math.floor(opts.maxRoomFileBytes))
      : ROOM_FILE_MAX_BYTES;
    // 可注入时钟：检查点冷却与预热 TTL 的测试用；生产走 Date.now。
    this._now = typeof opts.now === "function" ? opts.now : Date.now;
    this.prewarm = this.persist && opts.prewarm !== false;
    this.rooms = new Map();
    // 目录 fsync 失败只告警一次：Windows/个别文件系统不支持，不能每次 flush 都刷屏。
    this._dirFsyncWarned = false;
    // 预热完成但还没被 _room() 打开的索引；_room() 直接接管，省掉首次同步全量扫描。
    this._prewarmed = new Map();
    this._prewarmScheduled = false;
    this._prewarmPending = 0;
    this._prewarmWaiters = [];
    fs.mkdirSync(this.dir, { recursive: true });
    // 启动清理上次异常退出留下的检查点临时文件孤儿（异步、廉价：只枚举文件名，不读文件内容）。
    setImmediate(() => {
      try {
        this._cleanupOrphanTemps();
      } catch (e) {
        console.warn("[store] 清理检查点临时文件失败:", e.message);
      }
    });
    if (this.prewarm) {
      this._prewarmScheduled = true;
      // 构造器绝不做 O(file) 工作：把目录枚举与分块扫描都推迟到事件循环里。
      setImmediate(() => {
        this._prewarmScheduled = false;
        try {
          this._prewarmAll();
        } catch (e) {
          console.warn("[store] 构造器预热启动失败:", e.message);
          this._notifyPrewarm();
        }
      });
    }
  }

  /** 等待构造器触发的异步预热全部结束（测试/运维观测用；读 API 仍是同步的） */
  prewarmReady() {
    if (!this._prewarmScheduled && this._prewarmPending === 0) return Promise.resolve();
    return new Promise((resolve) => this._prewarmWaiters.push(resolve));
  }

  _notifyPrewarm() {
    if (this._prewarmScheduled || this._prewarmPending > 0) return;
    const waiters = this._prewarmWaiters;
    this._prewarmWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** 丢弃一个还没被打开的预热索引（首次打开接管 / reset / drop / 超过上限 / TTL）。 */
  _dropPrewarmed(id) {
    const pre = this._prewarmed.get(id);
    if (!pre) return false;
    this._prewarmed.delete(id);
    if (pre.timer) clearTimeout(pre.timer);
    return true;
  }

  /** 保存预热结果，并执行上限 + TTL：_prewarmed 最多 prewarmMaxRooms 个（超出丢最旧的），
   *  每个最多保留 prewarmTtlMs（期间没被首次打开就丢弃，下次打开回退同步扫描）。 */
  _rememberPrewarmed(id, entry) {
    this._dropPrewarmed(id);
    while (this._prewarmed.size >= this.prewarmMaxRooms) {
      const oldest = this._prewarmed.keys().next().value;
      if (!this._dropPrewarmed(oldest)) break;
    }
    if (this.prewarmTtlMs > 0) {
      entry.timer = setTimeout(() => {
        const cur = this._prewarmed.get(id);
        if (cur === entry) this._prewarmed.delete(id);
      }, this.prewarmTtlMs);
      if (entry.timer.unref) entry.timer.unref();
    }
    this._prewarmed.set(id, entry);
  }

  _file(id) {
    return path.join(this.dir, `${id}.jsonl`);
  }

  _ckptFile(id) {
    return path.join(this.dir, `${id}.ckpt.json`);
  }

  _newRoom(id, file) {
    return {
      id,
      file,
      rev: null,
      metaWritten: false,
      headTruncated: false,
      seq: 0,
      // 热缓存条目：{k, seq, json}；json = 交付给 UI 的消息 JSON 串
      recent: [],
      recentBytes: 0,
      superseded: new Set(),
      // 还没被同文本 user 消息取代的 remote（旧→新）。不能只扫热缓存末尾：
      // 忙时 steer 要等整轮工具跑完才变成 user 消息，中间可能隔开几百条记录。
      pendingRemotes: [],
      // ended-tool 元数据：toolCallId → {toolCallId, isError?, exit_code?, wall_time_seconds?, termStatus?, endedAt}。
      // 不占 seq、不进消息列表；Map 的插入顺序就是补发顺序（最旧→最新）。
      toolMetas: new Map(),
      buf: [],
      metaLine: null,   // 钉在缓冲里的 meta 行：落盘失败削批时绝不能丢（丢了 rev 对不上）
      dropped: 0,       // 落盘持续失败时丢掉的缓冲条数（info() 暴露）
      resetFailed: false, // reset 截断旧文件失败：禁止在旧文件上 seed/继续写
      timer: null,
      lastActivity: Date.now(),
      msgCount: 0,      // 已存消息条数（位置对齐用）
      firstMsgHash: null,
      lastMsgHash: null,
      ckpt: null,       // {off, len, end, sum}：当前生效的检查点行在文件中的位置
      _ckptReject: null,     // {at, bytes}：上次因过大被拒的时间/大小（冷却用）
      _ckptRejectWarnAt: 0,  // 上次打印"检查点过大"日志的时间（日志限频）
      _indexFailed: false,
      indexPartial: false,   // 索引只装了一部分（扫描失败/病态文件）：快照必须报 truncated，不能当正常房交付
      _ckptWriting: false,
      dirSynced: false, // 新文件首次落盘后是否已 fsync 过数据目录（目录项耐久）
      _dirSyncRetryAt: 0, // 目录 fsync 失败后的下次重试时刻（退避，不是"一次失败永久放弃"）
      _dirSyncTries: 0,
      fileCapped: false, // 房文件到达 maxRoomFileBytes：停止落盘，只在内存热缓存继续服务
      _capWarned: false,
    };
  }

  /** 清空索引态，回到"还没读盘"的空白房间（换 rev 等身份字段由调用方处理） */
  _resetRoomData(r) {
    r.rev = null;
    r.metaWritten = false;
    r.headTruncated = false;
    r.seq = 0;
    r.recent = [];
    r.recentBytes = 0;
    r.superseded = new Set();
    r.pendingRemotes = [];
    r.toolMetas = new Map();
    r.msgCount = 0;
    r.firstMsgHash = null;
    r.lastMsgHash = null;
    r.ckpt = null;
    r._indexFailed = false;
    r.indexPartial = false;
  }

  _room(id, { create = false } = {}) {
    let r = this.rooms.get(id);
    if (r) { r.lastActivity = Date.now(); return r; }
    if (!safeRoomId(id)) return null;
    const file = this._file(id);
    const onDisk = this.persist && fs.existsSync(file);
    if (!create && !onDisk) {
      this._dropPrewarmed(id);
      return null;
    }
    // 构造器预热好的索引：文件指纹没变就直接接管，不阻塞事件循环。
    if (onDisk) {
      const pre = this._prewarmed.get(id);
      if (pre) {
        this._dropPrewarmed(id);
        let st = null;
        try { st = fs.statSync(file); } catch {}
        if (st && st.size === pre.size && (pre.ino == null || st.ino === pre.ino) &&
            (pre.mtimeMs == null || st.mtimeMs === pre.mtimeMs)) {
          r = pre.room;
          r.lastActivity = Date.now();
          r.buf = [];
          r.timer = null;
          r.dirSynced = true; // 预热只针对已存在的文件，目录项早就落过盘
          this.rooms.set(id, r);
          return r;
        }
      }
    } else {
      this._dropPrewarmed(id);
    }
    r = this._newRoom(id, file);
    r.dirSynced = onDisk; // 已存在的文件不需要再同步目录项；新建文件等首次 flush 后补
    let fullScanned = false;
    if (onDisk) {
      // 走到这里说明预热未完成/文件已变/没有预热（小文件）。读 API 是同步的，只能当场扫一次。
      // 长房间的常见路径是构造器预热先完成，viewer 打开时直接接管上面的 pre.room。
      const ck = this._readCheckpoint(id, file);
      let restored = false;
      if (ck) {
        try {
          // 只从检查点行末尾往回修残行，避免又摸一遍前缀；repair 的已知换行边界就是 ck.end。
          const tailOk = this._repairTail(r, ck.end);
          restored = this._restoreCheckpoint(r, ck);
          // 检查点之后的尾巴整体没有换行边界：_restoreCheckpoint 只能丢掉这段残行，
          // 交付的就是"缺了尾巴"的历史，同样必须标 truncated 而不是当正常房。
          if (restored && !tailOk) this._markIndexFailed(r, "检查点之后的末行残缺且无法修复");
        } catch (e) {
          console.warn("[store] 检查点恢复失败，回退全量扫描:", id, e.message);
          restored = false;
        }
      }
      if (!restored) {
        this._resetRoomData(r);
        const tailOk = this._repairTail(r); // 上次异常退出可能留下半截行：先修再索引
        this._indexFile(r);
        // 病态文件（整段找不到换行边界）只能装出一部分/空索引：必须标记，快照据此报 truncated。
        if (!tailOk) this._markIndexFailed(r, "文件末行残缺且找不到完整换行边界");
        fullScanned = true;
      }
    }
    if (!r.rev) r.rev = newRev();
    this.rooms.set(id, r);
    // 旧文件第一次全量扫完就补检查点（不论大小：下次重启只读尾巴）；
    // 运行时新增则由 _flush 里的阈值控制，避免小房间每 200ms 写检查点。
    this._maybeCheckpoint(r, fullScanned ? { minBytes: 0 } : undefined);
    return r;
  }

  /** 文件末行不是 \n 时，截掉残行（否则下次追加会与残行粘连，永久丢失一条）。
   *  minPos > 0 表示检查点恢复：已知 ckpt 行末尾是换行，只需检查它之后的尾巴。
   *  返回文件尾现在是否是完整换行（空文件/成功截断/本来就完整 → true）；
   *  病态文件（整段找不到换行）或修复失败 → false，调用方必须放弃追加而不是制造粘行。 */
  _repairTail(r, minPos = 0) {
    let fd;
    try {
      const size = fs.statSync(r.file).size;
      if (size <= minPos) return true;
      fd = fs.openSync(r.file, "r+");
      // 绝大多数 flush 尾字节就是换行：只读 1 字节，不做 64KB 回溯。
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return true;
      // 倒序分块回溯找最后一个完整换行。**不能只瞄一个 64KB 窗口**：
      // 单条记录可远超 64KB，窗口内没有换行就把整个房间历史清零，比坏一行坏上万倍。
      const cut = this._lastNewlinePos(fd, size, minPos);
      if (cut < 0) {
        if (minPos > 0) {
          // 检查点之后整段都没有换行：截到检查点行末尾（那里一定是换行），残行丢弃。
          fs.ftruncateSync(fd, minPos);
          console.warn(`[store] 房间 ${r.id} 检查点后的末行残缺，已截断到检查点末尾 ${minPos}（原 ${size}）`);
          return true;
        }
        console.error(`[store] 房间 ${r.id} 文件 ${size} 字节内没有完整换行，判为病态文件，不截断`);
        return false;
      }
      fs.ftruncateSync(fd, cut);
      console.warn(`[store] 房间 ${r.id} 末行残缺，已截断到 ${cut}（原 ${size}）`);
      return true;
    } catch (e) {
      console.warn("[store] 末行修复失败:", r.id, e.message);
      return false;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** 在 [minPos, size) 内倒序分块找最后一个换行的结束偏移；没有返回 -1。 */
  _lastNewlinePos(fd, size, minPos = 0) {
    let pos = size;
    const CH = 65536;
    while (pos > minPos) {
      const cnt = Math.min(CH, pos - minPos);
      pos -= cnt;
      const b = Buffer.alloc(cnt);
      fs.readSync(fd, b, 0, cnt, pos);
      const i = b.lastIndexOf(0x0a);
      if (i >= 0) return pos + i + 1;
    }
    return -1;
  }

  _newIndexCtx() {
    return {
      firstLine: null,
      // 首/尾 hash 在扫描结束后各算一次即可：中间消息的 hash 不参与索引。
      firstMsg: null,
      lastMsg: null,
      // 临时环：只为最后 cacheSize 条保留原始记录，结束时再物化 JSON。
      tail: [],
      skipped: 0,
    };
  }

  /** 解析一行并更新房间索引。全量扫描与检查点尾扫描共用，保证两条路径语义一致。
   *  ckpt 行在这里被显式忽略：旧实现不认识它，新实现也不能把它当消息。 */
  _ingestLine(r, ctx, raw) {
    const t = raw.trim();
    if (!t) return;
    if (ctx.firstLine === null) ctx.firstLine = t;
    let rec;
    try { rec = JSON.parse(t); } catch { ctx.skipped++; return; }
    if (!rec || typeof rec.seq !== "number") { ctx.skipped++; return; }
    try {
      // 旧实现看到它：seq 是数字不计坏行，k 不是 msg/remote 不交付 —— 等价于忽略。
      if (rec.k === "ckpt") return;
      if (rec.k === "toolmeta") {
        const meta = cleanToolMeta(rec);
        if (meta) this._applyToolMeta(r, meta);
        return;
      }
      if (rec.k === "meta") {
        if (typeof rec.rev === "string") r.rev = rec.rev;
        r.headTruncated = !!rec.headTruncated;
        r.metaWritten = true;
        return;
      }
      if (rec.k === "drop") {
        if (typeof rec.ref === "number") {
          r.superseded.add(rec.ref);
          const i = r.pendingRemotes.findIndex((p) => p.seq === rec.ref);
          if (i >= 0) r.pendingRemotes.splice(i, 1);
          this._trimSuperseded(r);
        }
        return;
      }
      if (rec.seq > r.seq) r.seq = rec.seq;
      if (rec.k === "msg" && rec.m) {
        if (rec.m.role === "system") return;
        if (!ctx.firstMsg) ctx.firstMsg = rec.m;
        ctx.lastMsg = rec.m;
        r.msgCount += 1;
        ctx.tail.push({ rec, line: t });
        if (rec.m.role === "user") this._supersedePending(r, contentText(rec.m));
      } else if (rec.k === "remote") {
        this._rememberRemote(r, rec.seq, String(rec.text || ""), cleanCid(rec.cid));
        ctx.tail.push({ rec, line: t });
      }
      if (ctx.tail.length > this.cacheSize * 2) ctx.tail = ctx.tail.slice(-this.cacheSize);
    } catch { ctx.skipped++; }
  }

  /** 合并一条 ended-tool 元数据：同 toolCallId 只留一份。
   *  - 只有新字段才覆盖旧值（重复帧缺字段不抹掉已有退出码）；
   *  - endedAt 不回退（乱序的旧 end 不能把结束时刻改早）；
   *  - 新 id 才增长，超过 toolMetaMax 从最旧（Map 头部）丢。
   *  返回 {changed, meta}：changed=false 表示重复帧，调用方不必再写盘/补发。 */
  _applyToolMeta(r, meta) {
    const prev = r.toolMetas.get(meta.toolCallId);
    let next;
    if (!prev) {
      next = { ...meta };
    } else {
      next = { ...prev };
      for (const k of TOOLMETA_FIELDS) {
        if (meta[k] === undefined) continue;
        if (k === "endedAt" && prev.endedAt != null && meta.endedAt < prev.endedAt) continue;
        next[k] = meta[k];
      }
    }
    const changed = !prev || !toolMetaSame(prev, next);
    if (changed) {
      r.toolMetas.set(meta.toolCallId, next);
      this._trimToolMetas(r);
    }
    return { changed, meta: next };
  }

  /** 每房上限：旧的可丢。Map 删除头元素是 O(1)，热路径正常只淘汰 0~1 条。 */
  _trimToolMetas(r) {
    while (r.toolMetas.size > this.toolMetaMax) {
      const oldest = r.toolMetas.keys().next().value;
      if (oldest === undefined) break;
      r.toolMetas.delete(oldest);
    }
  }

  /** 记一条 tool_execution_end 的结束元数据并落盘（不占 seq）。
   *  没有显式 endedAt 时用 relay 收到 end 的时刻；重复 end 沿用第一次的时刻，保证幂等。
   *  返回 {changed, meta}；没有合法 toolCallId 时返回 {changed:false, meta:null}。 */
  recordToolEnd(roomId, event) {
    const meta = cleanToolMeta(event);
    if (!meta) return { changed: false, meta: null };
    const r = this._room(roomId, { create: true });
    if (!r) return { changed: false, meta: null };
    const prev = r.toolMetas.get(meta.toolCallId);
    if (meta.endedAt === undefined) {
      meta.endedAt = prev && prev.endedAt != null ? prev.endedAt : Date.now();
    }
    const applied = this._applyToolMeta(r, meta);
    if (applied.changed) {
      const line = { k: "toolmeta", seq: 0 };
      for (const k of ["toolCallId", ...TOOLMETA_FIELDS]) {
        if (applied.meta[k] !== undefined) line[k] = applied.meta[k];
      }
      // toolmeta 不进消息历史、频率低；检查点要等很久才可能带上它，掉电不能丢最后一条结束元数据。
      // 立即 flush（连同缓冲里的消息一起）并 fsync，不额外制造重复写。
      this._writeLine(r, JSON.stringify(line), { flush: true });
    }
    return applied;
  }

  /** 一条 ended-tool 元数据的只读拷贝；房间/条目不存在返回 null。 */
  toolEnd(roomId, toolCallId) {
    const r = this.rooms.get(roomId);
    if (!r || !r.toolMetas) return null;
    const meta = r.toolMetas.get(toolCallId);
    return meta ? { ...meta } : null;
  }

  /** 全部 ended-tool 元数据（旧→新，已按每房上限裁剪）。viewer 补发用。 */
  toolEnds(roomId) {
    const r = this._room(roomId);
    if (!r || !r.toolMetas) return [];
    return [...r.toolMetas.values()].map((meta) => ({ ...meta }));
  }

  /** superseded 只增不减会线性膨胀：超过上限（带容差）就按 seq 保最新的一批，
   *  覆盖默认快照窗口（maxSnapshotRecords=10000）两倍以上；更旧的记录单体快照已经取不到。
   *  容差避免全量索引时每一条 drop 行都排序一次。 */
  _trimSuperseded(r, force = false) {
    const max = this.supersededMax;
    const slack = Math.min(SUPERSEDED_TRIM_SLACK, Math.max(1, max >> 2));
    if (!force && r.superseded.size <= max + slack) return;
    if (r.superseded.size <= max) return;
    const seqs = [...r.superseded].sort((a, b) => a - b);
    r.superseded = new Set(seqs.slice(seqs.length - max));
  }

  /** 一条 user 消息只取代最早一条还没被取代的同文本回显（索引路径，不写 drop 行） */
  _supersedePending(r, text) {
    const i = r.pendingRemotes.findIndex((p) => !r.superseded.has(p.seq) && remoteEchoMatches(p.text, text));
    if (i < 0) return false;
    r.superseded.add(r.pendingRemotes[i].seq);
    r.pendingRemotes.splice(i, 1);
    this._trimSuperseded(r);
    return true;
  }

  _finishIndex(r, ctx) {
    if (!r.firstMsgHash && ctx.firstMsg) r.firstMsgHash = hashOf(ctx.firstMsg);
    if (ctx.lastMsg) r.lastMsgHash = hashOf(ctx.lastMsg);
    const keep = ctx.tail.length > this.cacheSize ? ctx.tail.slice(-this.cacheSize) : ctx.tail;
    for (const { rec, line } of keep) this._cachePush(r, this._entryFromRecord(rec, line));
    // 病态文件里 drop 行可能先于 remote 行：索引结束时统一过滤一次（正常文件是空操作）。
    if (r.pendingRemotes.length) {
      r.pendingRemotes = r.pendingRemotes.filter((p) => !r.superseded.has(p.seq));
    }
    // 旧版本文件没有 meta 行：rev 由首行内容派生，relay 重启前后保持一致（viewer 增量重连仍可命中）
    if (!r.rev && ctx.firstLine) {
      r.rev = "l" + crypto.createHash("sha1").update(ctx.firstLine).digest("hex").slice(0, 11);
      r.metaWritten = true;
    }
  }

  /** 索引只装了一部分（扫描失败/病态文件）：房间不能继续被当成正常房交付部分历史。
   *  标记后 snapshot() 一律带 truncated:true（info().indexFailed 也可见），让 UI 明确显示"历史不完整"。
   *  _indexFailed 沿用既有语义（禁止写检查点），indexPartial 是本条修复引入的对外可见标志。 */
  _markIndexFailed(r, why) {
    if (!r) return;
    r._indexFailed = true;
    r.indexPartial = true;
    if (!r._indexWarned) {
      r._indexWarned = true;
      console.error(
        `[store] 房间 ${r.id} 索引不完整（${why}）：快照将标记 truncated，重启后重新扫描`,
      );
    }
  }

  /** 同步分块扫描 [start, EOF)。块边界可能切在多字节字符中间：StringDecoder 把残缺字节交给下一块补齐。 */
  _scanChunksSync(r, file, start, ctx) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.statSync(file).size;
      let pos = Math.max(0, start);
      const dec = new StringDecoder("utf8");
      let carry = "";
      while (pos < size) {
        const n = Math.min(1024 * 1024, size - pos);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, pos);
        pos += n;
        const lines = (carry + dec.write(buf)).split("\n");
        carry = lines.pop();
        for (const line of lines) this._ingestLine(r, ctx, line);
      }
      // 末尾无换行的残行已被 _repairTail 截掉；这里与旧实现一样丢弃 carry。
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** 全量扫描：seq 上限 + 头尾 hash + 热缓存 + remote/user 的取代关系 + meta(rev)。
   *  单条坏记录只跳过并计数，绝不让它中断整个索引（否则后半文件会被当新消息二次落盘）。
   *  只用于"没有有效检查点"的旧文件首次打开；长文件由构造器异步预热，或随后补检查点。 */
  _indexFile(r) {
    const started = Date.now();
    this._resetRoomData(r);
    const ctx = this._newIndexCtx();
    try {
      this._scanChunksSync(r, r.file, 0, ctx);
      this._finishIndex(r, ctx);
      const ms = Date.now() - started;
      if (ctx.skipped || ms > 500) {
        console.warn(`[store] 房间 ${r.id} 索引完成：seq=${r.seq} 缓存=${r.recent.length} 跳过坏记录=${ctx.skipped} 耗时=${ms}ms`);
      }
    } catch (e) {
      // 扫描中断时 r 里只有半份索引：不能让它当"正常房的部分历史"交付（报告：索引损坏的房间不报错）。
      this._markIndexFailed(r, `索引建立失败：${e.message}`);
      console.warn("[store] 索引建立失败（该房间降级为热缓存读取）:", r.id, e.message);
    }
  }

  /** 读取并校验 <room>.ckpt.json + 它指向的 ckpt 行。任何不一致都返回 null（回退全量扫描）。
   *  校验项：版本/房间/rev、偏移与长度、行 sha1、行内 k/v/rev、状态字段基本类型、superseded 区间规模。
   *  sha1 让"文件被轮转成另一份更长文件、偏移恰好落在别的行上"也能被发现。 */
  _readCheckpoint(id, file, { quiet = false } = {}) {
    const ptrFile = this._ckptFile(id);
    let raw;
    try { raw = fs.readFileSync(ptrFile, "utf8"); } catch { return null; }
    const bad = (why) => {
      if (!quiet) console.warn(`[store] 房间 ${id} 检查点无效（${why}），回退全量扫描`);
      try { fs.unlinkSync(ptrFile); } catch {}
      return null;
    };
    if (raw.length > 64 * 1024) return bad("指针文件过大");
    let p;
    try { p = JSON.parse(raw); } catch { return bad("指针不是 JSON"); }
    if (
      !p || p.v !== CKPT_VERSION || p.room !== id || typeof p.rev !== "string" ||
      !Number.isInteger(p.off) || p.off < 0 ||
      !Number.isInteger(p.len) || p.len <= 0 || p.len > this.ckptPayloadMaxBytes ||
      typeof p.sum !== "string"
    ) return bad("指针字段非法");
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return bad("房文件不存在"); }
    if (p.off + p.len > size) return bad(`文件被截断（${size} < ${p.off + p.len}）`);
    let buf;
    try {
      buf = Buffer.alloc(p.len);
      const fd = fs.openSync(file, "r");
      try { fs.readSync(fd, buf, 0, p.len, p.off); } finally { fs.closeSync(fd); }
    } catch (e) { return bad(`读取检查点行失败：${e.message}`); }
    if (buf.length && buf[buf.length - 1] === 0x0a) buf = buf.subarray(0, buf.length - 1);
    if (sha1(buf) !== p.sum) return bad("校验和不匹配（文件被改写/轮转）");
    let rec;
    try { rec = JSON.parse(buf.toString("utf8")); } catch { return bad("检查点行不是 JSON"); }
    if (!rec || rec.k !== "ckpt" || rec.v !== CKPT_VERSION || rec.rev !== p.rev) return bad("检查点行与指针不一致");
    if (!Number.isInteger(rec.seq) || rec.seq < 0 || !Number.isInteger(rec.msgCount) || rec.msgCount < 0) {
      return bad("检查点状态非法");
    }
    if (!Number.isInteger(rec.maxSeq) || rec.maxSeq < 0) return bad("maxSeq 非法");
    if (!Array.isArray(rec.recent) || !Array.isArray(rec.pending) || !Array.isArray(rec.superseded)) {
      return bad("检查点数组非法");
    }
    if (!Array.isArray(rec.toolMetas) || rec.toolMetas.length > TOOLMETA_CKPT_MAX) {
      return bad("toolMetas 数组非法或超限");
    }
    if (rec.firstHash != null && typeof rec.firstHash !== "string") return bad("firstHash 非法");
    if (rec.lastHash != null && typeof rec.lastHash !== "string") return bad("lastHash 非法");
    // superseded 区间超限/越界不是"旧格式可忽略"，必须判坏：否则展开时会静默丢一部分 seq，
    // 被丢掉的 remote 回显会在重启后复活。这里回退全量扫描，与其它指针校验失败同一处理。
    if (!packedSeqsValid(rec.superseded, rec.maxSeq)) return bad("superseded 区间非法或超限");
    for (const e of rec.recent) {
      if (
        !e || (e.k !== "msg" && e.k !== "remote") || !Number.isInteger(e.seq) ||
        e.seq <= 0 || e.seq > rec.maxSeq || typeof e.j !== "string"
      ) {
        return bad("recent 条目非法");
      }
    }
    for (const q of rec.pending) {
      if (!q || !Number.isInteger(q.seq) || q.seq <= 0 || q.seq > rec.maxSeq || typeof q.text !== "string") {
        return bad("pending 条目非法");
      }
    }
    // 大量元数据只占一个小数组；任何一条缺 toolCallId/字段类型不对都判坏，回退全量扫描
    // （全量扫描会逐行跳过坏 toolmeta，不会静默丢一半有效元数据）。
    for (const m of rec.toolMetas) {
      const meta = cleanToolMeta(m);
      if (!meta || meta.toolCallId !== m.toolCallId) return bad("toolMetas 条目非法");
    }
    return { off: p.off, len: p.len, end: p.off + p.len, sum: p.sum, rev: p.rev, rec };
  }

  /** 把校验过的检查点状态装回房间，然后只扫 ckpt 行之后的尾巴（重建热缓存并接上新的 msg/remote/drop）。 */
  _restoreCheckpoint(r, ck) {
    const rec = ck.rec;
    const superseded = unpackSeqs(rec.superseded, rec.maxSeq);
    if (!superseded) throw new Error("superseded 区间非法或超限"); // 防御：_readCheckpoint 已拦截，调用方会回退全量扫描
    const pending = [];
    for (const p of rec.pending) {
      if (superseded.has(p.seq)) continue;
      pending.push({ seq: p.seq, text: p.text, cid: cleanCid(p.cid) });
    }
    r.rev = rec.rev;
    r.metaWritten = !!rec.metaWritten;
    r.headTruncated = !!rec.headTruncated;
    r.seq = rec.maxSeq;
    r.msgCount = rec.msgCount;
    r.firstMsgHash = rec.firstHash == null ? null : rec.firstHash;
    r.lastMsgHash = rec.lastHash == null ? null : rec.lastHash;
    r.superseded = superseded;
    this._trimSuperseded(r, true); // 旧版本检查点可能带了超过当前上限的集合：装回后立即裁到上限
    r.pendingRemotes = pending;
    r.toolMetas = new Map();
    for (const m of rec.toolMetas) {
      const meta = cleanToolMeta(m);
      if (meta) this._applyToolMeta(r, meta);
    }
    this._trimToolMetas(r);
    r.recent = [];
    r.recentBytes = 0;
    for (const e of rec.recent) this._cachePush(r, { k: e.k, seq: e.seq, json: e.j });
    r.ckpt = { off: ck.off, len: ck.len, end: ck.end, sum: ck.sum };
    const ctx = this._newIndexCtx();
    this._scanChunksSync(r, r.file, ck.end, ctx);
    this._finishIndex(r, ctx);
    return true;
  }

  /** 磁盘记录 → 热缓存条目。msg 行是本模块写出的固定前缀格式时直接切片，省一次 stringify */
  _entryFromRecord(rec, line) {
    if (rec.k === "remote") {
      return { k: "remote", seq: rec.seq, text: rec.text, json: remoteJson(rec.text, rec.at || 0, cleanCid(rec.cid)) };
    }
    let json = null;
    if (line && MSG_PREFIX.test(line) && line.endsWith("}")) {
      const m = MSG_PREFIX.exec(line);
      json = line.slice(m[0].length, -1);
    }
    if (json === null) json = JSON.stringify(rec.m);
    return { k: "msg", seq: rec.seq, json };
  }

  _cachePush(r, entry) {
    r.recent.push(entry);
    r.recentBytes += entry.json.length;
    let drop = 0;
    let bytes = r.recentBytes;
    // 不落盘时条数上限会丢掉没有磁盘副本的头部。只按字节从最旧丢，至少留一条。
    // 落盘时条数和字节都裁热缓存，超出 cacheSize 的记录由 snapshot 从磁盘补回。
    while (
      r.recent.length - drop > 1 &&
      ((this.persist && r.recent.length - drop > this.cacheSize) || bytes > this.cacheMaxBytes)
    ) {
      bytes -= r.recent[drop].json.length;
      drop++;
    }
    if (drop) {
      r.recent.splice(0, drop);
      r.recentBytes = bytes;
    }
  }

  /**
   * 反向扫描：取 after < seq < before 的记录（新→旧），最多 limit 条、最多读 maxBytes 字节。
   * hasMore = 因 limit 截断；more = 因 maxBytes 提前停止、磁盘上还有更早的历史。
   */
  _scanBack(file, before, limit, maxBytes = 8 * 1024 * 1024, after = 0) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { records: [], hasMore: false, more: false, scanned: 0 };
    }
    if (size === 0) return { records: [], hasMore: false, more: false, scanned: 0 };
    const out = [];
    let pos = size;
    // carry 保存"下一块开头那一行的前缀字节"，停留在 Buffer 域：整段连续字节一次性解码，
    // 不存在跨块字符损坏。
    let carry = Buffer.alloc(0);
    let scanned = 0;
    let reachedAfter = false;
    let fd;
    try {
      fd = fs.openSync(file, "r");
      while (pos > 0 && out.length <= limit && scanned < maxBytes && !reachedAfter) {
        const n = Math.min(65536, pos);
        pos -= n;
        scanned += n;
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, pos);
        const full = carry.length ? Buffer.concat([buf, carry]) : buf;
        let text;
        if (pos > 0) {
          const firstNl = full.indexOf(10);
          if (firstNl >= 0) {
            text = full.slice(firstNl + 1).toString("utf8");
            carry = full.slice(0, firstNl);
          } else {
            carry = full;
            continue;
          }
        } else {
          text = full.toString("utf8");
        }
        const lines = text.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          if (!rec || (rec.k !== "msg" && rec.k !== "remote") || typeof rec.seq !== "number") continue;
          if (rec.seq >= before) continue;
          if (rec.seq <= after) { reachedAfter = true; break; }
          rec._line = line;
          out.push(rec);
          if (out.length > limit) break;
        }
      }
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
    const more = !reachedAfter && pos > 0 && scanned >= maxBytes && out.length <= limit;
    const hasMore = out.length > limit;
    if (hasMore) out.pop();
    return { records: out, hasMore, more, scanned };
  }

  /** 追加一行到房间缓冲。flush=true 用于低频、必须尽快耐久的通用记录（如 toolmeta）：
   *  立即走一次批量 flush（连同缓冲里的其它记录）并 fsync，不等 200ms 定时器。
   *  房文件到顶（fileCapped）后不再缓冲新记录：重试没有意义，只会把缓冲撑到硬顶再狂丢。 */
  _writeLine(r, line, { flush = false } = {}) {
    if (!this.persist) return;
    if (r.fileCapped) {
      r.dropped = (r.dropped || 0) + 1;
      return;
    }
    if (!r.metaWritten) {
      r.metaWritten = true;
      const metaLine = JSON.stringify({ k: "meta", seq: 0, rev: r.rev, headTruncated: r.headTruncated || undefined });
      r.metaLine = metaLine;
      r.buf.push(metaLine);
    }
    r.buf.push(line);
    if (flush) this._flush(r, { sync: true });
    else this._scheduleFlush(r);
  }

  _pushMsg(r, m, json) {
    r.seq += 1;
    const j = json || JSON.stringify(m);
    const entry = { k: "msg", seq: r.seq, json: j };
    this._cachePush(r, entry);
    const h = hashOf(m);
    r.lastMsgHash = h;
    if (!r.firstMsgHash) r.firstMsgHash = h;
    r.msgCount += 1;
    this._writeLine(r, `{"k":"msg","seq":${r.seq},"m":${j}}`);
    // 快照追加进来的 user 消息同样要盖掉 remote 回显：message_end 丢了时，只靠 record() 会留下一条永远在的回显
    if (m && m.role === "user") this._supersedeRemote(r, contentText(m));
    return entry;
  }

  _scheduleFlush(r) {
    // 批量满 200 条立即落盘并 fsync；否则 200ms 定时 flush（同样 fsync）。不是每个 delta。
    if (r.buf.length >= FLUSH_BATCH) this._flush(r, { sync: true });
    else if (!r.timer) {
      r.timer = setTimeout(() => {
        r.timer = null;
        this._flush(r, { sync: true });
      }, this.flushIntervalMs);
      if (r.timer.unref) r.timer.unref();
    }
  }

  /** fsync 一个已写过的房间文件。失败只告警：记录已经在页缓存里（进程崩溃不丢），
   *  不能因为 fsync 失败把缓冲当成未落盘而重写一遍——那会产生重复记录。 */
  _fsyncFile(file) {
    let fd;
    try {
      fd = fs.openSync(file, "r+");
      fs.fsyncSync(fd);
      return true;
    } catch (e) {
      console.warn("[store] fsync 失败（已写入页缓存；进程崩溃不丢，断电可能丢）:", file, e.message);
      return false;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** fsync 数据目录（目录项耐久）：文件内容 fsync 只保证数据块落盘，新建/删除/rename 产生的
   *  目录项还要同步父目录，否则掉电可能出现"内容在、文件名不在"（丢整个新房文件/刚写的索引）。
   *  尽力而为：Windows 与部分文件系统不允许 fsync 目录，失败只告警一次并降级，不阻断写入
   *  ——检查点指针本身有 sha1/rev 校验，真丢了最多回退一次全量扫描。 */
  _fsyncDir(dir = this.dir) {
    let fd;
    try {
      fd = fs.openSync(dir, "r");
      fs.fsyncSync(fd);
      return true;
    } catch (e) {
      if (!this._dirFsyncWarned) {
        this._dirFsyncWarned = true;
        console.warn("[store] 目录 fsync 失败（目录项耐久降级为尽力而为）:", dir, e.message);
      }
      return false;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** 目录项耐久的重试入口：成功一次就标 dirSynced；失败按退避重试，**绝不再"一次失败就永久算已同步"**。
   *  force=true 用于刚完成 rename 的指针写：即使这个房间此前目录项已同步过，这次 rename 的目录项
   *  也要单独落盘（否则掉电后指针可能"复活"成上一代）。 */
  _syncRoomDir(r, { force = false } = {}) {
    const now = this._now();
    if (!force && r.dirSynced) return true;
    if (!force && r._dirSyncRetryAt && now < r._dirSyncRetryAt) return false;
    if (this._fsyncDir(this.dir)) {
      r.dirSynced = true;
      r._dirSyncRetryAt = 0;
      r._dirSyncTries = 0;
      return true;
    }
    r.dirSynced = false;
    r._dirSyncTries = (r._dirSyncTries || 0) + 1;
    const delay = Math.min(
      DIR_FSYNC_RETRY_MAX_MS,
      DIR_FSYNC_RETRY_MIN_MS * 2 ** Math.min(r._dirSyncTries - 1, 6),
    );
    r._dirSyncRetryAt = now + delay;
    return false;
  }

  /** 启动时清理检查点指针临时文件孤儿：_writeCheckpointPointer 只在自己的同步写路径里兜底删除，
   *  进程被强杀（或宿主机掉电）留下的 <room>.ckpt.json.<pid>.<hex>.tmp 没人清理，会永久占着目录。
   *  只删一小时以前的：另一个进程可能正在写同名临时文件，不能误删。 */
  _cleanupOrphanTemps() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - CKPT_TMP_MAX_AGE_MS;
    let removed = 0;
    for (const name of names) {
      if (!CKPT_TMP_RE.test(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.mtimeMs > cutoff) continue;
        fs.unlinkSync(file);
        removed++;
      } catch {}
    }
    if (removed) {
      console.warn(`[store] 清理检查点临时文件孤儿 ${removed} 个（上次写入进程异常退出）`);
    }
    return removed;
  }

  /**
   * 追加一批已序列化字节，返回 {ok, off, size, error, writtenLines, partial, tooLarge}。
   *  - 追加前确认文件尾是换行：残行先截掉（崩溃残留/上次半截写入），否则重试会与残行粘成一行；
   *  - 用 writeSync 自己记录实际写入字节；失败时已完整写入的行算已落盘（writtenLines），
   *    写了一半的行截掉，调用方只重试没写完的行——绝不整批重写（否则重复记录 + 粘行）；
   *  - 这一批会越过 maxRoomFileBytes 时整批拒写（tooLarge）：房文件本体的硬上限，不写出半条记录。
   */
  _appendBatch(r, data, lineCount) {
    if (fs.existsSync(r.file) && !this._repairTail(r)) {
      return { ok: false, off: 0, error: new Error("文件末尾没有完整换行，拒绝追加（防粘行）"), writtenLines: 0, partial: false };
    }
    let fd;
    let off = 0;
    let haveOff = false;
    let written = 0;
    try {
      fd = fs.openSync(r.file, "a+");
      off = fs.fstatSync(fd).size;
      haveOff = true;
      if (this.maxRoomFileBytes > 0 && off + data.length > this.maxRoomFileBytes) {
        return {
          ok: false,
          off,
          tooLarge: true,
          error: new Error(`房文件将超过上限 ${this.maxRoomFileBytes} 字节（当前 ${off} + ${data.length}）`),
          writtenLines: 0,
          partial: false,
        };
      }
      while (written < data.length) {
        const n = fs.writeSync(fd, data, written, data.length - written);
        if (!(n > 0)) throw new Error("writeSync 未写入任何字节");
        written += n;
      }
      return { ok: true, off, size: off + data.length, writtenLines: lineCount, partial: false };
    } catch (e) {
      // 已完整写入的行保留（调用方从缓冲里丢掉，避免重写重复）；写了一半的行截掉。
      let complete = 0;
      for (let i = 0; i < written; i++) if (data[i] === 0x0a) complete++;
      let partial = false;
      // 只有拿到起始偏移后才允许截断：fstat 本身失败时 off 不可信，绝不能把文件截到 0。
      if (fd !== undefined && haveOff) {
        let cut = off;
        for (let i = written - 1; i >= 0; i--) {
          if (data[i] === 0x0a) { cut = off + i + 1; break; }
        }
        try {
          // 失败的系统调用可能留下未计入 written 的字节：一律截回最后一个完整行边界。
          if (fs.fstatSync(fd).size > cut) fs.ftruncateSync(fd, cut);
        } catch {
          partial = true;
        }
      }
      return { ok: false, off, error: e, writtenLines: complete, partial };
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** 落盘失败后的缓冲硬顶：保留最新一端，丢最旧一端；但钉在缓冲里的 meta 行永不丢
   *  （丢了 metaWritten 仍是 true，重启后 rev 对不上、被删回显复活）。 */
  _trimBuffer(r, drop) {
    let removed = 0;
    while (removed < drop && r.buf.length > 1) {
      const i = r.buf[0] === r.metaLine ? 1 : 0;
      if (i >= r.buf.length) break;
      r.buf.splice(i, 1);
      removed++;
    }
    if (removed) {
      r.dropped = (r.dropped || 0) + removed;
      console.error(`[store] 房间 ${r.id} 落盘持续失败，丢弃最旧 ${removed} 条缓冲（累计 ${r.dropped}）`);
    }
  }

  /** 房文件到达上限：停止落盘。缓冲里的这一批不再写（内存热缓存已有一份），只计数并告警一次。
   *  之后 _writeLine 直接丢弃新记录（seq 照常递增），快照靠 distinct seq 缺口/热缓存标记 truncated。 */
  _markFileCapped(r) {
    const dropped = r.buf.length;
    r.buf = [];
    r.metaLine = null;
    r.fileCapped = true;
    if (dropped) r.dropped = (r.dropped || 0) + dropped;
    if (!r._capWarned) {
      r._capWarned = true;
      console.error(
        `[store] 房间 ${r.id} 房文件达到上限 ${this.maxRoomFileBytes} 字节，停止落盘` +
          `（内存热缓存继续服务；快照会按缺口标记 truncated，重启后旧历史仍可读）`,
      );
    }
  }

  /**
   * 批量追加落盘。sync 默认 true：每次 flush（200ms 定时、满 200 条、seed/尾部补传、
   * 空闲淘汰前、快照前、flushAll 关闭）都在追加后 fsync；store 只在 message_end /
   * remote_message 这类非流式事件上写，delta 根本不进这里，所以不是"每个 delta fsync"。
   * 代价：硬断电唯一可能丢的是还在 r.buf 里、尚未 flush 的尾部（≤200ms / ≤200 条）；
   * 进程崩溃/重启不丢（writeSync 已交给内核页缓存）。sync=false 只用于测试/调试。
   */
  _flush(r, { sync = true, allowCkpt = true } = {}) {
    if (!r.buf.length) return;
    const data = Buffer.from(r.buf.join("\n") + "\n", "utf8");
    const res = this._appendBatch(r, data, r.buf.length);
    if (res.ok) {
      r.buf = [];
      r.metaLine = null;
      const fsyncOk = !sync || this._fsyncFile(r.file);
      // 新建文件首次成功落盘后同步目录项：内容 fsync 不能保证文件名本身抗掉电。
      // 失败不再是"一次性放弃"：_syncRoomDir 保持 dirSynced=false 并按退避在后续 flush 重试。
      if (fsyncOk && sync && !r.dirSynced) this._syncRoomDir(r);
      if (allowCkpt && fsyncOk) this._maybeCheckpoint(r);
      return;
    }
    if (res.tooLarge) {
      // 房文件到顶不是临时写失败：重试永远不会成功，重试只会让缓冲涨到硬顶再狂丢。
      this._markFileCapped(r);
      return;
    }
    // 落盘失败不能影响实时流；保留没写完的缓冲稍后重试。
    // 已经完整写入的行从缓冲前面移除（不能整批重写，否则文件里出现重复记录）。
    console.warn("[store] 落盘失败（稍后重试）:", r.id, res.error && res.error.message);
    if (res.writtenLines) {
      const done = r.buf.splice(0, res.writtenLines);
      if (r.metaLine && done.includes(r.metaLine)) r.metaLine = null;
    }
    // 缓冲必须有硬顶（条数 + 字节），磁盘满/权限异常时持续失败不能把 relay 拖到 OOM。
    let keep = r.buf.length;
    if (keep > FLUSH_BUF_MAX_COUNT) keep = FLUSH_BUF_MAX_COUNT;
    let bytes = 0;
    for (let i = r.buf.length - 1, c = 0; i >= 0; i--, c++) {
      bytes += r.buf[i].length + 1;
      if (bytes > FLUSH_BUF_MAX_BYTES || c + 1 > FLUSH_BUF_MAX_COUNT) { keep = Math.min(keep, c); break; }
    }
    if (keep < r.buf.length) this._trimBuffer(r, r.buf.length - keep);
    if (!r.timer) {
      r.timer = setTimeout(() => {
        r.timer = null;
        this._flush(r);
      }, 1000);
      if (r.timer.unref) r.timer.unref();
    }
  }

  // ---------- 检查点 ----------

  /** 检查点里带的热缓存：最多 CKPT_RECENT_MAX 条，但保证最近 8 条消息在（tailHashes 默认窗口）。
   *  字节上限只裁更旧的条目；极端大消息宁可让检查点大一点，也不破坏"重启后尾哈希一致"。 */
  _packRecent(recent) {
    if (!recent.length) return [];
    let start = Math.max(0, recent.length - CKPT_RECENT_MAX);
    let msgs = 0;
    for (let i = recent.length - 1; i >= start; i--) if (recent[i].k === "msg") msgs++;
    while (start > 0 && msgs < CKPT_RECENT_MIN_MSGS) {
      start--;
      if (recent[start].k === "msg") msgs++;
    }
    const picked = recent.slice(start);
    let bytes = 0;
    for (const e of picked) bytes += e.json.length;
    while (bytes > CKPT_RECENT_MAX_BYTES && picked.length > CKPT_RECENT_MIN_MSGS) {
      bytes -= picked[0].json.length;
      picked.shift();
    }
    return picked.map((e) => ({ k: e.k, seq: e.seq, j: e.json }));
  }

  /** 上次检查点因过大被拒后的冷却期内，直接跳过（不整包 stringify、不写盘、不打日志）。 */
  _ckptCooling(r) {
    if (!r._ckptReject) return false;
    return this._now() - r._ckptReject.at < this.ckptRejectCooldownMs;
  }

  /** 到点才写：文件够大、且距上一个检查点又长了 ckptIntervalBytes。
   *  全量扫描后的首次写入用 minBytes:0（旧文件无论大小都补一个）；运行时默认走 ckptMinBytes。 */
  _maybeCheckpoint(r, { minBytes = this.ckptMinBytes } = {}) {
    if (!this.persist || r._ckptWriting || r._indexFailed || r.fileCapped) return false;
    if (this._ckptCooling(r)) return false;
    if (!r.seq && !r.msgCount) return false;
    let size = 0;
    try { size = fs.statSync(r.file).size; } catch { return false; }
    if (size <= 0 || size < minBytes) return false;
    if (r.ckpt && size - r.ckpt.end < this.ckptIntervalBytes) return false;
    return this._writeCheckpoint(r);
  }

  /** 房文件末尾追加一行 {k:"ckpt",...}（含完整聚合状态 + 有界热缓存 + pending + superseded），
   *  fsync 成功后才原子更新 <room>.ckpt.json 指针。顺序保证任何时刻崩溃：旧指针仍指向旧检查点，
   *  多出来的 ckpt 行会被后续扫描当未知记录忽略。 */
  _writeCheckpoint(r) {
    if (!this.persist || r._ckptWriting || r._indexFailed || r.fileCapped) return false;
    if (this._ckptCooling(r)) return false; // 直接调用（测试/内部）也遵守冷却，避免绕过限频
    if (!r.rev || (!r.seq && !r.msgCount)) return false;
    r._ckptWriting = true;
    try {
      // 先落缓冲：检查点聚合的是"文件里已存在的记录 + 热缓存状态"，不能指向缺尾巴的状态。
      this._flush(r, { sync: true, allowCkpt: false });
      if (r.buf.length) return false; // 落盘失败，别写指向不完整状态的检查点
      const payload = JSON.stringify({
        k: "ckpt",
        v: CKPT_VERSION,
        seq: 0, // 旧实现要求 seq 是数字（0 不会抬高 r.seq），且 k 未知 => 被忽略
        maxSeq: r.seq, // 真正的 seq 上限单独存（上面的 seq 只为旧实现兼容）
        rev: r.rev,
        msgCount: r.msgCount,
        firstHash: r.firstMsgHash,
        lastHash: r.lastMsgHash,
        headTruncated: !!r.headTruncated,
        metaWritten: !!r.metaWritten,
        recent: this._packRecent(r.recent),
        pending: r.pendingRemotes.map((p) => ({ seq: p.seq, text: p.text, cid: p.cid || undefined })),
        toolMetas: [...r.toolMetas.values()].map((m) => ({ ...m })),
        superseded: packSeqs(r.superseded),
        at: Date.now(),
      });
      const lineBuf = Buffer.from(payload + "\n", "utf8");
      if (lineBuf.length > this.ckptPayloadMaxBytes) {
        const now = this._now();
        r._ckptReject = { at: now, bytes: lineBuf.length };
        // 日志也限频：冷却期内不会重试，正常情况下每次拒绝最多一行；注入时钟/手动调用也不刷屏。
        if (now - r._ckptRejectWarnAt >= this.ckptRejectCooldownMs) {
          r._ckptRejectWarnAt = now;
          console.warn(
            `[store] 房间 ${r.id} 检查点过大（${lineBuf.length} 字节 > ${this.ckptPayloadMaxBytes}），` +
              `跳过并在 ${Math.ceil(this.ckptRejectCooldownMs / 1000)}s 内不再重试`,
          );
        }
        return false;
      }
      const started = Date.now();
      // 检查点行也是追加写：同样要防半截写入。失败时已写完整的行不会重复、残行会被截掉。
      const appended = this._appendBatch(r, lineBuf, 1);
      if (!appended.ok) {
        if (appended.tooLarge) this._markFileCapped(r);
        console.warn("[store] 写检查点行失败（继续按文件追加/全量扫描）:", r.id, appended.error && appended.error.message);
        return false;
      }
      // fsync 失败时不推进指针：旧指针仍然有效，绝不能让指针指向可能断电丢失的行。
      if (!this._fsyncFile(r.file)) return false;
      const off = appended.off; // _appendBatch 可能先修掉了残行，偏移必须用它回报的起点
      const sum = sha1(Buffer.from(payload, "utf8"));
      const ptr = { v: CKPT_VERSION, room: r.id, rev: r.rev, off, len: lineBuf.length, sum, at: Date.now() };
      if (!this._writeCheckpointPointer(r, ptr)) return false;
      r.ckpt = { off, len: lineBuf.length, end: off + lineBuf.length, sum };
      r._ckptReject = null;
      r._ckptRejectWarnAt = 0;
      const ms = Date.now() - started;
      if (ms > 200) console.warn(`[store] 房间 ${r.id} 写检查点较慢：${lineBuf.length} 字节 ${ms}ms`);
      return true;
    } catch (e) {
      console.warn("[store] 写检查点失败（继续按文件追加/全量扫描）:", r.id, e.message);
      return false;
    } finally {
      r._ckptWriting = false;
    }
  }

  /** 指针文件先写临时文件 + fsync + rename，避免半截 JSON 被当成有效指针。 */
  _writeCheckpointPointer(r, ptr) {
    const file = this._ckptFile(r.id);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, "w");
      fs.writeFileSync(fd, JSON.stringify(ptr) + "\n", "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, file);
      // rename 的目录项也要持久化。force：即使这个房间此前目录项已同步过，这次 rename 的
      // 目录项也必须单独落盘；失败时 dirSynced 保持 false，后续 flush 会按退避重试。
      this._syncRoomDir(r, { force: true });
      return true;
    } catch (e) {
      console.warn("[store] 写检查点指针失败（保留旧指针）:", r.id, e.message);
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  _removeCheckpointPointer(id) {
    let removed = false;
    try { fs.unlinkSync(this._ckptFile(id)); removed = true; } catch {}
    // 删除目录项也要同步：掉电后旧指针不能"复活"。旧指针有 rev/sha1 校验，最坏只多一次全量扫描。
    if (removed) this._fsyncDir(this.dir);
  }

  // ---------- 构造器异步预热 ----------

  /** 目录里"大且没有有效检查点"的房文件才预热；有检查点的房间打开时本来只读尾巴。 */
  _prewarmAll() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (e) {
      console.warn("[store] 预热枚举数据目录失败:", e.message);
      this._notifyPrewarm();
      return;
    }
    const jobs = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      const id = ent.name.slice(0, -".jsonl".length);
      if (!safeRoomId(id)) continue;
      const file = path.join(this.dir, ent.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size < this.prewarmMinBytes) continue;
      if (this._readCheckpoint(id, file, { quiet: true })) continue;
      jobs.push({ id, file, size: st.size, ino: st.ino, mtimeMs: st.mtimeMs });
    }
    if (!jobs.length) {
      this._notifyPrewarm();
      return;
    }
    // 构造器预热不是"把整个 data 目录搬进内存"：最多保留 prewarmMaxRooms 个索引。
    // 按 mtime 从新到旧排，优先预热最近活跃的房间（最可能被马上打开），其余首次打开时同步扫描。
    jobs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    if (jobs.length > this.prewarmMaxRooms) {
      console.warn(
        `[store] 待预热房间 ${jobs.length} 个，超过上限 ${this.prewarmMaxRooms}，只预热最近活跃的 ${this.prewarmMaxRooms} 个`,
      );
    }
    this._prewarmPending += 1;
    (async () => {
      try {
        for (const job of jobs) {
          if (this._prewarmed.size >= this.prewarmMaxRooms) break;
          if (this.rooms.has(job.id) || this._prewarmed.has(job.id)) continue;
          try {
            await this._prewarmRoom(job);
          } catch (e) {
            console.warn("[store] 房间预热异常（首次打开回退同步扫描）:", job.id, e.message);
          }
        }
      } finally {
        this._prewarmPending -= 1;
        this._notifyPrewarm();
      }
    })();
  }

  /** 分块读 + 每块结束 setImmediate：单块解析只有几百 KB，事件循环在块间一定可调度。
   *  完成后把索引留给 _room() 直接接管，并补一个检查点，下次重启即只读尾巴。 */
  _prewarmRoom(job) {
    return new Promise((resolve) => {
      const r = this._newRoom(job.id, job.file);
      r.dirSynced = true; // 预热只挑已存在的文件
      const ctx = this._newIndexCtx();
      const dec = new StringDecoder("utf8");
      const started = Date.now();
      let carry = "";
      let pos = 0;
      let fd;
      let size = job.size;
      let repaired = false;
      let tailOk = true;
      const cleanup = () => {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
      };
      const step = () => {
        try {
          // 预热期间房间已被同步打开：放弃这份索引，不覆盖活跃状态。
          if (this.rooms.has(job.id)) { cleanup(); resolve(); return; }
          if (!repaired) {
            repaired = true;
            // 旧文件可能有半截尾行：先修掉，否则检查点行会粘在残行后面。
            tailOk = this._repairTail(r, 0);
            const st = fs.statSync(job.file);
            size = st.size;
            job.ino = st.ino;
            job.size = size;
            job.mtimeMs = st.mtimeMs;
          }
          if (pos >= size) {
            // 文件在预热期间被改写/轮转：丢弃预热结果，首次打开回退同步扫描。
            let st;
            try { st = fs.statSync(job.file); } catch { cleanup(); resolve(); return; }
            if (st.size !== size || (job.ino != null && st.ino !== job.ino) ||
                (job.mtimeMs != null && st.mtimeMs !== job.mtimeMs)) {
              cleanup();
              resolve();
              return;
            }
            this._finishIndex(r, ctx);
            if (!r.rev) r.rev = newRev();
            // 病态文件（没有完整换行边界）：预热出来的只是半份/空索引，不能当正常房交给首次打开。
            if (!tailOk) this._markIndexFailed(r, "文件末行残缺且找不到完整换行边界");
            r.lastActivity = Date.now();
            // 先补检查点（可能追加一行、改变文件大小），再记录接管指纹。
            this._maybeCheckpoint(r, { minBytes: 0 });
            let st2;
            try { st2 = fs.statSync(job.file); } catch { cleanup(); resolve(); return; }
            this._rememberPrewarmed(job.id, { room: r, size: st2.size, ino: st2.ino, mtimeMs: st2.mtimeMs });
            const ms = Date.now() - started;
            if (ctx.skipped || ms > 1000) {
              console.warn(`[store] 房间 ${job.id} 预热完成：seq=${r.seq} 跳过坏记录=${ctx.skipped} 耗时=${ms}ms`);
            }
            cleanup();
            resolve();
            return;
          }
          if (!fd) fd = fs.openSync(job.file, "r");
          const n = Math.min(PREWARM_CHUNK, size - pos);
          const buf = Buffer.alloc(n);
          fs.readSync(fd, buf, 0, n, pos);
          pos += n;
          const lines = (carry + dec.write(buf)).split("\n");
          carry = lines.pop();
          for (const line of lines) this._ingestLine(r, ctx, line);
          setImmediate(step);
        } catch (e) {
          cleanup();
          console.warn("[store] 房间预热失败（首次打开回退同步扫描）:", job.id, e.message);
          resolve();
        }
      };
      setImmediate(step);
    });
  }

  /** 重置房间存储（会话换代/分支跳转后由 relay 调用）：内存与磁盘都清空，换新 rev，等待重新 seed。
   *  返回是否成功：落盘模式下截断旧文件失败时返回 false，且**不动内存状态**（内存与磁盘继续
   *  保持同一旧世代），调用方绝不能继续把新世代 seed 进去——否则新旧两代混写一个文件，
   *  重启后旧分支消息全部"复活"。 */
  reset(roomId) {
    // 预热好但还没打开的索引也必须作废，否则 reset 后第一次打开会把旧历史装回来。
    this._dropPrewarmed(roomId);
    const r = this.rooms.get(roomId);
    // 指针先删：即使随后截断失败，旧指针也不能再把这代历史装回来。
    this._removeCheckpointPointer(roomId);
    const file = this._file(roomId);
    // 先清磁盘，成功后才清内存：失败时保持内存/磁盘同一旧世代，绝不能让内存先行换代。
    try {
      if (this.persist) {
        // 截断为 0 而不是删除：rmSync 失败（EACCES/EBUSY）时旧文件还在，
        // 新的 seed 会追加到旧文件尾部，重启后旧分支消息全部"复活"。
        fs.closeSync(fs.openSync(file, "w"));
        // 换代是可确认的状态转换：fsync 一下，别让断电把截断前的旧分支带回来
        this._fsyncFile(file);
      } else if (fs.existsSync(file)) {
        // 默认不落盘：没有文件就别创建空文件；旧文件若还在，截断以免换代后被装配回来。
        fs.truncateSync(file, 0);
      }
    } catch (e) {
      console.error("[store] 房间重置失败（旧文件可能残留，禁止继续 seed）:", roomId, e.message);
      if (r) r.resetFailed = true;
      return false;
    }
    if (r) {
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
      r.buf = [];
      r.metaLine = null;
      r.dropped = 0;
      r.seq = 0;
      r.recent = [];
      r.recentBytes = 0;
      r.superseded = new Set();
      r.pendingRemotes = [];
      r.toolMetas = new Map();
      r.lastMsgHash = null;
      r.firstMsgHash = null;
      r.msgCount = 0;
      r.rev = newRev();
      r.metaWritten = false;
      r.headTruncated = false;
      r.ckpt = null;
      r._ckptWriting = false;
      r._ckptReject = null;
      r._ckptRejectWarnAt = 0;
      r.resetFailed = false;
      // 换了个新（或刚截断的）文件：目录项要重新同步。失败时 _syncRoomDir 会保持 false 并稍后重试，
      // 不能像旧写法那样直接把 dirSynced 置成"已同步"（一次失败就永久放弃）。
      r.dirSynced = false;
      r._dirSyncRetryAt = 0;
      r._dirSyncTries = 0;
      r.fileCapped = false;
      r._capWarned = false;
      r.indexPartial = false;
      r._indexFailed = false;
    }
    if (this.persist) {
      // 文件可能是刚创建的：目录项同样要落盘，否则换代后的空文件/新 seed 可能随掉电消失。
      if (r) this._syncRoomDir(r, { force: true });
      else this._fsyncDir(this.dir);
    }
    return true;
  }

  // ---------- 写 ----------

  /** 记录一条 pi 事件（message_end / remote_message / tool_execution_end，其余忽略；system 不落盘）。
   *  返回本条记录的 seq（未记录/元数据返回 0）——relay 把它放进 room_event，UI 据此去重/发现缺口。 */
  record(roomId, event) {
    if (!event || typeof event.type !== "string") return 0;
    if (event.type === "message_end" && event.message && typeof event.message.role === "string") {
      if (event.message.role === "system") return 0;
      const r = this._room(roomId, { create: true });
      if (!r) return 0;
      this._pushMsg(r, event.message);
      return r.seq;
    }
    if (event.type === "tool_execution_end") {
      this.recordToolEnd(roomId, event);
      return 0; // 元数据不是 transcript 记录，不占 seq
    }
    if (event.type === "remote_message" && typeof event.text === "string") {
      const r = this._room(roomId, { create: true });
      if (!r) return 0;
      r.seq += 1;
      const at = event.at || Date.now();
      const cid = cleanCid(event.cid);
      this._cachePush(r, { k: "remote", seq: r.seq, text: event.text, json: remoteJson(event.text, at, cid) });
      const line = { k: "remote", seq: r.seq, text: event.text, at };
      if (cid) line.cid = cid;
      this._writeLine(r, JSON.stringify(line));
      this._rememberRemote(r, r.seq, event.text, cid);
      return r.seq;
    }
    if (event.type === "remote_message_failed") this.markRemoteFailed(roomId, event.text, event.cid);
    return 0;
  }

  /** 房间是否真实存在（在内存注册表，或磁盘有文件）——供 viewer 订阅前验真，防幻影房 */
  exists(id) {
    if (!safeRoomId(id)) return false;
    if (this.rooms.has(id)) return true;
    return this.persist && fs.existsSync(this._file(id));
  }

  /** 对齐锚点（扩展重连时据此决定只传尾部还是全量）。
   *  indexFailed=true 表示这个房间的索引没装全（扫描失败/病态文件）：调用方/诊断能看到"不完整"，
   *  而不是把半份历史当正常房。 */
  info(roomId) {
    const r = this._room(roomId);
    if (!r) {
      return { exists: false, rev: null, seq: 0, msgCount: 0, firstHash: null, lastHash: null, dropped: 0, indexFailed: false };
    }
    return {
      exists: true,
      rev: r.rev,
      seq: r.seq,
      msgCount: r.msgCount,
      firstHash: r.firstMsgHash,
      lastHash: r.lastMsgHash,
      dropped: r.dropped || 0,
      indexFailed: !!(r._indexFailed || r.indexPartial),
    };
  }

  /** 最近 max 条消息的 hash（旧→新），给扩展对齐用。
   *  检查点只带有限热缓存：不够时从磁盘尾部倒扫补齐，保证重启后的尾哈希与全量扫描一致。 */
  _tailHashes(r, max = 8) {
    const n = Math.max(0, max);
    const newestFirst = [];
    for (let i = r.recent.length - 1; i >= 0 && newestFirst.length < n; i--) {
      const e = r.recent[i];
      if (!e || e.k !== "msg") continue;
      try {
        newestFirst.push(hashOf(JSON.parse(e.json)));
      } catch {
        return [];
      }
    }
    if (newestFirst.length < n && this.persist) {
      let before = r.recent.length ? r.recent[0].seq : Number.MAX_SAFE_INTEGER;
      let budget = 8 * 1024 * 1024; // 兜底补读最多 8MB：appendMessages 的 k 很大时不能把整个文件倒扫一遍
      while (newestFirst.length < n && budget > 0) {
        const want = Math.max((n - newestFirst.length) * 8, 64);
        const disk = this._scanBack(r.file, before, want, budget, 0);
        if (!disk.records.length) break;
        for (const rec of disk.records) {
          if (rec.k !== "msg") continue;
          newestFirst.push(hashOf(rec.m));
          if (newestFirst.length >= n) break;
        }
        budget -= disk.scanned || 0;
        if (budget <= 0) break; // 8MB 用尽，不再无限倒扫
        const oldest = disk.records[disk.records.length - 1].seq;
        if (oldest >= before) break;
        before = oldest;
      }
    }
    newestFirst.reverse();
    return newestFirst;
  }

  tailHashes(roomId, max = 8) {
    const r = this._room(roomId);
    if (!r) return [];
    return this._tailHashes(r, max);
  }

  _seedAll(r, incoming, headTruncated) {
    r.headTruncated = !!headTruncated;
    for (const m of incoming) this._pushMsg(r, m);
    this._flush(r, { sync: true });
  }

  /** 用扩展快照同步镜像。
   *  规则（完整镜像 = 本机当前分支）：
   *   - 存储空 → seed
   *   - 快照是已有历史的延续（头/尾锚点对齐）→ 只按位置追加第 N 条之后的新消息（重连补洞）
   *   - 快照被扩展从头部截断过（truncated）→ 用内存消息尾窗在快照里定位，只追加其后的消息。
   *     整段尾窗对不上时，内存后缀等于快照前缀仍算对齐（头部还在内存里，不换代）；对不上才换代
   *   - 否则（跳到另一分支 / 切回旧会话）→ reset 后重新 seed。**绝不合并**：合并会得到新旧并集。
   *  返回 {seeded, merged, reset, baseSeq, items}：items 是追加部分的消息 JSON（供 relay 广播增量）。 */
  seedOrMerge(roomId, messages, { truncated = false } = {}) {
    const none = { seeded: 0, merged: 0, reset: false, baseSeq: 0, items: [] };
    if (!Array.isArray(messages) || !messages.length) return none;
    const r = this._room(roomId, { create: true });
    if (!r) return none;
    const incoming = messages.filter((m) => m && typeof m.role === "string" && m.role !== "system");
    if (!incoming.length) return none;

    if (r.msgCount === 0 && r.seq === 0) {
      // 上一次 reset 截断旧文件失败：内存是空的，但磁盘上还有旧世代。直接 seed 会把新历史
      // 追加在旧文件后面（重启后新旧混写），必须先重试 reset，失败就中止本次 seed。
      if (r.resetFailed && !this.reset(roomId)) {
        console.error(`[store] 房间 ${roomId} 旧文件截断失败，拒绝 seed（避免新旧历史混写）`);
        return { seeded: 0, merged: 0, reset: false, resetFailed: true, baseSeq: 0, items: [] };
      }
      this._seedAll(r, incoming, truncated);
      return { seeded: incoming.length, merged: 0, reset: false, baseSeq: 0, items: [] };
    }

    const N = r.msgCount || 0;
    const M = incoming.length;
    let appendFrom = -1;
    if (truncated) {
      // 快照从头部截过，位置对不齐。用热缓存里的消息尾窗（remote 不在快照里，跳过）定位。
      // 不能只拿最后一条 hash：custom/摘要的 hash 不含时间戳，同内容的后一条会先被命中，中间消息被跳过。
      const tail = [];
      for (const e of r.recent) {
        if (e.k !== "msg") continue;
        try { tail.push(hashOf(JSON.parse(e.json))); } catch { tail.length = 0; break; }
      }
      if (tail.length) {
        const incomingHash = incoming.map((m) => hashOf(m));
        const n = tail.length;
        if (M >= n) {
          // 从右往左：整段尾窗在快照里重复时取最近一次（存储里的就是最新尾部），避免把已有消息再追加一遍
          for (let i = M - n; i >= 0; i--) {
            let ok = true;
            for (let t = 0; t < n; t++) if (incomingHash[i + t] !== tail[t]) { ok = false; break; }
            if (ok) { appendFrom = i + n; break; }
          }
        }
        // 整段对不上（常见于不落盘时内存比截断快照长）：快照是内存历史去掉头部后的后缀。
        // 只接受「内存后缀 == 快照前缀」。对上就不换代，被丢掉的头部留在内存里；前缀之后才是新消息。
        // **兜底门槛**：只重叠 1~2 条时，摘要/工具结果的 hash 不含时间戳，同内容必然同 hash，
        // 会把异分支历史误判成已对齐（主路径明令禁止的单条误判）。低于门槛一律 reset 重新种入。
        if (appendFrom < 0) {
          const max = Math.min(n, M);
          for (let L = max; L >= 1; L--) {
            let ok = true;
            for (let t = 0; t < L; t++) if (incomingHash[t] !== tail[n - L + t]) { ok = false; break; }
            if (!ok) continue;
            // 最大的一段重叠已经找到：满足门槛才对齐，不满足就换代，不能退到更短的重叠。
            let pinned = false;
            for (let t = 0; t < L; t++) if (hashPinsTimestamp(incoming[t])) { pinned = true; break; }
            if (L >= TRUNC_FALLBACK_MIN_OVERLAP && pinned) {
              appendFrom = L;
            } else {
              console.warn(
                `[store] 房间 ${roomId} 截断快照兜底对齐重叠不足（重叠 ${L} 条，` +
                  `带时间戳锚点=${pinned ? "有" : "无"}）：reset 后重新 seed`,
              );
            }
            break;
          }
        }
      }
    } else {
      // 位置对齐：只看 数量 / 头 hash / 尾 hash 三个锚点（不用 hash 集合：连发同文本"继续"会被误判已存在）
      const headOk = !!r.firstMsgHash && hashOf(incoming[0]) === r.firstMsgHash;
      const tailOk = !!r.lastMsgHash && N > 0 && M >= N && hashOf(incoming[N - 1]) === r.lastMsgHash;
      if (headOk && tailOk) appendFrom = N;
      else console.warn(`[store] 房间 ${roomId} 镜像换代：reset 后重新 seed（快照 ${M} 条，原存储 ${N} 条，headOk=${headOk} tailOk=${tailOk}）`);
    }

    if (appendFrom < 0) {
      if (truncated) console.warn(`[store] 房间 ${roomId} 截断快照无法对齐尾锚点：reset 后按截断快照 seed`);
      if (!this.reset(roomId)) {
        // 旧文件截断失败：绝不能把新世代追加进旧文件（重启后新旧分支混成一房）。
        console.error(`[store] 房间 ${roomId} reset 失败，已中止 seed`);
        return { seeded: 0, merged: 0, reset: false, resetFailed: true, baseSeq: 0, items: [] };
      }
      this._seedAll(r, incoming, truncated);
      return { seeded: incoming.length, merged: 0, reset: true, baseSeq: 0, items: [] };
    }
    return this._appendFrom(r, incoming, appendFrom);
  }

  _appendFrom(r, incoming, from) {
    const baseSeq = r.seq;
    const items = [];
    // 按位置追加，绝不做 hash 判重——同文本的连续消息是真实新增
    for (let i = from; i < incoming.length; i++) items.push(this._pushMsg(r, incoming[i]).json);
    if (items.length) this._flush(r, { sync: true });
    return { seeded: 0, merged: items.length, reset: false, baseSeq, items };
  }

  /** 扩展 append 模式：base = 扩展问询时 relay 已有的 {count, hash}，messages = 本机在其后的消息。
   *  问询到上传之间可能又有实时 message_end 落进来（relay 多了 k 条）：这 k 条必然就是 messages 的前 k 条，
   *  用第 k 条对上 lastMsgHash 确认后跳过。锚点不符返回 ok:false（扩展改发全量） */
  appendMessages(roomId, base, messages) {
    const r = this._room(roomId, { create: true });
    if (!r) return { ok: false, reason: "bad_room" };
    // 换代时旧文件没截断成功：任何追加都会把新世代写进旧文件，必须让扩展改发全量
    // （全量走 seedOrMerge → 先重试 reset，失败则中止）。
    if (r.resetFailed) return { ok: false, reason: "reset_failed" };
    const count = Number(base && base.count);
    const hash = base && base.hash ? String(base.hash) : null;
    const incoming = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m.role === "string" && m.role !== "system");
    const fail = () => ({ ok: false, reason: `锚点不符（relay ${r.msgCount}/${r.lastMsgHash}，扩展 ${count}/${hash}）` });
    if (!Number.isInteger(count) || count < 0 || count > r.msgCount) return fail();
    if (count === r.msgCount) {
      if (count > 0 && hash !== r.lastMsgHash) return fail();
      return { ok: true, ...this._appendFrom(r, incoming, 0) };
    }
    const k = r.msgCount - count;
    if (incoming.length < k) return fail();
    // 只核对最后一条会误伤同内容 custom：问询之后多落的 k 条必须整段都在上传的前 k 条里
    const tail = this._tailHashes(r, k);
    if (tail.length !== k) return fail();
    for (let t = 0; t < k; t++) if (hashOf(incoming[t]) !== tail[t]) return fail();
    return { ok: true, ...this._appendFrom(r, incoming, k) };
  }

  _rememberRemote(r, seq, text, cid = null) {
    r.pendingRemotes.push({ seq, text, cid });
    if (r.pendingRemotes.length > INDEX_REMOTE_WINDOW) r.pendingRemotes.shift();
  }

  /** 第 i 条待取代回显从回放摘掉，并写 drop 行（重启后仍然生效） */
  _dropRemote(r, i) {
    const seq = r.pendingRemotes[i].seq;
    r.pendingRemotes.splice(i, 1);
    if (r.superseded.has(seq)) return true;
    r.superseded.add(seq);
    this._trimSuperseded(r);
    this._writeLine(r, JSON.stringify({ k: "drop", seq: 0, ref: seq }));
    return true;
  }

  /** pi 的 user 消息取代 remote 回显：同文本有多条时先进先出取最早一条（后发的还在排队） */
  _supersedeRemote(r, text) {
    const i = r.pendingRemotes.findIndex((p) => remoteEchoMatches(p.text, text));
    return i >= 0 ? this._dropRemote(r, i) : false;
  }

  /**
   * 远程消息注入失败：把对应的 remote 回显从回放里摘掉（否则重订阅后失败的消息像发成功了一样）。
   * 带 cid 只认 cid（对不上就什么都不摘，不能误伤同文本的另一条）；没有 cid 的旧扩展退回按文本摘最近一条。
   */
  markRemoteFailed(roomId, text, cid) {
    const r = this.rooms.get(roomId);
    if (!r) return false;
    const id = cleanCid(cid);
    let i = -1;
    if (id) i = r.pendingRemotes.findIndex((p) => p.cid === id);
    else if (typeof text === "string") {
      for (i = r.pendingRemotes.length - 1; i >= 0; i--) if (remoteEchoMatches(r.pendingRemotes[i].text, text)) break;
    }
    return i >= 0 ? this._dropRemote(r, i) : false;
  }

  drop(roomId) {
    const r = this.rooms.get(roomId);
    if (r) {
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
      this.rooms.delete(roomId);
    }
    this._dropPrewarmed(roomId);
    this._removeCheckpointPointer(roomId);
    let removed = false;
    try { fs.unlinkSync(this._file(roomId)); removed = true; } catch {}
    // 删除房文件的目录项也同步：掉电后不能把已 drop 的历史文件"复活"。
    if (removed) this._fsyncDir(this.dir);
  }

  flushAll({ sync = true } = {}) {
    for (const r of this.rooms.values()) this._flush(r, { sync });
  }

  /** 内存淘汰：空闲超过 maxIdleMs 且 keep(id) 为假的房间刷盘后移出内存（文件保留，下次访问重建索引） */
  evictIdle(maxIdleMs, keep = () => false) {
    const cutoff = Date.now() - maxIdleMs;
    let n = 0;
    for (const [id, r] of this.rooms) {
      if (r.lastActivity > cutoff || keep(id)) continue;
      this._flush(r, { sync: true });
      if (r.buf.length) continue; // 落盘失败的房间不能淘汰（缓冲里是唯一副本）
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
      this.rooms.delete(id);
      n++;
    }
    return n;
  }

  // ---------- 读 ----------

  _deliverable(r, entry) {
    return entry.k === "msg" || (entry.k === "remote" && !r.superseded.has(entry.seq));
  }

  /**
   * 快照装配。返回 {rev, seq, truncated, delta, baseSeq, items}，items 是 old→new 的消息 JSON 串
   * （relay 直接拼进帧里，不再 parse/stringify）。
   *  - since = {rev, seq} 且 rev 一致、seq 有效 → 增量：只交付 seq 之后的记录（delta:true, baseSeq=since.seq）
   *  - 否则全量：热缓存 + 磁盘补齐；limit 条数、maxBytes 字节两道安全阀，触发即 truncated:true
   *  - 索引没装全（扫描失败/病态文件）→ 一律 truncated:true，不把半份历史当完整快照交付
   *  **永不抛错**：调用方（快照发布/重发兜底）拿到异常就发不出帧，订阅者会一直等首帧。
   *  真出 I/O 异常时退化为"带真实锚点 + truncated:true"的空快照，至少让 UI 明确收到不完整而不是干等。
   */
  snapshot(roomId, opts = {}) {
    try {
      return this._snapshot(roomId, opts);
    } catch (e) {
      console.error("[store] 快照装配失败（退回截断空快照，避免订阅者干等）:", roomId, e && e.message);
      const r = this.rooms.get(roomId);
      return {
        rev: r ? r.rev : null,
        seq: r ? r.seq : 0,
        truncated: true,
        delta: false,
        baseSeq: 0,
        items: [],
      };
    }
  }

  _snapshot(roomId, { limit = 10000, maxBytes = 24 * 1024 * 1024, since = null } = {}) {
    const r = this._room(roomId);
    if (!r) return null;
    this._flush(r);
    // 索引不完整时连增量都不能信（baseSeq 可能落在没扫到的区间），只能按全量路径交付并标 truncated。
    const indexPartial = !!(r._indexFailed || r.indexPartial);
    if (!indexPartial && since && since.rev === r.rev && Number.isInteger(since.seq) && since.seq >= 0 && since.seq <= r.seq) {
      const d = this._collect(r, { after: since.seq, limit, maxBytes });
      if (!d.truncated) return { rev: r.rev, seq: r.seq, truncated: false, delta: true, baseSeq: since.seq, items: d.items };
      // 增量本身超安全阀（离线太久）：退回全量，由全量路径给出 truncated 语义
    }
    const f = this._collect(r, { after: 0, limit, maxBytes });
    const truncated = f.truncated || r.headTruncated || indexPartial;
    if (f.truncated) {
      console.warn(`[store] 房间 ${r.id} 快照截断：交付 ${f.items.length} 条（触及 ${limit} 条 / ${Math.round(maxBytes / 1048576)}MB 安全阀）`);
    }
    return { rev: r.rev, seq: r.seq, truncated, delta: false, baseSeq: 0, items: f.items };
  }

  /** 收集 seq > after 的可交付记录（old→new）；先热缓存，不够再磁盘尾扫描 */
  _collect(r, { after, limit, maxBytes }) {
    const picked = []; // new→old
    let bytes = 0;
    let truncated = false;
    // 缺口判定必须数 distinct seq：重复记录（旧的落盘重试 bug 等）能把条数凑满，
    // 缺一条 + 重一条照样报“完整”，UI 就不会把这段增量当成不完整。
    const covered = new Set();
    const cache = r.recent;
    let i = cache.length - 1;
    for (; i >= 0; i--) {
      const e = cache[i];
      if (e.seq <= after) break;
      covered.add(e.seq);
      if (!this._deliverable(r, e)) continue;
      if (picked.length >= limit || bytes + e.json.length > maxBytes) { truncated = true; break; }
      picked.push(e.json);
      bytes += e.json.length + 1;
    }
    const needDisk = this.persist && !truncated && i < 0 && (cache.length ? cache[0].seq : r.seq + 1) > after + 1;
    if (needDisk) {
      const before = cache.length ? cache[0].seq : Number.MAX_SAFE_INTEGER;
      const disk = this._scanBack(r.file, before, Math.max(limit - picked.length, 0), Math.max(maxBytes - bytes, 0), after);
      for (const rec of disk.records) {
        covered.add(rec.seq);
        if (rec.k === "remote" && r.superseded.has(rec.seq)) continue;
        if (rec.k !== "msg" && rec.k !== "remote") continue;
        if (rec.k === "msg" && rec.m && rec.m.role === "system") continue;
        const json = this._entryFromRecord(rec, rec._line).json;
        if (picked.length >= limit || bytes + json.length > maxBytes) { truncated = true; break; }
        picked.push(json);
        bytes += json.length + 1;
      }
      if (disk.hasMore || disk.more) truncated = true;
    }
    // 兜底：distinct seq 覆盖数少于 seq 区间长度 = 有缺口（落盘失败丢批次等），必须让 UI 看见
    if (!truncated && covered.size < r.seq - after) truncated = true;
    picked.reverse();
    return { items: picked, truncated };
  }

  /** 兼容旧接口：返回解析后的 messages（测试与调试用；relay 主路径用 snapshot()） */
  recent(roomId, limit = 10000) {
    const s = this.snapshot(roomId, { limit });
    if (!s) return { messages: [], truncated: false };
    return { messages: JSON.parse("[" + s.items.join(",") + "]"), truncated: s.truncated };
  }
}

module.exports = { RoomStore, hashOf, contentText, remoteEchoMatches, cleanCid };
