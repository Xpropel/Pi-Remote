import { GhostIconButton } from "@/components/kit"
import { ArrowDownToLine, Copy, ListOrdered } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { piDuration } from "@/components/pi/shared/format"
import { PiTerminalCard, type PiTerminalStatus } from "./PiTerminalCard"
import { T_SECONDARY, TOUCH_44 } from "./styles"
import type { PiTerminalItem } from "@/components/pi/shared/types"

export interface PiTerminalPaneProps {
  items: readonly PiTerminalItem[]
  now: number
  variant: "desktop" | "phone"
  /** 展开的命令 id（默认：运行中的那条） */
  openIds?: readonly string[]
  /** 行号开关（桌面默认开，手机默认关） */
  lineNumbers?: boolean
  /** 画不画自带的工具行（默认画）；手机推入页传 false，改把 PiTerminalToolbar 放进 PiPhonePage.subHeader（M-10） */
  toolbar?: boolean
  /** 可交互（P5.4）：自带工具行的三个钮 */
  actions?: PiTerminalActions
  className?: string
}

/** 结束后的耗时："0.4s"、"4.5s"、"1m 12s"；运行中 = 已用时 */
function elapsedOf(t: PiTerminalItem, now: number): string | undefined {
  if (t.state === "running") return t.startedAt != null ? piDuration(now - t.startedAt, { zero: true }) : undefined
  const ms = t.durationMs ?? (t.startedAt != null && t.endedAt != null ? t.endedAt - t.startedAt : null)
  if (ms == null) return undefined
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`
  return piDuration(ms, { zero: true })
}

export interface PiTerminalToolbarProps {
  items: readonly PiTerminalItem[]
  variant: "desktop" | "phone"
  /** 行号开关当前是否开着 */
  lineNumbers: boolean
  /** 可交互（P5.4）：工具行三个钮。不传 = 只展示（画廊） */
  actions?: PiTerminalActions
  className?: string
}

/** 终端视图工具行的三个钮（容器给） */
export interface PiTerminalActions {
  onToggleLineNumbers?: () => void
  onCopyOutput?: () => void
  onJumpLatest?: () => void
}

/**
 * 终端视图的工具行（PiTerminalToolbar；compose from kit: GhostIconButton）："本会话 3 条命令 · 1 条在运行"+ 行号 / 复制 / 跳到最新。
 * 桌面由 PiTerminalPane 自己画；手机推入页放进 PiPhonePage.subHeader，钉在顶栏下、不随输出滚走（M-10）。
 */
export function PiTerminalToolbar({ items, variant, lineNumbers, actions, className }: PiTerminalToolbarProps) {
  const phone = variant === "phone"
  const running = items.filter((t) => t.state === "running").length
  return (
    <div
      data-pi-part="terminal-toolbar"
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-(--cw-divider) bg-(--cw-bg)",
        // 手机：三个图标中心相距 52，最右一个离屏幕边 22（点击区 44×44 不出屏、相邻隔 8；§4.4；B3、R2-B-m5）
        phone ? "h-11 gap-7 pr-2.5 pl-4" : "h-9 pr-2 pl-3.5",
        className,
      )}
    >
      <span className={cn("min-w-0 flex-1 truncate text-(length:--cw-text-sm)", T_SECONDARY)}>
        本会话 {items.length} 条命令{running > 0 ? ` · ${running} 条在运行` : ""}
      </span>
      <GhostIconButton
        label={lineNumbers ? "隐藏行号" : "显示行号"}
        aria-pressed={lineNumbers}
        icon={<ListOrdered />}
        forced={lineNumbers ? "pressed" : undefined}
        className={cn(phone && TOUCH_44)}
        onClick={actions?.onToggleLineNumbers}
      />
      <GhostIconButton label="复制输出" icon={<Copy />} className={cn(phone && TOUCH_44)} onClick={actions?.onCopyOutput} />
      <GhostIconButton label="跳到最新" icon={<ArrowDownToLine />} className={cn(phone && TOUCH_44)} onClick={actions?.onJumpLatest} />
    </div>
  )
}

/**
 * 终端视图（PiTerminalPane；compose from kit: GhostIconButton；卡片是 PiTerminalCard）。
 * 本会话跑过的命令按先后排，运行中的在最下面、展开并跟随（§1.8：流内卡默认收起，这里是唯一展开输出的地方）。
 * 结束的命令保留 30 秒（失败 60 秒）后移出（states）。整套运行 / 成功 / 失败卡态推断（run-brief ⑦）。
 */
export function PiTerminalPane({ items, now, variant, openIds, lineNumbers, toolbar = true, actions, className }: PiTerminalPaneProps) {
  const phone = variant === "phone"
  const open = new Set(openIds ?? items.filter((t) => t.state === "running").map((t) => t.id))
  const numbers = lineNumbers ?? !phone
  if (items.length === 0) {
    // 还没运行过命令（design terminal-pane states）；结束的命令过了保留期（成功 30 秒、失败 60 秒）也会移出
    return (
      <div data-pi-part="terminal-pane" data-empty="" className={cn("flex min-h-0 flex-1 flex-col items-center justify-center px-6", className)}>
        <div className="text-(length:--cw-text-md) text-(--cw-text-2)">这个会话还没有运行命令</div>
        <div className={cn("mt-1 text-(length:--cw-text-sm)", T_SECONDARY)}>结束的命令保留 30 秒（失败 60 秒）后移出</div>
      </div>
    )
  }
  return (
    <div data-pi-part="terminal-pane" className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {toolbar && <PiTerminalToolbar items={items} variant={variant} lineNumbers={numbers} actions={actions} />}
      <div data-pi-terminal-scroll="" className={cn("min-h-0 flex-1 overflow-y-auto", phone ? "px-3 py-2" : "px-3 py-2")}>
        {items.map((t) => (
          <PiTerminalCard
            key={t.id}
            command={t.command}
            status={t.state as PiTerminalStatus}
            exitCode={t.exitCode}
            elapsed={elapsedOf(t, now)}
            output={t.output}
            stderr={t.stderr}
            truncated={t.outputTruncated}
            open={open.has(t.id)}
            outputMaxHeight={phone ? 420 : 560}
            wrap={phone}
            lineNumbers={numbers}
          />
        ))}
      </div>
    </div>
  )
}
