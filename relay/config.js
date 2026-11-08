"use strict";
/** relay 配置：默认值、config.json 与环境变量 */
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_ACCOUNT } = require("./index");
const PROTOCOL = require("./protocol.json");
const { sanitizeNotifyEvents } = require("./notify");

const ROOT = path.resolve(__dirname, "..");

/** P11 身份行：中转服务器显示名（运维自定，不含用户身份）；空 = 客户端回退 hostname。 */
function cleanServerName(rawValue) {
  if (typeof rawValue !== "string") return "";
  const value = rawValue.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return value.slice(0, 64);
}
const LOG_DIR = path.join(ROOT, "logs");

// token 同时是 viewer 页面能看到的共享口令：短 token 可在线爆破（7002 无 TLS，只有长度和限流两道门）。
const MIN_TOKEN_LENGTH = 16;

const DEFAULT_CONFIG = {
  localPort: 7001,
  viewerPort: 7002,
  // 监听地址：local 通道默认只听回环（扩展/attach 从本机或隧道连入），要对公网开放必须显式配置
  // （PI_REMOTE_LOCAL_HOST=0.0.0.0）；viewer 通道默认全网卡（手机要能连），可用 PI_REMOTE_VIEWER_HOST 收紧。
  localHost: "127.0.0.1",
  viewerHost: "0.0.0.0",
  // 默认 token 是占位符：必须显式配置。设环境变量 PI_REMOTE_LOCAL_TOKEN / PI_REMOTE_VIEWER_TOKEN
  // （> relay/config.json > 默认；config.json 已在 .gitignore）。
  localToken: "",
  viewerToken: "",
  // 管理员令牌：生成配对码、撤销设备必须单独出示。它是独立配置，不是 viewer token 的别名；
  // 未配置（或短于 MIN_TOKEN_LENGTH）时管理功能禁用，查看/发消息等普通功能照常。
  adminToken: "",
  maxPayloadBytes: 256 * 1024,
  localMaxPayloadBytes: 16 * 1024 * 1024, // local 通道放宽：全量快照/大 command_result 可达数 MB，超限会被 relay 顶下线 → 重连风暴
  ratePerSec: 20,
  rateBurst: 60,
  maxViewersPerRoom: 20,
  // —— viewer 认证防护（7002 对公网开放，token 在页面里可见）——
  // 同一来源在窗口内认证失败达到上限后短时锁定；成功认证清空该来源的失败计数。
  viewerAuthFailMax: 10,
  viewerAuthFailWindowMs: 60 * 1000,
  viewerAuthLockMs: 30 * 1000,
  // 同时处于“已连接未认证”的 viewer 数量上限：防止大量半开连接占满内存/句柄。
  maxUnauthenticatedViewers: 100,
  // —— 会话存储（数据接口：完整镜像快照 + 持久化）——
  dataDir: path.join(ROOT, "data", "rooms"),
  cacheSize: 500,        // 每房间内存热缓存条数（超出驻留磁盘，快照时按需装配）
  cacheMaxBytes: 16 * 1024 * 1024, // 每房间热缓存字节上限（大工具输出不能把内存吃满）
  maxSnapshotRecords: 10000, // 快照安全阀：单房间交付条数上限
  maxSnapshotBytes: 24 * 1024 * 1024, // 快照安全阀：单房间交付字节上限（手机端也要能吃下）
  flushIntervalMs: 200,  // 批量落盘间隔
  retentionDays: 30,     // 房间文件保留天数（超期清理）
  // Per-room transcript file hard cap in bytes (all segments summed). Only
  // applies when persistTranscripts is on; 0 disables the cap. At the cap the
  // store stops persisting new records for that room (nothing is deleted, the
  // live stream keeps flowing); at 80% it warns once per room.
  persistMaxRoomBytes: 256 * 1024 * 1024,
  // —— 传输 ——
  perMessageDeflate: true,             // viewer 通道压缩（≥1KB 的帧；JSON 快照通常压到 1/5 以下）
  viewerLagBytes: 1024 * 1024,         // viewer 发送缓冲超过它：跳过可丢的流式 delta
  viewerMaxBufferBytes: 64 * 1024 * 1024, // 超过它：判为挂死消费者，断开
  // —— 内存淘汰 ——
  roomIdleEvictMs: 6 * 3600 * 1000,    // 离线且无人观看的房间元数据保留时长
  storeIdleEvictMs: 30 * 60 * 1000,    // 存储热缓存空闲淘汰（文件保留）
  snapshotCacheTtlMs: 1500,
  dedupeTtlMs: 10 * 60 * 1000,         // 命令去重表保留时长（重发同 dedupeKey 返回首个结果）
  quiet: false,
  // —— 设备窗口 / 会话清单（默认不落对话正文）——
  persistTranscripts: false,
  accountsDir: path.join(ROOT, "data", "accounts"),
  maxSessionsListed: 200,
  harnessStartTimeoutMs: 10000,
  resendSnapshotWaitMs: 3000,
  // 静态页面根目录（默认仓库 web/）。部署/测试可指向别处；不配就走默认。
  webRoot: path.join(ROOT, "web"),
  // 监听失败是否直接 exit(1)。默认 true；只有测试/嵌入方设 false，让 startRelay 以 reject 报错。
  exitOnListenError: true,
  // localToken 对应的账号：新设备/房间一律登记到这里，不信扩展/窗口上报的 accountId。
  // 单用户部署保持缺省 admin 即可；已登记过的设备沿用索引里原来的账号。
  // 可用 config.json 的 accountId 或环境变量 PI_REMOTE_RELAY_ACCOUNT 改。
  accountId: "admin",
  // P11：侧栏底部身份行的中转服务器名（可选；默认空 → 客户端用 window.location.hostname 回退）
  serverName: "",
  // —— 设备令牌（device.token）——
  // 兼容期仍接受共享 localToken 登录（连接标 legacy）；PI_REMOTE_ALLOW_LEGACY_LOCAL=0 时只认配对换来的设备令牌
  allowLegacyLocal: true,
  pairCodeTtlMs: PROTOCOL.limits.pairCodeTtlMs,
  // —— 页面外通知（R2-2 / P2-4b，编排器在 relay/notify.js）——
  // 字段清单（定版，P4-1 的偏好 UI 必须对同一份字段施工，不要另立字段）：
  //   notifyWebhookUrl  webhook 渠道目标地址；空 = 整渠道禁用、零行为变化。
  //                     config.json 的 notifyWebhookUrl < 环境变量 PI_REMOTE_NOTIFY_WEBHOOK_URL。
  //                     地址本身即凭据（含 ntfy 话题名）：只许写服务器侧 config/env，绝不进仓库。
  //   notifyEvents      渠道 × 事件偏好矩阵（一期只有 webhook 一个渠道）：
  //                     { turn_done, turn_error, dialog_waiting } 三类各自开关，
  //                     默认全关，须在 config 里显式写 true 才发（防意外轰炸）。
  notifyWebhookUrl: "",
  notifyEvents: { turn_done: false, turn_error: false, dialog_waiting: false },
  // Plaintext-room policy while body encryption rolls out (design section 5):
  // "allow" (default) = plaintext rooms behave exactly as before;
  // "readonly" = plaintext rooms reject NEW writes but stay readable;
  // "deny" = plaintext rooms reject reads and writes. Enc rooms are unaffected.
  cryptoPlaintextRooms: "allow",
  // Phase 4 slice T-1 (honest plaintext labels): a plaintext room whose host
  // device has not attached for longer than this many days is presented as an
  // orphan room ("device offline"), whatever its original plaintext class.
  // Presentation only -- no room data or policy behavior depends on it.
  cryptoOrphanDays: 30,
};

