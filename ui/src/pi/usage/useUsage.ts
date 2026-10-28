/**
 * 「使用活动」真实数据 hook（P10）：`useUsageActivity(relay, { deviceId })`。
 *
 * 数据链路：本 hook 只调 `relay.getUsage(deviceId, { force })`（useRelay 里新增，发 `usage_get` 等 `usage_snapshot`）；
 * relay 负责取设备 extension 聚合快照并缓存。UI 不在本 hook 里造任何假数据：
 * - 无 relay / 旧 relay（握手 caps 无 usage.activity.v1）→ `reason: "unsupported"` 诚实空态；
 * - 设备离线 / 无数据 / 超时 → 对应 reason 空态（`snapshot: null`，不返回 0 假数据）；
 * - 快照回来仍用共享 `validateUsageSnapshot` 再校验一次（防旧 relay/坏数据），失败给 error；
 * - 回帧带 deviceId 时核对请求设备（防 relay 串设备）；旧 relay 漏字段按 requestId 兼容；
 * - 未认证不放任无限 loading：等待上限（协议 8s + 1s 宽限）到点收口成可重试 timeout；
 * - `stale: true` 表示 relay 回的是缓存（设备离线/超时），UI 可标「数据可能不是最新」。
 *
 * 用法（claude/codex 设置页）：
 * ```tsx
 * const usage = useUsageActivity(relay, { deviceId: relay.selectedDevice?.id })
 * // usage.snapshot（null = 空态）、usage.loading、usage.stale、usage.reason、usage.error、usage.refresh()
 * ```
 * 本文件归属 arch：UI 页面（UsageActivityPage/usage.css）由 claude 线实现，只消费本 hook 的返回形状。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { validateUsageSnapshot } from "./validate.ts"
import { USAGE_VIEWER_TIMEOUT_MS } from "./types.ts"
import type { UsageSnapshotFrame, UsageSnapshotV1, UsageUnavailableReason } from "./types.ts"

/**
 * 空态/失败原因：`invalid` 是 UI 侧专有原因——快照到了但没通过校验（本 hook 没有把它伪装成
 * 「还没有活动」）。relay 帧里的 reason 仍只有 UsageUnavailableReason 那几种。
 */
export type UsageActivityFailureReason = UsageUnavailableReason | "invalid"

/** useRelay 返回值里本 hook 需要的最小面（结构类型，避免依赖整个 Relay 巨型类型） */
export interface UsageActivityRelayLike {
  /** useRelay 新增：向 relay 请求设备快照；无实现 = 独立画廊/旧 runner */
  getUsage?: (deviceId: string, opts?: { force?: boolean }) => Promise<unknown>
  /** relay 握手信息（caps 用于旧 relay 判定） */
  server?: { caps?: readonly string[] } | null
  /** socket 已认证；false 时先等待，避免无意义请求 */
  authed?: boolean
}

export interface UseUsageActivityOptions {
  /** 当前设备 id（设置页一般取 relay.selectedDevice?.id）；null/空 = 无设备空态 */
  deviceId: string | null | undefined
  /** false 时完全不请求（如页面未展开/隐藏） */
  enabled?: boolean
}

export interface UseUsageActivityState {
  /** 真实快照；null = 空态（无数据/离线/旧端/超时/校验失败），绝不返回假数据 */
  snapshot: UsageSnapshotV1 | null
  loading: boolean
  /** relay 回缓存（设备离线/超时）时 true */
  stale: boolean
  /** 空态原因（UI 文案映射：no_data/device_offline/unsupported/timeout/stale/invalid） */
  reason: UsageActivityFailureReason | null
  /** 传输/校验错误（空态之外的可诊断信息；UI 摘要展示，不展示原始堆栈） */
  error: string | null
  /** 快照成功时间（relay receivedAt 或 snapshot.generatedAt） */
  updatedAt: number | null
  /** 重新拉取（force=true，跳过 relay 缓存） */
  refresh: () => void
}

