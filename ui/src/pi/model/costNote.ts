/**
 * 模型费用说明（G12，protocol-followups §8；replica c/model-menu 的 Gemini 行橙字、模型说明卡的费用行）。纯函数，node --test 直接加载。
 * 数据来自 get_available_models 回包里原样转发的 pi ModelCost：{ input, output, cacheRead, cacheWrite, tiers?[]{ input, …, inputTokensAbove } }。
 * 说明文字 pi 里没有，只能从数字推：倍率 = tier.input / cost.input。旧版 pi 没有 tiers，说明不出现。
 */

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
}

/** 门槛 token 数："200k" / "128k" / "1M" / "1.05M" / "800" */
function tokensLabel(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round((n / 1000) * 10) / 10}k`
  return `${Math.round((n / 1_000_000) * 100) / 100}M`
}

/**
 * cost → 「输入超过 200k 时单价翻倍」/「输入超过 128k 时单价 ×1.5」。
 * - 多档时只写第一档（门槛最低的一档）；
 * - 倍率保留两位小数，等于 2 写「翻倍」，等于 1（单价没变）不写；
 * - 没有 tiers、基础单价不是正数、档位缺门槛或单价时返回 null，不编。
 */
export function costNoteOf(cost: unknown): string | null {
  if (!cost || typeof cost !== "object") return null
  const { input, tiers } = cost as { input?: unknown; tiers?: unknown }
  const base = positive(input)
  if (base === null || !Array.isArray(tiers)) return null
  let first: { above: number; input: number } | null = null
  for (const raw of tiers) {
    if (!raw || typeof raw !== "object") continue
    const t = raw as { inputTokensAbove?: unknown; input?: unknown }
    const above = positive(t.inputTokensAbove)
    const price = positive(t.input)
    if (above === null || price === null) continue
    if (!first || above < first.above) first = { above, input: price }
  }
  if (!first) return null
  const r = Math.round((first.input / base) * 100) / 100
  if (r === 1) return null
  return `输入超过 ${tokensLabel(first.above)} 时单价${r === 2 ? "翻倍" : ` ×${r}`}`
}
