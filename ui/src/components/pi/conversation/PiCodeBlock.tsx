import { Fragment, useEffect, useRef, useState } from "react"
import { GhostIconButton, SyntaxHighlight } from "@/components/kit"
import { Check, Copy } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { usePiStatic } from "@/components/pi/shared/layers"
import { highlightLabelOf, highlightRouteOf, type HighlightLine } from "@/pi/model/highlight"
import { useCachedHighlightLines } from "./useCachedHighlightLines"
import { piCopyText, PI_COPIED_MS } from "./clipboard"
import { CARD, CARD_DIVIDER, CARD_GAP, CARD_HEAD, CARD_HEAD_H, CARD_PEEK, PiCardFoot, PiCardPeekFade } from "./PiCard"
import { T_SECONDARY } from "./styles"

export interface PiCodeBlockProps {
  code: string
  /**
   * 围栏语言（PLAN 4.4、D12）：kit 分词器认的 6 种（ts / tsx / js / jsx / json / html 及别名）照旧走 kit；
   * 其余（python、bash、go…）走 shiki，按需加载，回来之前和不认识的语言按纯文本；"plain" / 空 = 不高亮。
   */
  lang?: string
  /** 超过这么多行时收起：底部渐隐 + 居中 chevron（D07，默认 12） */
  foldAfter?: number
  /** 静态复现"已复制"（✓ 1.2 秒） */
  copied?: boolean
  /** P4：静态态（画廊截图）。不传时取 PiStaticProvider；静态态下复制钮不加 44 点击区外扩（见 COPY_HIT_44） */
  static?: boolean
  /**
   * 流式中、围栏还没闭合：不走 shiki（异步着色每来一批字都要重来，结果回来前是纯文本，会在纯文本和着色之间闪），
   * 闭合后再着色；kit 认得的语言照常同步高亮，卡头的语言名照写
   */
  streaming?: boolean
  className?: string
}

const PLAIN_CODE =
  "block font-(family-name:--cw-font-mono) text-(length:--cw-text-code-block) leading-(--cw-leading-code) whitespace-pre text-[color:var(--cw-pi-stream-fg,var(--cw-text))]"

/**
 * 复制钮视觉 20×20，点击区 44×44（§4.4）：看不见的 ::after 从钮的右上角往左下铺 44×44（不居中外扩：卡是 overflow-hidden，居中会被裁掉 6px）。
 * 只在可交互态加：钮多出这块溢出后，Chrome 栅格化钮里的图标会差 1 级（实测 session-archived 1440 有 6 个像素 Δ=1），
 * 静态态（画廊）要和冻结版逐像素一样，而且截图本来就点不了。
 */
const COPY_HIT_44 = "after:absolute after:top-0 after:right-0 after:size-11 after:content-['']"

/** 代码的横滚区（O-R3）：复制钮在卡头里，代码区左右各留 12，第一行的长注释、横滚时的每一行都不会钻到钮下面 */
const CODE_SCROLL = "overflow-x-auto py-2 px-3 [scrollbar-width:thin]"

/** shiki 的一行记号：颜色是 `var(--cw-syntax-*)`（深浅主题跟着 CSS 变量变），没有颜色的继承容器字色 */
export function PiHighlightTokens({ line }: { line: HighlightLine }) {
  return (
    <>
      {line.map((t, i) =>
        t.color == null && !t.italic ? (
          <Fragment key={i}>{t.text}</Fragment>
        ) : (
          <span key={i} style={{ color: t.color, fontStyle: t.italic ? "italic" : undefined }}>
            {t.text}
          </span>
        ),
      )}
    </>
  )
}

/**
 * 回复里的围栏代码块（D07；compose from kit: SyntaxHighlight, GhostIconButton）。
 * 卡的几何同 diff 卡、终端卡（PiCard）：卡头 = 语言名 + 复制钮；超过 12 行收起，展开箭头在卡底单独一条（推断）。
 * 代码不折行，横向滚动（手机也一样，保持原样排版）。
 */
export function PiCodeBlock({ code, lang = "plain", foldAfter = 12, copied: copiedProp, static: staticProp, streaming, className }: PiCodeBlockProps) {
  const isStatic = usePiStatic(staticProp)
  const lines = code.replace(/\n$/, "").split("\n")
  const foldable = lines.length > foldAfter
  const [open, setOpen] = useState(false)
  const clipped = foldable && !open
  const route = highlightRouteOf(lang)
  const text = lines.join("\n")
  const viaShiki = route.via === "shiki" && !streaming
  const shiki = useCachedHighlightLines(viaShiki ? text : null, viaShiki ? route.lang : null)
  // 可交互态：复制钮真的写剪贴板（P5.4，P4 交接），成功后 ✓ 停 1.2 秒；静态态只看 copied prop
  const [copiedNow, setCopiedNow] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copied = copiedProp || copiedNow
  const copy = isStatic
    ? undefined
    : () => {
        void piCopyText(text).then((ok) => {
          if (!ok) return
          setCopiedNow(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopiedNow(false), PI_COPIED_MS)
        })
      }
  // 卡头的语言名：认得的写显示名（TypeScript、Shell…），认不得的照写围栏原文；没写语言的写"纯文本"（同文件视图），卡头不空着
  const label = highlightLabelOf(lang) ?? lang
  return (
    <div data-pi-part="code-block" data-lang={route.via === "plain" ? undefined : route.lang} className={cn("group/code", CARD, CARD_GAP, className)}>
      <div data-pi-part="code-head" className={cn(CARD_HEAD, CARD_DIVIDER, CARD_HEAD_H, "pl-3 in-data-[pi-layout=phone]:h-9")}>
        <span className={cn("min-w-0 flex-1 truncate text-(length:--cw-text-sm)", T_SECONDARY)}>{label}</span>
        <GhostIconButton
          size="sm"
          label={copied ? "已复制" : "复制代码"}
          icon={copied ? <Check /> : <Copy />}
          onClick={copy}
          className={cn("-mr-0.5", !isStatic && COPY_HIT_44, copied && "text-(--cw-blue)")}
        />
      </div>
      <div className="relative">
        <div
          className={CODE_SCROLL}
          style={clipped ? { maxHeight: `calc(8px + ${foldAfter} * var(--cw-leading-code) + ${CARD_PEEK}px)`, overflowY: "hidden" } : undefined}
        >
          {route.via === "kit" ? (
            <SyntaxHighlight block code={text} lang={route.lang} />
          ) : shiki ? (
            <code data-highlight="shiki" className={PLAIN_CODE}>
              {shiki.map((line, i) => (
                <Fragment key={i}>
                  {i > 0 && "\n"}
                  <PiHighlightTokens line={line} />
                </Fragment>
              ))}
            </code>
          ) : (
            <code className={PLAIN_CODE}>{text}</code>
          )}
        </div>
        {clipped && <PiCardPeekFade />}
      </div>
      {foldable && (
        <PiCardFoot open={open} onToggle={() => setOpen(!open)} label={open ? "收起代码" : "展开代码"} />
      )}
    </div>
  )
}
