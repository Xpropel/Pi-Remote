import type { PiContainerProps } from "@/pi/containers/types"
import { useGitBranch } from "../model/logic"
import { sessionHeadOf, useRailData, linkSummaryOf } from "../model/view"
import { copyText } from "../model/logic"
import { baseName } from "../model/format"
import { ClaudeButton, ClaudeCopyField, ClaudeSheet } from "../primitives/ClaudePrimitives"
import { ClaudeDeleteDialog, ClaudeRenameDialog } from "./ClaudeSessionDialogs"
import { CLAUDE_OVERLAY } from "./ids"

/**
 * 会话信息（手机点标题的 sheet / 桌面悬浮卡内容）：标题、设备、分支、目录、模型与用量行；缺数据的行整行不出现。
 * 数据：relay 切片 + @/pi/model/sessionInfo 纯函数；渲染自写。
 */
export function ClaudeSessionInfoSheet({ p }: { p: PiContainerProps }) {
  const { relay, ui, act } = p
  const open = ui.sheet?.id === CLAUDE_OVERLAY.sessionInfo
  const head = sessionHeadOf(relay)
  const branch = useGitBranch(relay, !!open && !!relay.roomId)
  const data = useRailData(p)
  if (!open) return null
  const modelLine = [relay.modelMeta?.name || relay.model || "", relay.thinkingLevel || ""].filter(Boolean).join(" · ")
  const usage = relay.usage
  const tokens = usage?.tokens
  return (
    <ClaudeSheet title="会话信息" subtitle={head.title} onClose={() => act.closeSheet()}>
      <div className="claude-sessinfo">
        <div className="claude-sessinfo-row">
          <span className="claude-sessinfo-label">设备</span>
          <span className="claude-sessinfo-value">{head.device ? `${head.device.name}${head.device.online ? "" : " · 未连接"}` : "—"}</span>
        </div>
        {branch ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">分支</span>
            <span className="claude-sessinfo-value claude-mono">{branch}</span>
          </div>
        ) : null}
        {head.cwd ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">目录</span>
            <span className="claude-sessinfo-value claude-mono">{baseName(head.cwd)}</span>
          </div>
        ) : null}
        {modelLine ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">模型</span>
            <span className="claude-sessinfo-value">{modelLine}</span>
          </div>
        ) : null}
        <div className="claude-sessinfo-row">
          <span className="claude-sessinfo-label">上下文</span>
          <span className="claude-sessinfo-value">{data.context.label || "还没有用量"}</span>
        </div>
        {tokens?.total != null ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">用量</span>
            <span className="claude-sessinfo-value">{tokens.total} tok</span>
          </div>
        ) : null}
        {relay.roomId ? <ClaudeCopyField value={relay.roomId} label="复制会话 ID" /> : null}
        <div className="claude-sessinfo-actions">
          <ClaudeButton kind="outline" onClick={() => act.openSheet({ id: CLAUDE_OVERLAY.rename, arg: relay.roomId })} disabled={!relay.roomId}>
            重命名
          </ClaudeButton>
          <ClaudeButton
            kind="outline"
            onClick={() => {
              if (head.cwd) copyText(relay, head.cwd, "已复制工作目录")
            }}
            disabled={!head.cwd}
          >
            复制目录
          </ClaudeButton>
        </div>
      </div>
      {linkSummaryOf(relay).kind !== "ok" ? <p className="claude-dialog-hint">{linkSummaryOf(relay).text}</p> : null}
      <ClaudeDeleteDialog p={p} />
      <ClaudeRenameDialog p={p} />
    </ClaudeSheet>
  )
}

/**
 * 桌面会话信息悬浮卡（[C-图8①] 会话胶囊的悬停卡）：标题 / 设备 / 分支 / 目录 / 模型 / 上下文 / 用量 + 复制。
 * 纯增量自有组件：鼠标悬停标题栏胶囊时显示，不影响点击打开会话菜单。
 */
export function ClaudeSessionHoverCard({ p }: { p: PiContainerProps }) {
  const { relay, act } = p
  const head = sessionHeadOf(relay)
  const branch = useGitBranch(relay, relay.roomId !== "")
  const data = useRailData(p)
  const modelLine = [relay.modelMeta?.name || relay.model || "", relay.thinkingLevel || ""].filter(Boolean).join(" · ")
  const tokens = relay.usage?.tokens
  return (
    <div className="claude-hovercard" data-pi-ui-part="panel" role="dialog" aria-label="会话信息">
      <p className="claude-hovercard-title">{head.title || "Pi-Remote"}</p>
      <div className="claude-sessinfo">
        <div className="claude-sessinfo-row">
          <span className="claude-sessinfo-label">设备</span>
          <span className="claude-sessinfo-value">{head.device ? `${head.device.name}${head.device.online ? "" : " · 未连接"}` : "—"}</span>
        </div>
        {branch ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">分支</span>
            <span className="claude-sessinfo-value claude-mono">{branch}</span>
          </div>
        ) : null}
        {head.cwd ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">目录</span>
            <span className="claude-sessinfo-value claude-mono">{head.cwd}</span>
          </div>
        ) : null}
        {modelLine ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">模型</span>
            <span className="claude-sessinfo-value">{modelLine}</span>
          </div>
        ) : null}
        <div className="claude-sessinfo-row">
          <span className="claude-sessinfo-label">上下文</span>
          <span className="claude-sessinfo-value">{data.context.label || "还没有用量"}</span>
        </div>
        {tokens?.total != null ? (
          <div className="claude-sessinfo-row">
            <span className="claude-sessinfo-label">用量</span>
            <span className="claude-sessinfo-value">{tokens.total} tok</span>
          </div>
        ) : null}
      </div>
      {relay.roomId ? <ClaudeCopyField value={relay.roomId} label="复制会话 ID" /> : null}
      <div className="claude-hovercard-foot">
        <button type="button" className="claude-link-btn" onClick={() => act.openSheet({ id: CLAUDE_OVERLAY.sessionInfo })}>
          会话信息…
        </button>
      </div>
    </div>
  )
}
