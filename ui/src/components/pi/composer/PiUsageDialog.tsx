import type { ReactNode } from "react"
import type { PiLayout } from "@/components/pi/shared/viewport"
import {
  PiButton,
  PiContextRing,
  PiDialog,
  piPercent,
  piTokens,
  usePiStatic,
  type PiOverlayControl,
  type PiReturnFocus,
  type PiUsageState,
} from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { C_ERROR, C_SECONDARY } from "./styles"

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-(--cw-radius-card) border border-solid border-(--cw-border) px-3 py-2.5">
      <span className={cn("text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>{label}</span>
      <span className="mt-1 text-[20px] leading-[26px] font-semibold text-(--cw-text) tabular-nums">{value}</span>
      {sub && <span className={cn("text-(length:--cw-text-xs) leading-[16px]", C_SECONDARY)}>{sub}</span>}
    </div>
  )
}

function KV({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-8 min-w-0 items-center justify-between gap-4 border-b border-solid border-(--cw-divider-soft) last:border-b-0">
      <span className={cn("min-w-0 truncate text-(length:--cw-text-md)", C_SECONDARY, mono && "font-(family-name:--cw-font-mono) text-(length:--cw-text-code)")}>
        {label}
      </span>
      <span className="shrink-0 text-(length:--cw-text-md) text-(--cw-text) tabular-nums">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className={cn("m-0 mb-1 text-(length:--cw-text-sm) leading-(--cw-leading-sm) font-normal", C_SECONDARY)}>{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

export interface PiUsageDialogProps extends PiOverlayControl {
  viewport: PiLayout
  usage: PiUsageState
  /** get_session_stats 的计数字段（data-interface §4.11.2）；P5：null = 还没回来或读失败（三格的计数写"—"） */
  stats: { userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number } | null
  /** P4 可交互："刷新"（重新拉 get_session_stats / usage_state） */
  onRefresh?: () => void
  /** P4 可交互：关闭后焦点回哪（默认 = 打开前的焦点元素） */
  returnFocus?: PiReturnFocus
  /** P5：标题下一行灰字（会话名）；不传或 null = 不写（画廊屏自己传示例会话名） */
  subtitle?: ReactNode | null
  /** P5：读取失败的说明：按钮行上方一行红字（design states「读取失败 · 重试」），弹窗不关 */
  error?: string | null
}


/**
 * 用量与费用（G05 G06，/stats + /usage 合并）：三格统计 → 上下文圆环 → token 键值行 → 按模型 → 刷新 / 完成。
 * 数据：get_session_stats（totalMessages、userMessages / assistantMessages、toolCalls / toolResults）+ usage_state
 * （token、费用、costByModel、contextUsage）；三格的分法照现有 ui/src/chat/dialogs.tsx 的 stats 弹窗；不再用绿色进度条。
 * 桌面 = PiDialog 480 居中；手机 = PiDialog 自动变成全高 PiSheet。
 * P4 可交互：PiDialog 的可交互分支（焦点进主按钮"完成"、Tab 圈在卡里、Esc / 点遮罩 / × / 完成关闭，关闭回打开前的焦点）。
 */
export function PiUsageDialog({
  viewport,
  usage,
  stats,
  open,
  onOpenChange,
  static: staticProp,
  onRefresh,
  returnFocus,
  subtitle,
  error,
}: PiUsageDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const t = usage.tokens ?? {}
  const ctx = usage.contextUsage
  const percent = ctx?.percent ?? null
  const trusted = ctx?.contextWindow != null && percent != null
  const hit =
    t.cacheRead != null && t.input != null && t.input + t.cacheRead > 0
      ? Math.round((t.cacheRead / (t.input + t.cacheRead)) * 100)
      : null
  const phone = viewport === "phone"
  const footer = (
    <>
      {error && (
        // 失败时弹窗不关：按钮行上方一行红字（M-04）；按钮照常可点
        <p role="alert" data-slot="pi-dialog-error" className={cn("m-0 mr-auto min-w-0 self-center truncate text-(length:--cw-text-sm)", C_ERROR)}>
          {error}
        </p>
      )}
      <PiButton kind="outline" variant={phone ? "phone" : "desktop"} className={cn(phone && "flex-1")} onClick={isStatic ? undefined : onRefresh}>
        刷新
      </PiButton>
      <PiButton variant={phone ? "phone" : "desktop"} className={cn(phone && "flex-1")} onClick={isStatic ? undefined : () => onOpenChange?.(false)}>
        完成
      </PiButton>
    </>
  )
  const count = (n: number | undefined) => (n != null ? String(n) : "—")
  return (
    <PiDialog
      title="用量与费用"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={480}
      footer={footer}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
    >
      <div data-slot="pi-usage-dialog" className={cn("flex flex-col pt-1", phone && "[&_.min-h-8]:min-h-11")}>
        <div className="flex gap-2">
          <Stat label="消息" value={count(stats?.totalMessages)} sub={stats ? `你 ${stats.userMessages} · pi ${stats.assistantMessages}` : undefined} />
          <Stat label="工具调用" value={count(stats?.toolCalls)} sub={stats ? `结果 ${stats.toolResults}` : undefined} />
          <Stat label="费用" value={usage.cost != null ? `$${usage.cost.toFixed(2)}` : "—"} sub={hit != null ? `缓存命中 ${hit}%` : undefined} />
        </div>
        <Section title="上下文">
          <div className="flex min-h-11 items-center gap-3">
            <PiContextRing percent={percent} trusted={trusted} tokens={ctx?.tokens} size={28} />
            <span className="text-(length:--cw-text-md) text-(--cw-text) tabular-nums">
              {trusted && ctx?.tokens != null && ctx.contextWindow != null
                ? `${piTokens(ctx.tokens)} / ${piTokens(ctx.contextWindow)}（${piPercent(percent ?? 0)}%）`
                : ctx?.tokens != null
                  ? `${piTokens(ctx.tokens)} tokens`
                  : "—"}
            </span>
          </div>
        </Section>
        <Section title="token">
          <KV label="输入" value={t.input != null ? piTokens(t.input) : "—"} />
          <KV label="输出" value={t.output != null ? piTokens(t.output) : "—"} />
          <KV label="缓存读取" value={t.cacheRead != null ? piTokens(t.cacheRead) : "—"} />
          <KV label="缓存写入" value={t.cacheWrite != null ? piTokens(t.cacheWrite) : "—"} />
          <KV label="合计" value={t.total != null ? piTokens(t.total) : "—"} />
        </Section>
        <Section title="按模型">
          {Object.entries(usage.costByModel ?? {}).map(([model, cost]) => (
            <KV key={model} label={model} value={`$${cost.toFixed(2)}`} mono />
          ))}
        </Section>
      </div>
    </PiDialog>
  )
}