/**
 * config.json 里允许出现的数值字段及合法区间。字符类型、NaN、小数、负数、越界一律回退默认值并告警：
 * 这些字段直接参与限流/背压/清理计算，静默落成 NaN 会得到"限流失效""永远不清理"这类怪语义。
 */
const NUMERIC_CONFIG_FIELDS = {
  localPort: { min: 1, max: 65535 },
  viewerPort: { min: 1, max: 65535 },
  maxPayloadBytes: { min: 1 },
  localMaxPayloadBytes: { min: 1 },
  ratePerSec: { min: 1 },
  rateBurst: { min: 1 },
  maxViewersPerRoom: { min: 1 },
  viewerAuthFailMax: { min: 1 },
  viewerAuthFailWindowMs: { min: 1 },
  viewerAuthLockMs: { min: 1 },
  maxUnauthenticatedViewers: { min: 1 },
  cacheSize: { min: 1 },
  cacheMaxBytes: { min: 1 },
  maxSnapshotRecords: { min: 1 },
  maxSnapshotBytes: { min: 1 },
  flushIntervalMs: { min: 1 },
  retentionDays: { min: 1 },
  persistMaxRoomBytes: { min: 0 },
  viewerLagBytes: { min: 1 },
  viewerMaxBufferBytes: { min: 1 },
  roomIdleEvictMs: { min: 1 },
  storeIdleEvictMs: { min: 1 },
  snapshotCacheTtlMs: { min: 1 },
  dedupeTtlMs: { min: 1 },
  maxSessionsListed: { min: 1 },
  harnessStartTimeoutMs: { min: 1 },
  resendSnapshotWaitMs: { min: 1 },
  pairCodeTtlMs: { min: 1 },
  cryptoOrphanDays: { min: 1 },
};

