/**
 * 设置 › Pi 升级 · 纯逻辑（无 React / 无 DOM，node --test 可直载）。
 *
 * 统一「从任一设置页检查并升级所连设备 Pi（get_pi_update_info / update_pi）」的
 * 状态衍生、可用性判断与文案收口。
 */
import type { SettingsPiRestartTarget } from "./settingsPiRestart.ts"
import {
  operationElapsedTextOf,
  operationPhaseTextOf,
  type OperationStatus,
  type PiUpdateInfo,
} from "./systemOpsLogic.ts"

export const SETTINGS_PI_UPDATE_TIMEOUT_TEXT = "更新 Pi 超时，请到「设备 › 系统操作」查看实时状态"

export interface SettingsPiUpdateRowModel {
  title: string
  description: string
  actionLabel: string
  actionKind: "update" | "recheck" | "none"
  disabled: boolean
  canUpdate: boolean
  badgeText: string | null
}

export function settingsPiUpdateRowOf({
  target,
  checking,
  update,
  checkError,
  status,
  otherRunning,
  now,
}: {
  target: SettingsPiRestartTarget
  checking: boolean
  update: PiUpdateInfo | null
  checkError: string | null
  status: OperationStatus
  otherRunning: boolean
  now: number
}): SettingsPiUpdateRowModel {
  const title = "更新 Pi"
  const isThisRunning = status.state === "running" && status.kind === "update_pi"

  if (!target.canRestart && !isThisRunning) {
    return {
      title,
      description: target.reason,
      actionLabel: "不可用",
      actionKind: "none",
      disabled: true,
      canUpdate: false,
      badgeText: null,
    }
  }

  if (isThisRunning) {
    const phaseText = operationPhaseTextOf(status, update)
    const elapsed = status.startedAt != null ? operationElapsedTextOf(status.startedAt, now) : ""
    return {
      title,
      description: [phaseText, elapsed, "更新完成后自动重启所连设备上的 Pi"].filter(Boolean).join(" · "),
      actionLabel: "更新中…",
      actionKind: "none",
      disabled: true,
      canUpdate: false,
      badgeText: null,
    }
  }

  if (otherRunning || (status.state === "running" && status.kind !== "update_pi")) {
    return {
      title,
      description: "这台设备正在执行其他系统操作，请稍候",
      actionLabel: "请稍候",
      actionKind: "none",
      disabled: true,
      canUpdate: false,
      badgeText: null,
    }
  }

  if (checking && !update) {
    return {
      title,
      description: "正在向设备与 npm 注册表检查 Pi 最新版本…",
      actionLabel: "检查中…",
      actionKind: "none",
      disabled: true,
      canUpdate: false,
      badgeText: null,
    }
  }

  if (status.state === "failed" && status.kind === "update_pi") {
    const err = status.error || status.detail || "上次更新 Pi 未完成，可重试"
    const canRetryUpdate = Boolean(update?.canUpdate && update.latestVersion)
    return {
      title,
      description: `上次更新失败：${err}`,
      actionLabel: checking ? "检查中…" : canRetryUpdate ? `重试更新到 ${update!.latestVersion}` : "重新检查",
      actionKind: canRetryUpdate ? "update" : "recheck",
      disabled: checking,
      canUpdate: canRetryUpdate,
      badgeText: canRetryUpdate ? `新版 ${update!.latestVersion}` : null,
    }
  }

  if (checkError || (update && !update.latestVersion && update.installMethod === "npm-global")) {
    const cur = update?.currentVersion ? `当前 Pi ${update.currentVersion} · ` : ""
    const err = checkError || update?.checkError || "未能连接 npm 注册表"
    return {
      title,
      description: `${cur}检查更新失败：${err}`,
      actionLabel: checking ? "检查中…" : "重新检查",
      actionKind: "recheck",
      disabled: checking,
      canUpdate: false,
      badgeText: null,
    }
  }

  if (update && update.installMethod !== "npm-global") {
    const cur = update.currentVersion ? `当前 Pi ${update.currentVersion} · ` : ""
    const reason =
      update.installMethod === "other"
        ? "非 npm 全局安装，请按原安装方式在设备终端升级"
        : "未能识别 Pi 安装方式，请在设备终端手动升级"
    return {
      title,
      description: `${cur}${reason}`,
      actionLabel: checking ? "检查中…" : "重新检查",
      actionKind: "recheck",
      disabled: checking,
      canUpdate: false,
      badgeText: null,
    }
  }

  if (update && update.canUpdate && update.latestVersion) {
    const busyWarn = target.busy.generating
      ? "当前有会话正在生成回复，更新重启会打断本轮；"
      : target.busy.pendingDialog
        ? "当前有待回答提问，更新重启会使其失效；"
        : ""
    const cur = update.currentVersion ? `当前 ${update.currentVersion}，` : ""
    return {
      title,
      description: `${busyWarn}${cur}发现新版本 ${update.latestVersion}，确认后自动升级并重启 Pi`,
      actionLabel: checking ? "检查中…" : `更新到 ${update.latestVersion}`,
      actionKind: "update",
      disabled: checking,
      canUpdate: true,
      badgeText: `新版 ${update.latestVersion}`,
    }
  }

  if (update) {
    const ver = update.currentVersion || update.latestVersion || "—"
    const donePrefix = status.state === "succeeded" && status.kind === "update_pi" ? "已更新到最新版本 · " : ""
    return {
      title,
      description: `${donePrefix}当前 Pi ${ver} 已是最新版本（npm 全局安装）`,
      actionLabel: checking ? "检查中…" : "重新检查",
      actionKind: "recheck",
      disabled: checking,
      canUpdate: false,
      badgeText: null,
    }
  }

  return {
    title,
    description: "检查所连设备上的 Pi 是否有 npm 新版本并一键升级",
    actionLabel: checking ? "检查中…" : "重新检查",
    actionKind: "recheck",
    disabled: checking,
    canUpdate: false,
    badgeText: null,
  }
}
