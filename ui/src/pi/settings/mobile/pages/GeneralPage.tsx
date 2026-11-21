/**
 * 手机端设置 · 通用（桌面定稿第 3 节的移动压缩版）。
 *
 * 口径与桌面 GeneralPage 一致：
 *   ○ 本机项即时写 pi_remote_pi_settings_v2（打开时进入 / 常驻搜索 / 发送键 / 自动滚底 /
 *     自动归档 / 语音 / 听写键）；
 *   ● 插话投递 / 收尾投递 / 图片自动缩小：设备端 pi 设置，经 settings_set 写全局 settings.json；
 *     保存后需重启 pi 生效，成功提示带 reloadHint；不支持 / 离线时保持只读；
 *   ● 对话（提问 / 确认框转发 / 审批门）：与桌面同走 cShared 读写口径；
 *   ● 连接状态 / 服务器地址 / 连接诊断 / 重新配对：接真实 relay（重新配对接现有配对流程）。
 *   ◌ 本页无预留项。
 */
import { useState } from "react"
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "../../../../i18n/locale.ts"
import { commandErrorText, usePrefsWriter, useSettingsPrefs } from "@/pi/containers/cShared"
import { useNow } from "@/pi/hooks/useNow"
import { serverDisplayName } from "@/pi/model/serverName"
import { switchDisplayStateOf } from "@/pi/model/switchSync"
import type { PiApprovalGateTier } from "@/pi/model/prefs"
import { useSettings } from "../../SettingsContext.tsx"
import { SettingsHoverTitle, SettingsShortcutCapture } from "../../ui.tsx"
import type { SettingsDeliveryMode, SettingsSendKey, SettingsStartView } from "../../types.ts"
import {
  autoResizeImagesPatch,
  effectiveSettingsBoolOf,
  effectiveSettingsDeliveryModeOf,
  followUpModePatch,
  settingsCommandsReady,
  settingsRunCommand,
  steeringModePatch,
} from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import { settingsPiRestartBannerOf } from "../../pages/settingsPiRestart.ts"
import { settingsPiUpdateRowOf } from "../../pages/settingsPiUpdate.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "../../pages/useSettingsPiRestart.tsx"
import { SettingsPiUpdateDialog, useSettingsPiUpdate } from "../../pages/useSettingsPiUpdate.tsx"
import {
  MobileActionBar,
  MobileActionButton,
  MobileActionRow,
  MobileField,
  MobileGroup,
  MobileOptionList,
  MobilePageBody,
  MobileReadOnlyRow,
  MobileRow,
  MobileSelect,
  MobileStatusLine,
  MobileSwitch,
  MobileSwitchRow,
  MobileValue,
} from "../atoms.tsx"

const START_VIEW_OPTIONS = [
  { value: "last", title: "上次会话" },
  { value: "list", title: "会话列表" },
  { value: "hub", title: "设备选择页" },
] as const satisfies readonly { value: SettingsStartView; title: string }[]

const SEND_KEY_OPTIONS = [
  { value: "enter", label: "Enter 发送" },
  { value: "ctrl-enter", label: "Ctrl+Enter" },
] as const satisfies readonly { value: SettingsSendKey; label: string }[]

const AUTO_ARCHIVE_OPTIONS = [
  { value: "never", label: "不自动" },
  { value: "7d", label: "7 天后" },
  { value: "30d", label: "30 天后" },
] as const

const DELIVERY_OPTIONS = [
  { value: "one-at-a-time", title: "逐条发送" },
  { value: "all", title: "全部一起" },
] as const satisfies readonly { value: SettingsDeliveryMode; title: string }[]

