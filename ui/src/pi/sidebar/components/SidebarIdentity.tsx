import { useEffect, useRef, useState, type ReactNode } from "react"
import { PiMenu } from "@/components/pi/shared"
import { FilterIcon, GearIcon, ServerIcon } from "./icons"

/**
 * 显示选项钮（筛选 / 分组 / 主题）：从钮上方弹出，左缘对齐侧栏左缘 + 8（同画廊屏 c/quick-settings）。
 * 偏移在打开时按钮在侧栏里的位置量出来；打开期间是按下态。
 */
function OptionsButton({ menu, pressed }: { menu: ReactNode; pressed?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // 菜单内容只在打开期间挂载（里面有每秒刷新的时钟），关后留到退出动画播完
  const [mounted, setMounted] = useState(false)
  const [alignOffset, setAlignOffset] = useState(0)
  useEffect(() => {
    if (open || !mounted) return
    const timer = window.setTimeout(() => setMounted(false), 200)
    return () => window.clearTimeout(timer)
  }, [open, mounted])
  return (
    <PiMenu
      side="top"
      align="start"
      sideOffset={6}
      alignOffset={alignOffset}
      onOpenChange={(next) => {
        const el = ref.current
        const bar = el?.closest("[data-pi-sidebar]")?.getBoundingClientRect()
        if (next && el && bar) setAlignOffset(bar.left + 8 - el.getBoundingClientRect().left)
        if (next) setMounted(true)
        setOpen(next)
      }}
      trigger={
        <button
          ref={ref}
          type="button"
          className="sb-iconbtn sb-iconbtn-weak sb-identity-options"
          data-pressed={open || pressed ? "" : undefined}
          aria-label="显示选项"
          title="显示选项"
        >
          <FilterIcon size={16} />
        </button>
      }
    >
      {mounted ? menu : null}
    </PiMenu>
  )
}

/** P11-SIDE-11：底部身份行（中转服务器名 + 显示选项 + 右锚齿轮）；serverName 由宿主/model 归纳。折叠成窄栏时只留齿轮。 */
export function SidebarIdentity({
  serverName,
  serverUrl,
  online,
  settingsShortcut,
  onSettings,
  optionsMenu,
  optionsPressed,
}: {
  serverName: string
  serverUrl?: string
  online: boolean
  settingsShortcut?: string
  onSettings: () => void
  /** 显示选项菜单内容（不给就不出这颗钮） */
  optionsMenu?: ReactNode
  /** 静态对图：显示选项菜单开着 */
  optionsPressed?: boolean
}) {
  return (
    <div className="sb-identity" data-p11-surface="P11-SIDE-11">
      <div className="sb-identity-row">
        <span className="sb-identity-tile" data-online={online ? "" : undefined} aria-hidden>
          <ServerIcon />
        </span>
        <span className="sb-identity-name" title={serverUrl || serverName}>{serverName}</span>
        {online ? null : <span className="sb-identity-state">未连接</span>}
        {optionsMenu != null ? <OptionsButton menu={optionsMenu} pressed={optionsPressed} /> : null}
        <button
          type="button"
          className="sb-iconbtn sb-iconbtn-weak sb-identity-gear"
          aria-label="设置"
          title={settingsShortcut ? `设置（${settingsShortcut}）` : "设置"}
          onClick={onSettings}
        >
          <GearIcon size={16} />
        </button>
      </div>
    </div>
  )
}
