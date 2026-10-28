import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react"
import { ArrowUp, AtSign, Check, ChevronDown, LoaderCircle, Paperclip, Shield, Square, X } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { contextReadout } from "@/relay/contextUsage"
import { modelPillName, thinkingLevelZh } from "@/pi/model/models"
import { ClaudeContextRing, ClaudeIconButton, ClaudeMenu, ClaudeMenuItem, ClaudeMenuLabel, ClaudeMenuSeparator, ClaudeSwitch } from "../primitives/ClaudePrimitives"
import { modelShortName } from "../model/format"
import { selectModel, selectThinking, useModelMenuData } from "../model/logic"
import { sessionHeadOf } from "../model/view"
import { usePiUiCapabilities } from "@/pi/extensions"
import { useComposerEnter } from "@/pi/headless/useComposerEnter"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"
import { ClaudeCapabilitySheet } from "../overlays/ClaudeCapabilitySheet"
import { bytesText } from "../model/format"

/**
 * Claude v2 自有 composer（§1.8 [C-图9⑤] / C-01-5：S3 白盒、20 圆角、44–384 高、阴影公式、
 * 框内「＋ Add content / 模型胶囊 / Thinking」、陶土圆形发送键）。
 * 行为全部自有：草稿（relay.draft/setDraft）、发送（relay.sendText）、停止（relay.abort）、排队（remoteQueue/outbox）、
 * 附件（pendingImages/addPendingImages/removePendingImage）、投递方式（sendMode/setSendMode）、模型 / 思考级别（runCommand + model 纯函数）。
 */

const QUEUE_STATUS_TEXT: Record<string, string> = { pending: "等发送", steering: "插入中", follow_up: "排队中" }

