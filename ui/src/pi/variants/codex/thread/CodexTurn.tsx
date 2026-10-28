import type { Item } from "@/relay/transcript"
import type { VariantAppProps } from "@/pi/variants/types"
import { memo, useMemo } from "react"
import { codexWorkedText } from "../logic/transcript"
import { CodexActivityRow, CodexWorkedRow } from "./CodexActivityRow"
import { CodexAssistantProse } from "./CodexCodeBlock"
import { CodexErrorPart } from "./CodexErrorPart"
import { CodexReplyActions } from "./CodexReplyActions"
import { CodexSubagentRows } from "./CodexStreamTail"
import { CodexTaskList, CodexToolRow } from "./CodexToolRow"
import { CodexUserBubble } from "./CodexUserBubble"

export interface CodexTurnData {
  user: Extract<Item, { kind: "user" }> | null
  rest: Item[]
}

/** 一个回合（[X-§3]：回合间距 34 / 回合内 12；不靠卡片边框分组） */
function CodexTurnImpl({
  p,
  turn,
  phone,
  observed,
  workedMs,
  running,
  subagents,
  onOpenImage,
}: {
  p: VariantAppProps
  turn: CodexTurnData
  phone: boolean
  observed: ReadonlyMap<string, number>
  workedMs: number | null
  running: boolean
  subagents: readonly { name: string; task: string; startedAt: number }[]
  onOpenImage: (image: { src: string; alt?: string }) => void
}) {
  const lastAssistant = useMemo(() => [...turn.rest].reverse().find((item) => item.kind === "assistant"), [turn.rest])
  const copyText = turn.rest
    .flatMap((item) => (item.kind === "assistant" ? item.blocks.filter((b) => b.kind === "text").map((b) => (b.kind === "text" ? b.text : "")) : []))
    .join("\n\n")
  return (
    <section className="cx-turn" data-p4-ready="" data-pi-ui-part="thread">
      {turn.user ? <CodexUserBubble item={turn.user} phone={phone} /> : null}
      {!running ? <CodexWorkedRow text={codexWorkedText(workedMs)} /> : null}
      {turn.rest.map((item) => {
        // 真实 pi 历史里还有 summary / bash / custom 三类条目（mock 不覆盖）；按变体语言渲染，不静默丢内容
        if (item.kind === "summary") {
          return (
            <div className="cx-summary-note" key={item.key} role="note" data-pi-ui-part="thread">
              <span className="cx-summary-title">{item.title}</span>
              <div className="cx-summary-text">{item.text}</div>
            </div>
          )
        }
        if (item.kind === "bash") {
          return (
            <div className="cx-bash-row" key={item.key} data-pi-ui-part="thread">
              <div className="cx-activity-label">{item.label || "命令"}</div>
              <pre className="cx-bash-command"><code>{item.command}</code></pre>
              {item.output ? <pre className="cx-bash-output">{item.output}</pre> : null}
            </div>
          )
        }
        if (item.kind === "custom") {
          return (
            <div className="cx-custom-row" key={item.key} data-pi-ui-part="thread">
              <div className="cx-activity-label">{item.label}</div>
              <div className="cx-custom-text">{item.text}</div>
            </div>
          )
        }
        if (item.kind === "assistant") {
          return (
            <div className="cx-assistant-wrap" key={item.key}>
              {item.blocks.map((block, index) => {
                if (block.kind === "text") return <CodexAssistantProse key={`${item.key}-t${index}`} text={block.text} />
                if (block.kind === "thinking")
                  return (
                    <CodexActivityRow
                      key={`${item.key}-th${index}`}
                      kind="thought"
                      label={observed.get(`${item.key}:${index}`) != null ? `Thought for ${Math.max(1, Math.round((observed.get(`${item.key}:${index}`) ?? 0) / 1000))}s` : "已思考"}
                      detail={block.text}
                    />
                  )
                if (block.kind === "tool")
                  return (
                    <div key={block.id}>
                      <CodexToolRow block={block} />
                      {block.tasks && block.tasks.length > 0 ? <CodexTaskList tasks={block.tasks} /> : null}
                      {block.images && block.images.length > 0 ? (
                        <div className="cx-inline-images">
                          {block.images.map((image, i) => (
                            <span key={i} className="cx-inline-image">
                              {/* 工具结果里的图片沿用图片 part 的占位/像素规则 */}
                              <CodexImageWrapper image={image} onOpen={onOpenImage} />
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                return null
              })}
              {item.errorMessage ? <CodexErrorPart text={item.errorMessage} /> : null}
              {item.live ? <span className="cx-stream-caret" aria-hidden /> : null}
              {item === lastAssistant && !running && copyText ? <CodexReplyActions p={p} text={copyText} meta={metaOf(item)} /> : null}
            </div>
          )
        }
        return null
      })}
      {running ? <CodexSubagentRows agents={subagents} /> : null}
    </section>
  )
}

import { CodexImagePart } from "./CodexImagePart"

function CodexImageWrapper({ image, onOpen }: { image: Parameters<typeof CodexImagePart>[0]["image"]; onOpen: (image: { src: string; alt?: string }) => void }) {
  const raw = image as Parameters<typeof CodexImagePart>[0]["image"] & { data?: string; src?: string }
  const src = raw.data ?? raw.src
  return <CodexImagePart image={image} onOpen={() => src && onOpen({ src: src.startsWith("data:") ? src : `data:${image.mimeType ?? "image/png"};base64,${src}`, alt: "图片" })} />
}

function metaOf(item: Extract<Item, { kind: "assistant" }>): string | undefined {
  const parts: string[] = []
  if (item.model) parts.push(item.model.replace(/^claude[-:]?/i, ""))
  if (item.usage?.totalTokens != null) parts.push(`${Math.round(item.usage.totalTokens / 1000)}k tok`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

/** R4 性能动作 1/2：旧回合的 item 引用稳定则整回合跳过渲染（流式只更新最后一条 item）。 */
function sameItems(a: readonly Item[], b: readonly Item[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

export const CodexTurn = memo(CodexTurnImpl, (prev, next) => {
  return (
    prev.turn.user === next.turn.user &&
    sameItems(prev.turn.rest, next.turn.rest) &&
    prev.phone === next.phone &&
    prev.workedMs === next.workedMs &&
    prev.running === next.running &&
    prev.subagents === next.subagents &&
    prev.onOpenImage === next.onOpenImage
  )
})
