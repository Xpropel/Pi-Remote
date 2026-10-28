/**
 * `usage.activity.v1` 快照校验（纯函数，node --test 可直接加载）。
 *
 * 使用方：relay 收到 extension 的 usage_snapshot 先校验再缓存/转发；extension 发送前也用它自检；
 * UI 收到 relay 帧后可再校验一次（防旧 relay/坏数据）。规则除了形状，还**强制隐私红线**：
 * 快照任意层级出现 cost / 消息正文 / 标题 / cwd / 文件路径等敏感键 → 直接判非法（不缓存、不转发）。
 */
import {
  USAGE_ACTIVITY_VERSION,
  USAGE_DAYS_MAX,
  USAGE_MODELS_MAX,
  USAGE_SNAPSHOT_MAX_BYTES,
  type UsageDay,
  type UsagePeak,
  type UsageSnapshotV1,
  type UsageTimezone,
} from "./types.ts"
import { isValidDayKey } from "./format.ts"

export type UsageValidationResult =
  | {
      ok: true
      snapshot: UsageSnapshotV1
      /** 日级隔离降级：被丢弃的坏天数（0 = 数据完整）。 */
      droppedDays: number
      /** 丢弃原因摘要（最多 20 条，仅用于诊断/提示，不含会话内容）。 */
      warnings: string[]
    }
  | { ok: false; errors: string[] }

/** 时区偏移上限（UTC±14:00，分钟）。与扩展 -getTimezoneOffset() 口径一致，**有符号**。 */
export const USAGE_TZ_OFFSET_MAX = 840
const FORBIDDEN_KEYS = new Set(["cost", "content", "cwd", "title", "text", "path", "body", "prompt", "messagesText"])
export const USAGE_SENSITIVE_KEY_POLICY = [...FORBIDDEN_KEYS]
/** 一次最多列出的日级告警条数（坏 400 天时别把错误列表撑爆）。 */
export const USAGE_DROPPED_WARNINGS_MAX = 20

/** `YYYY-MM-DD` 且日历真实存在（2 月 31 日/非闰年 2 月 29 日均非法，不再被 Date.parse 归一化）。 */
export function isUsageDateKey(value: unknown): value is string {
  return isValidDayKey(value)
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
const isNonNegativeInt = (v: unknown): v is number => isInt(v) && v >= 0
/** UTC 偏移（分钟）：西半球为负（纽约 -300），东半球为正（上海 +480）。 */
const isSignedOffsetMinutes = (v: unknown): v is number => isInt(v) && v >= -USAGE_TZ_OFFSET_MAX && v <= USAGE_TZ_OFFSET_MAX

/** 深度扫敏感键（有就拒绝：聚合数据不允许夹带正文/路径/金额） */
function sensitiveKeyPath(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = sensitiveKeyPath(value[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k)) return `${path}.${k}`
    const hit = sensitiveKeyPath(v, `${path}.${k}`)
    if (hit) return hit
  }
  return null
}

/** 单日校验：错误收集是**局部**的——坏天只丢自己，不连累其他天（中-3 日级隔离降级）。 */
function validateDay(raw: unknown, i: number): { day: UsageDay | null; errors: string[] } {
  const where = `days[${i}]`
  const errors: string[] = []
  if (!isRecord(raw)) {
    errors.push(`${where} 必须是对象`)
    return { day: null, errors }
  }
  if (!isUsageDateKey(raw.date)) errors.push(`${where}.date 必须是 YYYY-MM-DD 合法日期`)
  const tokens = raw.tokens
  if (!isRecord(tokens)) errors.push(`${where}.tokens 必须是对象`)
  else {
    for (const k of ["total", "input", "output", "cacheRead", "cacheWrite"]) if (!isNonNegativeInt(tokens[k])) errors.push(`${where}.tokens.${k} 必须是非负整数`)
  }
  const messages = raw.messages
  if (!isRecord(messages)) errors.push(`${where}.messages 必须是对象`)
  else for (const k of ["user", "assistant"]) if (!isNonNegativeInt(messages[k])) errors.push(`${where}.messages.${k} 必须是非负整数`)
  if (!isNonNegativeInt(raw.sessions)) errors.push(`${where}.sessions 必须是非负整数`)
  return { day: errors.length ? null : (raw as unknown as UsageDay), errors }
}

