/**
 * shiki 高亮的 React 接线（带跨挂载缓存；UI 低危 19）。
 *
 * 与 ui/src/pi/hooks/useHighlightLines.ts 的行为差别只在"结果从哪来"：
 *  - 命中缓存时**首次渲染**就返回着色行（翻页回来不再先闪纯文本）；
 *  - 未命中时仍按 code/lang 绑定结果，旧结果不会串到新代码上；
 *  - 并发挂载同一块共用一次着色（highlightCache 的 in-flight 去重）。
 *
 * 语言不认识 / 加载失败仍是 null（调用方渲染纯文本），且不写缓存，下次还能重试。
 * 单块超过缓存上限时结果只留在本次挂载的 state 里（照样显示，只是下次要重着色）。
 */
import { useEffect, useState } from "react"
import type { HighlightLine } from "@/pi/model/highlight"
import { cachedHighlight, highlightLinesFor, touchCachedHighlight } from "./highlightCache"

type Resolved = { code: string; lang: string; lines: HighlightLine[] }

export function useCachedHighlightLines(code: string | null, lang: string | null): HighlightLine[] | null {
  const [resolved, setResolved] = useState<Resolved | null>(null)
  useEffect(() => {
    if (code == null || lang == null) return
    if (cachedHighlight(code, lang) !== undefined) {
      touchCachedHighlight(code, lang)
      return
    }
    let alive = true
    void highlightLinesFor(code, lang).then((next) => {
      if (alive && next) setResolved({ code, lang, lines: next })
    })
    return () => {
      alive = false
    }
  }, [code, lang])
  if (code == null || lang == null) return null
  const hit = cachedHighlight(code, lang)
  if (hit !== undefined) return hit
  return resolved != null && resolved.code === code && resolved.lang === lang ? resolved.lines : null
}