const USAGE_ACTIVITY_CAP = "usage.activity.v1"
/** 错误摘要最长展示字符：技术细节不进 UI，只留一条能对症的短句。 */
const USAGE_ERROR_SUMMARY_MAX = 160

function frameOf(raw: unknown): UsageSnapshotFrame | null {
  if (!raw || typeof raw !== "object") return null
  const frame = raw as UsageSnapshotFrame
  if (frame.type !== "usage_snapshot" || typeof frame.available !== "boolean") return null
  return frame
}

/**
 * 回帧设备核对（UI·usage 低危 22）：契约要求 `deviceId` 为必填，但历史 relay 回给 viewer 的帧漏带该字段，
 * 不能因此把正常数据全判坏——**缺省/空白按旧端兼容放行**（只能靠 requestId 对号），
 * **带了就必须与请求设备一致**，否则说明 relay 串了设备，必须拒绝展示而不是把别的设备数字顶上来。
 */
export function usageFrameDeviceMatches(frame: Pick<UsageSnapshotFrame, "deviceId"> | null | undefined, target: string): boolean {
  const want = typeof target === "string" ? target.trim() : ""
  if (!want) return false
  const got = typeof frame?.deviceId === "string" ? frame.deviceId.trim() : ""
  return got === "" || got === want
}

/** 校验错误/日级丢弃告警 → 一条可展示摘要（不含会话正文，最多 160 字）。 */
function usageErrorSummaryOf(errors: readonly string[], droppedDays = 0): string {
  const head = errors.filter((item) => typeof item === "string" && item.trim()).slice(0, 2).join("；")
  const text = droppedDays > 0 ? `已跳过 ${droppedDays} 天异常数据：${head || "字段不完整"}` : `数据校验未通过：${head || "未知原因"}`
  return text.length > USAGE_ERROR_SUMMARY_MAX ? `${text.slice(0, USAGE_ERROR_SUMMARY_MAX - 1)}…` : text
}