export function ClaudeComposer({ p }: { p: PiContainerProps }) {
  const { relay, ui, variant } = p
  const [modelOpen, setModelOpen] = useState(false)
  const caps = usePiUiCapabilities()
  const head = sessionHeadOf(relay)
  const [capSheet, setCapSheet] = useState<"plugins" | "connectors" | "skills" | null>(null)
  const [tierId, setTierId] = useState<string | null>(null)
  const [suggestionReceipt, setSuggestionReceipt] = useState<string | null>(null)
  const permissionTiers = caps.dataOf("permission-tiers")
  const permissionDisabled = caps.disabledOf("permission-tiers")
  const currentTierId = tierId ?? permissionTiers?.currentTierId ?? null
  const skillsStatus = caps.statusOf("skills")
  const connectorsStatus = caps.statusOf("connectors")
  const pluginsStatus = caps.statusOf("plugins")
  const skillsDisabled = skillsStatus === "unavailable" ? caps.disabledOf("skills") : null
  const connectorsDisabled = connectorsStatus === "unavailable" ? caps.disabledOf("connectors") : null
  const pluginsDisabled = pluginsStatus === "unavailable" ? caps.disabledOf("plugins") : null
  const [queueOpen, setQueueOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const blocked = ui.blockedBy === "approval"
  const modelData = useModelMenuData(relay, modelOpen)
  const composer = relay.composer
  const draft = relay.draft ?? ""
  const images = relay.pendingImages ?? []
  const files = relay.pendingFiles ?? []
  const queueItems = (relay.remoteQueue?.items ?? []).filter((item) => item.status === "pending")
  const outboxItems = relay.outbox ?? []
  const queueCount = queueItems.length + outboxItems.length
  const canSend = composer.canSend && !blocked && (draft.trim().length > 0 || images.length > 0 || files.length > 0)
  const stopVisible = composer.stopVisible && !blocked
  const placeholder = blocked ? "等待授权，先在审批卡上回答" : composer.placeholder || "继续追问…"
  const modelName = modelPillName({ model: relay.model, modelMeta: relay.modelMeta }) ?? "选择模型"
  const thinking = relay.thinkingLevel ? thinkingLevelZh(relay.thinkingLevel) : ""
  const context = contextReadout((relay.usage?.contextUsage ?? null) as Parameters<typeof contextReadout>[0])
  const mayStop = relay.busy && relay.authed
  const action = stopVisible || mayStop ? "stop" : "send"
  // CL-CODE-19：建议词 ghost text（capability suggestions；生产 disabled 不显示，mock simulated 显示，Tab 接受）
  const suggestionList = caps.statusOf("suggestions") === "unavailable" ? null : (caps.dataOf("suggestions")?.suggestions ?? null)
  const ghost = !suggestionReceipt && suggestionList && suggestionList.length > 0 && draft.trim().length === 0 && !blocked ? suggestionList[0] : null

  const send = () => {
    if (!canSend) return
    void relay.sendText()
  }
  const onComposerEnter = useComposerEnter({
    value: draft,
    setValue: (next) => relay.setDraft(next),
    send,
    canSend,
    mobile: variant === "phone",
    readOnly: blocked,
  })
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onComposerEnter(event)) return
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") {
      setModelOpen(false)
      setQueueOpen(false)
    }
    if (event.key === "Tab" && ghost && draft.trim().length === 0) {
      event.preventDefault()
      caps.actionsOf("suggestions")?.pickSuggestion?.(ghost.id)
      setSuggestionReceipt(`已采用建议：${ghost.text}（${caps.statusOf("suggestions") === "simulated" ? "模拟演示 · 非真实" : "已接入"}）`)
      relay.setDraft(ghost.text)
    }
  }
  const pickImages = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (picked.length === 0) return
    void Promise.all(
      picked.map(
        (file) =>
          new Promise<{ data: string; mimeType: string } | null>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => {
              const result = typeof reader.result === "string" ? reader.result : ""
              const comma = result.indexOf(",")
              if (comma < 0) resolve(null)
              else resolve({ data: result.slice(comma + 1), mimeType: file.type || "image/png" })
            }
            reader.onerror = () => resolve(null)
            reader.readAsDataURL(file)
          }),
      ),
    ).then((all) => {
      const accepted = all.filter((img): img is { data: string; mimeType: string } => img != null)
      if (accepted.length === 0) return
      const added = relay.addPendingImages(accepted)
      if (added < accepted.length) relay.notify(`只加上了 ${added} 张图（数量或体积上限）`, "warn")
    })
  }

  return (
    <div className="claude-composer" data-layered={draft.includes("\n") || images.length > 0 || files.length > 0 ? "true" : "false"} data-blocked={blocked ? "" : undefined}>
      <div className="claude-composer-main">
        {images.length > 0 || files.length > 0 ? (
          <div className="claude-composer-attachments">
            {images.map((image, index) => (
              <div key={`img-${index}`} className="claude-attach-tile" data-p4-row="">
                <img src={`data:${image.mimeType};base64,${image.data}`} alt={`待发图片 ${index + 1}`} />
                <span className="claude-attach-tag">{image.mimeType.split("/")[1]?.toUpperCase() ?? "IMG"}</span>
                <span className="claude-attach-size">{bytesText(Math.round((image.data.length * 3) / 4))}</span>
                <ClaudeIconButton label="移除这张图" icon={<X size={11} strokeWidth={2.25} />} className="claude-attach-remove" onClick={() => relay.removePendingImage(index)} />
              </div>
            ))}
            {files.map((file, index) => (
              <div key={`file-${index}`} className="claude-attach-file">
                <Paperclip size={13} strokeWidth={1.75} aria-hidden />
                <span className="claude-attach-file-name">{file.path.split(/[\\/]/).pop()}</span>
                <ClaudeIconButton label="移除这个引用" icon={<X size={11} strokeWidth={2.25} />} className="claude-attach-remove" onClick={() => relay.removePendingFile(file)} />
              </div>
            ))}
          </div>
        ) : null}
        <div className="claude-composer-inputwrap" data-p4-surface="CL-CODE-19">
        {ghost ? (
          <span className="claude-composer-ghost" aria-hidden>
            {ghost.text}
            <span className="claude-composer-ghost-hint">Tab 接受</span>
          </span>
        ) : null}
        <textarea
          ref={textareaRef}
          className="claude-composer-input"
          value={draft}
          rows={1}
          readOnly={blocked}
          placeholder={placeholder}
          aria-label="给 pi 发消息"
          onChange={(event) => relay.setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          style={{ height: "auto" }}
          onInput={(event) => {
            const el = event.currentTarget
            el.style.height = "auto"
            el.style.height = `${Math.min(200, el.scrollHeight)}px`
          }}
        />
        </div>
      </div>

      <div className="claude-composer-tools">
        <div className="claude-composer-tools-left">
          <span className="claude-composer-env" data-p4-surface="CL-CODE-14" data-p4-ready="" title="环境（设备）与项目文件夹">
            <span className="claude-composer-env-device">{head.device?.name ?? "本机"}</span>
            {head.cwd ? <span className="claude-composer-env-folder">{head.cwd.split(/[\\/]/).pop()}</span> : null}
          </span>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={pickImages} />
          <ClaudeMenu
            side="top"
            align="start"
            width={240}
            trigger={
              <button type="button" className="claude-composer-tool" aria-label="添加图片或文件" disabled={blocked} data-p4-surface="CL-CODE-15">
                <Paperclip size={16} strokeWidth={1.75} aria-hidden />
                <span>Add content</span>
              </button>
            }
          >
            <ClaudeMenuItem onClick={() => fileRef.current?.click()}>添加图片…</ClaudeMenuItem>
            <ClaudeMenuItem data-p4-surface="CL-CODE-15" data-p4-action="mention" title="本机 pi 未提供 @ 提及文件能力；接入扩展后启用">
              <AtSign size={14} strokeWidth={1.75} aria-hidden />@ 提及文件（未接入）
            </ClaudeMenuItem>
            <ClaudeMenuSeparator />
            <ClaudeMenuLabel>扩展能力</ClaudeMenuLabel>
            <ClaudeMenuItem disabled={skillsStatus === "unavailable"} data-p4-surface="CL-CODE-15" data-p4-action="open-skills" {...claudeCapabilityAttrs("skills", skillsStatus)} title={skillsDisabled ? `${skillsDisabled.title}：${skillsDisabled.reason}` : undefined} onClick={() => setCapSheet("skills")}>
              Pi 技能包…（{skillsStatus === "unavailable" ? "本机未提供" : skillsStatus === "simulated" ? "模拟演示" : "可用"}）
            </ClaudeMenuItem>
            <ClaudeMenuItem disabled={connectorsStatus === "unavailable"} data-p4-surface="CL-CODE-15" data-p4-action="open-connectors" {...claudeCapabilityAttrs("connectors", connectorsStatus)} title={connectorsDisabled ? `${connectorsDisabled.title}：${connectorsDisabled.reason}` : undefined} onClick={() => setCapSheet("connectors")}>
              Pi 连接器…（{connectorsStatus === "unavailable" ? "本机未提供" : connectorsStatus === "simulated" ? "模拟演示" : "可用"}）
            </ClaudeMenuItem>
            <ClaudeMenuItem disabled={pluginsStatus === "unavailable"} data-p4-surface="CL-CODE-15" data-p4-action="open-plugins" {...claudeCapabilityAttrs("plugins", pluginsStatus)} title={pluginsDisabled ? `${pluginsDisabled.title}：${pluginsDisabled.reason}` : undefined} onClick={() => setCapSheet("plugins")}>
              Pi 插件…（{pluginsStatus === "unavailable" ? "本机未提供" : pluginsStatus === "simulated" ? "模拟演示" : "可用"}）
            </ClaudeMenuItem>
            <ClaudeMenuSeparator />
            <ClaudeMenuLabel>附件</ClaudeMenuLabel>
            <p className="claude-menu-note">图片会显示在对话里；附件上限与网页端一致。</p>
          </ClaudeMenu>

          <ClaudeMenu
            side="top"
            align="start"
            width={260}
            trigger={
              <button
                type="button"
                className="claude-composer-tool"
                aria-label="权限模式"
                data-p4-surface="CL-CODE-16"
                data-p4-action="permission-open"
                {...claudeCapabilityAttrs("permission-tiers", caps.statusOf("permission-tiers"))}
                title={permissionDisabled ? `${permissionDisabled.title}：${permissionDisabled.reason}（${permissionDisabled.docsPath}）` : "权限模式"}
              >
                <Shield size={15} strokeWidth={1.75} aria-hidden />
                <span>{currentTierId ? (permissionTiers?.tiers.find((tier) => tier.id === currentTierId)?.label ?? "权限") : "权限"}</span>
              </button>
            }
          >
            {permissionTiers ? (
              permissionTiers.tiers.map((tier) => (
                <ClaudeMenuItem
                  key={tier.id}
                  onClick={() => {
                    setTierId(tier.id)
                    caps.actionsOf("permission-tiers")?.selectTier?.(tier.id)
                  }}
                  data-p4-action="permission-tier"
                >
                  <span className="claude-menu-item-label">{tier.label}</span>
                  {tier.id === currentTierId ? <Check size={13} strokeWidth={2} aria-hidden className="claude-menu-item-chevron" /> : null}
                </ClaudeMenuItem>
              ))
            ) : (
              <ClaudeMenuItem disabled data-p4-action="permission-tier">{permissionDisabled ? `${permissionDisabled.title}（${permissionDisabled.reason}）` : "权限模式"}</ClaudeMenuItem>
            )}
            {permissionDisabled ? <p className="claude-menu-note">{permissionDisabled.hint} {permissionDisabled.docsPath}</p> : null}
          </ClaudeMenu>
          <span className="claude-composer-model-wrap">
            <button
              type="button"
              className="claude-composer-model"
              aria-label={`模型 ${modelName}${thinking ? `，思考级别 ${thinking}` : ""}，切换模型`}
              onClick={() => setModelOpen((v) => !v)}
              disabled={blocked}
              data-open={modelOpen ? "" : undefined}
            >
              <span className="claude-composer-model-name">{modelName}</span>
              {thinking ? <span className="claude-composer-thinking">{thinking}</span> : <ChevronDown size={12} strokeWidth={2} aria-hidden />}
            </button>
            <ClaudeSwitch
              checked={relay.thinkingLevel !== "" && relay.thinkingLevel !== "off" && relay.thinkingLevel !== "none"}
              onChange={() => {
                const next = relay.thinkingLevel === "" || relay.thinkingLevel === "off" || relay.thinkingLevel === "none" ? "medium" : "off"
                selectThinking(relay, next)
              }}
              label="Thinking"
            />
          </span>
          {files.length > 0 ? <span className="claude-composer-filecount">{files.length} 个引用</span> : null}
        </div>

        <div className="claude-composer-tools-right">
          {queueCount > 0 ? (
            <button type="button" className="claude-composer-queuepill" onClick={() => setQueueOpen((v) => !v)} aria-expanded={queueOpen}>
              队列 {queueCount}
            </button>
          ) : null}
          {relay.sendMode === "follow_up" ? <span className="claude-composer-delivery">排队</span> : null}
          <span className="claude-composer-context" title={context.title || "上下文用量"}>
            <ClaudeContextRing percent={contextPercentOf(context)} size={18} />
            {context.label ? <span>{context.label.replace(/^上下文\s*/, "")}</span> : null}
          </span>
          {action === "stop" ? (
            <button type="button" className="claude-send-btn claude-send-stop" aria-label="停止" onClick={() => void relay.abort()}>
              <Square size={12} strokeWidth={2.5} aria-hidden />
            </button>
          ) : (
            <button type="button" className="claude-send-btn" aria-label={canSend ? "发送" : "发送（不可用）"} aria-disabled={!canSend} disabled={!canSend} onClick={send}>
              <ArrowUp size={16} strokeWidth={2.25} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {modelOpen ? (
        <div className="claude-composer-popover" role="dialog" aria-label="模型与思考">
          <div className="claude-composer-popover-head">
            <span className="claude-composer-popover-title">模型与思考</span>
            <ClaudeIconButton label="关闭" icon={<X size={13} strokeWidth={2} />} className="claude-icon-btn-sm" onClick={() => setModelOpen(false)} />
          </div>
          {modelData.loading ? <p className="claude-menu-note">正在读取模型清单…</p> : null}
          {modelData.rows.map((row) => (
            <button
              key={row.key}
              type="button"
              className="claude-model-row"
              data-current={row.current ? "" : undefined}
              disabled={row.unconfigured}
              onClick={() => {
                selectModel(relay, row)
                setModelOpen(false)
              }}
            >
              <span className="claude-model-row-main">
                <span className="claude-model-row-name">{modelShortName(row.name)}</span>
                {row.spec ? <span className="claude-model-row-spec">{row.spec}</span> : null}
                {row.unconfigured ? <span className="claude-model-row-spec">未配置</span> : null}
              </span>
              {row.current ? <Check size={14} strokeWidth={2} className="claude-model-row-check" aria-hidden /> : null}
            </button>
          ))}
          {modelData.segments.length > 0 ? (
            <>
              <div className="claude-menu-sep" role="separator" />
              <p className="claude-menu-label">思考级别</p>
              <div className="claude-thinking-seg">
                {modelData.segments.map((segment) => (
                  <button
                    key={segment.value}
                    type="button"
                    className="claude-thinking-seg-item"
                    data-active={segment.value === relay.thinkingLevel ? "" : undefined}
                    onClick={() => {
                      selectThinking(relay, segment.value)
                      setModelOpen(false)
                    }}
                  >
                    {segment.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {queueOpen && queueCount > 0 ? (
        <div className="claude-composer-popover claude-queue-panel" role="dialog" aria-label="排队">
          <div className="claude-composer-popover-head">
            <span className="claude-composer-popover-title">排队</span>
            <ClaudeIconButton label="关闭" icon={<X size={13} strokeWidth={2} />} className="claude-icon-btn-sm" onClick={() => setQueueOpen(false)} />
          </div>
          {queueItems.map((item) => (
            <div key={item.id} className="claude-queue-row">
              <span className="claude-queue-text">{item.text}</span>
              <span className="claude-queue-status">{QUEUE_STATUS_TEXT[item.status] ?? item.status}</span>
              <div className="claude-queue-actions">
                <button type="button" className="claude-link-btn" onClick={() => void relay.queueSendNow(item.id)}>
                  立即发送
                </button>
                <button type="button" className="claude-link-btn" onClick={() => void relay.queueCancel(item.id).catch(() => relay.notify("取消失败", "warn"))}>
                  取消
                </button>
              </div>
            </div>
          ))}
          {outboxItems.map((entry) => (
            <div key={entry.cid} className="claude-queue-row">
              <span className="claude-queue-text">{entry.text}</span>
              <span className="claude-queue-status">{entry.status === "failed" ? "回放失败" : "等重连后发送"}</span>
              <div className="claude-queue-actions">
                {entry.status === "failed" ? (
                  <button type="button" className="claude-link-btn" onClick={() => relay.outboxRetry(entry.cid)}>
                    重试
                  </button>
                ) : null}
                <button type="button" className="claude-link-btn" onClick={() => relay.outboxCancel(entry.cid)}>
                  取消
                </button>
              </div>
            </div>
          ))}
          <p className="claude-queue-hint">忙时投递方式：{relay.sendMode === "follow_up" ? "排队到下一个回合" : "插入当前回合"}。在设置里可改。</p>
        </div>
      ) : null}

      <div className="claude-composer-status">
        <span className="claude-composer-status-text" role="status" data-p4-surface="CL-CODE-19" data-p4-receipt={suggestionReceipt ? "" : undefined}>
          {blocked ? "等待授权 · 先在卡上回答" : suggestionReceipt ? suggestionReceipt : composer.state === "S2" ? "发送中…" : composer.canType === false ? placeholder : ""}
        </span>
        <span className="claude-composer-status-right">{relay.busy ? <LoaderCircle size={12} className="claude-spin" aria-hidden /> : null}</span>
      </div>
      {capSheet ? <ClaudeCapabilitySheet capability={capSheet} onClose={() => setCapSheet(null)} /> : null}
    </div>
  )
}

function contextPercentOf(context: ReturnType<typeof contextReadout>): number | null {
  return context.percent
}

/** 状态行里的一句：忙时的投递方式 + 最近用量（桌面 dock 下方 / 手机状态行） */

/** 附件磁贴尺寸（§0.3-4：128×96 横向缩略图；这里按 48×48 的输入条磁贴展示，点开可看原图） */

/** 当前正在跑的回合用时（status line / 运行行共用） */
