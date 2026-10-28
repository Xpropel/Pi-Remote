import { useRef, useState } from "react"
import { ChevronDown, Plus, Search, Settings, SquarePen } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { sessionHeadOf } from "../model/view"
import { ClaudeDot, ClaudeIconButton, ClaudeMenu } from "../primitives/ClaudePrimitives"
import { ClaudeSessionMenuItems } from "../overlays/ClaudeSessionDialogs"
import { ClaudeSessionHoverCard } from "../overlays/ClaudeSessionInfoCard"
import { ClaudePlatformTabs } from "./ClaudePlatformTabs"
import { claudeDotOf } from "../model/logic"

/**
 * Claude v2 自有标题栏（C-01-1 / [C-图8①]）：46px、品牌位 74px、中央 999 会话胶囊（状态点 · 设备 · 会话 · ▾）、
 * 右侧 ⌘K / 新建 / 设置 16px 细线图标；S0 底 + 下 1px 双环。
 */

export function ClaudeTitleBar({ p }: { p: PiContainerProps }) {
  const { relay, ui, act } = p
  const head = sessionHeadOf(relay)
  const dot = claudeDotOf(p)
  const hasSession = ui.view === "session" && !!relay.roomId
  const [hover, setHover] = useState(false)
  const hoverTimer = useRef<number | undefined>(undefined)
  const schedule = () => {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHover(true), 260)
  }
  const cancel = () => {
    window.clearTimeout(hoverTimer.current)
    setHover(false)
  }
  const pill = (
    <button type="button" className="claude-session-pill" aria-label="会话菜单" data-dot={dot} data-p4-surface="CL-SHELL-02" data-p4-action="open-session-info">
      <ClaudeDot kind={dot} />
      <span className="claude-session-pill-title">{head.title || "Pi-Remote"}</span>
      <span className="claude-session-pill-sub">{head.device?.name ?? "未选择设备"}{relay.online ? " · 在线" : " · 未连接"}</span>
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="claude-session-pill-caret" />
    </button>
  )
  return (
    <header data-pi-ui-part="titlebar" className="claude-titlebar" data-p4-surface="CL-SHELL-01" data-p4-ready="">
      <div className="claude-titlebar-brand">
        <span aria-hidden className="claude-mark">
          ✳
        </span>
        <span className="claude-wordmark">Pi-Remote</span>
        <ClaudePlatformTabs p={p} />
      </div>
      <div className="claude-titlebar-center">
        {hasSession ? (
          <span className="claude-hover-wrap" onMouseEnter={schedule} onMouseLeave={cancel} onPointerDown={cancel}>
            <ClaudeMenu align="center" width={250} trigger={pill}>
              <ClaudeSessionMenuItems p={p} rowId={relay.roomId} />
            </ClaudeMenu>
            {hover ? <ClaudeSessionHoverCard p={p} /> : null}
          </span>
        ) : (
          <span className="claude-session-pill claude-session-pill-empty">
            <ClaudeDot kind="idle" />
            <span className="claude-session-pill-title">Pi-Remote</span>
          </span>
        )}
      </div>
      <div className="claude-titlebar-actions">
        <span hidden data-p4-surface="CL-SHELL-06" data-p4-ready="" data-capability-state="simulated" title="窗口状态图标：web 版装饰，默认不渲染" aria-hidden />
        <ClaudeIconButton label="搜索与命令 ⌘K" icon={<Search size={16} strokeWidth={1.5} />} className="claude-iconbtn" onClick={() => act.setPaletteOpen(true)} />
        <ClaudeIconButton label="新建会话 ⇧⌘O" icon={<SquarePen size={16} strokeWidth={1.5} />} className="claude-iconbtn" onClick={act.newSession} />
        <ClaudeIconButton label="设置 ⌘," icon={<Settings size={16} strokeWidth={1.5} />} className="claude-iconbtn" onClick={act.openSettings} />
      </div>
    </header>
  )
}

/** 手机列表页顶栏：衬线字标 + 陶土「＋」；对话页用 ClaudePhoneChat 里的顶栏 */
export function ClaudePhoneListTopBar({ p }: { p: PiContainerProps }) {
  const { act } = p
  return (
    <div data-pi-ui-part="titlebar" className="claude-phone-topbar">
      <span className="claude-phone-brand">
        <span aria-hidden className="claude-mark">
          ✳
        </span>
        <span className="claude-phone-wordmark">Pi-Remote</span>
      </span>
      <button type="button" className="claude-phone-new" aria-label="新建会话" onClick={act.newSession}>
        <Plus size={18} strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}
