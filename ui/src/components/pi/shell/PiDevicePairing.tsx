import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { PaneTabBar } from "@/components/kit"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { Check, KeyRound } from "@/components/kit/icons"
import { PiButton, PiCopyField, PiPlatformIcon, piAgo, piClock, piDuration, type PiDevice } from "@/components/pi/shared"
import { A_PAIR_HINT, aFormatPairCode, aPairCommands } from "./pairing"
import { ASectionLabel, ATextButton, ATokenInput } from "./parts"

/** 已登记设备的第二行灰字（照 relay/devices.ts deviceAuthState 的口径） */
export function aDeviceRosterText(device: PiDevice, now: number): string {
  return aDeviceRosterParts(device, now).join(" · ")
}

/** 同上，分段返回：手机上按段折行（不在「允许目录」中间断开） */
export function aDeviceRosterParts(device: PiDevice, now: number): string[] {
  const parts: string[] = []
  if (device.online) {
    parts.push("在线")
    if (device.auth === "token") parts.push("设备令牌")
    else if (device.auth === "legacy") parts.push("旧令牌连接")
    if (device.windowExpiresAt) parts.push(`窗口剩余 ${piDuration(device.windowExpiresAt - now)}`)
  } else {
    const ago = piAgo(device.lastAttachAt, now)
    parts.push(ago ? `未连接 · ${ago}在线` : "未连接")
    parts.push(device.paired ? "已配对" : "未配对")
  }
  parts.push(`${device.projects.length} 个允许目录`)
  return parts
}

function Section({ title, children, phone, className }: { title: ReactNode; children: ReactNode; phone: boolean; className?: string }) {
  return (
    <section className={cn("flex flex-col", phone ? "py-3" : "py-2.5", className)}>
      <ASectionLabel className="mb-2">{title}</ASectionLabel>
      {children}
    </section>
  )
}

/** P5：管理员令牌一段（可交互）。不传 = 画廊口径"已保存在这个浏览器 · 更换" */
export interface PiPairingAdmin {
  /** 已保存（adminTokenReady）：显示"已保存在这个浏览器 · 更换" */
  saved: boolean
  /** 正在输入（没保存过，或点了"更换"） */
  editing: boolean
  value: string
  onChange: (value: string) => void
  onEdit: () => void
  onSave: () => void
  /** 改到一半不改了（只在已保存时有） */
  onCancel?: () => void
  /** 只保存在本机浏览器的说明（ADMIN_TOKEN_COPY.hint）；没保存时后接"需要管理员令牌…" */
  hint: string
  required: string
}

/** P5：配对码一段（可交互）。不传 = 画廊口径（码有效、等新设备） */
export interface PiPairingFlow {
  creating: boolean
  /** 生成配对码之后新配上的设备名（newlyPaired）：换成"✓ <名字> 已配对"和重启提示 */
  pairedName?: string | null
  /** 配对成功后的说明（relay/devices.ts COPY.pairDone） */
  pairedHint: string
  /** 配对码过期的说明（COPY.pairExpired） */
  expiredText: string
  /** 生成 / 重新生成 / 再添加一台 */
  onGenerate: () => void
  /** 生成 / 撤销失败的红字（adminTokenErrorText 的结果） */
  error?: string | null
}

/** P5：撤销（可交互）。不传 = 每台设备行尾都有红字"撤销"（画廊口径） */
export interface PiPairingRevoke {
  /** 第一次点过、等确认的设备 */
  armedId: string | null
  /** 正在撤销的设备 */
  busyId: string | null
  /** canRevoke(device) 为 false 的不出按钮（未登记设备、没有令牌可作废） */
  canRevoke: (device: PiDevice) => boolean
  /** 没有管理员令牌：按钮禁用 */
  disabled: boolean
  /** 点"撤销"：第一次武装，第二次真的撤 */
  onRevoke: (device: PiDevice) => void
  /** 武装时行下的说明（COPY.revokeExplain） */
  explain: string
}

export interface PiDevicePairingProps {
  variant: "desktop" | "phone"
  devices: PiDevice[]
  /** pair_create 回包：8 位码 + 到期时刻；null = 还没生成（P5：出"生成配对码"） */
  pair: { code: string; expiresAt: number } | null
  now: number
  /** 当前选中的命令页签 */
  commandPlatform?: "unix" | "windows"
  /** P4（可交互，放进可交互 PiDialog 时）：切换命令页签。不传 = 静态（点页签不变） */
  onCommandPlatformChange?: (platform: "unix" | "windows") => void
  /** P5（PairingContainer）：三段的可交互态，见上面三个类型 */
  admin?: PiPairingAdmin
  flow?: PiPairingFlow
  revoke?: PiPairingRevoke
  className?: string
}