function validatePeak(raw: unknown, name: string, errors: string[]): UsagePeak | null {
  if (raw == null) return null
  if (!isRecord(raw) || !isUsageDateKey(raw.date) || !isNonNegativeInt(raw.value)) {
    errors.push(`summary.peaks.${name} 必须是 { date, value } 或 null`)
    return null
  }
  return raw as unknown as UsagePeak
}

/** 校验 + 强制隐私/大小约束；ok=false 时 errors 列出全部原因（relay 记日志后丢弃）。
 *
 * 降级口径（中-3「校验全有全无」）：
 *  - **敏感键**（正文/路径/金额…）与**结构错误**（顶层字段、summary/coverage/cache、days 非数组、
 *    超 400 天、排序/重复）→ 整份拒收；
 *  - **单日脏数据**（某天某个计数字段坏了/日期非法）→ 只丢坏的那一天，其余照常放行，
 *    返回值带 `droppedDays` 与告警摘要；range 按存活天数重建，避免 400 天里一字段脏了整页空白。 */
export function validateUsageSnapshot(raw: unknown): UsageValidationResult {
  const errors: string[] = []
  if (!isRecord(raw)) return { ok: false, errors: ["快照必须是对象"] }
  const hit = sensitiveKeyPath(raw)
  if (hit) return { ok: false, errors: [`快照包含敏感/禁用字段：${hit}（只允许聚合计数，不得含正文/标题/cwd/金额）`] }
  if (raw.v !== USAGE_ACTIVITY_VERSION) errors.push(`v 必须是 ${USAGE_ACTIVITY_VERSION}`)
  if (!isInt(raw.generatedAt) || raw.generatedAt <= 0) errors.push("generatedAt 必须是正整数（ms）")
  if (raw.deviceId != null && typeof raw.deviceId !== "string") errors.push("deviceId 必须是字符串")
  const tz = raw.timezone
  if (!isRecord(tz) || typeof tz.id !== "string" || !tz.id || !isSignedOffsetMinutes(tz.offsetMinutes)) {
    errors.push("timezone 必须是 { id: string, offsetMinutes: int（UTC±14h，可为负） }")
  }
  const range = raw.range
  if (!isRecord(range)) errors.push("range 必须是对象")
  else {
    for (const k of ["firstDay", "lastDay"]) if (range[k] != null && !isUsageDateKey(range[k])) errors.push(`range.${k} 必须是 null 或 YYYY-MM-DD`)
    if (!isNonNegativeInt(range.days)) errors.push("range.days 必须是非负整数")
  }
  const daysRaw = raw.days
  const days: UsageDay[] = []
  const warnings: string[] = []
  let droppedDays = 0
  if (!Array.isArray(daysRaw)) errors.push("days 必须是数组")
  else {
    if (daysRaw.length > USAGE_DAYS_MAX) errors.push(`days 不能超过 ${USAGE_DAYS_MAX} 天`)
    for (let i = 0; i < daysRaw.length; i++) {
      const { day, errors: dayErrors } = validateDay(daysRaw[i], i)
      if (day) {
        days.push(day)
        continue
      }
      droppedDays += 1
      if (warnings.length < USAGE_DROPPED_WARNINGS_MAX) warnings.push(`丢弃 ${dayErrors[0] ?? `days[${i}]`}（该天数据不完整）`)
    }
    if (droppedDays > warnings.length) warnings.push(`另有 ${droppedDays - warnings.length} 天数据不完整已丢弃`)
    // 排序/重复是结构约束（重排后无法判断哪一条该丢）：整份拒收，与旧口径一致。
    for (let i = 1; i < days.length; i++) {
      if (days[i - 1].date >= days[i].date) {
        errors.push("days 必须按 date 严格升序且无重复")
        break
      }
    }
    if (isRecord(range) && isInt(range.days)) {
      // 有坏天被丢弃时 range 由本函数按存活天数重建；没有丢弃才按契约做全量一致性校验。
      if (droppedDays === 0) {
        if (range.days !== days.length) errors.push("range.days 与 days.length 不一致")
        const first = days.length ? days[0].date : null
        const last = days.length ? days[days.length - 1].date : null
        if (range.firstDay !== first) errors.push("range.firstDay 与 days 首日不一致")
        if (range.lastDay !== last) errors.push("range.lastDay 与 days 末日不一致")
      }
    }
  }
  const summary = raw.summary
  if (!isRecord(summary)) errors.push("summary 必须是对象")
  else {
    const totals = summary.totals
    if (!isRecord(totals)) errors.push("summary.totals 必须是对象")
    else for (const k of ["tokens", "messagesUser", "messagesAssistant", "sessions", "activeDays"]) if (!isNonNegativeInt(totals[k])) errors.push(`summary.totals.${k} 必须是非负整数`)
    const streaks = summary.streaks
    if (!isRecord(streaks) || !isNonNegativeInt(streaks.current) || !isNonNegativeInt(streaks.longest)) errors.push("summary.streaks 必须是 { current, longest } 非负整数")
    const peaks = summary.peaks
    if (!isRecord(peaks)) errors.push("summary.peaks 必须是对象")
    else {
      validatePeak(peaks.tokens, "tokens", errors)
      validatePeak(peaks.messages, "messages", errors)
    }
    const models = summary.models
    if (!Array.isArray(models)) errors.push("summary.models 必须是数组")
    else {
      if (models.length > USAGE_MODELS_MAX) errors.push(`summary.models 不能超过 ${USAGE_MODELS_MAX} 行`)
      for (let i = 0; i < models.length; i++) {
        const m = models[i]
        if (!isRecord(m) || typeof m.provider !== "string" || typeof m.model !== "string" || !isNonNegativeInt(m.tokens)) {
          errors.push(`summary.models[${i}] 必须是 { provider, model, tokens }`)
        }
      }
    }
    if (summary.modelsWindowDays !== 30) errors.push("summary.modelsWindowDays 必须是 30")
  }
  const coverage = raw.coverage
  if (!isRecord(coverage)) errors.push("coverage 必须是对象")
  else {
    for (const k of ["files", "parsedFiles", "cacheHitFiles", "skippedFiles", "errors", "scanMs"]) if (!isNonNegativeInt(coverage[k])) errors.push(`coverage.${k} 必须是非负整数`)
    if (typeof coverage.truncated !== "boolean") errors.push("coverage.truncated 必须是布尔")
    if (coverage.source !== "pi-sessions") errors.push('coverage.source 必须是 "pi-sessions"')
  }
  const cache = raw.cache
  if (!isRecord(cache)) errors.push("cache 必须是对象")
  else {
    if (typeof cache.hit !== "boolean") errors.push("cache.hit 必须是布尔")
    if (cache.generatedFrom !== "incremental" && cache.generatedFrom !== "full") errors.push('cache.generatedFrom 必须是 "incremental" | "full"')
  }
  if (errors.length) return { ok: false, errors }
  // 日级隔离降级：坏天已剔除，range 按存活天数重建（summary 仍是设备上报口径，不在这里重算）。
  const snapshot = droppedDays
    ? ({
        ...raw,
        days,
        range: { firstDay: days[0]?.date ?? null, lastDay: days[days.length - 1]?.date ?? null, days: days.length },
      } as unknown as UsageSnapshotV1)
    : (raw as unknown as UsageSnapshotV1)
  const size = new TextEncoder().encode(JSON.stringify(snapshot)).length
  if (size > USAGE_SNAPSHOT_MAX_BYTES) return { ok: false, errors: [`快照 ${size}B 超过上限 ${USAGE_SNAPSHOT_MAX_BYTES}B`] }
  return { ok: true, snapshot, droppedDays, warnings }
}

/** 空快照（relay 无数据/离线/旧端降级用；UI 空态直接渲染，不报错） */
export function piUsageEmptySnapshot(options: { deviceId?: string; timezone?: UsageTimezone; generatedAt?: number } = {}): UsageSnapshotV1 {
  const tz = options.timezone ?? { id: "local", offsetMinutes: -new Date().getTimezoneOffset() }
  return {
    v: USAGE_ACTIVITY_VERSION,
    generatedAt: options.generatedAt ?? Date.now(),
    ...(options.deviceId ? { deviceId: options.deviceId } : null),
    timezone: tz,
    range: { firstDay: null, lastDay: null, days: 0 },
    days: [],
    summary: {
      totals: { tokens: 0, messagesUser: 0, messagesAssistant: 0, sessions: 0, activeDays: 0 },
      streaks: { current: 0, longest: 0 },
      peaks: { tokens: null, messages: null },
      models: [],
      modelsWindowDays: 30,
    },
    coverage: { files: 0, parsedFiles: 0, cacheHitFiles: 0, skippedFiles: 0, truncated: false, errors: 0, scanMs: 0, source: "pi-sessions" },
    cache: { hit: false, generatedFrom: "full" },
  }
}
