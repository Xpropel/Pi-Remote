import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import type { DiffRow, FileKind } from "@/components/kit"
import { InlineLink } from "@/components/kit"
import { piCopyText } from "@/components/pi/conversation/clipboard"
import { PiChangesPane, type PiChangedFile } from "@/components/pi/conversation/PiChangesPane"
import { PiFileOpenRow, PiFilePane, PiFileToolbar } from "@/components/pi/conversation/PiFilePane"
import { PiPaneTabs, PiPaneTitle, type PiPaneKind } from "@/components/pi/conversation/PiPaneTabs"
import { PiTerminalPane, PiTerminalToolbar, type PiTerminalActions } from "@/components/pi/conversation/PiTerminalPane"
import { PiCenteredState, PiPhonePage, PiTopBar } from "@/components/pi/shared"
import { piBaseName } from "@/components/pi/shared/format"
import type { PiFileResult } from "@/components/pi/shared/types"
import { sortTerminalItems, visibleTerminalItems } from "@/chat/capsules/terminalModel"
import { useNow } from "@/pi/hooks/useNow"
import { changesViewOf, type PiPaneDiffRow } from "@/pi/model/changesView"
import { fileErrorTextOf, filePayloadOf, type PiFilePayload } from "@/pi/model/filePayload"
import type { Item } from "@/relay/transcript"
import type { PiContainerProps } from "./types"

/**
 * 右 pane / 手机推入页（plan §7.2 changes-pane / terminal-pane / file-pane，P5.4 b 线）：视图在 ui.pane（act.setPane），文件路径在 ui.file。
 * - 改动：pi/model/changesView.ts（changesOfSession 的口径，先读 patch，G5）；版头"根据本会话的编辑记录，不是 git 状态"；
 *   按行号断档画"N 行未改动"折叠条；同一文件第 2 次起有"第 N 次编辑"分隔条；patch 被截断时写明。没有成功编辑的文件整行不出现。
 * - 终端：terminalItems（terminalModel.ts 的保留期：成功 30 秒、失败 60 秒后移出；按开始时间排）；输出只在这里展开，不设 live region。
 *   工具行：行号开关、复制全部输出、跳到最新。
 * - 文件：relay.getFile（G10：回包字段对照过扩展的 readFileInRoot，见 model/filePayload.ts；缺什么不显示什么）。
 *   加载中 / 失败（"读取失败 · 重试"）/ 文本 / 图片；截断写"只显示前 5 MB"（扩展的真实上限）；下载在浏览器本地生成。
 * 桌面放在外壳 pane 槽（PiPaneTabs + 视图，× 调 act.setPane(null)）；手机是整页（PiPhonePage + subHeader 放工具行，M-10；‹ 回对话页）。
 */
