/**
 * P10「使用活动」共享数据契约（`usage.activity.v1`，唯一事实源）。
 *
 * 数据链路：pi 会话 jsonl（设备本地）→ extension 聚合 `UsageSnapshotV1` → relay 校验/缓存 →
 * viewer 经 `usage_get`/`usage_snapshot` 帧读取 → 三套设置页「使用活动」渲染。
 *
 * 红线（详见 `.agents/tasks/pi-ui-refs-2026-10-26/p10-usage-data-plan.md`）：
 * - **不读/不传/不展示金额**（pi 的 usage.cost 字段实测不可信）；
 * - 只上聚合计数：**无消息正文、无标题、无 cwd、无消息 id**；
 * - 分天按设备本地时区；`totalTokens` = API 处理量口径（每轮上下文重报），文案只能写「Token 活动/用量」；
 * - 旧端兼容：无 `usage.activity.v1` cap 的扩展/relay/UI 互不发送未知帧，降级为空态。
 *
 * 本文件纯类型/常量（无 React/无 Node）：UI、relay、extension 镜像契约与单测都引用它；
 * extension 是单文件安装（无法 import 仓库文件），其内部镜像一份并在 `test/usage-contract.test.mjs` 校验。
 */

/** 能力位（protocol/v4.json caps；extension CLIENT_CAPS 与 relay 都声明） */
export const USAGE_ACTIVITY_CAP = "usage.activity.v1" as const
/** 快照/协议版本（破坏性变更升版本；新增字段必须可选） */
export const USAGE_ACTIVITY_VERSION = "usage.activity.v1" as const

/** 快照保留天数上限（一年多的热力图；超出截断最旧并标 truncated） */
export const USAGE_DAYS_MAX = 400
/** 模型分布行数上限（UI 第 5 名起合并「其他」；聚合层仍给到 8 行） */
export const USAGE_MODELS_MAX = 8
/** 快照 JSON 字节上限（relay 校验；超出丢弃/截断） */
export const USAGE_SNAPSHOT_MAX_BYTES = 256 * 1024
/** relay 请求设备刷新的超时（超时回缓存/空态；协议 limits.usageRequestTimeoutMs = 8000） */
export const USAGE_REQUEST_TIMEOUT_MS = 8000
/**
 * viewer 侧等待上限（UI·usage 低危 24）：由协议 8s 派生并多留 1s，让 relay 自己的 timeout/stale 帧先到。
 * **禁止**在别处再写 12_000 之类的独立硬编码（useRelay 的 12s 旧值应改为引用本常量）。
 */
export const USAGE_VIEWER_TIMEOUT_MS = USAGE_REQUEST_TIMEOUT_MS + 1000
/** relay 缓存新鲜期（此窗口内 usage_get 不触发设备重扫） */
export const USAGE_CACHE_TTL_MS = 5 * 60 * 1000
/** 设备侧增量缓存版本（usage-days.json；不兼容时全量重扫） */
export const USAGE_CACHE_VERSION = 1

/** 本地时区标识（快照随附，relay 不参与时间换算） */
export interface UsageTimezone {
  /** IANA 名称（如 Asia/Shanghai）；取不到时 "local" */
  id: string
  /** 采样时刻的 UTC 偏移（分钟，**有符号**：东八区 = 480，纽约 = -300；合法范围 ±840） */
  offsetMinutes: number
}

