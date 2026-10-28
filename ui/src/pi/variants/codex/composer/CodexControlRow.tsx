import { ChevronDown, Mic, Plus, Send, Square } from "../icons/CodexIcons"
import type { ContextReadout } from "@/relay/contextUsage"
import type { PiComposerBlock } from "@/pi/model/composerButton"
import { CodexApprovalChip, type CodexApprovalMode } from "./CodexApprovalChip"
import { CodexContextRing } from "./CodexContextRing"

/** composer 底部控件行（[X-§4] / X-01-9：28px 统一控件；左 + 与蓝字审批 chip，右模型/上下文/麦克风/纯黑圆发送） */
export function CodexControlRow({
  mode,
  approvalOpen,
  modelName,
  modelThinking,
  modelOpen,
  ctx,
  block,
  hasContent,
  readOnly,
  dictation,
  approvalLabel,
  approvalTitle,
  approvalState,
  onToggleApproval,
  onToggleAttach,
  onToggleModel,
  onDictate,
  onSend,
}: {
  mode: CodexApprovalMode
  approvalOpen: boolean
  modelName: string
  modelThinking: string
  modelOpen: boolean
  ctx: ContextReadout
  block: PiComposerBlock
  hasContent: boolean
  readOnly: boolean
  dictation: { interactive: boolean; status: string; reason: string }
  approvalLabel: string
  approvalTitle: string
  approvalState: string
  onToggleApproval: () => void
  onToggleAttach: () => void
  onToggleModel: () => void
  onDictate: () => void
  onSend: () => void
}) {
  const canStop = block.button.variant === "stop"
  const disabled = !canStop && (block.button.disabled || readOnly || !hasContent)
  return (
    <div className="cx-composer-controls" data-p4-surface="CX-COMP-02" data-p4-ready="">
      <div className="cx-composer-left">
        <button type="button" className="cx-ctrl-btn" aria-label="添加" onClick={onToggleAttach}>
          <Plus aria-hidden size={16} strokeWidth={1.75} />
        </button>
        <CodexApprovalChip mode={mode} open={approvalOpen} label={approvalLabel} title={approvalTitle} capabilityState={approvalState} onToggle={onToggleApproval} />
      </div>
      <div className="cx-composer-right">
        <CodexContextRing readout={ctx} />
        <button
          type="button"
          className="cx-model-chip"
          aria-label={`模型 ${modelName}${modelThinking ? `，思考级别 ${modelThinking}` : ""}`}
          aria-expanded={modelOpen}
          data-p4-action="pick-model-open"
          onClick={onToggleModel}
        >
          <span className="cx-model-name">{modelName}</span>
          {modelThinking ? <span className="cx-model-thinking">{modelThinking}</span> : null}
          <ChevronDown aria-hidden size={11} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="cx-ctrl-btn cx-mic"
          aria-label="语音输入"
          data-p4-action="dictate"
          data-capability-state={dictation.status}
          data-pi-capability-disabled={dictation.interactive ? undefined : ""}
          disabled={!dictation.interactive}
          title={dictation.interactive ? "语音输入（扩展）" : dictation.reason}
          onClick={onDictate}
        >
          <Mic aria-hidden size={15} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="cx-send"
          data-variant={canStop ? "stop" : disabled ? "send-muted" : "send"}
          disabled={disabled}
          aria-label={canStop ? "停止" : block.button.disabled ? "发送（不可用）" : "发送"}
          onClick={onSend}
        >
          {canStop ? <Square aria-hidden size={11} strokeWidth={2} fill="currentColor" /> : <Send aria-hidden size={14} strokeWidth={2} />}
        </button>
      </div>
    </div>
  )
}
