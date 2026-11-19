/**
 * 设置 › 通用（设计册第 3 节，v3 定稿）。
 *
 * 状态口径：
 *   ○ 本机项（打开时进入 / 常驻搜索 / 语言 / 发送键 / 自动滚底 / 自动归档 / 语音两项）
 *     改完立即写入本机偏好并呈现；
 *   ● 插话投递 / 收尾投递 / 图片自动缩小：设备端 pi 设置，经 settings_set 写全局 settings.json；
 *     保存后需重启 pi 生效，成功提示带 reloadHint；
 *   ● 连接状态 / 服务器地址 / 连接诊断 / 重新配对：接真实 relay。
 *   ◌ 本页没有预留项。
 *   (Conversation group: local preferences, but not the v2 settings store —
 *    read/written via cShared useSettingsPrefs/usePrefsWriter, the same dual
 *    PiPrefs + legacy-style path the composer settings popover uses.)
 */
import { useState } from "react"
import { commandErrorText, usePrefsWriter, useSettingsPrefs } from "@/pi/containers/cShared"
import { useNow } from "@/pi/hooks/useNow"
import { serverDisplayName } from "@/pi/model/serverName"
import { switchDisplayStateOf } from "@/pi/model/switchSync"
import type { PiApprovalGateTier } from "@/pi/model/prefs"
import { useSettings } from "../SettingsContext"
import {
  SETTINGS_AUTO_ARCHIVE,
  SETTINGS_LANGUAGES,
  type SettingsDeliveryMode,
  type SettingsLanguage,
  type SettingsSendKey,
  type SettingsStartView,
} from "../types"
import {
  autoResizeImagesPatch,
  effectiveSettingsBoolOf,
  effectiveSettingsDeliveryModeOf,
  followUpModePatch,
  settingsCommandsReady,
  settingsRunCommand,
  steeringModePatch,
} from "./settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import { settingsPiRestartBannerOf } from "./settingsPiRestart.ts"
import { settingsPiUpdateRowOf } from "./settingsPiUpdate.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "./useSettingsPiRestart.tsx"
import { SettingsPiUpdateDialog, useSettingsPiUpdate } from "./useSettingsPiUpdate.tsx"
import {
  SettingsActionBar,
  SettingsActionButton,
  SettingsActionRow,
  SettingsGroup,
  SettingsInlineRadio,
  SettingsPageTitle,
  SettingsRadioGroup,
  SettingsRow,
  SettingsSelect,
  SettingsShortcutCapture,
  SettingsStatusDot,
  SettingsSwitch,
} from "../ui"


const START_VIEW_OPTIONS = [
  { value: "last", label: "上次会话" },
  { value: "list", label: "新建会话页" },
  { value: "hub", label: "设备选择页" },
] as const satisfies readonly { value: SettingsStartView; label: string }[]

const SEND_KEY_OPTIONS = [
  { value: "enter", label: "Enter 发送" },
  { value: "ctrl-enter", label: "Ctrl + Enter 发送" },
] as const satisfies readonly { value: SettingsSendKey; label: string }[]

const AUTO_ARCHIVE_OPTIONS = [
  { value: "never", label: "不自动" },
  { value: "7d", label: "7 天后" },
  { value: "30d", label: "30 天后" },
] as const satisfies readonly { value: (typeof SETTINGS_AUTO_ARCHIVE)[number]; label: string }[]

const DELIVERY_OPTIONS = [
  { value: "one-at-a-time", label: "逐条发送" },
  { value: "all", label: "全部一起" },
] as const satisfies readonly { value: SettingsDeliveryMode; label: string }[]

const LANGUAGE_OPTIONS = SETTINGS_LANGUAGES.map((language) => ({ value: language, label: "简体中文" })) as readonly {
  value: SettingsLanguage
  label: string
}[]

const APPROVAL_TIER_OPTIONS = [
  { value: "high-risk", label: "只问高危操作" },
  { value: "all-non-readonly", label: "所有非只读操作都问" },
  { value: "list", label: "只问名单里的工具" },
] as const satisfies readonly { value: PiApprovalGateTier; label: string }[]

function serverAddress(): string {
  try {
    return typeof window !== "undefined" && window.location.host ? window.location.host : "—"
  } catch {
    return "—"
  }
}

function hostname(): string {
  try {
    return typeof window === "undefined" ? "" : window.location.hostname
  } catch {
    return ""
  }
}

