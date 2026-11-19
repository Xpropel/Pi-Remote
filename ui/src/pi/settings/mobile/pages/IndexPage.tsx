/**
 * 手机端设置 · 首页（列表入口）。
 *
 * 设计：board-mobile.png 第一张 / m-settings-index.png。三张卡 + 唯一分组标题「移动端」。
 * 12 个入口对应 12 个内容界面；首页自身是第 13 个界面（title=设置）。
 */
import { useEffect, useState } from "react"
import { ArrowUpCircle, PanelLeft, RotateCw } from "lucide-react"
import { useNow } from "@/pi/hooks/useNow"
import { useSettings } from "../../SettingsContext.tsx"
import { settingsPiRestartBannerOf } from "../../pages/settingsPiRestart.ts"
import { settingsPiUpdateRowOf } from "../../pages/settingsPiUpdate.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "../../pages/useSettingsPiRestart.tsx"
import { SettingsPiUpdateDialog, useSettingsPiUpdate } from "../../pages/useSettingsPiUpdate.tsx"
import { SETTINGS_PAGE_META } from "../../types.ts"
import { SettingsIcon } from "../../ui.tsx"
import { MobileActionRow, MobileCard, MobileGroup, MobilePageBody } from "../atoms.tsx"
import {
  MOBILE_INDEX_GROUPS,
  MOBILE_SETTINGS_PAGE_LABELS,
  type MobileSettingsDestination,
  type MobileSettingsPageId,
} from "../types.ts"

function EntryIcon({ page }: { page: MobileSettingsDestination }) {
  if (page === "interaction") {
    return <PanelLeft size={17} strokeWidth={1.8} aria-hidden="true" className="sm-index-icon" />
  }
  return <SettingsIcon name={SETTINGS_PAGE_META[page].icon} size={17} />
}

export function MobileIndexPage({ onNavigate }: { onNavigate: (page: MobileSettingsPageId) => void }) {
  const { p, act } = useSettings()
  const restart = useSettingsPiRestart(p.relay, act.notify)
  const piUpdate = useSettingsPiUpdate(p.relay, act.notify, { autoCheck: false })
  const now = useNow(piUpdate.running ? 1000 : 60_000)
  const [triggeredHere, setTriggeredHere] = useState(false)

  useEffect(() => {
    if (restart.phase === "idle") setTriggeredHere(false)
  }, [restart.phase])

  const updateFailed = piUpdate.status.state === "failed" && piUpdate.status.kind === "update_pi"
  const updateAvailable = Boolean(piUpdate.update?.canUpdate && piUpdate.update.latestVersion)
  const showUpdateCard = piUpdate.running || updateFailed || updateAvailable
  const updateRow = settingsPiUpdateRowOf({
    target: piUpdate.target,
    checking: piUpdate.checking,
    update: piUpdate.update,
    checkError: piUpdate.checkError,
    status: piUpdate.status,
    otherRunning: restart.running,
    now,
  })
  const updateTitle = piUpdate.running
    ? "正在更新 Pi…"
    : updateFailed
      ? "更新 Pi 失败"
      : `发现 Pi 新版本 ${piUpdate.update?.latestVersion ?? ""}`

  const showRestartCard =
    (restart.pendingRestart ||
      restart.phase === "running" ||
      restart.phase === "failed" ||
      (triggeredHere && restart.phase === "succeeded")) &&
    !piUpdate.running
  const banner = settingsPiRestartBannerOf({
    pendingRestart: restart.pendingRestart,
    phase: restart.phase,
    error: restart.error,
    canRestart: restart.target.canRestart,
    unsupportedReason: restart.target.reason,
  })

  return (
    <MobilePageBody page="index">
      {showUpdateCard ? (
        <MobileGroup label="Pi 升级" stacked>
          <MobileCard className="sm-restart-card">
            <div className="sm-restart-card-head">
              <span className="sm-restart-card-title">{updateTitle}</span>
              <button
                type="button"
                className="sm-note-action"
                data-settings-mobile-update-btn=""
                disabled={updateRow.disabled}
                title={!piUpdate.target.canRestart ? piUpdate.target.reason : undefined}
                onClick={() => piUpdate.triggerPrimaryAction(restart.running)}
              >
                <ArrowUpCircle size={13} strokeWidth={2} aria-hidden="true" />
                <span>{updateRow.actionLabel}</span>
              </button>
            </div>
            <p className="sm-restart-card-desc">{updateRow.description}</p>
          </MobileCard>
        </MobileGroup>
      ) : null}
      {showRestartCard ? (
        <MobileGroup label="运行与重启" stacked>
          <MobileCard className="sm-restart-card">
            <div className="sm-restart-card-head">
              <span className="sm-restart-card-title">{banner.title}</span>
              <button
                type="button"
                className="sm-note-action"
                data-settings-mobile-restart-btn=""
                disabled={banner.buttonDisabled}
                title={!restart.target.canRestart ? restart.target.reason : undefined}
                onClick={() => {
                  setTriggeredHere(true)
                  restart.requestRestart()
                }}
              >
                <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
                <span>{banner.buttonLabel}</span>
              </button>
            </div>
            <p className="sm-restart-card-desc">{banner.description}</p>
          </MobileCard>
        </MobileGroup>
      ) : null}
      {MOBILE_INDEX_GROUPS.map((group) => (
        <MobileGroup key={group.id} label={group.label} stacked>
          <MobileCard className="sm-index-card">
            {group.entries.map((page) => (
              <MobileActionRow
                key={page}
                title={MOBILE_SETTINGS_PAGE_LABELS[page]}
                leading={<EntryIcon page={page} />}
                onClick={() => onNavigate(page)}
              />
            ))}
          </MobileCard>
        </MobileGroup>
      ))}
      <p className="sm-note">设置只保存在这个浏览器里；会话记录仍留在所连设备上。</p>
      <SettingsPiUpdateDialog viewport="phone" piUpdate={piUpdate} />
      <SettingsPiRestartDialog viewport="phone" restart={restart} />
    </MobilePageBody>
  )
}