const APPROVAL_TIER_OPTIONS = [
  { value: "high-risk", title: "只问高危操作" },
  { value: "all-non-readonly", title: "所有非只读操作都问" },
  { value: "list", title: "只问名单里的工具" },
] as const satisfies readonly { value: PiApprovalGateTier; title: string }[]

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
  const conversation = useSettingsPrefs(p)
  const writeConversation = usePrefsWriter(p)
  const switchesPending = relay.switchSyncView.mode === "pending" && !!relay.roomId
  const identityRequired = switchDisplayStateOf(relay.switchSyncView, relay.viewerIdentity) === "identity-required"
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const connected = relay.authed && relay.browserOnline
  const connectionText = connected ? `已连接 · ${serverDisplayName(relay.serverName, hostname())}` : relay.browserOnline ? "未连接" : "浏览器离线"
  const dictationKeys = prefs.dictationShortcut.split(/\s+\+\s+/).filter(Boolean)
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null
  const steering = effectiveSettingsDeliveryModeOf(settingsDoc.data, writer.applied, "steeringMode")
  const followUp = effectiveSettingsDeliveryModeOf(settingsDoc.data, writer.applied, "followUpMode")
  const autoResize = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "images.autoResize")

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
    <MobilePageBody page="general">
      <MobileGroup label="启动与导航">
        <MobileField title="打开时进入">
          <MobileOptionList
            label="打开时进入"
            value={prefs.startView}
            options={START_VIEW_OPTIONS}
            onChange={(value) => act.setPref("startView", value)}
          />
        </MobileField>
        <MobileSwitchRow
          title="侧边栏常驻搜索框"
          checked={prefs.sidebarPersistentSearch}
          onChange={(checked) => act.setPref("sidebarPersistentSearch", checked)}
        />
        <MobileSelect
          label="界面语言"
          value={prefs.language}
          options={SUPPORTED_LANGUAGES.map((language) => ({ value: language, label: LANGUAGE_LABELS[language] }))}
          onChange={(value) => act.setPref("language", value)}
        />
      </MobileGroup>

      <MobileGroup label="发送与会话">
        <MobileField
          title="发送消息"
          value={prefs.sendKey}
          options={SEND_KEY_OPTIONS}
          onChange={(value) => act.setPref("sendKey", value)}
        />
        <MobileSwitchRow
          title="生成时自动滚到底部"
          checked={prefs.autoScroll}
          onChange={(checked) => act.setPref("autoScroll", checked)}
        />
        <MobileSelect
          label="已完成会话自动归档"
          value={prefs.autoArchive}
          options={AUTO_ARCHIVE_OPTIONS}
          onChange={(value) => act.setPref("autoArchive", value)}
        />
        <div className="sm-pad">
          <div className="sm-field-title">
            <SettingsHoverTitle tooltip="模型生成期间发送新消息时的投递策略（逐条插入或合并发送）；写入设备 settings.json，重启 Pi 后生效。">
              插话消息投递
            </SettingsHoverTitle>
          </div>
          <MobileOptionList
            label="插话消息投递"
            value={steering}
            options={DELIVERY_OPTIONS}
            disabled={writeDisabled}
            onChange={(value) => {
              void writer.save("steeringMode", steeringModePatch(value))
            }}
          />
        </div>
        <div className="sm-pad">
          <div className="sm-field-title">
            <SettingsHoverTitle tooltip="模型本轮生成结束后排队消息的投递策略；写入设备 settings.json，重启 Pi 后生效。">
              收尾消息投递
            </SettingsHoverTitle>
          </div>
          <MobileOptionList
            label="收尾消息投递"
            value={followUp}
            options={DELIVERY_OPTIONS}
            disabled={writeDisabled}
            onChange={(value) => {
              void writer.save("followUpMode", followUpModePatch(value))
            }}
          />
        </div>
        <MobileSwitchRow
          title="发送图片前自动缩小"
          tooltip="发送前将超尺寸图片等比压缩至 2000px 以内以降低上下文占用；写入设备 settings.json，重启 Pi 后生效。"
          checked={autoResize === true}
          disabled={writeDisabled || autoResize === null}
          onChange={(checked) => {
            void writer.save("images.autoResize", autoResizeImagesPatch(checked))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      <MobileGroup
        label="对话"
        description={
          identityRequired
            ? "这三项开关归设备所有。当前观看端没有可用的身份，读不到设备上的真实状态；本机保存的值不是设备状态，所以不在这里显示。"
            : undefined
        }
      >
        {identityRequired ? (
          <MobileActionRow
            title="启用观看端身份"
            description="启用后，这里会显示并修改设备上的真实开关状态"
            onClick={() => setPage("devices")}
          />
        ) : null}
        <MobileRow
          title="允许智能体向我提问"
          tooltip="允许模型调用 ask_user 工具向当前网页发起单选、多选或填空提问。"
        >
          {identityRequired ? (
            <MobileValue>需先启用身份</MobileValue>
          ) : (
            <MobileSwitch
              label="允许智能体向我提问"
              checked={conversation.askUser}
              disabled={switchesPending}
              onChange={(checked) => writeConversation({ askUser: checked })}
            />
          )}
        </MobileRow>
        <MobileRow
          title="在网页上回答电脑上的确认框"
          tooltip="将设备终端弹出的确认框转发到网页端作答；关闭后仅能在设备终端内确认。"
        >
          {identityRequired ? (
            <MobileValue>需先启用身份</MobileValue>
          ) : (
            <MobileSwitch
              label="在网页上回答电脑上的确认框"
              checked={conversation.dialogRemote}
              disabled={switchesPending}
              onChange={(checked) => writeConversation({ dialogRemote: checked })}
            />
          )}
        </MobileRow>
        <MobileRow
          title="工具执行审批门"
          tooltip="执行受控工具前先暂停并请求你的批准；与终端确认框转发相互独立。"
        >
          {identityRequired ? (
            <MobileValue>需先启用身份</MobileValue>
          ) : (
            <MobileSwitch
              label="工具执行审批门"
              checked={conversation.approvalGate}
              disabled={switchesPending}
              onChange={(checked) => writeConversation({ approvalGate: checked })}
            />
          )}
        </MobileRow>
        {identityRequired ? (
          <MobileRow
            title="审批门问哪些工具"
            tooltip="选择「只问名单里的工具」时，具体工具名单由设备端扩展配置维护。"
          >
            <MobileValue>需先启用身份</MobileValue>
          </MobileRow>
        ) : (
          <MobileField
            title="审批门问哪些工具"
            tooltip="选择「只问名单里的工具」时，具体工具名单由设备端扩展配置维护。"
          >
            <MobileOptionList
              label="审批门问哪些工具"
              disabled={switchesPending}
              value={conversation.approvalGateTier}
              options={APPROVAL_TIER_OPTIONS}
              onChange={(value) => writeConversation({ approvalGateTier: value })}
            />
          </MobileField>
        )}
      </MobileGroup>

      <MobileGroup label="语音输入">
        <MobileSwitchRow
          title="语音转文字"
          checked={prefs.speechToText}
          onChange={(checked) => act.setPref("speechToText", checked)}
        />
        <MobileRow title="听写快捷键">
          <SettingsShortcutCapture
            label="听写快捷键"
            keys={dictationKeys}
            onChange={(keys) => act.setPref("dictationShortcut", keys.join(" + "))}
          />
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="中转服务器">
        <MobileRow title="连接状态">
          <MobileStatusLine tone={connected ? "online" : "offline"}>{connectionText}</MobileStatusLine>
        </MobileRow>
        <MobileReadOnlyRow title="服务器地址" value={serverAddress()} />
        <MobileActionBar
          title="连接与配对"
          description={diag.text}
        >
          <MobileActionButton
            title="连接诊断"
            label={diag.phase === "probing" ? "检测中…" : diag.phase === "ok" ? "重新诊断" : "连接诊断"}
            disabled={diag.phase === "probing"}
            onClick={() => {
              void runDiag()
            }}
          />
          <MobileActionButton title="重新配对" onClick={act.openPairing} />
        </MobileActionBar>
      </MobileGroup>

      <MobileGeneralRestartGroup relay={relay} notify={act.notify} onOpenDevices={() => setPage("devices")} />
    </MobilePageBody>
  )
}