export function GeneralPage() {
  const { p, prefs, act, setPage } = useSettings()
  const { relay } = p
  // Conversation trio (ask / remote answer / approval gate): read and written
  // through the exact same cShared path as the composer settings popover, so
  // both surfaces always show and change one shared set of preferences.
  const conversation = useSettingsPrefs(p)
  const writeConversation = usePrefsWriter(p)
  // The three conversation switches are device-owned: until the current
  // room's bridge report arrives (switchSyncView "pending"), the local
  // value is not settled truth, so the switches stay inert rather than
  // presenting -- or recording -- a local guess.
  // E4: the lock applies only while a room is actually entered and its
  // report is still in flight. With no current room the switches stay
  // live and record a local intent; entering a room never pushes that
  // intent unconditionally -- the switchSync push effects send it only
  // where it deviates from the device baseline.
  const switchesPending = relay.switchSyncView.mode === "pending" && !!relay.roomId
  // D-1: without a usable viewer identity no device report can ever
  // reach this viewer, so the pending state would never resolve and the
  // local values rendered under it would masquerade as device truth
  // (measured: local all-on while the device had the gate off). Render
  // an explicit identity-required state with the enable action instead;
  // with an identity, the pending behavior above stays exactly as-is.
  const identityRequired = switchDisplayStateOf(relay.switchSyncView, relay.viewerIdentity) === "identity-required"
  const document = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const connected = relay.authed && relay.browserOnline
  const connectionText = connected ? `已连接 · ${serverDisplayName(relay.serverName, hostname())}` : relay.browserOnline ? "未连接" : "浏览器离线"
  const dictationKeys = prefs.dictationShortcut.split(/\s+\+\s+/).filter(Boolean)

  const writeHint = readOnlyHintOf(document, writer)
  const busy = writer.saving !== null
  const writeDisabled = !writer.canWrite || document.phase !== "ready" || busy
  const steering = effectiveSettingsDeliveryModeOf(document.data, writer.applied, "steeringMode")
  const followUp = effectiveSettingsDeliveryModeOf(document.data, writer.applied, "followUpMode")
  const autoResize = effectiveSettingsBoolOf(document.data, writer.applied, "images.autoResize")

  const [diag, setDiag] = useState<{ phase: "idle" | "probing" | "ok" | "error"; text?: string }>({ phase: "idle" })
  const runDiag = async () => {
    if (diag.phase === "probing") return
    setDiag({ phase: "probing" })
    const started = typeof performance !== "undefined" ? performance.now() : Date.now()
    try {
      if (settingsCommandsReady(relay) && relay.browserOnline) {
        await settingsRunCommand(relay, "get_host_diag")
        const ms = Math.max(1, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started))
        const text = `设备与中转连通 · ${ms} ms`
        setDiag({ phase: "ok", text })
        act.notify(text)
        return
      }
      const res = await fetch("/", { method: "HEAD", cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ms = Math.max(1, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started))
      const text = `中转服务器连通 · ${ms} ms`
      setDiag({ phase: "ok", text })
      act.notify(text)
    } catch (error) {
      const msg = commandErrorText(error)
      setDiag({ phase: "error", text: `诊断失败：${msg}` })
      act.notify(`连接诊断失败：${msg}`, "bad")
    }
  }

  return (
    <div className="settings-page" data-settings-page="general">
      <SettingsPageTitle title="通用" />

      <SettingsGroup label="启动与导航" first>
        <SettingsRadioGroup
          label="打开时进入"
          value={prefs.startView}
          options={START_VIEW_OPTIONS}
          onChange={(value) => act.setPref("startView", value)}
        />
        <SettingsRow title="侧边栏常驻搜索框">
          <SettingsSwitch
            label="侧边栏常驻搜索框"
            checked={prefs.sidebarPersistentSearch}
            onChange={(checked) => act.setPref("sidebarPersistentSearch", checked)}
          />
        </SettingsRow>
        <SettingsSelect
          label="界面语言"
          value={prefs.language}
          options={LANGUAGE_OPTIONS}
          onChange={(value) => act.setPref("language", value)}
        />
      </SettingsGroup>

      <SettingsGroup label="发送与会话">
        <SettingsRadioGroup
          label="发送消息"
          value={prefs.sendKey}
          options={SEND_KEY_OPTIONS}
          onChange={(value) => act.setPref("sendKey", value)}
        />
        <SettingsRow title="生成时自动滚到底部">
          <SettingsSwitch
            label="生成时自动滚到底部"
            checked={prefs.autoScroll}
            onChange={(checked) => act.setPref("autoScroll", checked)}
          />
        </SettingsRow>
        <SettingsInlineRadio
          label="已完成会话自动归档"
          value={prefs.autoArchive}
          options={AUTO_ARCHIVE_OPTIONS}
          onChange={(value) => act.setPref("autoArchive", value)}
        />
        <SettingsRadioGroup
          label="插话消息投递"
          tooltip="模型生成期间发送新消息时的投递策略（逐条插入或合并发送）；写入设备 settings.json，重启 Pi 后生效。"
          value={steering}
          options={DELIVERY_OPTIONS}
          disabled={writeDisabled}
          onChange={(value) => {
            void writer.save("steeringMode", steeringModePatch(value))
          }}
        />
        <SettingsRadioGroup
          label="收尾消息投递"
          tooltip="模型本轮生成结束后排队消息的投递策略；写入设备 settings.json，重启 Pi 后生效。"
          value={followUp}
          options={DELIVERY_OPTIONS}
          disabled={writeDisabled}
          onChange={(value) => {
            void writer.save("followUpMode", followUpModePatch(value))
          }}
        />
        <SettingsRow
          title="发送图片前自动缩小"
          tooltip="发送前将超尺寸图片等比压缩至 2000px 以内以降低上下文占用；写入设备 settings.json，重启 Pi 后生效。"
        >
          <SettingsSwitch
            label="发送图片前自动缩小"
            checked={autoResize === true}
            disabled={writeDisabled || autoResize === null}
            onChange={(checked) => {
              void writer.save("images.autoResize", autoResizeImagesPatch(checked))
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      <SettingsGroup
        label="对话"
        description={
          identityRequired
            ? "这三项开关归设备所有。当前观看端没有可用的身份，读不到设备上的真实状态；本机保存的值不是设备状态，所以不在这里显示。"
            : undefined
        }
      >
        {identityRequired ? (
          <SettingsActionRow
            title="启用观看端身份"
            description="启用后，这里会显示并修改设备上的真实开关状态"
            onClick={() => setPage("devices")}
          />
        ) : null}
        <SettingsRow
          title="允许智能体向我提问"
          tooltip="允许模型调用 ask_user 工具向当前网页发起单选、多选或填空提问。"
        >
          {identityRequired ? (
            <span className="settings-value">需先启用身份</span>
          ) : (
            <SettingsSwitch
              label="允许智能体向我提问"
              checked={conversation.askUser}
              disabled={switchesPending}
              onChange={(checked) => writeConversation({ askUser: checked })}
            />
          )}
        </SettingsRow>
        <SettingsRow
          title="在网页上回答电脑上的确认框"
          tooltip="将设备终端弹出的确认框转发到网页端作答；关闭后仅能在设备终端内确认。"
        >
          {identityRequired ? (
            <span className="settings-value">需先启用身份</span>
          ) : (
            <SettingsSwitch
              label="在网页上回答电脑上的确认框"
              checked={conversation.dialogRemote}
              disabled={switchesPending}
              onChange={(checked) => writeConversation({ dialogRemote: checked })}
            />
          )}
        </SettingsRow>
        <SettingsRow
          title="工具执行审批门"
          tooltip="执行受控工具前先暂停并请求你的批准；与终端确认框转发相互独立。"
        >
          {identityRequired ? (
            <span className="settings-value">需先启用身份</span>
          ) : (
            <SettingsSwitch
              label="工具执行审批门"
              checked={conversation.approvalGate}
              disabled={switchesPending}
              onChange={(checked) => writeConversation({ approvalGate: checked })}
            />
          )}
        </SettingsRow>
        {identityRequired ? (
          <SettingsRow
            title="审批门问哪些工具"
            tooltip="选择「只问名单里的工具」时，具体工具名单由设备端扩展配置维护。"
          >
            <span className="settings-value">需先启用身份</span>
          </SettingsRow>
        ) : (
          <SettingsRadioGroup
            label="审批门问哪些工具"
            tooltip="选择「只问名单里的工具」时，具体工具名单由设备端扩展配置维护。"
            disabled={switchesPending}
            value={conversation.approvalGateTier}
            options={APPROVAL_TIER_OPTIONS}
            onChange={(value) => writeConversation({ approvalGateTier: value })}
          />
        )}
      </SettingsGroup>

      <SettingsGroup label="语音输入">
        <SettingsRow title="语音转文字">
          <SettingsSwitch
            label="语音转文字"
            checked={prefs.speechToText}
            onChange={(checked) => act.setPref("speechToText", checked)}
          />
        </SettingsRow>
        <SettingsRow title="听写快捷键">
          <SettingsShortcutCapture
            label="听写快捷键"
            keys={dictationKeys}
            onChange={(keys) => act.setPref("dictationShortcut", keys.join(" + "))}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="中转服务器">
        <SettingsRow title="连接状态">
          <span className="settings-value">
            <SettingsStatusDot tone={connected ? "online" : "offline"} />
            {connectionText}
          </span>
        </SettingsRow>
        <SettingsRow title="服务器地址">
          <span className="settings-value">{serverAddress()}</span>
        </SettingsRow>
        <SettingsActionBar
          title="连接与配对"
          description={diag.text}
        >
          <SettingsActionButton
            title="连接诊断"
            label={diag.phase === "probing" ? "检测中…" : diag.phase === "ok" ? "重新诊断" : "连接诊断"}
            disabled={diag.phase === "probing"}
            onClick={() => {
              void runDiag()
            }}
          />
          <SettingsActionButton title="重新配对" onClick={act.openPairing} />
        </SettingsActionBar>
      </SettingsGroup>

      <GeneralRestartGroup relay={relay} notify={act.notify} onOpenDevices={() => setPage("devices")} />
    </div>
  )
}

function GeneralRestartGroup({
  relay,
  notify,
  onOpenDevices,
}: {
  relay: Parameters<typeof useSettingsPiRestart>[0]
  notify: Parameters<typeof useSettingsPiRestart>[1]
  onOpenDevices: () => void
}) {
  const restart = useSettingsPiRestart(relay, notify)
  const piUpdate = useSettingsPiUpdate(relay, notify)
  const now = useNow(piUpdate.running ? 1000 : 60_000)
  const updateRow = settingsPiUpdateRowOf({
    target: piUpdate.target,
    checking: piUpdate.checking,
    update: piUpdate.update,
    checkError: piUpdate.checkError,
    status: piUpdate.status,
    otherRunning: restart.running,
    now,
  })
  const banner = settingsPiRestartBannerOf({
    pendingRestart: restart.pendingRestart,
    phase: restart.phase,
    error: restart.error,
    canRestart: restart.target.canRestart,
    unsupportedReason: restart.target.reason,
  })
  const description = piUpdate.running
    ? "正在更新 Pi，更新完成后会自动重启"
    : banner.title !== "重启 Pi"
      ? `${banner.title} · ${banner.description}`
      : banner.description
  const barSummary =
    piUpdate.running || updateRow.canUpdate || piUpdate.checkError || (piUpdate.status.state === "failed" && piUpdate.status.kind === "update_pi")
      ? updateRow.description
      : restart.pendingRestart || restart.phase === "running" || restart.phase === "failed"
        ? description
        : undefined

  return (
    <>
      <SettingsGroup label="运行与重启">
        <SettingsActionBar description={barSummary}>
          <SettingsActionButton
            title="更新 Pi"
            label={updateRow.canUpdate ? updateRow.actionLabel : piUpdate.checking ? "检查中…" : piUpdate.running ? "更新中…" : "检查更新"}
            tone={updateRow.canUpdate ? "primary" : "default"}
            hint={updateRow.description}
            disabled={updateRow.disabled}
            onClick={() => piUpdate.triggerPrimaryAction(restart.running)}
          />
          <SettingsActionButton
            title="重启 Pi"
            label={restart.running ? "重启中…" : banner.buttonLabel}
            tone={restart.pendingRestart ? "primary" : "default"}
            hint={description}
            disabled={banner.buttonDisabled || piUpdate.running}
            onClick={restart.requestRestart}
          />
          <SettingsActionButton
            title="设备端更新与系统操作"
            label="系统操作"
            hint="查看 Pi / 扩展 / Attach 版本矩阵，或执行重启设备端、更新设备端组件"
            onClick={onOpenDevices}
          />
        </SettingsActionBar>
      </SettingsGroup>
      <SettingsPiUpdateDialog viewport="desktop" piUpdate={piUpdate} />
      <SettingsPiRestartDialog viewport="desktop" restart={restart} />
    </>
  )
}
