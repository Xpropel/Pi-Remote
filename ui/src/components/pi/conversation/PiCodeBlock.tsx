import { Fragment, useEffect, useRef, useState } from "react"
import { GhostIconButton, SyntaxHighlight } from "@/components/kit"
import { Check, ChevronDown, Copy } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { usePiStatic } from "@/components/pi/shared/layers"
import { highlightRouteOf, type HighlightLine } from "@/pi/model/highlight"
import { useCachedHighlightLines } from "./useCachedHighlightLines"
import { piCopyText, PI_COPIED_MS } from "./clipboard"

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
  className?: string
}

const PLAIN_CODE =
  "block font-(family-name:--cw-font-mono) text-(length:--cw-text-code-block) leading-(--cw-leading-code) whitespace-pre text-(--cw-text)"

/**
 * 复制钮视觉 20×20，点击区 44×44（§4.4）：看不见的 ::after 从钮的右上角往左下铺 44×44（不居中外扩：卡是 overflow-hidden，居中会被裁掉 6px）。
 * 只在可交互态加：钮多出这块溢出后，Chrome 栅格化钮里的图标会差 1 级（实测 session-archived 1440 有 6 个像素 Δ=1），
 * 静态态（画廊）要和冻结版逐像素一样，而且截图本来就点不了。
 */
const COPY_HIT_44 = "after:absolute after:top-0 after:right-0 after:size-11 after:content-['']"

/**
 * 代码的横滚区（O-R3）：右边让出复制钮那一栏（钮 right-1.5 + 20 宽 = 距卡右缘 26），横滚区右缘停在钮左侧 2px，
 * 再留 4px 内距，第一行的长注释、横滚时的每一行都不再钻到钮下面。左、上、下内距不变。
 */
const CODE_SCROLL = "mr-7 overflow-x-auto py-2 pr-1 pl-3 [scrollbar-width:thin]"

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
 * 白底细描边圆角；右上复制钮；超过 12 行底部渐隐 + chevron（推断）。代码不折行，横向滚动（手机也一样，保持原样排版）。
 */
export function PiCodeBlock({ code, lang = "plain", foldAfter = 12, copied: copiedProp, static: staticProp, className }: PiCodeBlockProps) {
  const isStatic = usePiStatic(staticProp)
  const lines = code.replace(/\n$/, "").split("\n")
  const foldable = lines.length > foldAfter
  const [open, setOpen] = useState(false)
  const clipped = foldable && !open
  const route = highlightRouteOf(lang)
  const text = lines.join("\n")
  const shiki = useCachedHighlightLines(route.via === "shiki" ? text : null, route.via === "shiki" ? route.lang : null)
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
  return (
    <div
      data-pi-part="code-block"
      data-lang={route.via === "plain" ? undefined : route.lang}
      className={cn(
        "group/code relative my-(--cw-space-2-5) overflow-hidden rounded-(--cw-radius-card) border border-(--cw-border) bg-(--cw-surface)",
        className,
      )}
    >
      <div
        className={CODE_SCROLL}
        style={clipped ? { maxHeight: `calc(${foldAfter} * var(--cw-leading-code) + 16px)` } : undefined}
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
      <GhostIconButton
        size="sm"
        label={copied ? "已复制" : "复制代码"}
        icon={copied ? <Check /> : <Copy />}
        onClick={copy}
        className={cn("absolute top-1.5 right-1.5 bg-(--cw-surface)", !isStatic && COPY_HIT_44, copied && "text-(--cw-blue)")}
      />
      {clipped && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-b from-transparent to-(--cw-surface)"
        />
      )}
      {foldable && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "收起代码" : "展开代码"}
          onClick={() => setOpen(!open)}
          // 视觉位置不变（图标距卡底 6），点击区 44×44 向上盖住渐隐区（§4.4；B4）
          className="absolute bottom-0 left-1/2 z-[1] inline-flex h-11 w-11 -translate-x-1/2 items-end justify-center pb-1.5 text-(--cw-text-2)"
        >
          <ChevronDown size={16} strokeWidth={1.5} aria-hidden className={cn(open && "rotate-180")} />
        </button>
      )}
    </div>
  )
}