/** Token 聚合（单位：token；全部非负整数。total = API 处理量口径，含每轮重报上下文） */
export interface UsageTokens {
  /** Σ assistant.message.usage.totalTokens（主指标） */
  total: number
  /** Σ usage.input（不含缓存；口径见 data-feasibility §五） */
  input: number
  /** Σ usage.output（reasoning 已包含在 output，不重复加） */
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 消息计数（单位：条） */
export interface UsageMessages {
  /** 只数 role=user（排除 system/toolResult/custom…） */
  user: number
  /** role=assistant（含失败轮 error/aborted） */
  assistant: number
}

/** 一天（设备本地时区自然日）的聚合值 */
export interface UsageDay {
  /** YYYY-MM-DD（本地时区） */
  date: string
  tokens: UsageTokens
  messages: UsageMessages
  /** 当日开始的会话数（一个 jsonl = 一个会话，按 header timestamp 分天） */
  sessions: number
}

/** 模型分布片（按 token 降序，最多 USAGE_MODELS_MAX；UI 第 5 名起合并「其他」） */
export interface UsageModelSlice {
  provider: string
  model: string
  /** 该模型近 30 天 token 合计 */
  tokens: number
}
/** 兼容别名（旧草稿命名） */
export type UsageModelRow = UsageModelSlice

/** 单日峰值 */
export interface UsagePeak {
  date: string
  value: number
}

/** 汇总总量：**近 30 天**（以设备本地“今天”为锚，含今天；前 30 天环比由 UI 从 days 自算，更早历史不计入）；streak/peaks 为全期派生 */
export interface UsageTotals {
  tokens: number
  messagesUser: number
  messagesAssistant: number
  sessions: number
  /** 有任意会话的天数（与设计「当天有任一会话即活跃」一致） */
  activeDays: number
}

/** 单日/峰值 */
export interface UsagePeaks {
  /** 快照窗口内单日 **totalTokens** 峰值（API 处理量口径） */
  tokens: UsagePeak | null
  /** 快照窗口内单日 **user 消息数** 峰值（只数 role=user，不叠加 assistant；设计「最活跃的一天」口径） */
  messages: UsagePeak | null
}

/** 汇总（快照 summary 字段） */
export interface UsageSummary {
  /**
   * **近 30 天总量**（设备本地「今天」为锚，含今天）：与设计汇总卡口径一致；
   * 前 30 天环比由 UI 从 `days` 自算（本快照不预计算上一窗口），更早历史**不计入** totals。
   * 窗口与 `modelsWindowDays = 30` 相同；streak/peaks 见各字段注释（全期/快照窗口）。
   */
  totals: UsageTotals
  /** 以最后一天为基准；current 含今天（若无今天数据则 0） */
  streaks: { current: number; longest: number }
  peaks: UsagePeaks
  /** 近 30 天模型分布（按 token 降序，≤ USAGE_MODELS_MAX） */
  models: UsageModelSlice[]
  modelsWindowDays: 30
}

/** 快照覆盖信息（诊断/空态用；不做展示主数据） */
export interface UsageCoverage {
  files: number
  parsedFiles: number
  cacheHitFiles: number
  skippedFiles: number
  truncated: boolean
  errors: number
  scanMs: number
  source: "pi-sessions"
}

/** 快照生成来源（relay/UI 诊断用） */
export interface UsageSnapshotCacheInfo {
  hit: boolean
  generatedFrom: "incremental" | "full"
}

/** `usage.activity.v1` 快照（extension → relay → viewer） */
export interface UsageSnapshotV1 {
  v: typeof USAGE_ACTIVITY_VERSION
  /** 生成时刻（ms） */
  generatedAt: number
  deviceId?: string
  timezone: UsageTimezone
  range: {
    /** 现存最早会话日；无数据 = null */
    firstDay: string | null
    lastDay: string | null
    /** days.length */
    days: number
  }
  /** 升序、无重复、≤ USAGE_DAYS_MAX */
  days: UsageDay[]
  summary: UsageSummary
  coverage: UsageCoverage
  cache: UsageSnapshotCacheInfo
}

/* ------------------------------------------------------------------------------------------------
 * 帧契约（viewer ↔ relay ↔ extension）
 * ---------------------------------------------------------------------------------------------- */

/** viewer → relay：请求某设备的使用活动（requestId 由 viewer 生成，回帧原样带回） */
export interface UsageGetFrame {
  type: "usage_get"
  /** viewer 只能取本账号设备（未知/越权 → 空态） */
  deviceId: string
  requestId: string
  /** true = 跳过 relay 缓存，要求设备重扫（设置页下拉刷新） */
  force?: boolean
}

/** relay → extension：请求增量重扫（extension 以 usage_snapshot 回） */
export interface UsageRefreshFrame {
  type: "usage_refresh"
  deviceId: string
  requestId: string
}

/** 空态原因（UI 文案映射；不报错） */
export type UsageUnavailableReason = "no_data" | "device_offline" | "unsupported" | "timeout" | "stale"

/** relay → viewer / extension → relay：快照或空态 */
export interface UsageSnapshotFrame {
  type: "usage_snapshot"
  /** 快照所属设备：新 relay 必须回显请求的 deviceId；旧 relay 漏发时 UI 只能按 requestId 对号（兼容放行） */
  deviceId: string
  /** 回 viewer 时带回请求 id；extension → relay 时也可带 */
  requestId?: string
  /** false = 空态（无数据/离线/旧端/超时），snapshot 为空 */
  available: boolean
  reason?: UsageUnavailableReason
  snapshot?: UsageSnapshotV1
  /** relay 回缓存时的收帧时刻（ms） */
  receivedAt?: number
  /** true = 缓存过期/设备离线但仍可用（UI 可标「数据可能不是最新」） */
  stale?: boolean
}

/** relay 侧缓存文件结构（data/accounts/<acct>/usage/<device>.json） */
export interface UsageRelayCacheFile {
  v: typeof USAGE_CACHE_VERSION
  accountId: string
  deviceId: string
  receivedAt: number
  snapshot: UsageSnapshotV1
}
