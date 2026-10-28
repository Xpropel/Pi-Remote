import { useState } from "react"
import { Check, ChevronDown, ChevronRight, CircleAlert, LoaderCircle, Terminal } from "lucide-react"
import type { Block, ImagePart, ToolState } from "@/relay/transcript"
import { diffRowsFromEdit } from "@/pi/model/diffRows"
import { baseName, bytesText } from "../model/format"
import { cx } from "../model/cx"
import { ClaudeDiffCard } from "./ClaudeDiffCard"
import { ClaudeMark } from "../primitives/ClaudePrimitives"

/**
 * Claude v2 自有工具卡 / 工具状态行（§1.8：工具状态行小字 + 图标；diff 卡；终端卡；任务清单）。
 * 数据：relay/transcript 的 Block（typing 来自 relay 层，允许 import type）。渲染与样式全部自有。
 */

type ToolBlock = Extract<Block, { kind: "tool" }>

const TERMINAL_TOOLS = new Set(["bash", "powershell", "shell"])
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit"])
const READ_TOOLS = new Set(["read", "ls", "list", "glob", "grep", "search", "find"])

function toolDisplayOf(block: ToolBlock): "preparing" | "running" | "succeeded" | "failed" | "denied" | "waiting" | "cancelled" {
  const state: ToolState = block.state
  if (block.outcome === "denied" && state === "output-error") return "denied"
  switch (state) {
    case "input-streaming":
      return "preparing"
    case "input-available":
    case "waiting_approval":
      return state === "waiting_approval" ? "waiting" : "running"
    case "output-available":
      return "succeeded"
    case "output-error":
      return "failed"
    case "denied":
      return "denied"
    case "cancelled":
      return "cancelled"
    case "queued":
      return "preparing"
    default:
      return "running"
  }
}

function stateText(state: ReturnType<typeof toolDisplayOf>): string {
  switch (state) {
    case "preparing":
      return "准备中…"
    case "running":
      return "运行中…"
    case "succeeded":
      return "完成"
    case "failed":
      return "失败"
    case "denied":
      return "已拒绝"
    case "waiting":
      return "等你授权"
    case "cancelled":
      return "已取消"
  }
}

function toolTarget(block: ToolBlock): string {
  const input = block.input ?? {}
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "")
  return pick("path") || pick("file_path") || pick("filePath") || pick("pattern") || pick("query") || pick("url") || ""
}

function toolCommand(block: ToolBlock): string {
  const input = block.input ?? {}
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "")
  return pick("command") || pick("cmd") || pick("script") || block.argsText || ""
}

/** 一行工具状态（读取 / 搜索 / 网页 / 其它轻工具）：图标 + 小字，不占卡片 */
function ToolLine({ block }: { block: ToolBlock }) {
  const state = toolDisplayOf(block)
  const target = toolTarget(block)
  return (
    <div className="claude-tool-line" data-state={state}>
      {state === "running" ? <LoaderCircle size={13} className="claude-spin" aria-hidden /> : null}
      {state === "failed" || state === "denied" ? <CircleAlert size={13} aria-hidden /> : null}
      {state === "succeeded" ? <Check size={13} aria-hidden /> : null}
      {state === "preparing" || state === "waiting" || state === "cancelled" ? <ClaudeMark size={12} /> : null}
      <span className="claude-tool-line-name">{block.name}</span>
      {target ? <span className="claude-tool-line-target">{baseName(target) || target}</span> : null}
      <span className="claude-tool-line-state">{stateText(state)}</span>
    </div>
  )
}

/** 终端卡：命令 + 折叠的输出（§1.8 [C-图7③] 工具状态行 + 终端块） */
function TerminalBlockCard({ block, live }: { block: ToolBlock; live?: boolean }) {
  const state = toolDisplayOf(block)
  const [open, setOpen] = useState(state === "failed")
  const output = [block.outputText, block.stderr].filter(Boolean).join("\n")
  const command = toolCommand(block)
  return (
    <section className="claude-terminal-card" data-state={state}>
      <header className="claude-terminal-head">
        <button type="button" className="claude-terminal-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={13} strokeWidth={2} aria-hidden /> : <ChevronRight size={13} strokeWidth={2} aria-hidden />}
          <Terminal size={13} strokeWidth={1.75} aria-hidden />
          <span className="claude-terminal-title">{state === "running" && live ? "正在运行" : "运行命令"}</span>
          <span className="claude-terminal-command">{command}</span>
        </button>
        <span className="claude-terminal-meta">
          {typeof block.exitCode === "number" && block.exitCode !== 0 ? <span className="claude-term-exit">exit {block.exitCode}</span> : null}
          <span className="claude-terminal-state">{stateText(state)}</span>
        </span>
      </header>
      {open ? <pre className="claude-terminal-body">{output || "（没有输出）"}</pre> : null}
      {block.images && block.images.length > 0 ? <ImageStrip images={block.images} /> : null}
    </section>
  )
}

