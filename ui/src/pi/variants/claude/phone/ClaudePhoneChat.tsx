import { useState } from "react"
import { ChevronLeft, Ellipsis } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { sessionHeadOf, useRailData, linkSummaryOf } from "../model/view"
import { claudeDotOf } from "../model/logic"
import { ClaudeComposer } from "../composer/ClaudeComposer"
import { ClaudeApprovalCard } from "../approval/ClaudeApprovalCard"
import { ClaudeThread } from "../thread/ClaudeThread"
import { ClaudeDot, ClaudeIconButton, ClaudeMark, ClaudeSheet } from "../primitives/ClaudePrimitives"
import { ClaudeStatusLine } from "../overlays/ClaudeStatusLine"
import { ClaudeNotice } from "../overlays/ClaudeNotice"
import { CLAUDE_OVERLAY } from "../overlays/ids"
import { ClaudePhoneStatusBar } from "../panels/ClaudeStatusRail"
import { ClaudePaneColumn } from "../panels/ClaudeStatusRail"

/**
 * 手机对话页（C-04 / §1.6 推导）：44 顶栏（‹ + 会话胶囊 + …）→ 状态行 / 通知 → 对话流 → 审批卡 → 状态卡一行 → composer。
 * sheet（会话菜单 / 会话信息 / 配对 / 显示选项）由 ClaudeOverlayHost 挂在外壳层。
 */
export function ClaudePhoneChat({ p, onBack }: { p: PiContainerProps; onBack?: () => void }) {
  const { relay, ui, act } = p
  const head = sessionHeadOf(relay)
  const dot = claudeDotOf(p)
  const [statusOpen, setStatusOpen] = useState(false)
  return (
    <div data-pi-ui-part="page" className="claude-phone claude-phone-chat">
      <div data-pi-ui-part="titlebar" className="claude-phone-topbar">
        <ClaudeIconButton label="返回会话列表" icon={<ChevronLeft size={20} strokeWidth={2} />} className="claude-iconbtn" onClick={onBack ?? (() => act.setPhonePage("list"))} />
        <button type="button" className="claude-phone-pill" data-dot={dot} aria-label="会话信息" onClick={() => relay.roomId && act.openSheet({ id: CLAUDE_OVERLAY.sessionInfo })}>
          <ClaudeDot kind={dot} />
          <span className="claude-session-pill-title">{head.title || "Pi-Remote"}</span>
          {head.device ? <span className="claude-session-pill-sub">{head.device.name}</span> : null}
        </button>
        <ClaudeIconButton
          label="会话菜单"
          icon={<Ellipsis size={18} strokeWidth={1.75} />}
          className="claude-iconbtn"
          onClick={relay.roomId ? () => act.openSheet({ id: CLAUDE_OVERLAY.sessionMenu, arg: relay.roomId }) : undefined}
        />
      </div>
      <ClaudeStatusLine p={p} />
      <ClaudeNotice p={p} />
      <div className="claude-phone-scroll claude-phone-thread">
        <ClaudeThread relay={relay} />
      </div>
      {ui.pane ? (
        <div className="claude-phone-pane">
          <ClaudePaneColumn p={p} onClose={() => act.setPane(null)} />
        </div>
      ) : null}
      <div className="claude-phone-approval">
        <ClaudeApprovalCard p={p} />
      </div>
      <ClaudePhoneStatusBar p={p} onOpen={() => setStatusOpen(true)} />
      <div data-pi-ui-part="composer" className="claude-phone-dock">
        <ClaudeComposer p={p} />
      </div>
      {statusOpen ? <ClaudePhoneStatusSheet p={p} onClose={() => setStatusOpen(false)} /> : null}
    </div>
  )
}

/** 手机状态卡 sheet（C-04-3：点开含 ≥3 张状态卡：环境 / 上下文 / 变更 / 任务） */
function ClaudePhoneStatusSheet({ p, onClose }: { p: PiContainerProps; onClose: () => void }) {
  const data = useRailData(p)
  const head = sessionHeadOf(p.relay)
  const link = linkSummaryOf(p.relay)
  return (
    <ClaudeSheet title="会话状态" onClose={onClose}>
      <div className="claude-sheet-body-cards">
        <section className="claude-card">
          <h2 className="claude-card-title">环境</h2>
          <p className="claude-card-row">
            <ClaudeMark size={12} />
            <span className="claude-card-value">{data.deviceLine}</span>
          </p>
          {head.cwd ? <p className="claude-card-sub">{head.cwd}</p> : null}
        </section>
        <section className="claude-card">
          <h2 className="claude-card-title">上下文</h2>
          <p className="claude-card-value">{data.context.label || "还没有用量"}</p>
        </section>
        <section className="claude-card">
          <h2 className="claude-card-title">变更</h2>
          {data.changes ? (
            <p className="claude-card-row">
              <span className="claude-diffstat">
                <span className="claude-diffstat-add">+{data.changes.added}</span>
                <span className="claude-diffstat-del">−{data.changes.removed}</span>
              </span>
              <span className="claude-card-sub">{data.changes.files} 个文件</span>
            </p>
          ) : (
            <p className="claude-card-empty">还没有改动</p>
          )}
        </section>
        <section className="claude-card">
          <h2 className="claude-card-title">任务 / 服务器</h2>
          <p className="claude-card-sub">
            {data.tasks.total > 0 ? `任务 ${data.tasks.done}/${data.tasks.total}` : "没有任务清单"} · {link.text}
          </p>
        </section>
      </div>
    </ClaudeSheet>
  )
}
