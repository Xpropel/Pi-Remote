import { cn } from "@/lib/utils"
import { ArrowRight, Folder, LogOut, Plus, Settings } from "@/components/kit/icons"
import { PiButton } from "@/components/pi/shared/PiButton"
import { PiCenteredState } from "@/components/pi/shared/PiFeedback"
import { PiMark, PiPlatformIcon } from "@/components/pi/shared/PiMark"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import type { PiDeviceHubCard } from "@/pi/model/deviceHub"

export interface PiDeviceHubProps {
  variant: "desktop" | "phone"
  relayHost: string
  serverName: string
  relayOnline: boolean
  bootKind: "connecting" | "no-devices" | "all-offline" | "ready"
  pairingSupported: boolean
  cards: readonly PiDeviceHubCard[]
  onSelectDevice: (deviceId: string) => void
  onPairDevice: () => void
  onOpenSettings: () => void
  onEnterWorkspace?: () => void
  onLogout: () => void
  className?: string
}

/**
 * 登录后设备选择中心（桌面居中画布 + 柔和径向光晕；手机嵌入 PiPhonePage 滚动区）。
 * 全组件不写字面色值，视觉细节全部走 --cw-* / --cw-pi-* 令牌与 pi-theme.css。
 */
export function PiDeviceHub({
  variant,
  relayHost,
  serverName,
  relayOnline,
  bootKind,
  pairingSupported,
  cards,
  onSelectDevice,
  onPairDevice,
  onOpenSettings,
  onEnterWorkspace,
  onLogout,
  className,
}: PiDeviceHubProps) {
  const phone = variant === "phone"
  const cleanHost = relayHost?.replace(/:\d+$/, "")
  const showServerName = Boolean(serverName && serverName !== relayHost && serverName !== cleanHost)
  const onlineCount = cards.filter((c) => c.online).length
  const connectingEmpty = bootKind === "connecting" && cards.length === 0
  const showHero = connectingEmpty || cards.length > 0

  const title = connectingEmpty ? "正在同步设备…" : "选择设备"
  const subtitle = connectingEmpty ? null : onlineCount > 0 ? `${onlineCount} 台在线` : `${cards.length} 台离线`

  return (
    <div
      data-pi-device-hub=""
      className={cn(
        "w-full",
        phone ? "pb-6" : "mx-auto max-w-[820px] px-6 py-10 md:px-10 md:py-12",
        className,
      )}
    >
      {/* 顶栏：中转服务身份与快捷控制 */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[14px] border border-(--cw-border) bg-(--cw-surface) shadow-(--cw-shadow-float)">
            <PiMark size={22} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-(length:--cw-text-base) font-semibold text-(--cw-text)">Pi-Remote</span>
              {showServerName ? (
                <>
                  <span className="hidden text-(length:--cw-text-sm) text-(--cw-pi-text-secondary) sm:inline">·</span>
                  <span className="hidden truncate text-(length:--cw-text-sm) text-(--cw-pi-text-secondary) sm:inline">{serverName}</span>
                </>
              ) : null}
            </div>
            <div className="mt-0.5 inline-flex items-center gap-1.5 text-(length:--cw-text-xs) text-(--cw-pi-text-secondary)">
              {relayOnline ? (
                <>
                  <span aria-hidden className="size-1.5 rounded-full bg-(--cw-green-solid)" />
                  <span className="truncate">已连接 {relayHost}</span>
                </>
              ) : (
                <>
                  <PiSpinner size={11} label="正在连接" className="text-(--cw-pi-text-secondary)" />
                  <span className="truncate">正在连接 {relayHost}…</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-pi-hub-action="settings"
            onClick={onOpenSettings}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-(--cw-border) bg-(--cw-surface) px-3.5 text-(length:--cw-text-md) font-medium text-(--cw-text-2) shadow-(--cw-shadow-card) transition hover:border-(--cw-border-strong) hover:bg-(--cw-row-hover) hover:text-(--cw-text) active:scale-[0.98]"
          >
            <Settings size={14} strokeWidth={1.6} aria-hidden />
            <span>设置</span>
          </button>
          <button
            type="button"
            data-pi-hub-action="logout"
            onClick={onLogout}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-(--cw-border) bg-(--cw-surface) px-3.5 text-(length:--cw-text-md) font-medium text-(--cw-pi-text-secondary) shadow-(--cw-shadow-card) transition hover:border-(--cw-border-strong) hover:bg-(--cw-row-hover) hover:text-(--cw-text) active:scale-[0.98]"
          >
            <LogOut size={14} strokeWidth={1.6} aria-hidden />
            <span>退出</span>
          </button>
        </div>
      </header>

      {/* 主标题区 */}
      {showHero && (
        <section className={cn("mt-8", phone ? "mt-6" : "mt-10")}>
          <h1 className="m-0 text-[24px] leading-[32px] font-semibold tracking-[-0.02em] text-(--cw-text) md:text-[28px] md:leading-[36px]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 mb-0 text-(length:--cw-text-base) leading-(--cw-leading-base) text-(--cw-pi-text-secondary)">
              {subtitle}
            </p>
          )}
        </section>
      )}

      {/* 内容区：连接中骨架 / 空态 / 设备卡片网格 */}
      <section className={cn("mt-6", phone ? "mt-5" : "mt-8")} aria-label="设备列表">
        {connectingEmpty ? (
          <div className={cn("grid gap-4", !phone && "md:grid-cols-2")}>
            {[0, 1].map((idx) => (
              <div
                key={idx}
                className="flex flex-col justify-between rounded-[24px] border border-(--cw-border) bg-(--cw-surface) p-5 shadow-(--cw-shadow-card)"
              >
                <div className="flex items-center gap-3.5">
                  <div className="size-11 rounded-[15px] bg-(--cw-pi-skeleton)" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-28 rounded-full bg-(--cw-pi-skeleton)" />
                    <div className="h-3 w-16 rounded-full bg-(--cw-pi-skeleton)" />
                  </div>
                </div>
                <div className="mt-6 flex items-center gap-2">
                  <div className="h-5 w-20 rounded-full bg-(--cw-pi-skeleton)" />
                  <div className="h-5 w-24 rounded-full bg-(--cw-pi-skeleton)" />
                </div>
              </div>
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="rounded-[26px] border border-(--cw-border) bg-(--cw-surface) p-6 shadow-(--cw-shadow-composer) md:p-10">
            <PiCenteredState
              icon={<PiMark size={32} />}
              title={<h1 className="m-0 text-(length:--cw-text-lg) leading-[22px] font-semibold text-(--cw-text)">暂无设备</h1>}
              body={
                <code className="mt-1 inline-block rounded-(--cw-radius-input) border border-(--cw-border) bg-(--cw-bg) px-3 py-1.5 font-(family-name:--cw-font-mono) text-(length:--cw-text-code) text-(--cw-text-2) select-all">
                  deploy/attach.sh --pair &lt;配对码&gt;
                </code>
              }
              actions={
                pairingSupported ? (
                  <PiButton
                    variant={variant}
                    data-pi-hub-action="pair"
                    onClick={onPairDevice}
                    className={cn("gap-1.5 rounded-full px-4", phone && "w-full justify-center")}
                  >
                    <Plus size={14} strokeWidth={2} aria-hidden />
                    <span>生成配对码</span>
                  </PiButton>
                ) : (
                  <PiButton
                    kind="outline"
                    variant={variant}
                    data-pi-hub-action="pair"
                    onClick={onPairDevice}
                    className={cn("rounded-full px-4", phone && "w-full justify-center")}
                  >
                    接入说明
                  </PiButton>
                )
              }
              actionsClassName={phone ? "w-full" : undefined}
              className="w-full"
            />
          </div>
        ) : (
          <div className={cn("grid grid-cols-1 gap-4", !phone && cards.length >= 2 && "md:grid-cols-2")}>
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                data-pi-device-card={card.id}
                data-online={card.online ? "" : undefined}
                data-selected={card.selected ? "" : undefined}
                onClick={() => onSelectDevice(card.id)}
                className="group flex flex-col justify-between rounded-[24px] border border-(--cw-border) bg-(--cw-surface) p-5 text-left transition duration-200 focus-visible:ring-2 focus-visible:ring-(--cw-border-strong) focus-visible:outline-none"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3.5">
                      <div
                        data-pi-hub-icon={card.online ? "online" : "offline"}
                        className={cn(
                          "flex size-11 shrink-0 items-center justify-center rounded-[15px] border border-(--cw-border)/80 transition-colors",
                          card.online ? "bg-(--cw-pi-hub-icon-bg)" : "bg-(--cw-chip-bg)/70",
                        )}
                      >
                        <PiPlatformIcon
                          platform={card.platform}
                          size={20}
                          className={card.online ? "text-(--cw-text)" : "text-(--cw-text-3)"}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[16px] leading-[22px] font-semibold text-(--cw-text)">
                            {card.name}
                          </span>
                        </div>
                        <div className="mt-0.5 text-(length:--cw-text-xs) text-(--cw-pi-text-secondary)">
                          {card.platformLabel}
                        </div>
                      </div>
                    </div>

                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-(--cw-divider-soft) px-2.5 py-1 text-(length:--cw-text-xs) font-medium",
                        card.online
                          ? "bg-(--cw-chip-bg)/70 text-(--cw-green)"
                          : "bg-(--cw-chip-bg)/70 text-(--cw-pi-text-secondary)",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 rounded-full",
                          card.online ? "bg-(--cw-green-solid)" : "bg-(--cw-status-pending)",
                        )}
                      />
                      <span>{card.online ? (card.runningCount > 0 ? "运行中" : "在线") : "离线"}</span>
                    </span>
                  </div>

                  <div className="mt-4 space-y-1.5">
                    <p className="m-0 text-(length:--cw-text-md) font-medium text-(--cw-text-2)">
                      {card.activityLabel}
                    </p>
                    {card.recentTitle && (
                      <p className="m-0 truncate text-(length:--cw-text-sm) text-(--cw-pi-text-secondary)">
                        最近：{card.recentTitle}
                      </p>
                    )}
                  </div>

                  {card.folders.length > 0 && (
                    <div className="mt-3.5 flex flex-wrap gap-1.5">
                      {card.folders.map((folder) => (
                        <span
                          key={folder}
                          className="inline-flex max-w-full items-center gap-1 rounded-full bg-(--cw-chip-bg)/65 px-2.5 py-0.5 text-(length:--cw-text-xs) text-(--cw-text-2)"
                        >
                          <Folder size={11} strokeWidth={1.6} aria-hidden className="shrink-0 text-(--cw-pi-text-secondary)" />
                          <span className="truncate">{folder}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-(--cw-divider-soft) pt-3">
                  <span className="text-(length:--cw-text-sm) font-medium text-(--cw-pi-text-secondary) transition-colors group-hover:text-(--cw-text)">
                    {card.online ? "进入" : "历史会话"}
                  </span>
                  <span className="flex size-7 items-center justify-center rounded-full border border-(--cw-divider-soft) bg-(--cw-chip-bg)/70 text-(--cw-text-2) transition duration-200 group-hover:translate-x-0.5 group-hover:border-transparent group-hover:bg-(--cw-primary) group-hover:text-(--cw-primary-fg)">
                    <ArrowRight size={14} strokeWidth={1.8} aria-hidden />
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* 底部辅助操作条：接入新设备 / 直接进入工作区 */}
        {cards.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            {onEnterWorkspace && (
              <button
                type="button"
                data-pi-hub-action="workspace"
                onClick={onEnterWorkspace}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-(--cw-border) bg-(--cw-surface) px-4 text-(length:--cw-text-md) font-medium text-(--cw-text-2) transition hover:bg-(--cw-row-hover) hover:text-(--cw-text) active:scale-[0.98]"
              >
                <span>进入工作区</span>
              </button>
            )}
            <button
              type="button"
              data-pi-hub-action="pair"
              onClick={onPairDevice}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-(--cw-primary) px-4 text-(length:--cw-text-md) font-medium text-(--cw-primary-fg) transition hover:opacity-90 active:scale-[0.98]"
            >
              <Plus size={14} strokeWidth={2} aria-hidden />
              <span>接入新设备</span>
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
