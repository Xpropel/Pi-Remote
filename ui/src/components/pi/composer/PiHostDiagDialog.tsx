import type { ReactNode } from "react"
import { PiButton, PiDialog, usePiStatic } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { hostDiagSectionsOf, type HostDiagViewState } from "@/pi/model/hostDiag"
import { PiDialogNote, PiDialogStatus, PiKVRows, PiTextBlock } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"
import { C_SECONDARY, type CVariant } from "./styles"

export interface PiHostDiagDialogProps extends PiFamilyDialogProps {
  /** 弹窗的状态（model/hostDiag.ts 的 hostDiagViewOf）：设备离线 / 加载中 / 不支持 / 出错 / 就绪 */
  view: HostDiagViewState
  /** 出错时的"重试" */
  onRetry?: () => void
  /** 底部"刷新"（重新发 get_host_diag） */
  onRefresh?: () => void
  /** 底部"复制诊断"（只拼白名单字段，model/hostDiag.ts 的 formatHostDiag） */
  onCopy?: () => void
}

function Section({ variant, title, children }: { variant: CVariant; title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col">
      <h3 className={cn("m-0 mb-1 font-normal", variant === "phone" ? "text-[13px] leading-[18px]" : "text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>
        {title}
      </h3>
      {children}
    </section>
  )
}

/** 就绪：版本 / Attach / 最近错误 / 日志尾部四组（分组和写法照旧界面 HostDiagView；缺的字段写"未提供"） */
function DiagBody({ variant, view }: { variant: CVariant; view: Extract<HostDiagViewState, { kind: "ready" }> }) {
  const phone = variant === "phone"
  const s = hostDiagSectionsOf(view.diag)
  const text = phone ? "text-[15px] leading-[22px]" : "text-(length:--cw-text-md) leading-(--cw-leading-base)"
  return (
    <div data-slot="pi-host-diag-body" className="flex flex-col gap-4">
      {view.note && (
        <p role="status" className={cn("m-0", text, C_SECONDARY)}>
          {view.note}
        </p>
      )}
      <Section variant={variant} title="版本">
        <PiKVRows variant={variant} rows={s.version} />
      </Section>
      <Section variant={variant} title="Attach">
        <PiKVRows variant={variant} rows={s.attach} />
      </Section>
      <Section variant={variant} title={`最近错误（${s.errors.length}）`}>
        {s.errors.length ? (
          <ul data-slot="pi-host-diag-errors" className="m-0 flex list-none flex-col p-0">
            {s.errors.map((e) => (
              <li key={e.key} className={cn("flex min-w-0 flex-col gap-0.5 border-b border-solid border-(--cw-divider-soft) py-2 last:border-b-0", text)}>
                <span className="min-w-0 break-words text-(--cw-text)">
                  {e.code && <code className={cn("mr-2 font-(family-name:--cw-font-mono) text-(length:--cw-text-code)", C_SECONDARY)}>{e.code}</code>}
                  {e.message}
                </span>
                {e.time && (
                  <time dateTime={e.iso} className={cn("text-(length:--cw-text-xs) leading-[16px] tabular-nums", C_SECONDARY)}>
                    {e.time}
                  </time>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <PiDialogNote variant={variant}>最近没有记录到错误。</PiDialogNote>
        )}
      </Section>
      <Section variant={variant} title="日志尾部">
        <PiTextBlock variant={variant} text={s.logTail} label="日志尾部" maxHeight={phone ? 320 : 200} />
      </Section>
    </div>
  )
}

/**
 * 主机诊断（design B07「主机诊断进 设置 › 设备 › 某台 › 诊断」；PLAN §7.3 settings / 弹窗家族行，P5 第 2 轮）。
 * 内容和口径照旧界面 conversation/HostDiagView.tsx（纯函数在 pi/model/hostDiag.ts）：get_host_diag 的白名单字段分四组，
 * 日志尾部等宽可滚动、可选中；复制诊断只拼白名单字段。没有数据的情况分开写：设备离线 / 加载中 / 不支持（旧扩展）/ 出错（红字 + 重试），不编字段（§1.9）。
 * 桌面 PiDialog 560（标题下灰字 = 设备名）；手机全高 sheet。版式推断（replica 没有这一屏）：键值行、等宽块、按钮行都是弹窗家族的小件（PiDialogParts）。
 */
export function PiHostDiagDialog({ viewport, open, onOpenChange, static: staticProp, returnFocus, subtitle, view, onRetry, onRefresh, onCopy }: PiHostDiagDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v: CVariant = phone ? "phone" : "desktop"
  const busy = view.kind === "loading" || (view.kind === "ready" && view.refreshing)
  const footer = (
    <>
      <PiButton kind="outline" variant={v} className={cn(phone && "flex-1")} disabled={view.kind !== "ready" || busy} onClick={isStatic ? undefined : onCopy}>
        复制诊断
      </PiButton>
      <PiButton kind="outline" variant={v} className={cn(phone && "flex-1")} disabled={view.kind === "offline" || busy} onClick={isStatic ? undefined : onRefresh}>
        刷新
      </PiButton>
      <PiButton variant={v} className={cn(phone && "flex-1")} onClick={isStatic ? undefined : () => onOpenChange?.(false)}>
        完成
      </PiButton>
    </>
  )
  return (
    <PiDialog
      title="主机诊断"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={560}
      footer={footer}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
    >
      <div data-slot="pi-host-diag-dialog" data-state={view.kind} aria-busy={busy || undefined} className="flex flex-col gap-3 pt-1">
        <PiDialogNote variant={v}>这台电脑上 attach 报来的版本、连接窗口、最近错误和日志尾部。只显示这几项，日志里常见的令牌写法已经遮掉。</PiDialogNote>
        {view.kind === "ready" ? (
          <DiagBody variant={v} view={view} />
        ) : view.kind === "loading" ? (
          <PiDialogStatus variant={v} phase="loading" />
        ) : view.kind === "error" ? (
          <PiDialogStatus variant={v} phase="error" error={view.text} onRetry={onRetry} />
        ) : (
          // 设备离线、不支持：灰字一句原因（不是出错，不给重试）
          <PiDialogStatus variant={v} phase="ready" empty={view.text} />
        )}
      </div>
    </PiDialog>
  )
}