export function PaneContainer(props: PiContainerProps) {
  const { relay, ui, act, variant } = props
  const phone = variant === "phone"
  const view: PiPaneKind = ui.pane ?? "changes"
  const now = useNow(1000)
  const items: Item[] = relay.roomId ? relay.transcript.items : EMPTY_ITEMS

  const changes = useMemo(() => changesViewOf(items), [items])
  const files = useMemo<PiChangedFile[]>(
    () => (changes?.files ?? []).map((f) => ({ path: f.path, added: f.added, removed: f.removed, isNew: f.isNew, edits: f.edits, rows: f.rows.map(kitRow), truncated: f.truncated })),
    [changes],
  )
  const total = { added: changes?.added ?? 0, removed: changes?.removed ?? 0 }

  const terminals = useMemo(() => sortTerminalItems(visibleTerminalItems(relay.terminalItems, now)), [relay.terminalItems, now])
  const [lineNumbers, setLineNumbers] = useState<boolean | null>(null)
  const numbers = lineNumbers ?? !phone
  const terminalActions = useMemo<PiTerminalActions>(
    () => ({
      onToggleLineNumbers: () => setLineNumbers(!numbers),
      onCopyOutput: () => void piCopyText(terminalsText(terminals)),
      onJumpLatest: () => jumpToLatest(phone),
    }),
    [numbers, terminals, phone],
  )

  const file = useFileView(relay.getFile, view === "file" ? ui.file : null, relay.roomId)

  let body: ReactNode
  let subHeader: ReactNode = undefined
  if (view === "changes") {
    body = <PiChangesPane files={files} total={total} variant={variant} />
  } else if (view === "terminal") {
    body = <PiTerminalPane items={terminals} now={now} variant={variant} toolbar={!phone} lineNumbers={numbers} actions={terminalActions} />
    if (phone && terminals.length > 0) subHeader = <PiTerminalToolbar items={terminals} variant="phone" lineNumbers={numbers} actions={terminalActions} />
  } else if (!ui.file) {
    // 手动打开（B09）：顶部"打开文件…"输入行，回车 = act.openFile（之后同从流里点文件名）
    body = (
      <>
        <PiFileOpenRow variant={variant} onOpen={act.openFile} />
        <PaneState title="还没有打开文件" body="在对话里点文件名（蓝色）打开" />
      </>
    )
  } else if (file.status === "loading") {
    body = <PaneState spinner title="正在读取文件…" body={ui.file} />
  } else if (file.status === "error") {
    body = (
      <PaneState
        title="读取失败"
        body={
          <>
            {file.error} · <InlineLink onClick={file.retry}>重试</InlineLink>
          </>
        }
      />
    )
  } else {
    const result = fileResultOf(file.payload, ui.file)
    const download = () => downloadFile(file.payload, ui.file ?? "")
    body = (
      <PiFilePane
        file={result}
        variant={variant}
        toolbar={!phone}
        truncatedNote="文件太大，只显示前 5 MB"
        onDownload={download}
      />
    )
    if (phone) subHeader = <PiFileToolbar file={result} variant="phone" onDownload={download} />
  }

  if (phone) {
    return (
      <PiPhonePage
        topBar={<PiTopBar variant="phone-page" title={<PiPaneTitle active={view} />} onBack={() => act.setPane(null)} className="border-b border-(--cw-divider)" />}
        subHeader={subHeader}
      >
        {body}
      </PiPhonePage>
    )
  }
  return (
    <>
      <PiPaneTabs
        active={view}
        changes={total}
        terminalRunning={terminals.some((t) => t.state === "running")}
        file={ui.file ? { name: piBaseName(ui.file), kind: fileKindOfPath(ui.file) } : undefined}
        onSelect={(kind) => act.setPane(kind)}
        onClose={() => act.setPane(null)}
      />
      {body}
    </>
  )
}

const EMPTY_ITEMS: Item[] = []

/** pane 里的居中状态（没打开文件 / 读取中 / 读取失败） */
function PaneState({ spinner, title, body }: { spinner?: boolean; title: ReactNode; body?: ReactNode }) {
  return (
    <div data-pi-part="pane-state" className="flex min-h-0 flex-1 flex-col items-center justify-center py-10">
      <PiCenteredState spinner={spinner} title={title} body={body} />
    </div>
  )
}

/**
 * "N 行未改动"折叠条展不开（O-R5，design §1.9）：pane 只有编辑记录里的 patch，没有整份文件，藏起来的行拿不到。
 * 所以不画 kit 把手区的 ∨∧（像能点），也不给 hover 加深；文字留在原位置（把手区 31 宽 + 间距 12 = 左缘 43）。
 * 画廊 b/changes-pane（fixture 直接给 kit 行）照旧带把手。
 */
const PANE_FOLD_STATIC = "pl-[31px] hover:bg-(--cw-diff-unmodified-bg) data-[forced=hover]:bg-(--cw-diff-unmodified-bg) [&>[data-slot=unmodified-lines-handle]]:hidden"

/** 模型的行 → kit DiffRow（行号缺的不写，不编）；未改动折叠条按展不开画（PANE_FOLD_STATIC） */
function kitRow(row: PiPaneDiffRow): DiffRow {
  if (row.kind === "fold") return row.variant ? { kind: "fold", count: row.count, label: row.label, variant: row.variant } : { kind: "fold", count: row.count, label: row.label, className: PANE_FOLD_STATIC }
  return row.n == null ? { kind: row.kind, text: row.text } : { kind: row.kind, n: row.n, text: row.text }
}

