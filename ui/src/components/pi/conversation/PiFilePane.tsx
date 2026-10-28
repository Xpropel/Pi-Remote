import { Fragment, useMemo, useState, type ReactNode } from "react"
import { GhostIconButton, MenuSearch, SyntaxTokens, tokenizeLines } from "@/components/kit"
import { ChevronRight, Download } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { piBytes } from "@/components/pi/shared/format"
import { fileLangLabelOf, highlightLangOfPath, highlightRouteOf } from "@/pi/model/highlight"
import { PiHighlightTokens } from "./PiCodeBlock"
import { useCachedHighlightLines } from "./useCachedHighlightLines"
import { T_SECONDARY, TOUCH_44 } from "./styles"
import type { PiFileResult } from "@/components/pi/shared/types"

export interface PiCodeViewProps {
  text: string
  /**
   * 语言名（PLAN 4.4）：文件视图传 highlightLangOfPath(路径)。kit 认的 6 种走 kit 分词器（tokenizeLines，画廊 L1 不变）；
   * 其余走 shiki（按需加载，回来之前按纯文本）；text / 空 = 纯文本。行数和行号不受分流影响。
   */
  lang: string
  /** 手机：软换行、保留行号（续行留在代码列里）；桌面：不折行、横向滚动 */
  wrap?: boolean
  className?: string
}

/**
 * 只读代码视图（PiCodeView；compose from kit: SyntaxTokens / tokenizeLines；参照 ch5/CodeViewer 的版式）。
 * 行号浅灰、低饱和高亮；没有 minimap、LSP、blame（§8）。
 */