/**
 * 设备与配对（design C05；compose from kit: PaneTabBar（命令切换）、Spinner；+ PiCopyField、PiPlatformIcon、文字按钮）。
 * 放进 PiDialog（桌面 560 / 手机全高 sheet）。管理员令牌行 → 配对码（等宽大字 + 倒计时 + 重新生成）→ 命令页签 + 复制框
 * → 等新设备出现 → 已登记的设备（撤销红字，两步确认）。推断：Cursor 没有对应界面。
 * P5：admin / flow / revoke 三组 prop 接上真实动作（PairingContainer）：令牌为空时输入框 + 禁用、未生成 / 过期 / 配对成功、撤销武装。
 * 都不传时就是画廊屏的样子（L1 不变）。管理员令牌只在输入框里，不进日志。
 */
export function PiDevicePairing({
  variant,
  devices,
  pair,
  now,
  commandPlatform = "unix",
  onCommandPlatformChange,
  admin,
  flow,
  revoke,
  className,
}: PiDevicePairingProps) {
  const phone = variant === "phone"
  const adminReady = admin ? admin.saved && !admin.editing : true
  const expired = !!pair && pair.expiresAt - now <= 0
  return (
    <div data-pi-device-pairing="" className={cn("flex flex-col", className)}>
      <Section title="管理员令牌" phone={phone} className="pt-0">
        {admin && (admin.editing || !admin.saved) ? (
          <div data-pi-admin-token="" className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <ATokenInput
                label="管理员令牌"
                placeholder="输入管理员令牌"
                value={admin.value}
                onValueChange={admin.onChange}
                revealLabel="显示令牌"
                autoComplete="off"
                scale={phone ? "lg" : "md"}
                className="min-w-0 flex-1"
              />
              <ATextButton tone="link" touch={phone} disabled={!admin.value.trim()} onClick={admin.onSave}>
                保存
              </ATextButton>
              {admin.saved && admin.onCancel ? (
                <ATextButton touch={phone} onClick={admin.onCancel}>
                  取消
                </ATextButton>
              ) : null}
            </div>
            <p className="m-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">
              {admin.hint}
              {admin.saved ? "" : ` ${admin.required}。`}
            </p>
          </div>
        ) : (
          <div className={cn("flex min-w-0 items-center gap-2 text-(length:--cw-text-md) text-(--cw-text-2)", phone && "min-h-11")}>
            <KeyRound aria-hidden size={phone ? 18 : 14} strokeWidth={1.5} className="shrink-0 text-(--cw-text-3)" />
            <span className="min-w-0 truncate">已保存在这个浏览器</span>
            <span aria-hidden className="text-(--cw-text-4)">·</span>
            <ATextButton tone="link" touch={phone} className="-ml-1" onClick={admin?.onEdit}>
              更换
            </ATextButton>
          </div>
        )}
      </Section>
      <div aria-hidden className="h-px bg-(--cw-divider-soft)" />
      <Section title="配对新设备" phone={phone}>
        {flow?.pairedName ? (
          <div data-pi-pair-done="" role="status" className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-(length:--cw-text-md) font-medium text-(--cw-text)">
              <Check aria-hidden size={phone ? 18 : 16} strokeWidth={2} className="text-(--cw-blue)" />
              {flow.pairedName} 已配对
            </div>
            <p className="m-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">{flow.pairedHint}</p>
            <ATextButton tone="link" touch={phone} disabled={!adminReady || flow.creating} className="-ml-1.5 self-start" onClick={flow.onGenerate}>
              {flow.creating ? "正在生成…" : "再添加一台"}
            </ATextButton>
          </div>
        ) : !pair ? (
          <div data-pi-pair-idle="" className="flex flex-col items-start gap-2">
            <p className="m-0 text-(length:--cw-text-md) leading-[19px] text-(--cw-text-2)">先在这里生成一次性配对码，再到要添加的电脑上运行配对命令。</p>
            <PiButton variant={variant} disabled={!adminReady || !!flow?.creating} onClick={flow?.onGenerate}>
              {flow?.creating ? "正在生成…" : "生成配对码"}
            </PiButton>
          </div>
        ) : (
          <>
            {/* 桌面：码 · 倒计时 · 重新生成 一行；手机放不下三段：码单独一行，倒计时与「重新生成」在下一行 */}
            <div className={cn(phone ? "flex flex-col" : "flex flex-wrap items-center gap-x-3 gap-y-1")}>
              <code
                data-pi-pair-code=""
                className={cn(
                  "font-mono font-semibold tracking-[0.04em]",
                  expired ? "text-(--cw-text-4) line-through" : "text-(--cw-text)",
                  phone ? "text-[32px] leading-[40px]" : "text-[28px] leading-[34px]",
                )}
              >
                {aFormatPairCode(pair.code)}
              </code>
              <div className={phone ? "-mt-0.5 flex items-center gap-2" : "contents"}>
                {/* 倒计时不进 live region（每秒变，design §4.7：倒计时不播报） */}
                <span className={cn("text-(length:--cw-text-md) tabular-nums", expired ? "text-(--cw-pi-error)" : "text-(--cw-pi-text-secondary)")}>
                  {expired && flow ? flow.expiredText : `${piClock(pair.expiresAt - now)} 后过期`}
                </span>
                <ATextButton tone="link" touch={phone} className="-ml-1.5" disabled={flow ? !adminReady || flow.creating : undefined} onClick={flow?.onGenerate}>
                  {flow?.creating ? "正在生成…" : "重新生成"}
                </ATextButton>
              </div>
            </div>
            {expired && flow ? null : (
              <>
                <p className="mt-1 mb-3 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">{A_PAIR_HINT}</p>
                <ASectionLabel className="mb-1.5">在要添加的电脑上运行</ASectionLabel>
                <PairCommands phone={phone} code={pair.code} platform={commandPlatform} onCommandPlatformChange={onCommandPlatformChange} />
                <div className="mt-3 flex items-center gap-2 text-(length:--cw-text-md) text-(--cw-pi-text-secondary)">
                  <PiSpinner size={phone ? 14 : 12} tone="muted" label="等新设备出现" />
                  等新设备出现…
                </div>
              </>
            )}
          </>
        )}
        {flow?.error ? (
          <p role="alert" className="mt-2 mb-0 text-(length:--cw-text-md) leading-[18px] text-(--cw-pi-error)">
            {flow.error}
          </p>
        ) : null}
      </Section>
      <div aria-hidden className="h-px bg-(--cw-divider-soft)" />
      <Section title={`已登记的设备 ${devices.length}`} phone={phone} className="pb-0">
        <ul className="m-0 flex list-none flex-col p-0">
          {devices.map((device) => {
            const armed = revoke?.armedId === device.id
            return (
              <li key={device.id} data-pi-roster={device.id} className="flex flex-col">
                <div className={cn("flex min-w-0 items-center gap-3", phone ? "min-h-[52px] py-1" : "min-h-11 py-1")}>
                  <PiPlatformIcon platform={device.platform} size={phone ? 20 : 16} className="text-(--cw-icon-fg)" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-(length:--cw-text-md) leading-(--cw-leading-tight) text-(--cw-text)">{device.name}</span>
                    {/* 手机上状态行可折成两行（窗口剩余、允许目录数都要看得到），桌面一行截断 */}
                    <span
                      className={cn(
                        "text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)",
                        phone ? "mt-0.5" : "truncate",
                      )}
                    >
                      {phone
                        ? aDeviceRosterParts(device, now).map((part, i, all) => (
                            <span key={i}>
                              <span className="whitespace-nowrap">
                                {part}
                                {i < all.length - 1 ? " ·" : ""}
                              </span>
                              {i < all.length - 1 ? " " : null}
                            </span>
                          ))
                        : aDeviceRosterText(device, now)}
                    </span>
                  </span>
                  {!revoke || revoke.canRevoke(device) ? (
                    <ATextButton
                      tone="danger"
                      touch={phone}
                      disabled={revoke ? revoke.disabled || (revoke.busyId != null && revoke.busyId !== device.id) : undefined}
                      onClick={revoke ? () => revoke.onRevoke(device) : undefined}
                    >
                      {revoke?.busyId === device.id ? "撤销中…" : armed ? "再点一次撤销" : "撤销"}
                    </ATextButton>
                  ) : null}
                </div>
                {armed && revoke ? (
                  <p className="mt-0 mb-1.5 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-error)">{revoke.explain}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      </Section>
    </div>
  )
}

/** 命令页签 + 复制框（macOS / Linux 用 attach.sh，Windows 用 attach.cjs；同 relay/devices.ts pairCommands） */
function PairCommands({
  phone,
  code,
  platform,
  onCommandPlatformChange,
}: {
  phone: boolean
  code: string
  platform: "unix" | "windows"
  onCommandPlatformChange?: (platform: "unix" | "windows") => void
}) {
  const commands = aPairCommands(code)
  const command = commands.find((c) => c.platform === platform) ?? commands[0]
  return (
    <>
      <PaneTabBar
        tabs={commands.map((c) => ({ id: c.platform, label: c.label }))}
        selectedId={command.platform}
        onSelectedIdChange={onCommandPlatformChange && ((id) => onCommandPlatformChange(id === "windows" ? "windows" : "unix"))}
        showNewTab={false}
        showPanelToggle={false}
        className={cn(
          "mb-2 h-auto border-0 bg-transparent p-0",
          phone && "[&_[data-slot=pane-tab]]:h-11 [&_[data-slot=pane-tab]]:rounded-[10px] [&_[data-slot=pane-tab]]:px-3 [&_[data-slot=pane-tab]]:text-[15px]",
        )}
      />
      <PiCopyField value={command.command} />
    </>
  )
}