/** 页签上的文件类型图标（同 PiDiffCard 的认法） */
function fileKindOfPath(path: string): FileKind {
  const p = path.toLowerCase()
  if (p.endsWith(".json")) return "json"
  if (p.endsWith(".html")) return "html"
  if (p.endsWith(".tsx") || p.endsWith(".jsx")) return "tsx"
  if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(p)) return "ts"
  if (/\.(txt|md|log|csv)$/.test(p)) return "txt"
  return "file"
}

/** 复制输出：本会话（保留期内）每条命令 + 输出，空行隔开 */
function terminalsText(items: readonly { command: string; output: string; stderr?: string }[]): string {
  return items.map((t) => [`$ ${t.command}`, t.output, t.stderr].filter((s) => s && s.trim()).join("\n")).join("\n\n")
}

/** 跳到最新：桌面滚 pane 里的命令列表，手机滚整页 */
function jumpToLatest(phone: boolean) {
  const el = document.querySelector<HTMLElement>(phone ? "[data-pi-scroller]" : "[data-pi-pane] [data-pi-terminal-scroll]")
  if (el) el.scrollTop = el.scrollHeight
}

/** get_file 回包 → 部件的 PiFileResult（大小缺了按拿到的内容算：文本按 UTF-8 字节，base64 按解码后的字节） */
function fileResultOf(payload: PiFilePayload, path: string): PiFileResult {
  const size =
    payload.size ??
    (payload.encoding === "utf8" ? new TextEncoder().encode(payload.data).length : Math.floor((payload.data.length * 3) / 4))
  return {
    path,
    size,
    mime: payload.mimeType,
    encoding: payload.encoding === "utf8" ? "utf-8" : "base64",
    truncated: payload.truncated,
    text: payload.data,
  }
}

/** 下载：用拿到的内容在浏览器本地生成文件（不把内容再发回服务端）；文件名只取名字部分 */
function downloadFile(payload: PiFilePayload, path: string) {
  // 控制字符和路径 / 系统保留字符换成下划线（防目录穿越，同旧界面 fileDownloadName）
  const name = [...(payload.name || piBaseName(path) || "download")].map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? "_" : ch)).join("")
  let blob: Blob
  if (payload.encoding === "utf8") blob = new Blob([payload.data], { type: payload.mimeType || "text/plain" })
  else {
    const bin = atob(payload.data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    blob = new Blob([bytes], { type: payload.mimeType || "application/octet-stream" })
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type FileView =
  | { status: "loading" }
  | { status: "error"; error: string; retry: () => void }
  | { status: "ready"; payload: PiFilePayload }

/**
 * 读文件：路径（或会话、重试次数）变了重新 get_file。结果按"路径 + 会话 + 第几次"记，对不上就是加载中，
 * 所以切文件时不会闪上一份内容。
 */
function useFileView(getFile: (path: string) => Promise<unknown>, path: string | null, roomId: string): FileView {
  const [nonce, setNonce] = useState(0)
  const key = path ? `${roomId}\n${path}\n${nonce}` : null
  const [result, setResult] = useState<{ key: string; payload: PiFilePayload | null; error?: string } | null>(null)
  useEffect(() => {
    if (!key || !path) return
    let alive = true
    getFile(path).then(
      (data) => {
        if (!alive) return
        const payload = filePayloadOf(data)
        setResult(payload ? { key, payload } : { key, payload: null, error: "返回的文件数据不完整" })
      },
      (error: unknown) => {
        if (alive) setResult({ key, payload: null, error: fileErrorTextOf(error) })
      },
    )
    return () => {
      alive = false
    }
  }, [getFile, key, path])
  const retry = useCallback(() => setNonce((n) => n + 1), [])
  if (!key || result?.key !== key) return { status: "loading" }
  if (result.payload) return { status: "ready", payload: result.payload }
  return { status: "error", error: result.error ?? "读取文件失败，请重试", retry }
}
