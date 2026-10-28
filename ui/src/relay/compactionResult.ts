/** Compact 量化呈现的纯逻辑（R3-3 第 2 项）：从 compact 命令回包 / compaction_end 事件里
 *  提取 tokensBefore / estimatedTokensAfter 并拼成一行量化文案。
 *
 *  诚实口径：任一值缺失就省略对应段，绝不编造、绝不用 contextUsage 的当前值冒充压缩后值。
 */

export type CompactionNumbers = {
  tokensBefore?: number
  estimatedTokensAfter?: number
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 从任意回包/事件对象里提取量化数值；两个都缺 → null（无量化可呈）。 */
export function compactionNumbersOf(data: unknown): CompactionNumbers | null {
  if (!data || typeof data !== "object") return null
  const rec = data as Record<string, unknown>
  // compaction_end 事件把结果放在 result 里；compact 命令回包是平铺的。两处都认。
  const nested = rec.result && typeof rec.result === "object" ? (rec.result as Record<string, unknown>) : null
  const before = finiteCount(rec.tokensBefore) ?? (nested ? finiteCount(nested.tokensBefore) : undefined)
  const after = finiteCount(rec.estimatedTokensAfter) ?? (nested ? finiteCount(nested.estimatedTokensAfter) : undefined)
  if (before == null && after == null) return null
  const out: CompactionNumbers = {}
  if (before != null) out.tokensBefore = before
  if (after != null) out.estimatedTokensAfter = after
  return out
}

export function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

/** 量化文案：两值齐 → "已压缩：约 X tokens → Y tokens，省约 Z tokens（约 P%）"；
 *  只剩一段就只呈那一段；无值 → 空串（呈现层回退无量文案）。 */
export function compactionResultText(numbers: CompactionNumbers | null): string {
  if (!numbers) return ""
  const before = numbers.tokensBefore
  const after = numbers.estimatedTokensAfter
  if (before != null && after != null) {
    const saved = before - after
    if (saved > 0 && before > 0) {
      const pct = Math.round((saved / before) * 100)
      return `已压缩：约 ${formatTokenCount(before)} tokens → ${formatTokenCount(after)} tokens，省约 ${formatTokenCount(saved)} tokens（约 ${pct}%）`
    }
    return `已压缩：约 ${formatTokenCount(before)} tokens → ${formatTokenCount(after)} tokens`
  }
  if (before != null) return `已压缩：压缩前约 ${formatTokenCount(before)} tokens`
  if (after != null) return `已压缩：压缩后约 ${formatTokenCount(after)} tokens`
  return ""
}
