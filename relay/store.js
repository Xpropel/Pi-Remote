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
 *      预热（setImmediate 让出事件循环），首次访问直接接管预热结果。预热索引有房间数上限和 TTL
 *      （TTL 只管没被打开的预热结果；被打开接管的索引跟随房间缓存自身的淘汰纪律）。
 *      检查点超过 16MB 被拒后有 60s 冷却，忙房间不会每个消息都重新整包序列化。
 *   7. 首次打开走慢读（R-4）：预热没赶上时，首次打开（含检查点长尾恢复）要扫的字节超过同步
 *      阈值 SYNC_SCAN_MAX_BYTES（默认 1MB）就不再同步全量扫描，而是走与预热同一套异步分块
 *      索引：房间先占位注册，在飞任务登记在 _indexJobs，重复触碰只等同一个任务。索引落地前
 *      占位房间不暴露锚点（rev/seq 为空值、快照一律 truncated），写操作按到达顺序进 journal
 *      排队、落地后重放——不丢、不乱序；事件循环不再被整本账冻住。
 *   8. 目录分组与分段：房文件按 data/rooms/<设备段>/<工作区段>/ 两级分组（设备段 = deviceId，
 *      工作区段 = cwd 的 pi 式编码 --Users-a-...--，与 attach 的 encodeCwdDir 同规则的纯字符串
 *      版——relay 解析不了远端设备的真实路径，只做字符替换；定位由 Rooms 经 setLocator 提供，
 *      查不到的归 _未分类）。存量平铺文件在定位器接入时一次性迁移归位（同盘 rename、幂等、
 *      崩溃可重入、绝不丢数据）。单房默认一个 <roomId>.jsonl（现役段）；现役段写满
 *      SEGMENT_MAX_BYTES（默认 8MB）时封存为 <roomId>.<四位序号>.jsonl 再开新现役段，一条
 *      记录不跨段（整批不越过：这一批写完会超就先封存再写）。每场对话一份 <roomId>.index.json
 *      清单：每段的 {file, bytes, events, firstSeq, lastSeq, state}，state 是该段末尾的聚合
 *      状态（与检查点 payload 同形态，复用 _applyStateRec 装回）。冷打开先读清单：封存段索引
 *      直接取自清单（逐段校验文件字节数，对不上该段作废重扫），只现扫清单未覆盖的尾巴；
 *      检查点覆盖更靠前时以检查点为准（谁覆盖的虚拟偏移大用谁）；清单缺失/损坏 → 全量重扫
 *      并顺路重建清单（降级路径，不报错给用户）。段序列在逻辑上是一个连续字节流：检查点
 *      指针的 off/len/end 都是**虚拟偏移**（前面所有封存段字节数 + 段内偏移），指针格式与
 *      校验口径不变，旧指针在迁移/封存后按虚拟偏移继续有效。单房总量上限 ROOM_FILE_MAX_BYTES
 *      按全段总和判，到顶行为不变。
 *
 * 记录种类（每行一个 JSON）：
 *   {k:"meta", seq:0, rev, headTruncated?, ...}  存储世代；reset/首次 seed 时写在文件首行。
 *      标准字段之外的未知字段一律原样保留往返（加密地基阶段 0：将来的 enc/ackFp/rckWrap 住这里，
 *      本阶段无人写、store 只保证读进来再写出去不丢）
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
const { safeKey } = require("./index");
const PROTOCOL = require("./protocol.json");