/** 只接受 config.json 里的 JSON 数字：字符串/对象/NaN/小数/负数/越界都不算合法，避免隐式转换。 */
function validConfigInt(value, { min, max }) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && (max == null || value <= max);
}

/**
 * config.json 里只接受字符串的字段。非字符串会盲覆盖默认值：`localHost: 5` 让 listen 抛错，
 * 令牌写成数字会被静默当成未配置，路径写成对象会在启动时崩溃。
 */
const STRING_CONFIG_FIELDS = [
  "localHost", "viewerHost", "dataDir", "accountsDir", "accountId", "serverName",
  "localToken", "viewerToken", "adminToken", "notifyWebhookUrl", "webRoot",
];
/**
 * config.json 里只接受布尔值的字段。关键点是 `"false"` 字符串：直接落进 config 后是 truthy，
 * 会把 quiet 变成吞日志、把 persistTranscripts 变成偷偷落盘（报告 relay 中-12）。
 */
const BOOLEAN_CONFIG_FIELDS = ["quiet", "persistTranscripts", "allowLegacyLocal", "perMessageDeflate", "exitOnListenError"];

function describeValue(value) {
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value === "string" ? "字符串" : typeof value;
}

/** 校验/纠正 config.json 的类型字段（原地修改 fileConfig 并返回）。仅处理文件里真实出现的键，缺省不动。 */
function sanitizeTypedConfig(fileConfig, defaults = DEFAULT_CONFIG, warn = console.error) {
  if (!fileConfig || typeof fileConfig !== "object" || Array.isArray(fileConfig)) return fileConfig;
  for (const key of STRING_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fileConfig, key)) continue;
    if (typeof fileConfig[key] === "string") continue;
    warn(`[relay] config.json 字段 ${key} 非法（期望字符串，实际 ${describeValue(fileConfig[key])}），已回退默认值。`);
    fileConfig[key] = defaults[key];
  }
  for (const key of BOOLEAN_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fileConfig, key)) continue;
    if (typeof fileConfig[key] === "boolean") continue;
    warn(`[relay] config.json 字段 ${key} 非法（期望 true/false 布尔值，实际 ${describeValue(fileConfig[key])}），已回退默认值 ${defaults[key]}。`);
    fileConfig[key] = defaults[key];
  }
  if (Object.prototype.hasOwnProperty.call(fileConfig, "notifyEvents")) {
    const raw = fileConfig.notifyEvents;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warn(`[relay] config.json 字段 notifyEvents 非法（期望对象，实际 ${describeValue(raw)}），已回退默认值（全关）。`);
      fileConfig.notifyEvents = { ...defaults.notifyEvents };
    } else {
      for (const kind of Object.keys(defaults.notifyEvents)) {
        if (!Object.prototype.hasOwnProperty.call(raw, kind)) continue;
        if (typeof raw[kind] === "boolean") continue;
        warn(`[relay] config.json 字段 notifyEvents.${kind} 非法（期望 true/false 布尔值，实际 ${describeValue(raw[kind])}），已回退默认值 false。`);
        raw[kind] = defaults.notifyEvents[kind];
      }
    }
  }
  return fileConfig;
}

/** 校验/纠正 config.json 的数值字段（原地修改 fileConfig 并返回）。仅处理文件里真实出现的键，缺省不动。 */
function sanitizeNumericConfig(fileConfig, defaults = DEFAULT_CONFIG, warn = console.error) {
  if (!fileConfig || typeof fileConfig !== "object" || Array.isArray(fileConfig)) return fileConfig;
  for (const [key, rule] of Object.entries(NUMERIC_CONFIG_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(fileConfig, key)) continue;
    const value = fileConfig[key];
    if (validConfigInt(value, rule)) continue;
    const fallback = defaults[key];
    fileConfig[key] = fallback;
    const range = rule.max == null ? `${rule.min} 以上的整数` : `${rule.min}..${rule.max} 的整数`;
    warn(`[relay] config.json 字段 ${key} 非法（期望 ${range}，实际 ${describeValue(value)}），已回退默认值 ${fallback}。`);
  }
  return fileConfig;
}

