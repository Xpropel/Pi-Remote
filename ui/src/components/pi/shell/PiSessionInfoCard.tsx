import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { InlineLink, MenuSurface } from "@/components/kit"
import { Activity, Box, Database, Folder, GitBranch, Hash } from "@/components/kit/icons"
import { PiContextRing, PiPlatformIcon, piPercent, piShortId, piTokens, type PiDevice, type PiUsageState } from "@/components/pi/shared"
import { cacheHitOf } from "@/pi/model/sessionInfo"

export interface PiSessionInfoCardProps {
  variant: "desktop" | "phone"
  title: string
  /** 会话所在设备；没有名册（旧 relay）时不传，设备行整行不出现 */
  device?: PiDevice | null
  /** get_git_branch 的结果；null / 不传 = 整行不出现 */
  branch?: string | null
  cwd: string
  /** "Claude Sonnet 4.5 · medium"；还不知道模型时不传，整行不出现 */
  model?: string | null
  usage: PiUsageState
  sessionId: string
  /** 一行实时状态全句（设计 D §2.2 的 roomStatusLine 输出；容器按当前房间算）。不传/空 = 状态行不出现 */
  statusLine?: string | null
  /** P5：点"用量明细"（开用量弹窗，c 线 PI_UI_IDS.usage）。不传 = 静态链接 */
  onUsage?: () => void
  className?: string
}

interface Row {
  key: string
  icon: ReactNode
  text: ReactNode
  mono?: boolean
}

/** 上下文窗口可信：有窗口大小和百分比（contextUsage.percent 是百分点） */
function contextOf(usage: PiUsageState) {
  const c = usage.contextUsage
  const trusted = !!c && c.contextWindow != null && c.contextWindow > 0 && c.percent != null
  return { c, trusted }
}

/** 缓存命中 = cacheRead / (input + cacheRead)；缺数就不写（P5：口径只在 pi/model/sessionInfo.ts 一处） */
function cacheHit(usage: PiUsageState): number | null {
  return cacheHitOf(usage.tokens)
}

/**
 * 会话信息（design B06 / K09 / E13；compose from kit: MenuSurface(elevation popover), InlineLink；参照 ch2/SessionHoverCard + PiContextRing）。
 * Adds device, cache-hit and session-id rows over the Cursor hover card. Desktop = title hover card (320 wide); phone = the same rows inside a sheet (44 row height).
 * 数据缺失的行整行不出现（§1.9）。
 */
export function PiSessionInfoCard({ variant, title, device, branch, cwd, model, usage, sessionId, statusLine, onUsage, className }: PiSessionInfoCardProps) {
  const phone = variant === "phone"
  const iconSize = phone ? 18 : 14
  const { c, trusted } = contextOf(usage)
  const hit = cacheHit(usage)
  const rows: Row[] = []
  // 设计 D §2.2：信息卡与侧栏共用同一句状态行（roomStatusLine），放首行（"现在怎么样"最先看）
  if (statusLine) rows.push({ key: "status", icon: <Activity size={iconSize} strokeWidth={1.5} />, text: statusLine })
  if (device) {
    rows.push({
      key: "device",
      icon: <PiPlatformIcon platform={device.platform} size={iconSize} className="text-(--cw-text-3)" />,
      text: `${device.name} · ${device.online ? "在线" : "未连接"}`,
    })
  }
  if (branch) rows.push({ key: "branch", icon: <GitBranch size={iconSize} strokeWidth={1.5} />, text: branch })
  if (cwd) rows.push({ key: "cwd", icon: <Folder size={iconSize} strokeWidth={1.5} />, text: cwd, mono: false })
  if (model) rows.push({ key: "model", icon: <Box size={iconSize} strokeWidth={1.5} />, text: model })
  if (c) {
    rows.push({
      key: "context",
      icon: <PiContextRing percent={c.percent ?? null} trusted={trusted} size={phone ? 16 : 13} />,
      text: trusted
        ? `上下文 ${piPercent(c.percent ?? 0)}% · ${piTokens(c.tokens ?? 0)} / ${piTokens(c.contextWindow ?? 0)}`
        : `上下文 ${c.tokens != null ? piTokens(c.tokens) : "—"} tokens`,
    })
  }
  // Fees are never shown on any usage surface (owner's ruling); the row
  // carries the cache-hit rate instead and appears only when it is known.
  if (hit != null) {
    rows.push({
      key: "cache",
      icon: <Database size={iconSize} strokeWidth={1.5} />,
      text: `缓存命中 ${hit}%`,
    })
  }
  rows.push({ key: "session", icon: <Hash size={iconSize} strokeWidth={1.5} />, text: `会话 ${piShortId(sessionId)}` })

  if (phone) {
    return (
      <div data-pi-session-info="phone" className={cn("flex flex-col px-2", className)}>
        {/* sheet 自己的标题是「会话信息」：会话名降一档（16/500），不和它抢 */}
        <div className="pb-2.5 text-[16px] leading-[22px] font-medium text-(--cw-text)">{title}</div>
        {rows.map((row) => (
          <div
            key={row.key}
            data-pi-info-row={row.key}
            className="flex h-11 min-w-0 items-center gap-3 border-t border-solid border-(--cw-divider) text-[15px] text-(--cw-text-2)"
          >
            <span className="flex w-5 shrink-0 items-center justify-center text-(--cw-text-3)">{row.icon}</span>
            <span className="min-w-0 truncate">{row.text}</span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <MenuSurface
      data-pi-session-info="desktop"
      elevation="popover"
      className={cn("w-80 gap-0 px-3 pt-2.5 pb-2", className)}
    >
      <div className="pb-1.5 text-(length:--cw-text-md) leading-[18px] font-medium text-(--cw-text)">{title}</div>
      {rows.map((row) => (
        <div
          key={row.key}
          data-pi-info-row={row.key}
          className="flex h-[22px] min-w-0 items-center gap-2.5 text-(length:--cw-text-sm) text-(--cw-text-2)"
        >
          <span className="flex w-3.5 shrink-0 items-center justify-center text-(--cw-text-3)">{row.icon}</span>
          <span className="min-w-0 truncate">{row.text}</span>
        </div>
      ))}
      <div className="mt-1.5 border-t border-solid border-(--cw-divider-soft) pt-1.5 text-(length:--cw-text-sm)">
        {/* kit InlineLink 自己 preventDefault，不改地址栏的 hash */}
        <InlineLink href="#usage" onClick={onUsage ? () => onUsage() : undefined}>
          用量明细
        </InlineLink>
      </div>
    </MenuSurface>
  )
}
