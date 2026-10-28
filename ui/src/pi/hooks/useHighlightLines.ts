/**
 * shiki 高亮的 React 接线（PLAN 4.4、D12）：PiCodeBlock、PiCodeView 里 kit 分词器不认的语言（python、bash、go…）用它。
 * kit 的 6 种和纯文本不走这里（highlightRouteOf 先分流），所以画廊 L1 不受影响。
 *
 * - shiki 由 highlight.ts 的 loadShiki() 动态 import()，第一次用到时才加载（产品入口 index.html 的主 chunk 里没有 shiki）。
 * - 结果和产生它的 code / lang 绑在一起：code 变了、结果还没回来时返回 null（调用方先按纯文本渲染），旧结果不会串到新代码上；
 *   effect 清理时作废未完成的那次（和 components/ui/code-block.tsx 的竞态处理一样）。
 * - 语言 shiki 不认识、加载失败：一直是 null（纯文本）。
 */
import { useEffect, useState } from "react"
import { highlightToLines, type HighlightLine } from "@/pi/model/highlight"

/** code 或 lang 为 null 时不高亮（返回 null） */
export function useHighlightLines(code: string | null, lang: string | null): HighlightLine[] | null {
  const [result, setResult] = useState<{ code: string; lang: string; lines: HighlightLine[] } | null>(null)
  useEffect(() => {
    if (code == null || lang == null) return
    let cancelled = false
    void highlightToLines(code, lang).then((lines) => {
      if (!cancelled && lines) setResult({ code, lang, lines })
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])
  return result != null && result.code === code && result.lang === lang ? result.lines : null
}