/**
 * 管理员分权告警：adminToken 同时承担配对/撤销，若与 local/viewer 相同，拿到 viewer 页面令牌的人
 * 也能做管理员操作。只告警不改行为（relay 照常启动），也不打印令牌值。
 * 用 Symbol 标记已检查：main() 里 loadConfig 先告警一次，startRelay 里 startViewerServer 再次装配
 * 同一份 config 时不会重复刷屏；直接调用 startRelay 的测试/嵌入方仍能收到告警。
 */
const TOKEN_SEPARATION_CHECKED = Symbol("adminTokenSeparationChecked");
function warnAdminTokenSeparation(config) {
  if (!config || !config.adminToken || config[TOKEN_SEPARATION_CHECKED]) return false;
  const sameAs = [];
  if (config.adminToken === config.localToken) sameAs.push("localToken");
  if (config.adminToken === config.viewerToken) sameAs.push("viewerToken");
  if (!sameAs.length) return false;
  config[TOKEN_SEPARATION_CHECKED] = true;
  console.error(`[relay] 警告：管理员令牌与 local/viewer 相同，分权失效（adminToken 与 ${sameAs.join(" / ")} 相同）。请给管理员操作单独设置一个随机令牌；日志不会打印令牌内容。`);
  return true;
}

function loadConfig(configPath = path.join(__dirname, "config.json")) {
  const config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(configPath)) {
    let text;
    try {
      text = fs.readFileSync(configPath, "utf8");
    } catch (readError) {
      throw new Error(`config.json 读取失败（${configPath}）：${readError.message}`);
    }
    let fileConfig;
    try {
      fileConfig = JSON.parse(text);
    } catch (parseError) {
      // 损坏时不能带默认值+tokens 静默启动：表现会像"历史/设置突然全没了"，
      // 还继续往旧数据目录写（报告 relay 中-13）。直接报错，由 main 打印并退出。
      throw new Error(`config.json 解析失败（${configPath}）：${parseError.message}`);
    }
    if (!fileConfig || typeof fileConfig !== "object" || Array.isArray(fileConfig)) {
      throw new Error(`config.json 内容必须是对象（${configPath}）`);
    }
    sanitizeNumericConfig(fileConfig);
    sanitizeTypedConfig(fileConfig);
    Object.assign(config, fileConfig);
  }
  config.localPort = clampPort(process.env.PI_REMOTE_LOCAL_PORT, config.localPort);
  config.viewerPort = clampPort(process.env.PI_REMOTE_VIEWER_PORT, config.viewerPort);
  const rawLocalToken = process.env.PI_REMOTE_LOCAL_TOKEN || config.localToken;
  const rawViewerToken = process.env.PI_REMOTE_VIEWER_TOKEN || config.viewerToken;
  const rawAdminToken = process.env.PI_REMOTE_ADMIN_TOKEN || config.adminToken;
  config.localToken = usableToken(rawLocalToken);
  config.viewerToken = usableToken(rawViewerToken);
  config.adminToken = usableToken(rawAdminToken);
  // 在启动装配阶段就明确拒绝弱令牌，而不是等到有人在线爆破成功。日志只说长度/占位符，不打印令牌内容。
  if (rawLocalToken && !config.localToken) warnRejectedToken("localToken", rawLocalToken);
  if (rawViewerToken && !config.viewerToken) warnRejectedToken("viewerToken", rawViewerToken);
  if (rawAdminToken && !config.adminToken) warnRejectedToken("adminToken", rawAdminToken);
  // 分权失效只告警，不阻止启动：单用户部署仍可能故意复用令牌。
  warnAdminTokenSeparation(config);
  // 管理功能是独立开关：未配置就明确说禁用，但 relay 仍然启动（看/发消息不依赖 adminToken）。
  if (!config.adminToken) {
    console.error(`[relay] 未配置 adminToken（PI_REMOTE_ADMIN_TOKEN 或 config.json 的 adminToken），管理员功能已禁用：生成配对码、撤销设备不可用。`);
  }
  if (process.env.PI_REMOTE_LOCAL_HOST) config.localHost = String(process.env.PI_REMOTE_LOCAL_HOST).trim();
  if (process.env.PI_REMOTE_VIEWER_HOST) config.viewerHost = String(process.env.PI_REMOTE_VIEWER_HOST).trim();
  if (process.env.PI_REMOTE_DATA_DIR) config.dataDir = process.env.PI_REMOTE_DATA_DIR;
  config.dataDir = path.isAbsolute(config.dataDir || "") ? config.dataDir : path.join(ROOT, config.dataDir || "data/rooms");
  if (process.env.PI_REMOTE_ACCOUNTS_DIR) config.accountsDir = process.env.PI_REMOTE_ACCOUNTS_DIR;
  config.accountsDir = path.isAbsolute(config.accountsDir || "") ? config.accountsDir : path.join(ROOT, config.accountsDir || "data/accounts");
  if (process.env.PI_REMOTE_SERVER_NAME != null) config.serverName = process.env.PI_REMOTE_SERVER_NAME;
  config.serverName = cleanServerName(config.serverName);
  if (process.env.PI_REMOTE_RELAY_ACCOUNT) config.accountId = process.env.PI_REMOTE_RELAY_ACCOUNT;
  config.accountId = normalizeAccount(config.accountId);
  const persistEnv = process.env.PI_REMOTE_PERSIST_TRANSCRIPTS;
  if (persistEnv != null && persistEnv !== "") config.persistTranscripts = persistEnv === "1" || /^true$/i.test(persistEnv);
  else config.persistTranscripts = !!config.persistTranscripts;
  const legacyEnv = process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL;
  if (legacyEnv != null && legacyEnv !== "") config.allowLegacyLocal = !(legacyEnv === "0" || /^false$/i.test(legacyEnv));
  else config.allowLegacyLocal = config.allowLegacyLocal !== false;
  // 页面外通知：URL 走 env 覆盖范式；偏好矩阵只认三类事件键的布尔 true，其余一律关。
  // env 只要存在就以 env 为准（C-5）：显式设成空字符串 = 临时停发，直接覆盖掉文件里
  // 已配的 URL，不必改 config.json；env 完全不设才回落文件值。
  if (process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL != null) config.notifyWebhookUrl = String(process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL).trim();
  else config.notifyWebhookUrl = typeof config.notifyWebhookUrl === "string" ? config.notifyWebhookUrl.trim() : "";
  config.notifyEvents = sanitizeNotifyEvents(config.notifyEvents);
  // Only the three documented values survive; anything else warns and falls
  // back to "allow" (same sanitize pattern as the rest of this loader).
  if (config.cryptoPlaintextRooms !== "allow" && config.cryptoPlaintextRooms !== "readonly" && config.cryptoPlaintextRooms !== "deny") {
    console.warn(`[config] cryptoPlaintextRooms 值无效（${JSON.stringify(config.cryptoPlaintextRooms)}）：按默认 "allow" 处理`);
    config.cryptoPlaintextRooms = "allow";
  }
  return config;
}