/** edit / write → diff 卡 */
function EditBlockCard({ block }: { block: ToolBlock }) {
  const rows = diffRowsFromEdit(block.input ?? null, block)
  const path = toolTarget(block)
  const file = baseName(path) || "改动"
  if (!rows) {
    return (
      <section className="claude-diffcard">
        <header className="claude-diffcard-head">
          <span className="claude-terminal-title">改动</span>
          <span className="claude-diffcard-file">{path || "（没有路径）"}</span>
        </header>
        <div className="claude-diff-fold">这个改动没有可显示的 diff</div>
      </section>
    )
  }
  return <ClaudeDiffCard file={file} added={rows.added} removed={rows.removed} rows={rows.rows} truncated={rows.truncated} />
}

/** todo 类工具的任务清单卡（可勾选样式，只读） */
function TasksBlockCard({ block }: { block: ToolBlock }) {
  const tasks = block.tasks ?? []
  return (
    <section className="claude-taskcard">
      <header className="claude-taskcard-head">
        <span className="claude-card-title">任务</span>
        <span className="claude-taskcard-count">
          {tasks.filter((t) => t.status === "completed").length}/{tasks.length}
        </span>
      </header>
      <ul className="claude-taskcard-list">
        {tasks.map((task) => (
          <li key={task.id} data-status={task.status}>
            <span aria-hidden className="claude-taskcard-dot" />
            <span className={task.status === "completed" ? "claude-taskcard-done" : undefined}>{task.content}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 图片条（工具输出 / 用户消息共用；omitted 图提供"加载原图"） */
export function ImageStrip({ images, onLoad }: { images: readonly ImagePart[]; onLoad?: (image: ImagePart) => void }) {
  return (
    <div className="claude-imgstrip">
      {images.map((image, index) => (
        <figure key={index} className="claude-imgstrip-item">
          {image.omitted || !image.data ? (
            <button type="button" className="claude-imgstrip-load" onClick={() => onLoad?.(image)} disabled={!image.entryId}>
              加载原图
              {image.bytes ? <span>{bytesText(image.bytes)}</span> : null}
            </button>
          ) : (
            <img src={`data:${image.mimeType};base64,${image.data}`} alt="附件图片" loading="lazy" />
          )}
        </figure>
      ))}
    </div>
  )
}

/** 一个工具块 → 对应 Claude 部件 */
export function ClaudeToolBlock({ block, live, onLoadImage }: { block: ToolBlock; live?: boolean; onLoadImage?: (image: ImagePart) => void }) {
  const name = block.name.trim().toLowerCase()
  if (TERMINAL_TOOLS.has(name)) return <TerminalBlockCard block={block} live={live} />
  if (EDIT_TOOLS.has(name)) return <EditBlockCard block={block} />
  if (block.tasks && block.tasks.length > 0) return <TasksBlockCard block={block} />
  if (READ_TOOLS.has(name)) return <ToolLine block={block} />
  if (block.images && block.images.length > 0) {
    return (
      <div className="claude-tool-imageblock">
        <ToolLine block={block} />
        <ImageStrip images={block.images} onLoad={onLoadImage} />
      </div>
    )
  }
  return <ToolLine block={block} />
}

/** 块级展开列表（思考块的 key 由上层维护） */
export function ClaudeExpandToggle({ open, onClick, children }: { open: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={cx("claude-expand-toggle")} aria-expanded={open} onClick={onClick}>
      {open ? <ChevronDown size={12} strokeWidth={2} aria-hidden /> : <ChevronRight size={12} strokeWidth={2} aria-hidden />}
      {children}
    </button>
  )
}
