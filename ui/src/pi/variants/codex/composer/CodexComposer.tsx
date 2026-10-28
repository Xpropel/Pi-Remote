import { useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react"
import { X } from "../icons/CodexIcons"
import type { SendImage } from "@/relay/transcript"
import type { VariantAppProps } from "@/pi/variants/types"
import { composerBlockOf } from "@/pi/model/composerButton"
import { useComposerEnter } from "@/pi/headless/useComposerEnter"
import { composerReasonOf } from "@/pi/model/composerReason"
import { modelMenuListOf, modelPillName, modelRowsOf, type PiModelRow } from "@/pi/model/models"
import { contextReadout } from "@/relay/contextUsage"
import { useCloseOnOutside, useCodexCommand, useSlowAck } from "../hooks/useCodex"
import { useCodexFrame } from "../root/context"
import { commandsReady, piBaseName, sessionLoaded } from "../logic/view"
import { CodexApprovalDock } from "../approval/CodexApprovalCard"
import { CodexSpinner } from "../primitives/primitives"
import { CodexControlRow } from "./CodexControlRow"
import { CodexAttachTray } from "./CodexAttachTray"
import { CodexQueue } from "./CodexQueue"
import { CodexSlashMenu } from "./CodexSlashMenu"
import { CodexMentionMenu } from "./CodexMentionMenu"
import type { CodexApprovalMode } from "./CodexApprovalChip"
import { CodexModelMenu } from "./CodexModelMenu"
import { useCodexCapability } from "../logic/capability"

function readImageFile(file: File): Promise<SendImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? { data: result.slice(comma + 1), mimeType: file.type || "image/png" } : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/**
 * Codex composer（[X-§4][X-图7⑤] / X-01-9~11 / X-04-2）：25 圆角 + 三层阴影 + 距底 16；28px 控件；
 * 左 `+` + 蓝字审批 chip，右模型/上下文环/麦克风/纯黑圆发送（深色反转）；运行中发送键变 Stop；队列一行。
 * 行为复用 @/pi/model（composerBlock/composerReason/models）+ relay 的 draft/send/abort，审批卡是本变体自己的 CodexApprovalCard。
 */
export function CodexComposer({ p, phone }: { p: VariantAppProps; phone: boolean }) {
  const { relay, ui } = p
  const frame = useCodexFrame()
  const draft = relay.draft
  const hasContent = draft.trim().length > 0 || relay.pendingImages.length > 0
  const block = composerBlockOf(relay.composer.state, ui.blockedBy, hasContent)
  const link = relay.browserOnline ? (relay.online ? ("ok" as const) : relay.everConnected ? ("waiting" as const) : ("first" as const)) : ("reconnecting" as const)
  const device = relay.deviceMode && relay.selectedDevice ? { name: relay.selectedDevice.name, online: relay.selectedDevice.online } : null
  const loaded = sessionLoaded(relay)
  const slowAck = useSlowAck(relay.composer.state)
  const reason = composerReasonOf({ kind: link }, device, { state: relay.composer.state, s7: relay.composer.blockReason === "revoked" ? "revoked" : relay.composer.blockReason === "readonly" ? "readonly" : null, slowAck }, ui.blockedBy, loaded)
  const ctx = contextReadout(relay.usage?.contextUsage)
  const model = { name: modelPillName(relay) ?? "选择模型", thinking: relay.thinkingLevel || "" }
  const readOnly = block.readOnly
  const wrap = useRef<HTMLDivElement>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [mode, setMode] = useState<CodexApprovalMode>("auto")
  const dictation = useCodexCapability("dictation")
  const permission = useCodexCapability("permission-tiers")
  const [approvalTierLabel, setApprovalTierLabel] = useState<string | null>(null)
  // audit CX-COMP-02：默认始终是「pi 逐次确认」信息 chip；只有用户显式选了扩展档位才显示档位名
  const approvalLabel = approvalTierLabel ?? "审批 · 逐次确认"
  const approvalTitle = permission.view
    ? `Pi 当前按审批卡逐次确认；策略档位需要扩展：${permission.view.reason}（见 ${permission.view.docsPath}）`
    : "Pi 当前按审批卡逐次确认（无法预先放行）；策略档位由扩展提供"
  const [dictating, setDictating] = useState(false)
  const dictationTimer = useState<number>(() => 0)[0]
  const imageInput = useRef<HTMLInputElement>(null)
  const textInput = useRef<HTMLInputElement>(null)
  const closeAll = () => {
    setAttachOpen(false)
    setApprovalOpen(false)
    setModelOpen(false)
  }
  useCloseOnOutside(attachOpen || approvalOpen || modelOpen, wrap, closeAll, frame.stage)
  const slashQuery = draft.startsWith("/") && !draft.includes("\n") ? draft : null
  const mentionMatch = /(^|\s)@([^\s@]*)$/.exec(draft)
  const mentionQuery = mentionMatch && !slashQuery ? mentionMatch[2] : null
  const queued = relay.queue.steering.length + relay.queue.followUp.length + relay.outbox.length
  const send = () => {
    if (block.button.variant === "stop") {
      void relay.abort()
      return
    }
    if (block.button.disabled || readOnly || !hasContent) return
    void relay.sendText()
  }
  const onComposerEnter = useComposerEnter({
    value: draft,
    setValue: (next) => relay.setDraft(next),
    send,
    canSend: !readOnly && hasContent,
    mobile: phone,
    readOnly,
  })
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQuery && event.key === "Escape") {
      relay.setDraft("")
      return
    }
    onComposerEnter(event)
  }
  const onImagePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ""
    setAttachOpen(false)
    const images = (await Promise.all(files.map(readImageFile))).filter((x): x is SendImage => x != null)
    if (images.length) relay.addPendingImages(images)
  }
  const onTextPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    setAttachOpen(false)
    if (!file) return
    if (file.size > 64 * 1024) {
      relay.notify("文本文件超过 64 KB，没有插入", "warn")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : ""
      if (text) relay.setDraft(`${draft}${draft ? "\n\n" : ""}${text}`)
    }
    reader.readAsText(file)
  }
  const modelData = useCodexCommand(relay.runCommand, modelOpen && commandsReady(relay) ? "get_available_models" : null, undefined, relay.roomId)
  const rows = useMemo(() => (modelData.phase === "ready" ? modelRowsOf(modelData.data, { model: relay.model, modelMeta: relay.modelMeta }) : []), [modelData.phase, modelData.data, relay.model, relay.modelMeta])
  const menuList = useMemo(() => modelMenuListOf(rows, "", () => true), [rows])
  const pickModel = (row: PiModelRow) => {
    if (row.unconfigured) return
    setModelOpen(false)
    void relay.runCommand("set_model", { provider: row.provider, modelId: row.modelId }).catch((error: unknown) => {
      relay.notify(`切换模型失败：${error instanceof Error ? error.message : "命令失败"}`, "warn")
    })
  }
  const hint = readOnly ? "先回答上面的问题" : reason.placeholder
  return (
    <div className="cx-composer-wrap" data-variant={phone ? "phone" : "desktop"} ref={wrap} data-pi-ui-part="composer" data-p4-surface="CX-COMP-01" data-p4-ready="">
      <CodexApprovalDock p={p} phone={phone} />
      <CodexQueue
        queue={relay.queue}
        count={queued}
        onEdit={(id, text) => {
          void relay.queueEdit(id, text)
        }}
        onCancel={(id) => {
          void relay.queueCancel(id)
        }}
      />
      <div className="cx-composer" data-state={relay.composer.state} data-blocked={readOnly ? "" : undefined} data-phone={phone ? "" : undefined}>
        <div className="cx-composer-top">
          {relay.pendingFiles.length > 0 ? (
            <div className="cx-composer-chips" data-p4-surface="CX-THREAD-08" data-p4-ready="" data-p4-partial="文件附件为 composer 引用 chip（Pi 无持久文件附件字段）">
              {relay.pendingFiles.map((file) => (
                <span className="cx-mention-chip" key={file.path} title={`${file.path}（在设备上打开需扩展）`}>
                  {piBaseName(file.path)}
                  <button type="button" aria-label={`移除引用 ${file.path}`} onClick={() => relay.removePendingFile(file.path)}>
                    <X aria-hidden size={10} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {relay.pendingImages.length > 0 ? (
            <div className="cx-composer-thumbs">
              {relay.pendingImages.map((image, index) => (
                <span className="cx-thumb" key={index}>
                  <img src={`data:${image.mimeType};base64,${image.data}`} alt={`待发图片 ${index + 1}`} />
                  <button type="button" aria-label="移除这张图" onClick={() => relay.removePendingImage(index)}>
                    <X aria-hidden size={10} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            className="cx-composer-input"
            value={draft}
            readOnly={readOnly}
            rows={1}
            placeholder={hint}
            aria-label={hint}
            onChange={(event) => relay.setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        <CodexControlRow
          approvalLabel={approvalLabel}
          approvalTitle={approvalTitle}
          approvalState={permission.status}
          dictation={{
            interactive: dictation.interactive,
            status: dictation.status,
            reason: dictation.view?.reason ?? "本机 pi 未提供听写能力",
          }}
          onDictate={() => {
            if (!dictation.interactive) {
              relay.notify(`${dictation.view?.reason ?? "本机 pi 未提供听写能力"}${dictation.view ? `（见 ${dictation.view.docsPath}）` : ""}`, "warn")
              return
            }
            if (dictating) {
              dictation.actions?.stop?.()
              setDictating(false)
              return
            }
            dictation.actions?.start?.()
            setDictating(true)
          }}
          mode={mode}
          approvalOpen={approvalOpen}
          modelName={model.name}
          modelThinking={model.thinking}
          modelOpen={modelOpen}
          ctx={ctx}
          block={block}
          hasContent={hasContent}
          readOnly={readOnly}
          onToggleApproval={() => {
            closeAll()
            setApprovalOpen(true)
          }}
          onToggleAttach={() => {
            closeAll()
            setAttachOpen(true)
          }}
          onToggleModel={() => {
            closeAll()
            setModelOpen(true)
          }}
          onSend={send}
        />
        {reason.note && !readOnly ? (
          <p className="cx-composer-note" data-tone={reason.tone}>
            {reason.note}
          </p>
        ) : null}
        {relay.composer.overLimit ? (
          <p className="cx-composer-note" data-tone="error">
            太长了，最多 100000 字
          </p>
        ) : null}
        {slashQuery ? <CodexSlashMenu p={p} query={slashQuery} onPick={(text) => relay.setDraft(`${text} `)} /> : null}
        {mentionQuery != null ? (
          <CodexMentionMenu
            p={p}
            query={mentionQuery}
            onPickPath={(path) => {
              relay.setDraft(draft.replace(/@([^\s@]*)$/, `@${path} `))
              relay.addPendingFiles([{ path, label: piBaseName(path) }])
            }}
            onPickPlugin={(name) => relay.setDraft(draft.replace(/@([^\s@]*)$/, `${name} `))}
          />
        ) : null}
        {attachOpen ? <CodexAttachTray onImage={() => imageInput.current?.click()} onText={() => textInput.current?.click()} /> : null}
        {approvalOpen ? (
          <div className="cx-composer-pop cx-composer-pop-approval" role="menu" aria-label="权限档位" data-p4-surface="CX-COMP-04" data-capability-state={permission.status} data-p4-ready="">
            <div className="cx-pop-head">审批策略</div>
            <p className="cx-pop-note">Pi 协议只有「逐次确认」：每次敏感操作都会弹审批卡。下面的档位需要扩展提供。</p>
            {(permission.interactive && permission.data?.tiers?.length
              ? permission.data.tiers.map((tier) => ({ key: tier.id, label: tier.label, hint: tier.description ?? "" }))
              : (Object.keys({ auto: 1, read: 1, full: 1 }) as CodexApprovalMode[]).map((key) => ({
                  key,
                  label: key === "auto" ? "自动审查" : key === "read" ? "只读观察" : "完全放行",
                  hint: key === "auto" ? "有风险时才弹审批卡" : key === "read" ? "审批卡只显示，需在电脑上回答" : "全部放行（仅本机显示）",
                }))
            ).map((tier) => {
              const disabled = !permission.interactive
              return (
                <button
                  key={tier.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === tier.key}
                  aria-disabled={disabled || undefined}
                  className="cx-pop-row"
                  data-p4-action="permission-tier"
                  data-capability-state={permission.status}
                  data-pi-capability-disabled={disabled ? "" : undefined}
                  title={disabled ? permission.view?.reason : undefined}
                  onClick={() => {
                    if (disabled) {
                      relay.notify(`权限档位需要 permission-tiers 扩展：${permission.view?.reason ?? "本机 pi 未提供"}${permission.view ? `（见 ${permission.view.docsPath}）` : ""}`, "warn")
                      return
                    }
                    if (permission.actions?.selectTier) permission.actions.selectTier(tier.key)
                    else setMode(tier.key as CodexApprovalMode)
                    setApprovalTierLabel(tier.label)
                    setApprovalOpen(false)
                  }}
                >
                  <span className="cx-pop-row-main">{tier.label}</span>
                  {mode === tier.key ? <span className="cx-pop-check" aria-hidden>✓</span> : null}
                  <span className="cx-pop-row-desc">{tier.hint}</span>
                </button>
              )
            })}
            <p className="cx-pop-note">
              {permission.view ? `${permission.view.reason}（见 ${permission.view.docsPath}）` : "审批卡里真正能答的仍由 Pi 决定；策略档位由扩展记录。"}
            </p>
          </div>
        ) : null}
        {modelOpen ? (
          <CodexModelMenu rows={menuList.list} phase={modelData.phase} onPick={pickModel} hiddenCount={menuList.hiddenUnconfigured} />
        ) : null}
        {modelData.phase === "loading" && modelOpen ? <span className="cx-model-loading"><CodexSpinner size={11} /></span> : null}
      </div>
      {dictating ? (
        <div className="cx-dictation" data-p4-surface="CX-XCUT-02" data-p4-ready="" role="status">
          <span className="cx-dictation-wave" aria-hidden>
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="cx-dictation-timer">{dictationTimer > 0 ? `${dictationTimer}s` : "正在听写…"}</span>
          <button type="button" className="cx-dictation-stop" data-p4-action="dictation-stop" onClick={() => { dictation.actions?.stop?.(); setDictating(false) }}>
            停止
          </button>
        </div>
      ) : null}
      <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(event) => void onImagePick(event)} />
      <input ref={textInput} type="file" accept=".txt,.md,.json,.csv,.log" hidden onChange={onTextPick} />
    </div>
  )
}