/** 占位符 change-me 和短于 MIN_TOKEN_LENGTH 的令牌视为未配置：避免公开常量登录，也避免可在线爆破的弱口令。 */
function usableToken(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === "change-me") return "";
  if (text.length < MIN_TOKEN_LENGTH) return "";
  return text;
}

/** 启动日志：说明哪个令牌被拒以及原因；绝不带出令牌本身，也不打印长度以外的片段。 */
function warnRejectedToken(fieldName, rawValue) {
  const text = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!text) return;
  const env = {
    localToken: "PI_REMOTE_LOCAL_TOKEN",
    viewerToken: "PI_REMOTE_VIEWER_TOKEN",
    adminToken: "PI_REMOTE_ADMIN_TOKEN",
  }[fieldName] || "PI_REMOTE_ADMIN_TOKEN";
  if (text === "change-me") {
    console.error(`[relay] ${fieldName} 还是示例占位符 change-me，已拒绝。请用 ${env} 或 config.json 设置至少 ${MIN_TOKEN_LENGTH} 字符的随机令牌（日志不会打印令牌内容）。`);
    return;
  }
  console.error(`[relay] ${fieldName} 长度不足 ${MIN_TOKEN_LENGTH} 字符，已拒绝。请用 ${env} 或 config.json 设置更长的随机令牌（日志不会打印令牌内容）。`);
}

/** 运行时配置里的正整数：数字或纯数字字符串；非法/非正数/小数回落到默认值（viewer 认证防护复用）。 */
function positiveInt(value, fallback) {
  let parsed;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) parsed = Number(value);
  else return fallback;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function clampPort(value, fallback) {
  let port = NaN;
  if (typeof value === "number") port = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) port = Number(value.trim());
  return Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

/** 服务端账号名：空/非字符串回落 admin */
function normalizeAccount(value) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ACCOUNT;
}

module.exports = {
  ROOT,
  LOG_DIR,
  MIN_TOKEN_LENGTH,
  DEFAULT_CONFIG,
  NUMERIC_CONFIG_FIELDS,
  STRING_CONFIG_FIELDS,
  BOOLEAN_CONFIG_FIELDS,
  loadConfig,
  usableToken,
  positiveInt,
  sanitizeNumericConfig,
  sanitizeTypedConfig,
  warnAdminTokenSeparation,
  normalizeAccount,
};