const FLUSH_BUF_MAX_BYTES = 64 * 1024 * 1024; // 落盘失败时的缓冲硬顶（防 OOM）
const FLUSH_BUF_MAX_COUNT = 5000;         // 落盘失败时的缓冲条数硬顶（磁盘满时事件仍在灌入）
const FLUSH_BATCH = 200;
const INDEX_REMOTE_WINDOW = 2000; // 索引时只为最近 2000 条 remote 维护取代关系
const MSG_PREFIX = /^\{"k":"msg","seq":(\d+),"m":/;
/** Encrypted msg line prefix (crypto Phase 3, design section 4.1): the envelope
 *  fields follow seq in pinned order (enc, role, h, ct), so the fast path can slice
 *  the frame-form envelope out of the stored line without a JSON round trip. */
const MSG_ENC_PREFIX = /^\{"k":"msg","seq":(\d+),"enc":1,/;
const HMAC_HEX_RE = /^[0-9a-f]{64}$/; // envelope h: HMAC-SHA256 hex
const ACK_FP_RE = /^[0-9a-f]{16}$/;   // content-key fingerprint (protocol limit contentKeyFpChars)
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
// 清单文件（<room>.index.json）用同一套临时文件纪律，一并覆盖。
const CKPT_TMP_RE = /\.(?:ckpt|index)\.json\.\d+\.[0-9a-f]+\.tmp$/;
const CKPT_TMP_MAX_AGE_MS = 60 * 60 * 1000;
// 现役段封存阈值：写满即封存为 <room>.NNNN.jsonl 再开新现役段（见文件头第 8 条）。
// 8MB 的来历：与既有常量同锚——热缓存上限 16MB 的一半、构造器预热阈值同为 8MB；
// 按实测纯解析 ~210MB/s 估算，单段全扫约 40ms，是"尾段现扫"可接受的上界；
// 同时 256MB 总量上限下段数最多 32 个，目录枚举/清单体积都还克制。可经 opts.segmentMaxBytes 覆盖，0 = 关闭分段。
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
const UNCLASSIFIED_SEG = "_未分类"; // 设备/cwd 无从考证时的分组段名
const MANIFEST_VERSION = 1;

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
const PREWARM_TTL_MS = 10 * 60 * 1000;        // 未被打开的预热结果最多保留这么久，过期丢弃（首次打开按大小重新索引）；已被打开接管的索引不受此 TTL 支配
// 首次打开（含检查点尾巴）的同步扫描上限：≤1MB 的 JSON.parse 只有数毫秒，异步分块的调度开销
// 反而更大；超过这个量级就走异步分块索引（256KB/块 + setImmediate 让出），事件循环不再被整本
// 账冻住数秒（R-4）。阈值可经 opts.syncScanMaxBytes 覆盖（测试/特殊部署用）。
const SYNC_SCAN_MAX_BYTES = 1 * 1024 * 1024;
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

/** cwd → 工作区目录段：与 attach.encodeCwdDir 同一条编码规则（去首尾斜杠、[/\\:] 换 -、包 --），
 *  但只做纯字符串变换——relay 拿不到远端设备的真实路径，做不了 realpath/符号链接解析。
 *  编码撞车（/a/b 与 /a-b 同为 --a-b--）与 pi 本身一致：只是同组，房文件按 roomId 区分，不冲突。
 *  超长路径截断加 hash 后缀，防单段目录名越过文件系统 255 字节上限。空/非法返回 null（归未分类）。 */
function encodeCwdSegment(cwd) {
  if (typeof cwd !== "string") return null;
  const raw = cwd.trim().replace(/[\\/]+$/, "");
  if (!raw) return null;
  const body = raw.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
  if (!body) return null;
  if (body.length + 4 <= 200) return `--${body}--`;
  return `--${body.slice(0, 160)}-${sha1(Buffer.from(raw, "utf8")).slice(0, 8)}--`;
}

/** deviceId → 设备目录段：本身就是安全字符集时原样用（目录可读性优先），
 *  否则退回 index.js 给设备文件命名用的 safeKey（同项目既有口径）。 */
function deviceSegment(deviceId) {
  const raw = String(deviceId == null ? "" : deviceId);
  if (/^[A-Za-z0-9._-]+$/.test(raw) && raw !== "." && raw !== "..") return raw;
  return safeKey(raw);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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


/** Frame/record envelope shape (crypto Phase 3, design section 4.1): {enc:1, role, h, ct}.
 *  The relay never decrypts: it only checks the shape, stores the envelope verbatim,
 *  and compares h values for anchoring and remote supersede. */
function isEnvelope(v) {
  return !!v && typeof v === "object" && v.enc === 1 &&
    typeof v.role === "string" && !!v.role &&
    typeof v.h === "string" && HMAC_HEX_RE.test(v.h) &&
    typeof v.ct === "string" && v.ct.length > 0;
}

/** The envelope as delivered inside frames / snapshot items: {enc:1, role, h, ct}. */
function envelopeFrameJson(env) {
  return JSON.stringify({ enc: 1, role: env.role, h: env.h, ct: env.ct });
}

/** Snapshot item for an encrypted remote record: the envelope plus the remote
 *  marker fields the plaintext form carries (role/timestamp/cid stay readable). */
function remoteEnvelopeJson(rec) {
  const o = { enc: 1, role: "user", remote: true };
  if (typeof rec.at === "number" && Number.isFinite(rec.at)) o.timestamp = rec.at;
  o.h = rec.h;
  o.ct = rec.ct;
  const cid = cleanCid(rec.cid);
  if (cid) o.cid = cid;
  return JSON.stringify(o);
}

/** The envelope fields of a remote_message event ({enc:1, h, ct} flattened onto
 *  the event by the extension), or null when the event is a plaintext remote. */
function remoteEnvelopeOf(event) {
  if (!event || event.enc !== 1) return null;
  if (typeof event.h !== "string" || !HMAC_HEX_RE.test(event.h)) return null;
  if (typeof event.ct !== "string" || !event.ct) return null;
  return { h: event.h, ct: event.ct };
}

/** Validate an enc-room declaration {ackFp, rckWrap} (design section 5 room meta).
 *  rckWrap is an opaque base64 blob for the relay: only its length is checked
 *  (protocol limit wrappedKeyMaxBytes); it is never parsed or logged. */
function cleanEncMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ackFp = typeof raw.ackFp === "string" ? raw.ackFp : "";
  const rckWrap = typeof raw.rckWrap === "string" ? raw.rckWrap : "";
  if (!ACK_FP_RE.test(ackFp)) return null;
  if (!rckWrap || rckWrap.length > PROTOCOL.limits.wrappedKeyMaxBytes) return null;
  return { enc: 1, ackFp, rckWrap };
}

/** The enc subset of a room's metaExtra ({enc:1, ackFp?, rckWrap?}), or null for
 *  plaintext rooms. Fields that fail validation are dropped, never trusted. */
function encMetaOf(metaExtra) {
  if (!metaExtra || metaExtra.enc !== 1) return null;
  const out = { enc: 1 };
  if (typeof metaExtra.ackFp === "string" && ACK_FP_RE.test(metaExtra.ackFp)) out.ackFp = metaExtra.ackFp;
  if (typeof metaExtra.rckWrap === "string" && metaExtra.rckWrap.length <= PROTOCOL.limits.wrappedKeyMaxBytes) {
    out.rckWrap = metaExtra.rckWrap;
  }
  return out;
}

/** Alignment anchor for a snapshot item: envelopes anchor on their keyed h,
 *  plaintext messages on hashOf (design section 4.1 — the relay compares the
 *  extension-supplied h for enc rooms, it can never recompute it). */
function anchorOf(item) {
  return isEnvelope(item) ? item.h : hashOf(item);
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
   *          prewarmTtlMs?:number, syncScanMaxBytes?:number, segmentMaxBytes?:number,
   *          prewarm?:boolean, now?:() => number}} opts
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
    // 首次打开同步扫描上限（见 SYNC_SCAN_MAX_BYTES）：超过就走异步分块索引。
    this.syncScanMaxBytes = opts.syncScanMaxBytes != null
      ? Math.max(0, Math.floor(opts.syncScanMaxBytes))
      : SYNC_SCAN_MAX_BYTES;
    // 房文件本体上限：默认 256MB；0 关闭（测试/特殊部署可用）。分段后按全段总和判。
    this.maxRoomFileBytes = opts.maxRoomFileBytes != null
      ? Math.max(0, Math.floor(opts.maxRoomFileBytes))
      : ROOM_FILE_MAX_BYTES;
    // 现役段封存阈值（见 SEGMENT_MAX_BYTES）；0 = 不分段（房文件保持单文件形态）。
    this.segmentMaxBytes = opts.segmentMaxBytes != null
      ? Math.max(0, Math.floor(opts.segmentMaxBytes))
      : SEGMENT_MAX_BYTES;
    // 房间定位器：id -> {deviceId, cwd} | null，由 Rooms.bindStore 经 setLocator 接入；
    // 没接入（单元测试/工具直连）时不分组、不迁移，房文件平铺在 this.dir（旧形态）。
    this._locator = null;
    // 房间 id -> 已定格的房文件目录（分组目录或 this.dir）。进程内定格不漂移：
    // 房间的家一旦定下，cwd 后来变了也不搬正在用的文件（重启后按新定位重新解析）。
    this._roomDirs = new Map();
    this._migrationDone = false;
    // 可注入时钟：检查点冷却与预热 TTL 的测试用；生产走 Date.now。
    this._now = typeof opts.now === "function" ? opts.now : Date.now;
    this.prewarm = this.persist && opts.prewarm !== false;
    this.rooms = new Map();
    // 目录 fsync 失败只告警一次：Windows/个别文件系统不支持，不能每次 flush 都刷屏。
    this._dirFsyncWarned = false;
    // 预热完成但还没被 _room() 打开的索引；_room() 直接接管，省掉首次同步全量扫描。
    this._prewarmed = new Map();
    // 异步索引任务登记表（R-4）：构造器预热与首次打开共用同一引擎，一房最多一个在飞任务。
    this._indexJobs = new Map();
    // Disk-probe cache for encInfo() on rooms that are not loaded yet:
    // roomId -> {sig, meta}; sig pins the first segment's (mtime, size) + total size.
    this._encProbeCache = new Map();
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

  /** 等某房间的异步索引落地（没有在飞任务时立即 resolved）。测试/运维观测用，
   *  与 prewarmReady() 同风格；读 API 本身仍是同步占位语义（见 _placeholderRoom）。 */
  whenIndexed(id) {
    const job = this._indexJobs.get(id);
    if (!job) return Promise.resolve();
    return job.promise;
  }

  /** 某房间是否正在异步建索引（此时它的读锚点不可信、快照必带 truncated）。 */
  indexing(id) {
    const r = this.rooms.get(id);
    return !!(r && r._indexing);
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
   *  每个最多保留 prewarmTtlMs（期间没被首次打开就丢弃，下次打开按大小重新索引）。
   *  TTL 只管"还没被打开"的条目：_room 接管时 _dropPrewarmed 已清掉计时器，
   *  接管后的索引跟随房间缓存自身的空闲淘汰纪律，不再被 TTL 单独过期（R-4 第 3 条）。 */
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
    return path.join(this._roomDir(id), `${id}.jsonl`);
  }

  _ckptFile(id) {
    return path.join(this._roomDir(id), `${id}.ckpt.json`);
  }

  _manifestFile(id, dir) {
    return path.join(dir || this._roomDir(id), `${id}.index.json`);
  }

  /** 接入房间定位器（Rooms.bindStore 调用）：id -> {deviceId, cwd} | null。
   *  接入即触发一次存量平铺文件迁移（幂等；失败只告警，文件保留平铺、读路径仍能找到）。 */
  setLocator(fn) {
    this._locator = typeof fn === "function" ? fn : null;
    if (this._locator) {
      try {
        this._migrateFlatRooms();
      } catch (e) {
        console.warn("[store] 存量房文件迁移失败（保留平铺，下次接入重试）:", e.message);
      }
    }
  }

  _locate(id) {
    if (!this._locator) return null;
    try {
      const loc = this._locator(id);
      return loc && (loc.deviceId || loc.cwd) ? loc : null;
    } catch {
      return null;
    }
  }

  /** 定位结果 → 分组目录。缺哪级用 _未分类 占位（两级结构恒定，枚举/迁移口径统一）。 */
  _groupedDir(loc) {
    const dev = loc && loc.deviceId ? deviceSegment(loc.deviceId) : UNCLASSIFIED_SEG;
    const ws = loc && loc.cwd ? encodeCwdSegment(loc.cwd) || UNCLASSIFIED_SEG : UNCLASSIFIED_SEG;
    return path.join(this.dir, dev, ws);
  }

  /** 枚举一个目录里某房间的全部段文件（封存段按序号排序）与指针/清单存在性。
   *  只 stat 不读内容；冷打开/预热/迁移共用。 */
  _layoutIn(id, dir) {
    const layout = {
      dir,
      sealed: [],        // [{n, name, file, bytes}]，序号小→大
      sealedBytes: 0,
      active: { file: path.join(dir, `${id}.jsonl`), size: 0, exists: false, ino: null, mtimeMs: null },
      total: 0,
      exists: false,     // 有现役段或任一封存段
      hasMeta: false,    // 有检查点指针或清单（房已删净数据但元文件还在时定位仍认这里）
    };
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return layout;
    }
    const segRe = new RegExp(`^${escapeRegExp(id)}\\.(\\d{4})\\.jsonl$`);
    const found = [];
    for (const name of names) {
      const m = segRe.exec(name);
      if (m) found.push({ n: Number(m[1]), name });
      else if (name === `${id}.ckpt.json` || name === `${id}.index.json`) layout.hasMeta = true;
    }
    found.sort((a, b) => a.n - b.n);
    for (const f of found) {
      const file = path.join(dir, f.name);
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      layout.sealed.push({ n: f.n, name: f.name, file, bytes: size });
      layout.sealedBytes += size;
    }
    try {
      const st = fs.statSync(layout.active.file);
      layout.active.size = st.size;
      layout.active.exists = true;
      layout.active.ino = st.ino;
      layout.active.mtimeMs = st.mtimeMs;
    } catch {}
    layout.total = layout.sealedBytes + layout.active.size;
    layout.exists = layout.active.exists || layout.sealed.length > 0;
    return layout;
  }

  /** 在整个数据目录里找某房间现在的家：分组两级逐层看，最后看平铺。找不到返回 null。 */
  _findRoomDir(id) {
    let devs;
    try {
      devs = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const d of devs) {
      if (!d.isDirectory()) continue;
      const devDir = path.join(this.dir, d.name);
      let wss;
      try {
        wss = fs.readdirSync(devDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const w of wss) {
        if (!w.isDirectory()) continue;
        const dir = path.join(devDir, w.name);
        const layout = this._layoutIn(id, dir);
        if (layout.exists || layout.hasMeta) return dir;
      }
    }
    const flat = this._layoutIn(id, this.dir);
    if (flat.exists || flat.hasMeta) return this.dir;
    return null;
  }

  /** 房间的家（定格缓存）：定位器算出的分组目录已有该房文件 → 用它；否则磁盘搜索
   *  （存量房可能在别的分组或平铺处，稳定性优先于新定位）；都没有且要新建 → 定位分组
   *  （无定位器时平铺 = 旧形态；有定位器但查不到 → _未分类 组）。查无此房且不新建时
   *  返回 this.dir 但不定格——之后房间真出现了还能按真定位归位。 */
  _roomDir(id, { create = false } = {}) {
    const cached = this._roomDirs.get(id);
    if (cached) return cached;
    let dir = null;
    const loc = this._locate(id);
    if (loc) {
      const grouped = this._groupedDir(loc);
      if (this._layoutIn(id, grouped).exists) dir = grouped;
    }
    if (!dir) dir = this._findRoomDir(id);
    if (!dir && create) dir = this._locator ? this._groupedDir(loc) : this.dir;
    if (!dir) return this.dir;
    this._roomDirs.set(id, dir);
    return dir;
  }

  _ensureRoomDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }

  /** 存量平铺 → 分组的一次性迁移（定位器接入时跑）：按房间收集平铺工件
   *  （现役段/封存段/检查点指针/清单），逐个同盘 rename 到定位目录，查不到定位的归 _未分类。
   *  幂等且崩溃可重入：rename 一次只挪一个文件，崩在中间时每个文件恰好只在一处，
   *  下次接入把剩下的接着挪；目标已存在同名文件说明上次已挪过（或外部干预），保留目标、告警跳过。
   *  已在内存/索引中的房间跳过（启动时接入，正常不存在）。 */
  _migrateFlatRooms() {
    if (this._migrationDone) return;
    this._migrationDone = true;
    if (!this.persist) return;
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const byRoom = new Map();
    const segRe = /^(.+)\.(\d{4})\.jsonl$/;
    for (const name of names) {
      let id = null;
      if (name.endsWith(".jsonl")) {
        const m = segRe.exec(name);
        id = m ? m[1] : name.slice(0, -".jsonl".length);
      } else if (name.endsWith(".ckpt.json")) id = name.slice(0, -".ckpt.json".length);
      else if (name.endsWith(".index.json")) id = name.slice(0, -".index.json".length);
      if (!id || !safeRoomId(id)) continue;
      if (!byRoom.has(id)) byRoom.set(id, []);
      byRoom.get(id).push(name);
    }
    let moved = 0;
    for (const [id, files] of byRoom) {
      if (this.rooms.has(id) || this._indexJobs.has(id)) continue;
      const destDir = this._groupedDir(this._locate(id));
      this._ensureRoomDir(destDir);
      let roomMoved = false;
      for (const name of files) {
        const src = path.join(this.dir, name);
        const dst = path.join(destDir, name);
        try {
          if (fs.existsSync(dst)) {
            console.warn(`[store] 迁移跳过（目标已存在同名文件，保留目标）: ${name}`);
            continue;
          }
          fs.renameSync(src, dst);
          roomMoved = true;
          moved++;
        } catch (e) {
          console.warn("[store] 迁移房文件失败（保留原地）:", id, name, e.message);
        }
      }
      if (roomMoved) {
        this._roomDirs.set(id, destDir);
        this._fsyncDir(destDir);
      }
    }
    if (moved) {
      this._fsyncDir(this.dir);
      console.warn(`[store] 存量房文件迁移完成：${moved} 个文件已按设备/工作区分组归位`);
    }
  }

  /** 枚举数据目录里全部房间的布局（平铺 + 分组两级），预热/运维用。同一 id 出现多处时
   *  以 _roomDir 的解析结果为准（分组优先、平铺兜底，与读路径一致）。 */
  _enumerateLayouts() {
    const ids = new Set();
    const collect = (dir) => {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const base = name.slice(0, -".jsonl".length);
        const m = /^(.+)\.\d{4}$/.exec(base);
        const id = m ? m[1] : base;
        if (safeRoomId(id)) ids.add(id);
      }
    };
    collect(this.dir);
    let devs;
    try {
      devs = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      devs = [];
    }
    for (const d of devs) {
      if (!d.isDirectory()) continue;
      const devDir = path.join(this.dir, d.name);
      let wss;
      try {
        wss = fs.readdirSync(devDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const w of wss) if (w.isDirectory()) collect(path.join(devDir, w.name));
    }
    const out = [];
    for (const id of ids) out.push({ id, layout: this._layoutIn(id, this._roomDir(id)) });
    return out;
  }

  _newRoom(id, file) {
    return {
      id,
      file,
      rev: null,
      metaWritten: false,
      metaExtra: null,   // meta 行标准字段（rev/headTruncated）之外的未知字段原样保留（见文件头注）
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
      _indexing: false,   // 异步索引在飞（占位房间）：读 API 不许信它的锚点，快照一律 truncated
      _indexJob: null,    // 在飞的索引任务（见 _startIndexJob；构造器预热与首次打开共用）
      _journal: null,     // 索引期间到达的写操作：按到达顺序排队，索引落地后重放（不丢不乱序）
      // ---- 分段/清单（文件头第 8 条）----
      dir: null,          // 房文件所在目录（分组目录或 this.dir）；file 恒为 <dir>/<id>.jsonl（现役段）
      segs: [],           // 封存段 [{n, name, file, bytes}]，序号小→大；不含现役段
      sealedBytes: 0,     // 封存段总字节 = 现役段的虚拟偏移基址（检查点指针用虚拟偏移）
      _manifestEntries: [], // 清单条目，与 segs 一一对位：{file, bytes, events, firstSeq, lastSeq, state|null}
      _segLines: 0,       // 现役段已落盘的行数 / 首尾 seq（封存时写进清单条目）
      _segFirstSeq: 0,
      _segLastSeq: 0,
      _diskState: null,   // 上一次 flush 完整落盘末尾的聚合状态快照（_statePayload 形态）：
                          // 封存时它恰好就是被封存前缀的状态，直接写进清单，不必重扫
      _diskStateStale: false, // 出现过部分落盘/缓冲残留：_diskState 不再与盘面对齐，封存改走重扫兜底
      _captureNeed: null, // 本次打开要顺路补清单 state 的封存段序号集合（扫描跨段时在段界捕获）
      _captureFilled: false,
    };
  }

  /** 清空索引态，回到"还没读盘"的空白房间（换 rev 等身份字段由调用方处理） */
  _resetRoomData(r) {
    r.rev = null;
    r.metaWritten = false;
    r.metaExtra = null; // 回到"还没读盘"的空白：随后扫描会从盘上的 meta 行重新装回
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
    const dir = this._roomDir(id, { create });
    const layout = this.persist ? this._layoutIn(id, dir) : null;
    const onDisk = !!(layout && layout.exists);
    if (!create && !onDisk) {
      this._dropPrewarmed(id);
      return null;
    }
    if (onDisk) {
      // 构造器预热好的索引：文件指纹（全段总字节 + 现役段 stat + 封存规模）没变就直接接管。
      const pre = this._prewarmed.get(id);
      if (pre) {
        this._dropPrewarmed(id);
        if (this._layoutMatchesFp(layout, pre.fp)) {
          r = pre.room;
          r.lastActivity = Date.now();
          r.buf = [];
          r.timer = null;
          r.dirSynced = true; // 预热只针对已存在的文件，目录项早就落过盘
          this.rooms.set(id, r);
          return r;
        }
      }
      // 索引任务已在飞（构造器预热或更早的首次触碰）：占位接管、等它落地，
      // 绝不另起一份重复扫描（R-4）。占位期间的读写语义见 _placeholderRoom。
      const flying = this._indexJobs.get(id);
      if (flying) return this._placeholderRoom(id, layout, flying);
      // 要扫的字节数（总量 − 起点覆盖：检查点/清单谁靠前用谁）超过同步阈值 →
      // 异步分块索引；阈值内仍走下面的同步路径（数毫秒，异步调度开销反而更大）。
      const base = this._probeBase(id, layout);
      const scanBytes = Math.max(0, layout.total - base.end);
      if (scanBytes > this.syncScanMaxBytes) {
        return this._placeholderRoom(id, layout, this._startIndexJob(id, layout, base));
      }
      return this._openRoomSync(id, layout, base);
    }
    this._dropPrewarmed(id);
    r = this._newRoom(id, path.join(dir, `${id}.jsonl`));
    r.dir = dir;
    if (this.persist) this._ensureRoomDir(dir);
    r.dirSynced = false; // 新建文件等首次 flush 后补目录项同步
    if (!r.rev) r.rev = newRev();
    this.rooms.set(id, r);
    return r;
  }

  /** 预热指纹对账：总量/封存规模/现役段指纹全对得上才许接管预热索引。 */
  _layoutMatchesFp(layout, fp) {
    if (!fp) return false;
    return layout.total === fp.total &&
      layout.sealedBytes === fp.sealedBytes &&
      layout.sealed.length === fp.segCount &&
      layout.active.size === fp.activeSize &&
      (fp.ino == null || layout.active.ino === fp.ino) &&
      (fp.mtimeMs == null || layout.active.mtimeMs === fp.mtimeMs);
  }

  /** 异步索引在飞时的占位房间：先注册进房间表，让并发触碰都汇到同一个任务上。
   *  索引落地前它不暴露任何锚点（rev 为 null、seq/msgCount 为 0），快照一律 truncated、
   *  info() 带 indexing:true；写操作不碰半份索引，一律进 _journal 按到达顺序排队，
   *  任务落地时先移植完整索引、再按序重放（见 _settleIndexJob），不丢不乱序。 */
  _placeholderRoom(id, layout, job) {
    const r = this._newRoom(id, layout.active.file);
    r.dir = layout.dir;
    r.segs = layout.sealed.map((s) => ({ ...s }));
    r.sealedBytes = layout.sealedBytes;
    r._segLines = -1; // 现役段是继承来的：行数未知，封存时按 \n 计数兜底（见 _sealSegment）
    r.dirSynced = true; // 文件已存在，目录项早就落过盘
    r._indexing = true;
    r._indexJob = job;
    r._journal = [];
    this.rooms.set(id, r);
    return r;
  }

  /** 同步打开：起点（检查点/清单 base）已由 _room 探好，只扫它之后的尾巴；
   *  base 为 none 时全量扫描。语义与旧实现一致，只是扫描对象从单文件变成段序列。 */
  _openRoomSync(id, layout, base) {
    const r = this._newRoom(id, layout.active.file);
    r.dir = layout.dir;
    r.segs = layout.sealed.map((s) => ({ ...s }));
    r.sealedBytes = layout.sealedBytes;
    r._manifestEntries = base.entries;
    r._segLines = -1; // 现役段是继承来的：行数未知，封存时按 \n 计数兜底（见 _sealSegment）
    r.dirSynced = true; // 已存在的文件不需要再同步目录项
    let fullScanned = false;
    let restored = false;
    if (base.kind !== "none") {
      try {
        // 只从起点末尾往回修残行，避免又摸一遍前缀；repair 在现役段内工作，
        // 已知换行边界 = 起点在现役段里的局部偏移（起点落在封存段时现役段整体都是尾巴）。
        const tailOk = this._repairTail(r, Math.max(0, base.end - layout.sealedBytes));
        // 清单 state 有洞且本次扫描会从段首经过 → 顺路捕获重建（降级路径的一部分）。
        r._captureNeed = this._captureNeedFor(layout, base.entries, base.end);
        restored = this._restoreFromBase(r, base);
        // 起点之后的尾巴整体没有换行边界：恢复只能丢掉这段残行，
        // 交付的就是"缺了尾巴"的历史，同样必须标 truncated 而不是当正常房交付。
        if (restored && !tailOk) this._markIndexFailed(r, "检查点之后的末行残缺且无法修复");
      } catch (e) {
        console.warn("[store] 起点状态恢复失败，回退全量扫描:", id, e.message);
        restored = false;
      }
    }
    if (!restored) {
      this._resetRoomData(r);
      r._captureNeed = this._captureNeedFor(layout, base.entries, 0);
      const tailOk = this._repairTail(r); // 上次异常退出可能留下半截行：先修再索引
      this._indexFile(r);
      // 病态文件（整段找不到换行边界）只能装出一部分/空索引：必须标记，快照据此报 truncated。
      if (!tailOk) this._markIndexFailed(r, "文件末行残缺且找不到完整换行边界");
      fullScanned = true;
    }
    if (!r.rev) r.rev = newRev();
    this.rooms.set(id, r);
    if (r._captureFilled) {
      this._writeManifest(r);
      r._captureFilled = false;
    }
    r._captureNeed = null;
    // 索引刚建完：内存聚合状态与盘面严格对齐，捕获为盘面状态（之后封存不必重扫）。
    this._captureDiskState(r);
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
      // Enc records anchor on their keyed h instead of a parsed message (section 4.1).
      firstHash: null,
      lastHash: null,
      // 临时环：只为最后 cacheSize 条保留原始记录，结束时再物化 JSON。
      tail: [],
      skipped: 0,
      lines: 0,    // 已喂入的行数（清单重建时按段记 events 用）
      firstSeq: 0, // 本 ctx 喂入的第一条 seq>0 记录（清单重建时按段记 firstSeq 用）
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
    if (rec.seq > 0 && !ctx.firstSeq) ctx.firstSeq = rec.seq;
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
        // 标准字段之外的未知字段（含将来的 enc/ackFp/rckWrap）整份收下，下次写 meta 行时原样带回。
        const extra = {};
        for (const key of Object.keys(rec)) {
          if (key === "k" || key === "seq" || key === "rev" || key === "headTruncated") continue;
          extra[key] = rec[key];
        }
        r.metaExtra = Object.keys(extra).length ? extra : null;
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
      if (rec.k === "msg" && rec.enc === 1 && typeof rec.ct === "string") {
        // Encrypted record (design section 4.1): the body is an opaque envelope.
        // Anchors come from the keyed h the extension computed; the relay never
        // parses a body here, it only counts, caches the line and matches h.
        if (rec.role === "system") return;
        if (typeof rec.h === "string" && HMAC_HEX_RE.test(rec.h)) {
          if (!ctx.firstHash) ctx.firstHash = rec.h;
          ctx.lastHash = rec.h;
        }
        r.msgCount += 1;
        ctx.tail.push({ rec, line: t });
        if (rec.role === "user" && typeof rec.h === "string") this._supersedePendingByH(r, rec.h);
      } else if (rec.k === "msg" && rec.m) {
        if (rec.m.role === "system") return;
        if (!ctx.firstMsg) ctx.firstMsg = rec.m;
        ctx.lastMsg = rec.m;
        r.msgCount += 1;
        ctx.tail.push({ rec, line: t });
        if (rec.m.role === "user") this._supersedePending(r, contentText(rec.m));
      } else if (rec.k === "remote") {
        if (rec.enc === 1 && typeof rec.ct === "string") {
          this._rememberRemote(r, { seq: rec.seq, h: rec.h, ct: rec.ct, cid: cleanCid(rec.cid) });
        } else {
          this._rememberRemote(r, { seq: rec.seq, text: String(rec.text || ""), cid: cleanCid(rec.cid) });
        }
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
    // 索引在飞：先排队，落地后按序重放（此刻报未变化，调用方不会误发实时 meta 广播）。
    if (this._journalIfIndexing(r, { op: "toolEnd", event })) return { changed: false, meta: null };
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
    const i = r.pendingRemotes.findIndex((p) => !r.superseded.has(p.seq) && typeof p.text === "string" && remoteEchoMatches(p.text, text));
    if (i < 0) return false;
    r.superseded.add(r.pendingRemotes[i].seq);
    r.pendingRemotes.splice(i, 1);
    this._trimSuperseded(r);
    return true;
  }

  /** Enc rooms (index path): a user envelope supersedes the earliest pending
   *  remote envelope with the same keyed h (design section 4.1 — the HMAC
   *  equality check replaces the text comparison; same FIFO order). */
  _supersedePendingByH(r, h) {
    const i = r.pendingRemotes.findIndex((p) => !r.superseded.has(p.seq) && p.enc === 1 && p.h === h);
    if (i < 0) return false;
    r.superseded.add(r.pendingRemotes[i].seq);
    r.pendingRemotes.splice(i, 1);
    this._trimSuperseded(r);
    return true;
  }

  _finishIndex(r, ctx) {
    if (!r.firstMsgHash) r.firstMsgHash = ctx.firstHash || (ctx.firstMsg ? hashOf(ctx.firstMsg) : null);
    if (ctx.lastHash) r.lastMsgHash = ctx.lastHash;
    else if (ctx.lastMsg) r.lastMsgHash = hashOf(ctx.lastMsg);
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

  /** 行喂入器：把字节块按行喂给 _ingestLine。块边界可能切在多字节字符中间：
   *  StringDecoder 把残缺字节交给下一块补齐；末尾无换行的残行由 _repairTail 提前截掉，这里丢弃。
   *  扫描逻辑只认「文件 + 字节范围」，不假设整文件——将来日志分段（每 ~10MB 一段）时，
   *  每一段就是一次独立的范围扫描，封存段可凭落盘索引整段跳过，不必改这套骨架。 */
  _lineFeeder(r, ctx) {
    const dec = new StringDecoder("utf8");
    let carry = "";
    return (buf) => {
      const lines = (carry + dec.write(buf)).split("\n");
      carry = lines.pop();
      for (const line of lines) {
        ctx.lines++;
        this._ingestLine(r, ctx, line);
      }
    };
  }

  /** 同步分块扫描 [start, EOF)。只许用在小文件/短尾巴（见 SYNC_SCAN_MAX_BYTES）。 */
  _scanChunksSync(r, file, start, ctx) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.statSync(file).size;
      let pos = Math.max(0, start);
      const feed = this._lineFeeder(r, ctx);
      while (pos < size) {
        const n = Math.min(1024 * 1024, size - pos);
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, pos);
        if (got <= 0) break;
        pos += got;
        feed(buf.subarray(0, got));
      }
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** 异步分块扫描 [start, end)：每块 PREWARM_CHUNK（256KB），块间 setImmediate 让出，
   *  与构造器预热同一节奏，事件循环在块间一定可调度（R-4）。
   *  返回实际扫到的末尾偏移 {pos}；shouldStop() 为真或文件提前到 EOF 时 pos < end。
   *  I/O 异常 reject，由调用方（索引任务）按失败降级处理。 */
  _scanRangeAsync(r, file, start, end, ctx, shouldStop) {
    return new Promise((resolve, reject) => {
      let fd;
      let pos = Math.max(0, start);
      const feed = this._lineFeeder(r, ctx);
      const cleanup = () => {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
      };
      const step = () => {
        try {
          if ((shouldStop && shouldStop()) || pos >= end) { cleanup(); resolve({ pos }); return; }
          if (fd === undefined) fd = fs.openSync(file, "r");
          const n = Math.min(PREWARM_CHUNK, end - pos);
          const buf = Buffer.alloc(n);
          const got = fs.readSync(fd, buf, 0, n, pos);
          if (got <= 0) { cleanup(); resolve({ pos }); return; } // 文件被截短：按已扫到的位置收尾，调用方对指纹决定重扫
          pos += got;
          feed(buf.subarray(0, got));
          setImmediate(step);
        } catch (e) {
          cleanup();
          reject(e);
        }
      };
      setImmediate(step);
    });
  }

  /** 全量扫描：seq 上限 + 头尾 hash + 热缓存 + remote/user 的取代关系 + meta(rev)。
   *  单条坏记录只跳过并计数，绝不让它中断整个索引（否则后半文件会被当新消息二次落盘）。
   *  只用于"没有有效检查点"的旧文件首次打开；长文件由构造器异步预热，或随后补检查点。 */
  /** 房间的段序列（虚拟字节流）：封存段在前、现役段殿后。activeSize 可由调用方
   *  传入刚 stat 的值（异步索引主循环），缺省现 stat。 */
  _segRanges(r, activeSize = null) {
    const out = r.segs.map((s, i) => ({ file: s.file, bytes: s.bytes, sealed: true, idx: i }));
    let size = activeSize;
    if (size == null) {
      size = 0;
      try { size = fs.statSync(r.file).size; } catch {}
    }
    out.push({ file: r.file, bytes: size, sealed: false, idx: -1 });
    return out;
  }

  /** 同步扫描虚拟偏移 [fromVirtual, 总量)：逐段调用既有分块扫描（每段以换行结尾，
   *  一条记录不跨段，逐段喂入与整流喂入等价）。r._captureNeed 命中的封存段在段尾
   *  捕获清单 state 并换新 ctx——返回的 ctx 才是调用方该 _finishIndex 的那一个。 */
  _scanVirtual(r, fromVirtual, ctx) {
    let base = 0;
    for (const seg of this._segRanges(r)) {
      const segEnd = base + seg.bytes;
      if (segEnd > fromVirtual) {
        const localStart = Math.max(0, fromVirtual - base);
        const linesAtStart = ctx.lines;
        const firstSeqBefore = ctx.firstSeq;
        if (seg.bytes > localStart) this._scanChunksSync(r, seg.file, localStart, ctx);
        // 现役段从段首扫过：顺手记下它的 firstSeq（清单条目元数据，封存时用）
        if (!seg.sealed && localStart === 0 && !firstSeqBefore && ctx.firstSeq && !r._segFirstSeq) {
          r._segFirstSeq = ctx.firstSeq;
        }
        if (seg.sealed && localStart === 0 && r._captureNeed && r._captureNeed.has(seg.idx)) {
          r._scanSkipped = (r._scanSkipped || 0) + ctx.skipped;
          this._captureSegState(r, ctx, seg.idx, ctx.lines - linesAtStart);
          ctx = this._newIndexCtx();
        }
      }
      base = segEnd;
    }
    return ctx;
  }

  _indexFile(r) {
    const started = Date.now();
    this._resetRoomData(r);
    r._scanSkipped = 0;
    let ctx = this._newIndexCtx();
    try {
      ctx = this._scanVirtual(r, 0, ctx);
      this._finishIndex(r, ctx);
      const skipped = (r._scanSkipped || 0) + ctx.skipped;
      const ms = Date.now() - started;
      if (skipped || ms > 500) {
        console.warn(`[store] 房间 ${r.id} 索引完成：seq=${r.seq} 缓存=${r.recent.length} 跳过坏记录=${skipped} 耗时=${ms}ms`);
      }
    } catch (e) {
      // 扫描中断时 r 里只有半份索引：不能让它当"正常房的部分历史"交付（报告：索引损坏的房间不报错）。
      this._markIndexFailed(r, `索引建立失败：${e.message}`);
      console.warn("[store] 索引建立失败（该房间降级为热缓存读取）:", r.id, e.message);
    }
  }

  /** 聚合状态 rec 的结构校验（检查点行与清单条目 state 同形态共用）。合法返回 null，否则返回判坏原因。
   *  superseded 区间超限/越界不是"旧格式可忽略"，必须判坏：否则展开时会静默丢一部分 seq，
   *  被丢掉的 remote 回显会在重启后复活。判坏后调用方回退扫描，与其它校验失败同一处理。
   *  toolMetas 同理：任何一条缺 toolCallId/字段类型不对都判坏（全量扫描会逐行跳过坏 toolmeta，
   *  不会静默丢一半有效元数据）。 */
  _stateRecValid(rec) {
    if (!rec || rec.k !== "ckpt" || rec.v !== CKPT_VERSION || typeof rec.rev !== "string") return "状态头非法";
    if (!Number.isInteger(rec.seq) || rec.seq < 0 || !Number.isInteger(rec.msgCount) || rec.msgCount < 0) {
      return "检查点状态非法";
    }
    if (!Number.isInteger(rec.maxSeq) || rec.maxSeq < 0) return "maxSeq 非法";
    if (!Array.isArray(rec.recent) || !Array.isArray(rec.pending) || !Array.isArray(rec.superseded)) {
      return "检查点数组非法";
    }
    if (!Array.isArray(rec.toolMetas) || rec.toolMetas.length > TOOLMETA_CKPT_MAX) {
      return "toolMetas 数组非法或超限";
    }
    if (rec.firstHash != null && typeof rec.firstHash !== "string") return "firstHash 非法";
    if (rec.lastHash != null && typeof rec.lastHash !== "string") return "lastHash 非法";
    if (!packedSeqsValid(rec.superseded, rec.maxSeq)) return "superseded 区间非法或超限";
    for (const e of rec.recent) {
      if (
        !e || (e.k !== "msg" && e.k !== "remote") || !Number.isInteger(e.seq) ||
        e.seq <= 0 || e.seq > rec.maxSeq || typeof e.j !== "string"
      ) {
        return "recent 条目非法";
      }
    }
    if (rec.encMeta != null) {
      const em = rec.encMeta;
      if (!em || em.enc !== 1 ||
          (em.ackFp != null && (typeof em.ackFp !== "string" || !ACK_FP_RE.test(em.ackFp))) ||
          (em.rckWrap != null && (typeof em.rckWrap !== "string" || !em.rckWrap || em.rckWrap.length > PROTOCOL.limits.wrappedKeyMaxBytes))) {
        return "encMeta 非法";
      }
    }
    for (const q of rec.pending) {
      if (!q || !Number.isInteger(q.seq) || q.seq <= 0 || q.seq > rec.maxSeq) {
        return "pending 条目非法";
      }
      // Enc pending entries carry the envelope (ct+h) instead of text (section 4.1).
      if (q.enc === 1) {
        if (typeof q.h !== "string" || !HMAC_HEX_RE.test(q.h) || typeof q.ct !== "string" || !q.ct) {
          return "pending 条目非法";
        }
      } else if (typeof q.text !== "string") {
        return "pending 条目非法";
      }
    }
    for (const m of rec.toolMetas) {
      const meta = cleanToolMeta(m);
      if (!meta || meta.toolCallId !== m.toolCallId) return "toolMetas 条目非法";
    }
    return null;
  }

  /** 读取并校验 <room>.ckpt.json + 它指向的 ckpt 行。任何不一致都返回 null（回退全量扫描）。
   *  校验项：版本/房间/rev、偏移与长度、行 sha1、行内 k/v/rev、状态字段基本类型、superseded 区间规模。
   *  sha1 让"文件被轮转成另一份更长文件、偏移恰好落在别的行上"也能被发现。
   *  指针里的 off/len 是**虚拟偏移**（段序列拼成的连续字节流，见文件头第 8 条）：分段前写下的
   *  旧指针指向单文件，迁移/封存不改字节内容与相对次序，虚拟偏移与旧文件偏移恰好一致，继续有效。 */
  _readCheckpoint(id, layout, { quiet = false } = {}) {
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
    if (!layout || !layout.exists) return bad("房文件不存在");
    const size = layout.total;
    if (p.off + p.len > size) return bad(`文件被截断（${size} < ${p.off + p.len}）`);
    // 虚拟偏移 → (段文件, 段内偏移)：ckpt 行由一次 _appendBatch 写进现役段，永不跨段。
    let segFile = null;
    let segOff = 0;
    {
      let base = 0;
      const all = [...layout.sealed, { file: layout.active.file, bytes: layout.active.size }];
      for (const seg of all) {
        if (p.off >= base && p.off + p.len <= base + seg.bytes) {
          segFile = seg.file;
          segOff = p.off - base;
          break;
        }
        base += seg.bytes;
      }
    }
    if (!segFile) return bad("检查点行跨段或越界");
    let buf;
    try {
      buf = Buffer.alloc(p.len);
      const fd = fs.openSync(segFile, "r");
      try { fs.readSync(fd, buf, 0, p.len, segOff); } finally { fs.closeSync(fd); }
    } catch (e) { return bad(`读取检查点行失败：${e.message}`); }
    if (buf.length && buf[buf.length - 1] === 0x0a) buf = buf.subarray(0, buf.length - 1);
    if (sha1(buf) !== p.sum) return bad("校验和不匹配（文件被改写/轮转）");
    let rec;
    try { rec = JSON.parse(buf.toString("utf8")); } catch { return bad("检查点行不是 JSON"); }
    if (!rec || rec.k !== "ckpt" || rec.v !== CKPT_VERSION || rec.rev !== p.rev) return bad("检查点行与指针不一致");
    const recBad = this._stateRecValid(rec);
    if (recBad) return bad(recBad);
    return { off: p.off, len: p.len, end: p.off + p.len, sum: p.sum, rev: p.rev, rec };
  }

  /** 当前房间的聚合状态（检查点 payload / 清单 state 同一份形态，见 _writeCheckpoint 与 _sealSegment）。 */
  _statePayload(r) {
    return {
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
      // The room's enc meta rides the state payload: a checkpoint/manifest-based
      // cold open never rescans the meta line (it sits before the state), so
      // without this field an enc room would resurrect as plaintext (Phase 0 gap).
      encMeta: encMetaOf(r.metaExtra),
      recent: this._packRecent(r.recent),
      pending: r.pendingRemotes.map((p) => (p.enc === 1
        ? { seq: p.seq, enc: 1, h: p.h, ct: p.ct, cid: p.cid || undefined }
        : { seq: p.seq, text: p.text, cid: p.cid || undefined })),
      toolMetas: [...r.toolMetas.values()].map((m) => ({ ...m })),
      superseded: packSeqs(r.superseded),
      at: Date.now(),
    };
  }

  /** 读清单并逐段核对：条目与布局里的封存段一一对位（文件名/字节数必须一致），
   *  state 过 _stateRecValid 才算数。返回 {entries, base}：entries 与 layout.sealed 对位
   *  （state 缺失/作废处为 null），base = 最后一个完全有效的条目 {state, end（虚拟偏移）, upto}。
   *  清单缺失/损坏/版本不对 → entries 全空、base 为 null（调用方走扫描降级并重建）。 */
  _readManifest(id, layout) {
    const empty = { entries: layout.sealed.map(() => null), base: null };
    let raw;
    try {
      raw = fs.readFileSync(this._manifestFile(id, layout.dir), "utf8");
    } catch {
      return empty;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return empty;
    }
    if (!data || data.v !== MANIFEST_VERSION || data.room !== id || !Array.isArray(data.segments)) return empty;
    // Room-dimension enc fields (design section 4.1 manifest rule): a fallback
    // source for the enc meta when segment states are missing/invalid.
    empty.encMeta = encMetaOf(data);
    const entries = layout.sealed.map(() => null);
    let base = null;
    let covered = 0;
    for (let i = 0; i < layout.sealed.length; i++) {
      const seg = layout.sealed[i];
      covered += seg.bytes;
      const e = data.segments[i];
      if (!e || e.file !== seg.name || e.bytes !== seg.bytes) continue;
      const entry = {
        file: seg.name,
        bytes: seg.bytes,
        events: Number.isInteger(e.events) && e.events >= 0 ? e.events : 0,
        firstSeq: Number.isInteger(e.firstSeq) && e.firstSeq >= 0 ? e.firstSeq : 0,
        lastSeq: Number.isInteger(e.lastSeq) && e.lastSeq >= 0 ? e.lastSeq : 0,
        state: null,
      };
      if (!this._stateRecValid(e.state)) {
        entry.state = e.state;
        base = { state: e.state, end: covered, upto: i };
      }
      entries[i] = entry;
    }
    return { entries, base };
  }

  /** 原子写清单（临时文件 + fsync + rename + 目录 fsync，与检查点指针同一套耐久纪律）。
   *  只收 r._manifestEntries 里已成形的条目（与 r.segs 对位）；清单写失败只告警——它只是
   *  冷打开的加速器，丢了下次重扫重建，绝不能反过来阻断写路径。 */
  _writeManifest(r) {
    if (!this.persist || !r.dir) return false;
    const segments = [];
    for (let i = 0; i < r.segs.length; i++) {
      const e = r._manifestEntries[i];
      if (!e) return false; // 条目与段不对位：宁可不写，也不写一份错位的清单
      segments.push({
        file: r.segs[i].name,
        bytes: r.segs[i].bytes,
        events: e.events || 0,
        firstSeq: e.firstSeq || 0,
        lastSeq: e.lastSeq || 0,
        state: e.state || null,
      });
    }
    const file = this._manifestFile(r.id, r.dir);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, "w");
      const doc = { v: MANIFEST_VERSION, room: r.id, rev: r.rev, updatedAt: Date.now(), segments };
      // Room-dimension enc fields (design section 4.1): the manifest is the cold
      // open's first read, so the enc flag must be visible here even before any
      // segment state is consulted. rckWrap stays an opaque blob.
      const em = encMetaOf(r.metaExtra);
      if (em) {
        doc.enc = 1;
        if (em.ackFp) doc.ackFp = em.ackFp;
        if (em.rckWrap) doc.rckWrap = em.rckWrap;
      }
      fs.writeFileSync(fd, JSON.stringify(doc) + "\n", "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, file);
      this._fsyncDir(r.dir);
      return true;
    } catch (e) {
      console.warn("[store] 写清单失败（下次打开重扫重建）:", r.id, e.message);
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  /** 冷打开的起点裁决：检查点与清单 base 谁覆盖的虚拟偏移大用谁（两者都按各自校验独立成立）。
   *  返回 {kind:"ckpt"|"manifest"|"none", end, ck?, state?, entries}；entries 恒为与 layout.sealed
   *  对位的清单条目（无清单则全 null），顺路指出哪些封存段的 state 缺失/作废（_captureNeed）。 */
  _probeBase(id, layout, { quiet = false } = {}) {
    const ck = this._readCheckpoint(id, layout, { quiet });
    const man = this._readManifest(id, layout);
    const ckEnd = ck ? ck.end : -1;
    const manEnd = man.base ? man.base.end : -1;
    if (man.base && manEnd >= ckEnd) {
      return { kind: "manifest", end: manEnd, state: man.base.state, ck, entries: man.entries, encMeta: man.encMeta || null };
    }
    if (ck) return { kind: "ckpt", end: ckEnd, ck, entries: man.entries, encMeta: man.encMeta || null };
    return { kind: "none", end: 0, ck: null, entries: man.entries, encMeta: man.encMeta || null };
  }

  /** 由 base 在房间对象上装好起点状态（清单 base 不动 r.ckpt：它不是检查点，
   *  但若同时探到检查点则把指针位置一并装上——_maybeCheckpoint 的间隔判据要用）。 */
  _applyBase(r, base) {
    if (!base) return;
    if (base.kind === "ckpt" && base.ck) {
      this._applyCheckpointState(r, base.ck);
    } else if (base.kind === "manifest" && base.state) {
      this._applyStateRec(r, base.state);
      if (base.ck) r.ckpt = { off: base.ck.off, len: base.ck.len, end: base.ck.end, sum: base.ck.sum };
    }
    if (base.encMeta && !encMetaOf(r.metaExtra)) {
      r.metaExtra = { ...(r.metaExtra || {}), ...base.encMeta };
    }
  }

  /** 本次打开要顺路补 state 的封存段序号集合：扫描会从段首完整经过、且清单条目缺 state 的段。 */
  _captureNeedFor(layout, entries, fromVirtual) {
    const need = new Set();
    let base = 0;
    for (let i = 0; i < layout.sealed.length; i++) {
      const segEnd = base + layout.sealed[i].bytes;
      if (fromVirtual <= base && !(entries[i] && entries[i].state)) need.add(i);
      base = segEnd;
    }
    return need.size ? need : null;
  }

  /** 扫描经过一个封存段段尾时的清单 state 捕获：先把 ctx 物化（_finishIndex），
   *  此刻房间聚合状态恰好就是该段末尾的状态，写进对位条目。 */
  _captureSegState(r, ctx, segIdx, segLines = 0) {
    const seg = r.segs[segIdx];
    if (!seg) return;
    const firstSeq = ctx.firstSeq;
    this._finishIndex(r, ctx);
    const prev = r._manifestEntries[segIdx] || {};
    r._manifestEntries[segIdx] = {
      file: seg.name,
      bytes: seg.bytes,
      events: segLines || prev.events || 0,
      firstSeq: firstSeq || prev.firstSeq || 0,
      lastSeq: r.seq,
      state: this._statePayload(r),
    };
    r._captureFilled = true;
  }

  /** 把校验过的检查点状态装回房间（不含尾扫描）：同步恢复与异步恢复共用，保证两条路径语义一致。 */
  _applyCheckpointState(r, ck) {
    this._applyStateRec(r, ck.rec);
    r.ckpt = { off: ck.off, len: ck.len, end: ck.end, sum: ck.sum };
  }

  /** 只装聚合状态本身（不碰 r.ckpt 指针）：清单条目的 state 与检查点 rec 同形态，共用这一份装回逻辑。 */
  _applyStateRec(r, rec) {
    const superseded = unpackSeqs(rec.superseded, rec.maxSeq);
    if (!superseded) throw new Error("superseded 区间非法或超限"); // 防御：_readCheckpoint 已拦截，调用方会回退全量扫描
    const pending = [];
    for (const p of rec.pending) {
      if (superseded.has(p.seq)) continue;
      if (p.enc === 1) pending.push({ seq: p.seq, enc: 1, h: p.h, ct: p.ct, cid: cleanCid(p.cid) });
      else pending.push({ seq: p.seq, text: p.text, cid: cleanCid(p.cid) });
    }
    if (rec.encMeta) {
      r.metaExtra = { ...(r.metaExtra || {}), enc: 1 };
      if (rec.encMeta.ackFp) r.metaExtra.ackFp = rec.encMeta.ackFp;
      if (rec.encMeta.rckWrap) r.metaExtra.rckWrap = rec.encMeta.rckWrap;
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
  }

  /** （原 _restoreCheckpoint 已并入 _restoreFromBase：起点可以是检查点，也可以是清单 base。） */
  /** 从起点（检查点/清单 base）恢复：装回起点状态，然后只扫起点之后的尾巴（跨段）。
   *  同步恢复与异步恢复共用同一套起点语义。 */
  _restoreFromBase(r, base) {
    this._applyBase(r, base);
    let ctx = this._newIndexCtx();
    ctx = this._scanVirtual(r, base.end, ctx);
    this._finishIndex(r, ctx);
    return true;
  }

  // ---------- 异步索引引擎（R-4：首次打开走慢读；构造器预热与首次打开共用） ----------

  /** 启动（或复用在飞的）异步索引任务：把 [起点, 总量) 按段分块扫进一个暂存房间。
   *  起点 = 0（全量）或 base.end（检查点/清单恢复，状态先装进暂存房间）。完成后按"有没有占位
   *  房间等它"二选一落地：有 → 索引状态移植进占位房间 + journal 按序重放；没有（构造器
   *  预热）→ 结果进 _prewarmed 等首次打开接管（与旧预热完全同义，含 TTL/上限纪律）。
   *  扫描以 (段文件, 字节范围) 组织：封存段是独立范围、现役段是会增长的尾巴。 */
  _startIndexJob(id, layout, base) {
    const existing = this._indexJobs.get(id);
    if (existing) return existing;
    const staging = this._newRoom(id, layout.active.file);
    staging.dir = layout.dir;
    staging.segs = layout.sealed.map((s) => ({ ...s }));
    staging.sealedBytes = layout.sealedBytes;
    staging._segLines = -1; // 现役段是继承来的：行数未知，封存时按 \n 计数兜底（见 _sealSegment）
    staging._manifestEntries = base ? base.entries : layout.sealed.map(() => null);
    staging.dirSynced = true; // 索引只针对已存在的文件，目录项早就落过盘
    let plan = base || { kind: "none", end: 0, ck: null, entries: staging._manifestEntries };
    if (plan.kind !== "none") {
      try {
        this._applyBase(staging, plan);
      } catch {
        plan = { kind: "none", end: 0, ck: null, entries: staging._manifestEntries }; // 起点已校验过，走到这里只剩防御：退回全量计划
      }
    }
    staging._captureNeed = this._captureNeedFor(layout, staging._manifestEntries, plan.end);
    staging._scanSkipped = 0;
    const job = {
      id, layout, file: layout.active.file, staging,
      base: plan,
      ck: plan.kind === "ckpt" ? plan.ck : null,
      ctx: this._newIndexCtx(),
      cancelled: false,
      error: null,
      tailOk: true,
      restarts: 0,
      startedAt: Date.now(),
      promise: null,
      _resolve: null,
    };
    job.promise = new Promise((resolve) => { job._resolve = resolve; });
    this._indexJobs.set(id, job);
    this._runIndexJob(job);
    return job;
  }

  /** 异步扫描虚拟范围 [from, total)：逐段走 _scanRangeAsync（256KB/块 + setImmediate 让出）。
   *  返回实际扫到的虚拟末尾；中途文件变短/任务取消时 < total，调用方回主循环重新对账。
   *  _captureNeed 命中的封存段在段尾捕获清单 state 并换新 ctx（与 _scanVirtual 同口径）。 */
  async _scanVirtualAsync(job, from, total) {
    const { staging } = job;
    const ranges = this._segRanges(staging, total - staging.sealedBytes);
    let base = 0;
    for (const seg of ranges) {
      const segEnd = base + seg.bytes;
      if (segEnd > from) {
        const localStart = Math.max(0, from - base);
        const localEnd = Math.min(seg.bytes, total - base);
        if (localEnd > localStart) {
          const linesAtStart = job.ctx.lines;
          const firstSeqBefore = job.ctx.firstSeq;
          const { pos } = await this._scanRangeAsync(staging, seg.file, localStart, localEnd, job.ctx, () => job.cancelled);
          from = base + pos;
          if (!seg.sealed && localStart === 0 && !firstSeqBefore && job.ctx.firstSeq && !staging._segFirstSeq) {
            staging._segFirstSeq = job.ctx.firstSeq;
          }
          if (pos < localEnd) return from;
          if (seg.sealed && localStart === 0 && staging._captureNeed && staging._captureNeed.has(seg.idx)) {
            staging._scanSkipped = (staging._scanSkipped || 0) + job.ctx.skipped;
            this._captureSegState(staging, job.ctx, seg.idx, job.ctx.lines - linesAtStart);
            job.ctx = this._newIndexCtx();
          }
        }
      }
      base = segEnd;
    }
    return from;
  }

  async _runIndexJob(job) {
    const { staging } = job;
    try {
      // 先修半截尾行（与旧预热同一步）：修完才知道真实文件尾；起点计划只修起点之后的尾巴
      // （换算成现役段内的局部偏移；起点落在封存段时现役段整体都是尾巴）。
      job.tailOk = this._repairTail(staging, Math.max(0, job.base.end - staging.sealedBytes));
      let from = job.base.end;
      let ino = null;
      for (;;) {
        if (job.cancelled) break;
        let st = null;
        try { st = fs.statSync(job.file); } catch {}
        const total = staging.sealedBytes + (st ? st.size : 0);
        if (st && ino === null) ino = st.ino;
        if (!st || (ino !== null && st.ino !== ino) || total < from) {
          // 索引期间文件被截断/轮转/删除：已扫的暂存状态整体作废，最多重来一次；再变就报错降级。
          if (job.restarts >= 1) throw new Error("文件在索引期间反复变化，索引作废");
          job.restarts += 1;
          this._resetRoomData(staging);
          const layout = this._layoutIn(job.id, staging.dir);
          job.layout = layout;
          staging.segs = layout.sealed.map((s) => ({ ...s }));
          staging.sealedBytes = layout.sealedBytes;
          job.base = this._probeBase(job.id, layout, { quiet: true });
          staging._manifestEntries = job.base.entries;
          if (job.base.kind !== "none") {
            try { this._applyBase(staging, job.base); } catch { job.base = { kind: "none", end: 0, ck: null, entries: staging._manifestEntries }; }
          }
          job.ck = job.base.kind === "ckpt" ? job.base.ck : null;
          staging._captureNeed = this._captureNeedFor(layout, staging._manifestEntries, job.base.end);
          staging._scanSkipped = 0;
          job.ctx = this._newIndexCtx();
          from = job.base.end;
          job.tailOk = this._repairTail(staging, Math.max(0, from - staging.sealedBytes));
          ino = null;
          continue;
        }
        if (total === from) break;
        // 本 store 自己的写在索引期间全部排队不落盘，能让文件变长的只有外部写入：
        // 扫完后回到循环顶部对一次大小，长出来的新增段接着扫，不漏行。
        from = await this._scanVirtualAsync(job, from, total);
      }
    } catch (e) {
      job.error = e;
    }
    this._settleIndexJob(job);
  }

  /** 索引任务落地：成功 → 移植/记预热；失败 → 暂存房间标 indexPartial 后同样移植
   *  （与同步路径同义：快照报 truncated，房间降级为热缓存读写）；被取消 → 整体丢弃。 */
  _settleIndexJob(job) {
    if (this._indexJobs.get(job.id) === job) this._indexJobs.delete(job.id);
    const { staging } = job;
    try {
      if (!job.cancelled) {
        if (job.error) {
          this._markIndexFailed(staging, `索引建立失败：${job.error.message}`);
          console.warn("[store] 索引建立失败（该房间降级为热缓存读取）:", job.id, job.error.message);
        } else {
          this._finishIndex(staging, job.ctx);
          if (!staging.rev) staging.rev = newRev();
          // 索引刚建完：暂存状态与盘面严格对齐，捕获为盘面状态（落地后封存不必重扫）。
          this._captureDiskState(staging);
          // 病态文件（没有完整换行边界）：扫出来的只是半份/空索引，不能当正常房交付。
          if (!job.tailOk) this._markIndexFailed(staging, "文件末行残缺且找不到完整换行边界");
          const ms = Date.now() - job.startedAt;
          const skipped = (staging._scanSkipped || 0) + job.ctx.skipped;
          if (skipped || ms > 1000) {
            console.warn(`[store] 房间 ${job.id} 异步索引完成：seq=${staging.seq} 跳过坏记录=${skipped} 耗时=${ms}ms`);
          }
          // 扫描顺路补好的清单 state 落盘（重建降级路径的收尾，与同步打开同口径）。
          if (staging._captureFilled) {
            this._writeManifest(staging);
            staging._captureFilled = false;
          }
        }
        const live = this.rooms.get(job.id);
        if (live && live._indexing && live._indexJob === job) {
          this._transplantIndex(live, staging);
          live._indexing = false;
          live._indexJob = null;
          live.lastActivity = Date.now();
          const journal = live._journal || [];
          live._journal = null;
          for (const op of journal) this._replayJournalOp(live, op);
          // 与同步 _room 同口径：全量扫完补检查点（minBytes:0）；起点恢复来的走默认阈值。
          this._maybeCheckpoint(live, job.base.kind === "none" ? { minBytes: 0 } : undefined);
        } else if (!job.error) {
          // 没人等它（构造器预热）：先补检查点（可能追加一行、改变文件大小），再记接管指纹。
          this._maybeCheckpoint(staging, { minBytes: 0 });
          const lay = this._layoutIn(job.id, staging.dir);
          if (lay.exists) {
            this._rememberPrewarmed(job.id, {
              room: staging,
              fp: {
                total: lay.total,
                activeSize: lay.active.size,
                ino: lay.active.ino,
                mtimeMs: lay.active.mtimeMs,
                sealedBytes: lay.sealedBytes,
                segCount: lay.sealed.length,
              },
            });
          }
        }
      }
    } catch (e) {
      console.warn("[store] 索引任务落地异常:", job.id, e.message);
    } finally {
      job._resolve();
    }
  }

  /** 把暂存房间的索引状态整体移进占位房间（对象身份不变：注册表与调用方握的都是占位房间）。
   *  只移索引域；写缓冲/定时器/目录同步等运行时域占位房间自己就是权威（索引期间没有真实写入）。 */
  _transplantIndex(live, staging) {
    live.rev = staging.rev;
    live.metaWritten = staging.metaWritten;
    live.metaExtra = staging.metaExtra;
    live.headTruncated = staging.headTruncated;
    live.seq = staging.seq;
    live.recent = staging.recent;
    live.recentBytes = staging.recentBytes;
    live.superseded = staging.superseded;
    live.pendingRemotes = staging.pendingRemotes;
    live.toolMetas = staging.toolMetas;
    live.msgCount = staging.msgCount;
    live.firstMsgHash = staging.firstMsgHash;
    live.lastMsgHash = staging.lastMsgHash;
    live.ckpt = staging.ckpt;
    live._ckptReject = staging._ckptReject;
    live._ckptRejectWarnAt = staging._ckptRejectWarnAt;
    live._indexFailed = staging._indexFailed;
    live.indexPartial = staging.indexPartial;
    live._indexWarned = staging._indexWarned;
    live.dir = staging.dir;
    live.segs = staging.segs;
    live.sealedBytes = staging.sealedBytes;
    live._manifestEntries = staging._manifestEntries;
    live._segLines = staging._segLines;
    live._segFirstSeq = staging._segFirstSeq;
    live._segLastSeq = staging._segLastSeq;
    live._diskState = staging._diskState;
    live._diskStateStale = staging._diskStateStale;
    live.dirSynced = true;
  }

  /** 索引在飞时写操作不许碰半份索引：一律按到达顺序记进 journal，索引落地后重放。
   *  返回 true 表示已排队，调用方直接给中性返回值（实时广播由重放后的既有补发路径覆盖）。 */
  _journalIfIndexing(r, op) {
    if (!r || !r._indexing) return false;
    (r._journal || (r._journal = [])).push(op);
    return true;
  }

  /** 重放一条排队操作：此时 _indexing 已清除，走的就是平时的真实路径（含锚点校验）。 */
  _replayJournalOp(r, op) {
    try {
      if (op.op === "record") this.record(r.id, op.event);
      else if (op.op === "toolEnd") this.recordToolEnd(r.id, op.event);
      else if (op.op === "remoteFailed") this.markRemoteFailed(r.id, op.text, op.cid);
      else if (op.op === "seed") this.seedOrMerge(r.id, op.messages, { truncated: op.truncated });
      else if (op.op === "append") this.appendMessages(r.id, op.base, op.messages);
    } catch (e) {
      console.warn("[store] 索引期间排队的操作重放失败（跳过）:", r.id, op.op, e.message);
    }
  }

  /** 取消在飞索引（reset/drop 用）：任务在下一个分块边界自行收尾，暂存结果整体丢弃。 */
  _cancelIndexJob(id) {
    const job = this._indexJobs.get(id);
    if (!job) return false;
    job.cancelled = true;
    this._indexJobs.delete(id);
    return true;
  }

  /** 磁盘记录 → 热缓存条目。msg 行是本模块写出的固定前缀格式时直接切片，省一次 stringify */
  _entryFromRecord(rec, line) {
    if (rec.k === "remote") {
      if (rec.enc === 1) return { k: "remote", seq: rec.seq, h: rec.h, json: remoteEnvelopeJson(rec) };
      return { k: "remote", seq: rec.seq, text: rec.text, json: remoteJson(rec.text, rec.at || 0, cleanCid(rec.cid)) };
    }
    let json = null;
    if (line && rec.enc === 1 && MSG_ENC_PREFIX.test(line) && line.endsWith("}")) {
      // Stored line is {"k":"msg","seq":N,"enc":1,"role":..,"h":..,"ct":..}:
      // the frame envelope is the same tail behind an {"enc":1, head.
      const m = MSG_ENC_PREFIX.exec(line);
      json = `{"enc":1,${line.slice(m[0].length, -1)}}`;
    } else if (line && MSG_PREFIX.test(line) && line.endsWith("}")) {
      const m = MSG_PREFIX.exec(line);
      json = line.slice(m[0].length, -1);
    }
    if (json === null) json = rec.enc === 1 ? envelopeFrameJson(rec) : JSON.stringify(rec.m);
    const entry = { k: "msg", seq: rec.seq, json };
    if (rec.enc === 1 && typeof rec.h === "string") entry.h = rec.h;
    return entry;
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

  /** 跨段反向扫描：从现役段到最旧封存段逐段调 _scanBack，结果拼接即全局新→旧
   *  （段内 seq 区间互不重叠且按段序递增）。hasMore/more 的口径与 _scanBack 一致，
   *  拿不准时往 true 标（调用方据此报 truncated，是安全方向）。未分段房间退化为单段直调。 */
  _scanBackSegs(r, before, limit, maxBytes = 8 * 1024 * 1024, after = 0) {
    const ranges = this._segRanges(r);
    const out = [];
    let scanned = 0;
    let hasMore = false;
    let more = false;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const seg = ranges[i];
      if (seg.bytes <= 0) continue;
      if (out.length >= limit) { hasMore = true; break; }
      if (scanned >= maxBytes) { more = true; break; }
      const res = this._scanBack(seg.file, before, limit - out.length, maxBytes - scanned, after);
      scanned += res.scanned || 0;
      for (const rec of res.records) out.push(rec);
      if (res.hasMore) { hasMore = true; break; }
      if (res.more) { more = true; break; }
    }
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
      // metaExtra 为空时与旧写法逐字节一致；有未知字段（如 enc 世代）才追加在标准字段之后。
      // reset() 换代不清 metaExtra：新世代的 meta 行继续带这些字段（设计 §5：不许借 reset 洗掉 enc）。
      const metaObj = { k: "meta", seq: 0, rev: r.rev, headTruncated: r.headTruncated || undefined };
      if (r.metaExtra) Object.assign(metaObj, r.metaExtra);
      const metaLine = JSON.stringify(metaObj);
      r.metaLine = metaLine;
      r.buf.push(metaLine);
    }
    r.buf.push(line);
    if (flush) this._flush(r, { sync: true });
    else this._scheduleFlush(r);
  }

  /** Store one encrypted message record (design section 4.1): the envelope is
   *  written verbatim — nonce/ct are never re-generated relay-side — the room
   *  anchors track its keyed h, and a user envelope supersedes the earliest
   *  pending remote with the same h. */
  _pushEnvelope(r, env) {
    r.seq += 1;
    const entry = { k: "msg", seq: r.seq, h: env.h, json: envelopeFrameJson(env) };
    this._cachePush(r, entry);
    r.lastMsgHash = env.h;
    if (!r.firstMsgHash) r.firstMsgHash = env.h;
    r.msgCount += 1;
    const rec = { k: "msg", seq: r.seq, enc: 1, role: env.role, h: env.h, ct: env.ct };
    this._writeLine(r, JSON.stringify(rec));
    if (env.role === "user") this._supersedeRemoteByH(r, env.h);
    return entry;
  }

  /** Seed/append dispatch: snapshot items are envelopes for enc rooms and
   *  plaintext messages otherwise; each keeps its own storage form. */
  _pushItem(r, item) {
    return isEnvelope(item) ? this._pushEnvelope(r, item) : this._pushMsg(r, item);
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
    if (this._fsyncDir(r.dir || path.dirname(r.file))) {
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

  /** 启动时清理检查点指针/清单的临时文件孤儿：_writeCheckpointPointer/_writeManifest
   *  只在自己的同步写路径里兜底删除，进程被强杀（或宿主机掉电）留下的
   *  <room>.ckpt.json.<pid>.<hex>.tmp / <room>.index.json.<pid>.<hex>.tmp 没人清理，
   *  会永久占着目录。只删一小时以前的：另一个进程可能正在写同名临时文件，不能误删。
   *  房文件分组后临时文件落在房间目录里，平铺根目录与分组两级子目录一并扫。 */
  _cleanupOrphanTemps() {
    const dirs = [this.dir];
    try {
      for (const d of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const devDir = path.join(this.dir, d.name);
        dirs.push(devDir);
        try {
          for (const w of fs.readdirSync(devDir, { withFileTypes: true })) {
            if (w.isDirectory()) dirs.push(path.join(devDir, w.name));
          }
        } catch {}
      }
    } catch {}
    const cutoff = Date.now() - CKPT_TMP_MAX_AGE_MS;
    let removed = 0;
    for (const dir of dirs) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!CKPT_TMP_RE.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          if (!st.isFile() || st.mtimeMs > cutoff) continue;
          fs.unlinkSync(file);
          removed++;
        } catch {}
      }
    }
    if (removed) {
      console.warn(`[store] 清理检查点临时文件孤儿 ${removed} 个（上次写入进程异常退出）`);
    }
    return removed;
  }

  /** 记一笔刚落盘成功的行（清单条目统计）：行数 + 首尾 seq（msg/remote 才有真 seq）。
   *  只许在 _appendBatch 确认整行写完后调用；部分落盘按 writtenLines 切片调用。 */
  _noteAppended(r, batchLines) {
    if (!batchLines || !batchLines.length) return;
    if (r._segLines >= 0) r._segLines += batchLines.length;
    for (const line of batchLines) {
      const m = /^\{"k":"(?:msg|remote)","seq":(\d+)/.exec(line);
      if (!m) continue;
      const seq = Number(m[1]);
      if (!r._segFirstSeq) r._segFirstSeq = seq;
      if (seq > r._segLastSeq) r._segLastSeq = seq;
    }
  }

  /** 捕获"盘面末尾状态"：在一次 flush 完整落盘后调用，此刻内存聚合状态与盘面记录
   *  恰好一一对应（缓冲已排空）。封存时这份快照就是被封存前缀的状态，直接进清单，
   *  冷打开不必重扫封存段。出现过部分落盘/缓冲残留时内存与盘面不再对齐（_diskStateStale），
   *  封存改走 _rebuildSegState 重扫兜底，绝不用过期状态冒充。 */
  _captureDiskState(r) {
    // 索引不完整的房间内存状态缺尾巴：捕获了会在封存时把缺失记录冒充成盘面状态，绝不许。
    if (!this.persist || this.segmentMaxBytes <= 0 || r.fileCapped || r._indexFailed || r.indexPartial) return;
    r._diskState = this._statePayload(r);
    r._diskStateStale = false;
  }

  /** 封存兜底：没有可信的 _diskState 时（重启后第一次封存、或出现过部分落盘），
   *  把全部封存段 + 当前现役段按序重扫进暂存房间，取其聚合状态。慢但罕见且有界（≤总量上限）。 */
  _rebuildSegState(r) {
    const scratch = this._newRoom(r.id, r.file);
    scratch.dir = r.dir;
    scratch.segs = r.segs.map((s) => ({ ...s }));
    scratch.sealedBytes = r.sealedBytes;
    let ctx = this._newIndexCtx();
    ctx = this._scanVirtual(scratch, 0, ctx);
    this._finishIndex(scratch, ctx);
    if (!scratch.rev) scratch.rev = r.rev;
    return this._statePayload(scratch);
  }

  /** 数一个文件里的换行数（= 完整行数）。只数原始字节不解析，封存时给继承来的
   *  现役段补 events 用。 */
  _countLines(file) {
    let fd;
    let n = 0;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(1024 * 1024);
      let got;
      while ((got = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        for (let i = 0; i < got; i++) if (buf[i] === 0x0a) n++;
      }
    } catch {}
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
    return n;
  }

  /** 封存现役段：现役文件改名为 <room>.<NNNN>.jsonl，清单追加该段条目并原子落盘，
   *  后续追加自然在新现役文件上继续。前置条件：调用点保证盘面状态与 _diskState
   *  （或重扫结果）严格对齐——_appendBatch 写新批之前调用，待写批次还在缓冲里，
   *  不属于被封存前缀。顺序：先 fsync 现役文件（内容耐久）→ rename → fsync 目录
   *  （改名耐久）→ 写清单（tmp+rename）。崩溃在 rename 后、清单前：清单缺这一段条目，
   *  冷打开时该段按"无 state"重扫，不丢数据。 */
  _sealSegment(r) {
    let size = 0;
    try { size = fs.statSync(r.file).size; } catch { return false; }
    if (size <= 0) return false;
    const n = r.segs.length ? r.segs[r.segs.length - 1].n + 1 : 1;
    const name = `${r.id}.${String(n).padStart(4, "0")}.jsonl`;
    const dest = path.join(r.dir, name);
    const state = !r._diskStateStale && r._diskState ? r._diskState : this._rebuildSegState(r);
    const entry = {
      file: name,
      bytes: size,
      events: r._segLines >= 0 ? r._segLines : this._countLines(r.file),
      firstSeq: r._segFirstSeq || 0,
      lastSeq: r._segLastSeq || state.maxSeq || 0,
      state,
    };
    this._fsyncFile(r.file);
    fs.renameSync(r.file, dest);
    this._fsyncDir(r.dir);
    r.segs.push({ n, name, file: dest, bytes: size });
    r.sealedBytes += size;
    r._manifestEntries[r.segs.length - 1] = entry;
    r._segLines = 0;
    r._segFirstSeq = 0;
    r._segLastSeq = 0;
    this._writeManifest(r);
    return true;
  }

  /**
   * 追加一批已序列化字节，返回 {ok, off, size, error, writtenLines, partial, tooLarge}。
   *  - 追加前确认文件尾是换行：残行先截掉（崩溃残留/上次半截写入），否则重试会与残行粘成一行；
   *  - 用 writeSync 自己记录实际写入字节；失败时已完整写入的行算已落盘（writtenLines），
   *    写了一半的行截掉，调用方只重试没写完的行——绝不整批重写（否则重复记录 + 粘行）；
   *  - 这一批会越过 maxRoomFileBytes 时整批拒写（tooLarge）：房文件本体的硬上限（分段后按
   *    全段总和判），不写出半条记录；
   *  - 现役段写满 segmentMaxBytes 时先封存再写（整批不越过段界，一条记录不跨段）；
   *    返回的 off/size 恒为现役段内的局部偏移，检查点的虚拟偏移由调用方加 r.sealedBytes。
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
      if (this.maxRoomFileBytes > 0 && r.sealedBytes + off + data.length > this.maxRoomFileBytes) {
        return {
          ok: false,
          off,
          tooLarge: true,
          error: new Error(`房文件将超过上限 ${this.maxRoomFileBytes} 字节（当前 ${r.sealedBytes + off} + ${data.length}）`),
          writtenLines: 0,
          partial: false,
        };
      }
      // 分段封存：现役段已有内容、且这一批写完会越过段界 → 先封存再写进新现役段。
      // 现役段为空时不封（封出空段没有意义；单个超大批次整批落进一段，下批再封）。
      if (this.segmentMaxBytes > 0 && off > 0 && off + data.length > this.segmentMaxBytes) {
        try { fs.closeSync(fd); } catch {}
        fd = undefined;
        haveOff = false;
        let sealed = false;
        try { sealed = this._sealSegment(r); } catch {}
        // 封存失败（rename 异常等）：不丢数据优先，继续往现役段写，下一批再试封存。
        fd = fs.openSync(r.file, "a+");
        off = sealed ? 0 : fs.fstatSync(fd).size;
        haveOff = true;
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
    const batchLines = r.buf;
    const data = Buffer.from(batchLines.join("\n") + "\n", "utf8");
    const res = this._appendBatch(r, data, batchLines.length);
    if (res.ok) {
      r.buf = [];
      r.metaLine = null;
      // 清单统计记账 + 盘面状态捕获（此刻内存与盘面严格对齐，见 _captureDiskState）。
      this._noteAppended(r, batchLines);
      this._captureDiskState(r);
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
    // 部分落盘/缓冲残留：内存与盘面不再严格对齐，封存时不许用 _diskState 冒充（走重扫兜底）。
    r._diskStateStale = true;
    if (res.writtenLines) {
      const done = r.buf.splice(0, res.writtenLines);
      this._noteAppended(r, done);
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
    // 大小与间隔都按虚拟口径：全段总字节、上个检查点的虚拟 end（分段前后语义一致）。
    let size = r.sealedBytes || 0;
    try { size += fs.statSync(r.file).size; } catch { return false; }
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
      const payload = JSON.stringify(this._statePayload(r));
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
      this._noteAppended(r, [payload]);
      // _appendBatch 可能先修掉了残行，偏移必须用它回报的起点；指针存虚拟偏移
      // （封存段总字节 + 段内偏移），分段前后同一口径（见 _readCheckpoint）。
      const off = r.sealedBytes + appended.off;
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
    const file = this._ckptFile(id);
    try { fs.unlinkSync(file); removed = true; } catch {}
    // 删除目录项也要同步：掉电后旧指针不能"复活"。旧指针有 rev/sha1 校验，最坏只多一次全量扫描。
    if (removed) this._fsyncDir(path.dirname(file));
  }


  // ---------- 构造器异步预热 ----------

  /** "大且起点覆盖不足"的房间才预热：有检查点/清单 base 时打开本来只读尾巴，
   *  待扫字节（总量 − 起点覆盖）不够 prewarmMinBytes 的不预热。 */
  _prewarmAll() {
    const jobs = [];
    for (const { id, layout } of this._enumerateLayouts()) {
      if (!layout.exists || layout.total < this.prewarmMinBytes) continue;
      const base = this._probeBase(id, layout, { quiet: true });
      if (layout.total - base.end < this.prewarmMinBytes) continue;
      jobs.push({ id, layout, base, size: layout.total, mtimeMs: layout.active.mtimeMs || 0 });
    }
    if (!jobs.length) {
      this._notifyPrewarm();
      return;
    }
    // 构造器预热不是"把整个 data 目录搬进内存"：最多保留 prewarmMaxRooms 个索引。
    // 按 mtime 从新到旧排，优先预热最近活跃的房间（最可能被马上打开），其余首次打开按大小索引。
    jobs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    if (jobs.length > this.prewarmMaxRooms) {
      console.warn(
        `[store] 待预热房间 ${jobs.length} 个，超过上限 ${this.prewarmMaxRooms}，只预热最近活跃的 ${this.prewarmMaxRooms} 个`,
      );
    }
    this._prewarmPending += 1;
    (async () => {
      try {
        for (const spec of jobs) {
          if (this._prewarmed.size >= this.prewarmMaxRooms) break;
          if (this.rooms.has(spec.id) || this._prewarmed.has(spec.id)) continue;
          // 与首次打开共用同一套异步索引引擎（R-4）：预热 = 没人等的首次打开，结果进 _prewarmed；
          // 若首次打开已抢先起了同一个任务，等它即可，不另起重复扫描。逐个房间串行跑，避免 IO 争抢。
          const flying = this._indexJobs.get(spec.id);
          if (flying) { await flying.promise; continue; }
          try {
            await this._startIndexJob(spec.id, spec.layout, spec.base).promise;
          } catch (e) {
            console.warn("[store] 房间预热异常（首次打开时重新索引）:", spec.id, e.message);
          }
        }
      } finally {
        this._prewarmPending -= 1;
        this._notifyPrewarm();
      }
    })();
  }

  /** 重置房间存储（会话换代/分支跳转后由 relay 调用）：内存与磁盘都清空，换新 rev，等待重新 seed。
   *  返回是否成功：落盘模式下截断旧文件失败时返回 false，且**不动内存状态**（内存与磁盘继续
   *  保持同一旧世代），调用方绝不能继续把新世代 seed 进去——否则新旧两代混写一个文件，
   *  重启后旧分支消息全部"复活"。 */
  reset(roomId) {
    // 预热好但还没打开的索引也必须作废，否则 reset 后第一次打开会把旧历史装回来。
    this._dropPrewarmed(roomId);
    // 在飞的异步索引同样作废：否则它落地时会把旧世代的状态移植进新房间/记进 _prewarmed。
    this._cancelIndexJob(roomId);
    const r = this.rooms.get(roomId);
    // 指针先删：即使随后截断失败，旧指针也不能再把这代历史装回来。
    this._removeCheckpointPointer(roomId);
    const dir = this._roomDir(roomId);
    const layout = this._layoutIn(roomId, dir);
    const file = layout.active.file;
    // 先清磁盘，成功后才清内存：失败时保持内存/磁盘同一旧世代，绝不能让内存先行换代。
    try {
      if (this.persist) {
        // 封存段与清单整房作废（换代后旧段绝不能被拼回新世代）；现役段截断为 0 而不是删除：
        // rmSync 失败（EACCES/EBUSY）时旧文件还在，新的 seed 会追加到旧文件尾部，
        // 重启后旧分支消息全部"复活"。删段失败同样进 catch，整次 reset 判失败。
        for (const seg of layout.sealed) fs.unlinkSync(seg.file);
        try { fs.unlinkSync(this._manifestFile(roomId, dir)); } catch {}
        fs.closeSync(fs.openSync(file, "w"));
        // 换代是可确认的状态转换：fsync 一下，别让断电把截断前的旧分支带回来
        this._fsyncFile(file);
        this._fsyncDir(dir);
      } else if (fs.existsSync(file)) {
        // 默认不落盘：没有文件就别创建空文件；旧文件若还在，截断以免换代后被装配回来。
        fs.truncateSync(file, 0);
        for (const seg of layout.sealed) { try { fs.unlinkSync(seg.file); } catch {} }
        try { fs.unlinkSync(this._manifestFile(roomId, dir)); } catch {}
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
      r._indexing = false;
      r._indexJob = null;
      r._journal = null; // 索引期间排队的操作属于旧世代，随换代一并丢弃
      // 分段状态随换代清零：旧封存段已删，新世代从空现役段重新长。
      r.segs = [];
      r.sealedBytes = 0;
      r._manifestEntries = [];
      r._segLines = 0;
      r._segFirstSeq = 0;
      r._segLastSeq = 0;
      r._diskState = null;
      r._diskStateStale = false;
      r._captureNeed = null;
      r._captureFilled = false;
    }
    if (this.persist) {
      // 文件可能是刚创建的：目录项同样要落盘，否则换代后的空文件/新 seed 可能随掉电消失。
      if (r) this._syncRoomDir(r, { force: true });
      else this._fsyncDir(dir);
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
      if (this._journalIfIndexing(r, { op: "record", event })) return 0; // 索引落地后重放时才分配 seq
      if (isEnvelope(event.message)) {
        // Safety net: an envelope record marks the room enc even without a prior
        // declaration, so the version gates engage instead of leaking ciphertext
        // to incapable viewers as if it were a message.
        if (!encMetaOf(r.metaExtra)) this._markEncUnknown(r);
        this._pushEnvelope(r, event.message);
      } else {
        this._pushMsg(r, event.message);
      }
      return r.seq;
    }
    if (event.type === "tool_execution_end") {
      this.recordToolEnd(roomId, event);
      return 0; // 元数据不是 transcript 记录，不占 seq
    }
    if (event.type === "remote_message" && (typeof event.text === "string" || remoteEnvelopeOf(event))) {
      const r = this._room(roomId, { create: true });
      if (!r) return 0;
      if (this._journalIfIndexing(r, { op: "record", event })) return 0;
      r.seq += 1;
      const at = event.at || Date.now();
      const cid = cleanCid(event.cid);
      const env = remoteEnvelopeOf(event);
      if (env) {
        if (!encMetaOf(r.metaExtra)) this._markEncUnknown(r);
        const line = { k: "remote", seq: r.seq, enc: 1, at };
        if (cid) line.cid = cid;
        line.h = env.h;
        line.ct = env.ct;
        this._cachePush(r, { k: "remote", seq: r.seq, h: env.h, json: remoteEnvelopeJson(line) });
        this._writeLine(r, JSON.stringify(line));
        this._rememberRemote(r, { seq: r.seq, h: env.h, ct: env.ct, cid });
      } else {
        this._cachePush(r, { k: "remote", seq: r.seq, text: event.text, json: remoteJson(event.text, at, cid) });
        const line = { k: "remote", seq: r.seq, text: event.text, at };
        if (cid) line.cid = cid;
        this._writeLine(r, JSON.stringify(line));
        this._rememberRemote(r, { seq: r.seq, text: event.text, cid });
      }
      return r.seq;
    }
    if (event.type === "remote_message_failed") this.markRemoteFailed(roomId, event.text, event.cid);
    return 0;
  }

  /** 房间是否真实存在（在内存注册表，或磁盘有文件）——供 viewer 订阅前验真，防幻影房 */
  exists(id) {
    if (!safeRoomId(id)) return false;
    if (this.rooms.has(id)) return true;
    return this.persist && this._layoutIn(id, this._roomDir(id)).exists;
  }

  /** A room's enc meta ({enc:1, ackFp?, rckWrap?}) or null when the room is
   *  plaintext / does not exist. Loaded rooms answer from memory; otherwise the
   *  meta line at the head of the first segment is probed with a bounded read
   *  and cached against that file's (mtime, size) plus the layout total — the
   *  meta line of a live generation never changes in place. */
  encInfo(roomId) {
    const loaded = this.rooms.get(roomId);
    if (loaded) return encMetaOf(loaded.metaExtra);
    if (!this.persist || !safeRoomId(roomId)) return null;
    const layout = this._layoutIn(roomId, this._roomDir(roomId));
    if (!layout.exists) return null;
    const first = layout.sealed.length ? layout.sealed[0] : null;
    const firstFile = first ? first.file : layout.active.file;
    let sig = null;
    try {
      const st = fs.statSync(firstFile);
      sig = `${st.mtimeMs}:${st.size}:${layout.total}`;
    } catch { return null; }
    const hit = this._encProbeCache.get(roomId);
    if (hit && hit.sig === sig) return hit.meta;
    let meta = null;
    try {
      const fd = fs.openSync(firstFile, "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const nl = buf.subarray(0, n).indexOf(0x0a);
        const line = (nl >= 0 ? buf.subarray(0, nl) : buf.subarray(0, n)).toString("utf8").trim();
        const rec = JSON.parse(line);
        if (rec && rec.k === "meta") {
          const extra = {};
          for (const key of Object.keys(rec)) {
            if (key === "k" || key === "seq" || key === "rev" || key === "headTruncated") continue;
            extra[key] = rec[key];
          }
          meta = encMetaOf(extra);
        }
      } finally { fs.closeSync(fd); }
    } catch { meta = null; }
    this._encProbeCache.set(roomId, { sig, meta });
    return meta;
  }

  /** Declare (or replace) a room's enc meta (design section 5: the meta record
   *  gains enc/ackFp/rckWrap). Takes effect in memory immediately; on disk it
   *  rides the generation's next meta line — appended right away when the
   *  current generation already has one (the scanner honors the latest meta
   *  line), otherwise the first write of the generation carries it. rckWrap is
   *  stored verbatim and never parsed or logged (opaque to the relay).
   *  Phase 4 gate B (ACK-rotation design section 1.2): an ackFp TRANSITION
   *  through this declaration path is refused — the stored wrap is the
   *  room's only key pointer, and re-pointing it at another ACK orphans
   *  the room's whole encrypted history. Legitimate transitions never come
   *  through here: migration assigns metaExtra itself inside migrateRoom,
   *  and the future room_key_rewrap channel must land its own store entry
   *  point rather than weaken this guard. A stored meta without an ackFp
   *  (the _markEncUnknown safety net) may still be completed by a
   *  declaration, and same-ackFp re-declarations keep working as before. */
  setEncMeta(roomId, meta) {
    const clean = cleanEncMeta(meta);
    if (!clean) return false;
    const r = this._room(roomId, { create: true });
    if (!r) return false;
    const prev = encMetaOf(r.metaExtra);
    if (prev && prev.ackFp && prev.ackFp !== clean.ackFp) {
      console.warn(`[store] refused enc meta ackFp transition (gate B): room=${roomId} ${prev.ackFp} -> ${clean.ackFp}`);
      return false;
    }
    r.metaExtra = { ...(r.metaExtra || {}), ...clean };
    this._encProbeCache.delete(roomId);
    if (prev && prev.ackFp === clean.ackFp && prev.rckWrap === clean.rckWrap) return true;
    if (r.metaWritten && this.persist && !r._indexing) {
      const metaObj = { k: "meta", seq: 0, rev: r.rev, headTruncated: r.headTruncated || undefined };
      Object.assign(metaObj, r.metaExtra);
      this._writeLine(r, JSON.stringify(metaObj), { flush: true });
    }
    return true;
  }

  /** Mark a room enc without key material (safety net for envelope records that
   *  arrive without a prior declaration): the version gates engage and snapshot
   *  keyInfo simply lacks rckWrap, so capable viewers fail loudly on decrypt
   *  instead of rendering ciphertext as text. */
  _markEncUnknown(r) {
    if (encMetaOf(r.metaExtra)) return;
    r.metaExtra = { ...(r.metaExtra || {}), enc: 1 };
    this._encProbeCache.delete(r.id);
    console.warn(`[store] 房间 ${r.id} 收到信封记录但未声明 enc 元数据：已按 enc 房处理（keyInfo 缺 rckWrap）`);
  }

  /** Encrypted-generation migration (design section 5). The candidate history
   *  is verified BEFORE anything on disk changes: it is counted and anchored in
   *  memory and compared with the declared trailer {msgCount, lastHash} (the
   *  last record's h). Only on a match — and only with no other live writer —
   *  is the plaintext generation destroyed (reset: active file truncated,
   *  sealed segments, manifest and checkpoint removed) and replaced by the
   *  encrypted generation carrying the enc meta. On any mismatch both
   *  generations survive untouched and the device may retry. */
  migrateRoom(roomId, messages, trailer, meta, { hasLiveWriter = false } = {}) {
    const fail = (reason, extra) => ({ ok: false, reason, ...(extra || {}) });
    const r = this._room(roomId, { create: true });
    if (!r) return fail("bad_room");
    if (r._indexing) return fail("indexing");
    if (hasLiveWriter) return fail("live_writer");
    const clean = cleanEncMeta(meta);
    if (!clean) return fail("bad_enc_meta");
    if (!trailer || !Number.isInteger(trailer.msgCount) || trailer.msgCount < 0 ||
        typeof trailer.lastHash !== "string" || !trailer.lastHash) {
      return fail("bad_trailer");
    }
    const raw = Array.isArray(messages) ? messages : [];
    const candidates = raw.filter((m) => m && typeof m.role === "string" && m.role !== "system");
    if (!candidates.length || candidates.some((m) => !isEnvelope(m))) return fail("not_envelopes");
    const lastHash = candidates[candidates.length - 1].h;
    if (candidates.length !== trailer.msgCount || lastHash !== trailer.lastHash) {
      return fail("trailer_mismatch", { landed: { msgCount: candidates.length, lastHash } });
    }
    if (!this.reset(roomId)) return fail("reset_failed");
    // reset() deliberately keeps metaExtra (the enc inheritance rule); replace
    // it wholesale with the migration's declared meta before seeding, so the
    // new generation's meta line carries exactly this declaration.
    r.metaExtra = { ...clean };
    this._encProbeCache.delete(roomId);
    this._seedAll(r, candidates, false);
    return { ok: true, msgCount: candidates.length, lastHash };
  }

  /** 对齐锚点（扩展重连时据此决定只传尾部还是全量）。
   *  indexFailed=true 表示这个房间的索引没装全（扫描失败/病态文件）：调用方/诊断能看到"不完整"，
   *  而不是把半份历史当正常房。 */
  info(roomId) {
    const r = this._room(roomId);
    if (!r) {
      return { exists: false, rev: null, seq: 0, msgCount: 0, firstHash: null, lastHash: null, dropped: 0, indexFailed: false, indexing: false, enc: 0 };
    }
    return {
      exists: true,
      rev: r.rev,
      seq: r.seq,
      msgCount: r.msgCount,
      firstHash: r.firstMsgHash,
      lastHash: r.lastMsgHash,
      enc: encMetaOf(r.metaExtra) ? 1 : 0,
      dropped: r.dropped || 0,
      indexFailed: !!(r._indexFailed || r.indexPartial),
      // 异步索引在飞（R-4）：锚点（rev/seq/hash）此刻都是占位空值，调用方据此知道要等落地后重问。
      indexing: !!r._indexing,
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
      if (typeof e.h === "string") {
        newestFirst.push(e.h);
        continue;
      }
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
        const disk = this._scanBackSegs(r, before, want, budget, 0);
        if (!disk.records.length) break;
        for (const rec of disk.records) {
          if (rec.k !== "msg") continue;
          newestFirst.push(rec.enc === 1 && typeof rec.h === "string" ? rec.h : hashOf(rec.m));
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
    if (!encMetaOf(r.metaExtra) && incoming.some((m) => isEnvelope(m))) this._markEncUnknown(r);
    for (const m of incoming) this._pushItem(r, m);
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
    // 索引在飞：锚点还不存在，任何对齐决定都不可信——整份排队，落地后按真实锚点重放。
    if (this._journalIfIndexing(r, { op: "seed", messages, truncated })) return none;
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
        if (typeof e.h === "string") { tail.push(e.h); continue; }
        try { tail.push(hashOf(JSON.parse(e.json))); } catch { tail.length = 0; break; }
      }
      if (tail.length) {
        const incomingHash = incoming.map((m) => anchorOf(m));
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
      const headOk = !!r.firstMsgHash && anchorOf(incoming[0]) === r.firstMsgHash;
      const tailOk = !!r.lastMsgHash && N > 0 && M >= N && anchorOf(incoming[N - 1]) === r.lastMsgHash;
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
    if (!encMetaOf(r.metaExtra) && incoming.some((m) => isEnvelope(m))) this._markEncUnknown(r);
    const baseSeq = r.seq;
    const items = [];
    // 按位置追加，绝不做 hash 判重——同文本的连续消息是真实新增
    for (let i = from; i < incoming.length; i++) items.push(this._pushItem(r, incoming[i]).json);
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
    // 索引在飞：排队等落地后按真实锚点重放；此刻报 ok 且零合并，
    // 调用方不会因为假"锚点不符"误发全量快照请求（真锚点校验在重放时做）。
    if (this._journalIfIndexing(r, { op: "append", base, messages })) {
      return { ok: true, seeded: 0, merged: 0, reset: false, baseSeq: 0, items: [] };
    }
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
    for (let t = 0; t < k; t++) if (anchorOf(incoming[t]) !== tail[t]) return fail();
    return { ok: true, ...this._appendFrom(r, incoming, k) };
  }

  /** Pending remote bookkeeping. Plaintext entries carry {seq, text, cid};
   *  enc entries carry {seq, enc:1, h, ct, cid} (ct is kept so checkpoint state
   *  can carry the envelope, per design section 4.1 pending rule). */
  _rememberRemote(r, entry) {
    const p = { seq: entry.seq, cid: entry.cid || null };
    if (entry.h) {
      p.enc = 1;
      p.h = entry.h;
      if (entry.ct) p.ct = entry.ct;
    } else {
      p.text = entry.text || "";
    }
    r.pendingRemotes.push(p);
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
    const i = r.pendingRemotes.findIndex((p) => typeof p.text === "string" && remoteEchoMatches(p.text, text));
    return i >= 0 ? this._dropRemote(r, i) : false;
  }

  /** Enc rooms (live path): same FIFO supersede as _supersedeRemote, keyed on h. */
  _supersedeRemoteByH(r, h) {
    const i = r.pendingRemotes.findIndex((p) => p.enc === 1 && p.h === h);
    return i >= 0 ? this._dropRemote(r, i) : false;
  }

  /**
   * 远程消息注入失败：把对应的 remote 回显从回放里摘掉（否则重订阅后失败的消息像发成功了一样）。
   * 带 cid 只认 cid（对不上就什么都不摘，不能误伤同文本的另一条）；没有 cid 的旧扩展退回按文本摘最近一条。
   */
  markRemoteFailed(roomId, text, cid) {
    const r = this.rooms.get(roomId);
    if (!r) return false;
    if (this._journalIfIndexing(r, { op: "remoteFailed", text, cid })) return false;
    const id = cleanCid(cid);
    let i = -1;
    if (id) i = r.pendingRemotes.findIndex((p) => p.cid === id);
    else if (typeof text === "string") {
      for (i = r.pendingRemotes.length - 1; i >= 0; i--) {
        if (typeof r.pendingRemotes[i].text === "string" && remoteEchoMatches(r.pendingRemotes[i].text, text)) break;
      }
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
    this._cancelIndexJob(roomId); // 在飞索引作废，别让它的落地把已删房间的状态记回 _prewarmed
    this._removeCheckpointPointer(roomId);
    // 整场对话删除：现役段 + 全部封存段 + 清单，一个不留（purge/保留清理的语义）。
    const dir = this._roomDir(roomId);
    const layout = this._layoutIn(roomId, dir);
    let removed = false;
    try { fs.unlinkSync(layout.active.file); removed = true; } catch {}
    for (const seg of layout.sealed) {
      try { fs.unlinkSync(seg.file); removed = true; } catch {}
    }
    try { fs.unlinkSync(this._manifestFile(roomId, dir)); removed = true; } catch {}
    // 删除房文件的目录项也同步：掉电后不能把已 drop 的历史文件"复活"。
    if (removed) this._fsyncDir(dir);
  }

  /** 房文件（任一段/清单）是否还在盘上——purge 删完后用它验真（drop 吞异常，调用方要确认）。 */
  roomFileExists(id) {
    if (!safeRoomId(id)) return false;
    const layout = this._layoutIn(id, this._roomDir(id));
    return layout.exists || layout.hasMeta;
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
      if (r._indexing) continue; // 索引在飞：占位房间的索引还没落地，淘汰会把在飞任务的家拆掉
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
  /** Snapshot enc header fields (design section 7): present only for enc rooms.
   *  snapshotBodyFrom renders them as the frame's enc/keyInfo header; the relay
   *  only ever forwards ackFp + the opaque rckWrap, never key material. */
  _snapEncFields(r) {
    const em = r ? encMetaOf(r.metaExtra) : null;
    if (!em) return null;
    return { enc: 1, keyInfo: { ackFp: em.ackFp || null, rckWrap: em.rckWrap || null } };
  }

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
        ...(r ? this._snapEncFields(r) || {} : {}),
      };
    }
  }

  _snapshot(roomId, { limit = 10000, maxBytes = 24 * 1024 * 1024, since = null } = {}) {
    const r = this._room(roomId);
    if (!r) return null;
    this._flush(r);
    // 索引不完整时连增量都不能信（baseSeq 可能落在没扫到的区间），只能按全量路径交付并标 truncated。
    // 异步索引在飞同理（R-4）：占位房间还没有任何可信锚点，一律走全量路径并标 truncated，
    // 订阅方靠既有补发/重订阅在索引落地后收敛，绝不能把空占位当"已同步到 seq=0"。
    const indexPartial = !!(r._indexFailed || r.indexPartial);
    const indexing = !!r._indexing;
    const encFields = this._snapEncFields(r);
    if (!indexPartial && !indexing && since && since.rev === r.rev && Number.isInteger(since.seq) && since.seq >= 0 && since.seq <= r.seq) {
      const d = this._collect(r, { after: since.seq, limit, maxBytes });
      if (!d.truncated) return { rev: r.rev, seq: r.seq, truncated: false, delta: true, baseSeq: since.seq, items: d.items, ...(encFields || {}) };
      // 增量本身超安全阀（离线太久）：退回全量，由全量路径给出 truncated 语义
    }
    const f = this._collect(r, { after: 0, limit, maxBytes });
    const truncated = f.truncated || r.headTruncated || indexPartial || indexing;
    if (f.truncated) {
      console.warn(`[store] 房间 ${r.id} 快照截断：交付 ${f.items.length} 条（触及 ${limit} 条 / ${Math.round(maxBytes / 1048576)}MB 安全阀）`);
    }
    return { rev: r.rev, seq: r.seq, truncated, delta: false, baseSeq: 0, items: f.items, ...(encFields || {}) };
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
      const disk = this._scanBackSegs(r, before, Math.max(limit - picked.length, 0), Math.max(maxBytes - bytes, 0), after);
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

module.exports = { RoomStore, hashOf, contentText, remoteEchoMatches, cleanCid, encodeCwdSegment, deviceSegment, SEGMENT_MAX_BYTES, UNCLASSIFIED_SEG };