function MobileGeneralRestartGroup({
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
      <MobileGroup label="运行与重启">
        <MobileActionBar description={barSummary}>
          <MobileActionButton
            title="更新 Pi"
            label={updateRow.canUpdate ? updateRow.actionLabel : piUpdate.checking ? "检查中…" : piUpdate.running ? "更新中…" : "检查更新"}
            tone={updateRow.canUpdate ? "primary" : "default"}
            hint={updateRow.description}
            disabled={updateRow.disabled}
            onClick={() => piUpdate.triggerPrimaryAction(restart.running)}
          />
          <MobileActionButton
            title="重启 Pi"
            label={restart.running ? "重启中…" : banner.buttonLabel}
            tone={restart.pendingRestart ? "primary" : "default"}
            hint={description}
            disabled={banner.buttonDisabled || piUpdate.running}
            onClick={restart.requestRestart}
          />
          <MobileActionButton
            title="设备端更新与系统操作"
            label="系统操作"
            hint="查看 Pi / 扩展 / Attach 版本矩阵，或执行重启设备端、更新设备端组件"
            onClick={onOpenDevices}
          />
        </MobileActionBar>
      </MobileGroup>
      <SettingsPiUpdateDialog viewport="phone" piUpdate={piUpdate} />
      <SettingsPiRestartDialog viewport="phone" restart={restart} />
    </>
  )
}