export function useUsageActivity(relay: UsageActivityRelayLike | null | undefined, options: UseUsageActivityOptions): UseUsageActivityState {
  const { deviceId, enabled = true } = options
  const [snapshot, setSnapshot] = useState<UsageSnapshotV1 | null>(null)
  const [loading, setLoading] = useState(false)
  const [stale, setStale] = useState(false)
  const [reason, setReason] = useState<UsageActivityFailureReason | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const forceRef = useRef(false)
  const requestGenRef = useRef(0)

  const refresh = useCallback(() => {
    forceRef.current = true
    setTick((n) => n + 1)
  }, [])

  // 结构类型依赖：getUsage 是 useCallback([]) 稳定引用；caps 用布尔指纹，避免 relay 对象每帧变化导致重复请求
  const getUsage = relay && typeof relay.getUsage === "function" ? relay.getUsage : null
  const caps = relay?.server?.caps
  const capsKnown = Array.isArray(caps) && caps.length > 0
  const capsHasUsage = capsKnown ? (caps as readonly string[]).includes(USAGE_ACTIVITY_CAP) : null
  const authed = relay?.authed

  useEffect(() => {
    const target = typeof deviceId === "string" ? deviceId.trim() : ""
    const gen = ++requestGenRef.current
    const force = forceRef.current
    forceRef.current = false
    if (!enabled || !target) {
      setSnapshot(null)
      setLoading(false)
      setStale(false)
      setReason("no_data")
      setError(null)
      return
    }
    if (!getUsage) {
      // 没有 relay 实现（独立画廊/旧 runner）：诚实空态，不造假数据
      setSnapshot(null)
      setLoading(false)
      setStale(false)
      setReason("unsupported")
      setError(null)
      return
    }
    if (authed === false) {
      // 还没认证：保持空态但不算错误（等 authed 变化会重跑）。低危 27：不能永远转圈——
      // 到点收口成可重试的 timeout；认证恢复后 effect 重跑，页面自动回到真实数据。
      setLoading(true)
      setReason(null)
      setError(null)
      const authTimer = setTimeout(() => {
        if (gen !== requestGenRef.current) return
        setLoading(false)
        setReason("timeout")
        setError("等待 relay 认证超时；连接/登录恢复后会自动重试。")
      }, USAGE_VIEWER_TIMEOUT_MS)
      return () => clearTimeout(authTimer)
    }
    if (capsHasUsage === false) {
      // 旧 relay：握手 caps 明确没有 usage.activity.v1 → 空态 + 诚实原因
      setSnapshot(null)
      setLoading(false)
      setStale(false)
      setReason("unsupported")
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    let cancelled = false
    let settled = false
    let loadTimer: ReturnType<typeof setTimeout> | null = null
    const clearLoadTimer = () => {
      if (loadTimer !== null) {
        clearTimeout(loadTimer)
        loadTimer = null
      }
    }
    // 低危 24：viewer 兜底超时由协议 8s 派生（9s），不再默默等 useRelay 里硬编码的 12s。
    // 先让 relay 在 8s 截止时回 timeout/stale，多 1s 给该帧到达。
    loadTimer = setTimeout(() => {
      if (cancelled || settled || gen !== requestGenRef.current) return
      settled = true
      setSnapshot(null)
      setLoading(false)
      setStale(false)
      setReason("timeout")
      setError(`读取超时（${Math.round(USAGE_VIEWER_TIMEOUT_MS / 1000)} 秒）`)
    }, USAGE_VIEWER_TIMEOUT_MS)
    Promise.resolve()
      .then(() => getUsage(target, { force }))
      .then((raw) => {
        if (cancelled || settled || gen !== requestGenRef.current) return
        settled = true
        clearLoadTimer()
        const frame = frameOf(raw)
        if (!frame) {
          setSnapshot(null)
          setLoading(false)
          setStale(false)
          // 响应形状都不对：不是「还没有活动」，给独立失败原因 + 可重试
          setReason("invalid")
          setError("响应格式不正确（usage_snapshot 帧不完整）")
          return
        }
        if (!usageFrameDeviceMatches(frame, target)) {
          // 低危 22：relay 回了别的设备 → 宁可空态报错，也不把另一台设备的数字当作本机展示
          setSnapshot(null)
          setLoading(false)
          setStale(false)
          setReason("invalid")
          setError("响应设备与请求设备不一致（relay 可能回错了设备）")
          return
        }
        setStale(frame.stale === true)
        if (!frame.available || !frame.snapshot) {
          setSnapshot(null)
          setLoading(false)
          setReason(frame.reason ?? "no_data")
          setUpdatedAt(typeof frame.receivedAt === "number" ? frame.receivedAt : null)
          return
        }
        const checked = validateUsageSnapshot(frame.snapshot)
        if (!checked.ok) {
          setSnapshot(null)
          setLoading(false)
          setStale(false)
          // 校验失败 ≠ 没数据：独立原因、错误摘要（含第一条原因），页面给重试入口
          setReason("invalid")
          setError(usageErrorSummaryOf(checked.errors))
          return
        }
        setSnapshot(checked.snapshot)
        setLoading(false)
        setReason(null)
        // 日级隔离降级（个别坏天被丢）不阻塞展示，但把摘要留在 error 里供诊断
        setError(checked.droppedDays > 0 ? usageErrorSummaryOf(checked.warnings, checked.droppedDays) : null)
        setUpdatedAt(typeof frame.receivedAt === "number" ? frame.receivedAt : checked.snapshot.generatedAt)
      })
      .catch((e: unknown) => {
        if (cancelled || settled || gen !== requestGenRef.current) return
        settled = true
        clearLoadTimer()
        setSnapshot(null)
        setLoading(false)
        setStale(false)
        setReason("timeout")
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      clearLoadTimer()
    }
  }, [deviceId, enabled, tick, getUsage, capsKnown, capsHasUsage, authed])

  return { snapshot, loading, stale, reason, error, updatedAt, refresh }
}