export function PiCodeView({ text, lang, wrap, className }: PiCodeViewProps) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text])
  const route = highlightRouteOf(lang)
  const kitLang = route.via === "kit" ? route.lang : "text"
  const tokens = useMemo(() => tokenizeLines(lines, kitLang), [lines, kitLang])
  const shiki = useCachedHighlightLines(route.via === "shiki" ? lines.join("\n") : null, route.via === "shiki" ? route.lang : null)
  const gutter = `${Math.max(2, String(lines.length).length) + 1}ch`
  // shiki 结果的行数和 lines 对不上（不应该发生）时不用它，免得行号错位
  const shikiLines = shiki && shiki.length === lines.length ? shiki : null
  // 空行写一个空格撑住行高（和原来一样按记号数判断）
  const lineNode = (i: number): ReactNode => {
    if (shikiLines) return shikiLines[i].length > 0 ? <PiHighlightTokens line={shikiLines[i]} /> : " "
    const kit = tokens[i] ?? []
    return kit.length > 0 ? <SyntaxTokens tokens={kit} /> : " "
  }
  return (
    <div
      data-pi-part="code-view"
      data-lang={route.via === "plain" ? undefined : route.lang}
      data-highlight={shikiLines ? "shiki" : undefined}
      className={cn(
        "font-(family-name:--cw-font-mono) text-(length:--cw-text-code-block) leading-(--cw-leading-code) text-(--cw-text)",
        wrap ? "" : "overflow-x-auto",
        className,
      )}
    >
      <div className={cn(wrap ? "" : "w-max min-w-full")}>
        {lines.map((_, i) => (
          <div key={i} className="flex">
            <span
              aria-hidden
              className="shrink-0 pr-3 text-right text-(--cw-diff-lineno) tabular-nums select-none"
              style={{ width: gutter, boxSizing: "content-box" }}
            >
              {i + 1}
            </span>
            <span className={cn("min-w-0 flex-1", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}>{lineNode(i)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface PiFileToolbarProps {
  file: PiFileResult
  variant: "desktop" | "phone"
  /** 可交互（P5.4）：下载钮（浏览器本地生成文件，不回传服务端） */
  onDownload?: () => void
  className?: string
}

/**
 * 文件视图的工具行（PiFileToolbar；compose from kit: GhostIconButton, ChevronRight）：
 * 面包屑 "ui › src › mobile › useMobileViewport.ts"（末段深色）+ 右端灰字"3 KB · TypeScript"+ 下载；
 * 手机面包屑可横滑，"大小 · 语言"挪到第二行。手机推入页放进 PiPhonePage.subHeader，钉在顶栏下（M-10）。
 * 不直接用 ch5/FileBreadcrumbs：它写死了左侧 大纲 / 文件内搜索 / 后退 / 前进 四个钮（Pi 没有这些功能，画出来就是假功能），
 * ch5 章节的 crumb 颜色变量只在 ch5.css 的 :root 里给了浅色值；所以按 kit 组合（kit-requests 里提了可选开关）。
 */
export function PiFileToolbar({ file, variant, onDownload, className }: PiFileToolbarProps) {
  const phone = variant === "phone"
  const segments = file.path.split("/")
  // "3 KB · TypeScript"：具体的 mime 先查表，笼统的（text/plain 等）按扩展名认（"Python""Go""Shell"，PLAN 4.4）
  const meta = `${piBytes(file.size)} · ${fileLangLabelOf(file.mime, file.path)}`
  return (
    <div data-pi-part="file-toolbar" className={cn("shrink-0 bg-(--cw-bg)", className)}>
      <div
        className={cn(
          "flex items-center gap-2 border-b border-(--cw-divider)",
          // 手机：下载钮中心离屏幕边 22，44×44 点击区不出屏（§4.4；B3）
          phone ? "h-11 pr-2.5 pl-4" : "h-9 pr-2 pl-3.5",
        )}
      >
        <nav
          aria-label="文件路径"
          className={cn(
            "flex min-w-0 flex-1 items-center whitespace-nowrap",
            phone ? "overflow-x-auto text-(length:--cw-text-md) [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "overflow-hidden text-(length:--cw-text-sm)",
          )}
        >
          {segments.map((seg, i) => {
            const last = i === segments.length - 1
            return (
              <Fragment key={i}>
                {i > 0 && <ChevronRight aria-hidden size={12} strokeWidth={1.5} className="mx-0.5 shrink-0 text-(--cw-text-4)" />}
                <span aria-current={last ? "page" : undefined} className={cn(last ? "text-(--cw-text)" : T_SECONDARY, last && !phone && "truncate")}>
                  {seg}
                </span>
              </Fragment>
            )
          })}
        </nav>
        {!phone && <span className={cn("shrink-0 text-(length:--cw-text-sm)", T_SECONDARY)}>{meta}</span>}
        <GhostIconButton label="下载文件" icon={<Download />} className={cn(phone && TOUCH_44)} onClick={onDownload} />
      </div>
      {phone && <div className={cn("px-4 pt-2 text-(length:--cw-text-sm)", T_SECONDARY)}>{meta}</div>}
    </div>
  )
}

export interface PiFilePaneProps {
  file: PiFileResult
  variant: "desktop" | "phone"
  /** 画不画自带的工具行（默认画）；手机推入页传 false，改把 PiFileToolbar 放进 PiPhonePage.subHeader（M-10） */
  toolbar?: boolean
  /** 截断时的说明（默认"只显示前 256 KB"；产品按 get_file 的真实上限写，P5.4 / G10） */
  truncatedNote?: string
  /** 可交互（P5.4）：自带工具行的下载钮 */
  onDownload?: () => void
  className?: string
}

/**
 * 文件视图（PiFilePane；工具行 PiFileToolbar + PiCodeView）。
 * P5.4：get_file 回 base64 的图片（png / jpeg / gif / webp）画图（MediaImage 那一档的描边圆角，不放大超过原尺寸）；
 * 其余 base64 是二进制，写"二进制文件，不能预览 · 下载"。
 */
export function PiFilePane({ file, variant, toolbar = true, truncatedNote = "只显示前 256 KB", onDownload, className }: PiFilePaneProps) {
  const phone = variant === "phone"
  const image = file.encoding === "base64" && /^image\//i.test(file.mime)
  return (
    <div data-pi-part="file-pane" className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {toolbar && <PiFileToolbar file={file} variant={variant} onDownload={onDownload} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {image ? (
          <div data-pi-part="file-image" className="flex justify-center p-4">
            <img
              src={`data:${file.mime};base64,${file.text}`}
              alt={file.path}
              className="block h-auto max-w-full rounded-(--cw-radius-card) border border-(--cw-border)"
            />
          </div>
        ) : file.encoding === "base64" ? (
          <div className={cn("px-4 py-6 text-(length:--cw-text-md)", T_SECONDARY)}>
            二进制文件，不能预览
            {onDownload && (
              <>
                {" "}
                ·{" "}
                <button type="button" className={cn("text-(--cw-link) hover:underline", TOUCH_44)} onClick={onDownload}>
                  下载
                </button>
              </>
            )}
          </div>
        ) : (
          <PiCodeView text={file.text} lang={highlightLangOfPath(file.path)} wrap={phone} className={phone ? "px-2 py-2" : "px-1 py-2"} />
        )}
        {file.truncated && <div className={cn("px-4 py-2 text-(length:--cw-text-sm)", T_SECONDARY)}>{truncatedNote}</div>}
      </div>
    </div>
  )
}

export interface PiFileOpenRowProps {
  variant: "desktop" | "phone"
  /** 回车：打开这个路径（相对会话的工作目录，由本机扩展读） */
  onOpen: (path: string) => void
  className?: string
}

/**
 * 文件视图顶部的"打开文件…"输入行（design B09，MenuSearch 样式）：手动输入路径，回车读取。
 * 手机 16px 字号（iOS 聚焦不放大）、44 高。
 */
export function PiFileOpenRow({ variant, onOpen, className }: PiFileOpenRowProps) {
  const phone = variant === "phone"
  const [value, setValue] = useState("")
  return (
    <form
      data-pi-part="file-open"
      className={cn("shrink-0 px-1 pt-1", className)}
      onSubmit={(event) => {
        event.preventDefault()
        const path = value.trim()
        if (path) onOpen(path)
      }}
    >
      <MenuSearch
        aria-label="打开文件"
        placeholder="打开文件…"
        enterKeyHint="go"
        value={value}
        onValueChange={setValue}
        className={phone ? "h-11 text-[16px]" : undefined}
      />
    </form>
  )
}
