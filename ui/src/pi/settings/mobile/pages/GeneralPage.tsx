/**
 * 手机端设置 · 通用（桌面定稿第 3 节的移动压缩版）。
 *
 * 口径与桌面 GeneralPage 一致：
 *   ○ 本机项即时写 pi_remote_pi_settings_v2（打开时进入 / 常驻搜索 / 发送键 / 自动滚底 /
 *     自动归档 / 语音 / 麦克风 / 听写键）；
 *   ● 插话投递 / 收尾投递 / 图片自动缩小：设备端 pi 设置，经 settings_set 写全局 settings.json；
 *     保存后需重启 pi 生效，成功提示带 reloadHint；不支持 / 离线时保持只读；
 *   ● 连接状态 / 服务器地址 / 自动重连 / 重新配对：接真实 relay（重新配对接现有配对流程）。
 *   ◌ 本页无预留项。
 */
import { serverDisplayName } from "@/pi/model/serverName"
import { useSettings } from "../../SettingsContext.tsx"
import { SettingsShortcutCapture } from "../../ui.tsx"
import type { SettingsDeliveryMode, SettingsSendKey, SettingsStartView } from "../../types.ts"
import {
  autoResizeImagesPatch,
  effectiveSettingsBoolOf,
  effectiveSettingsDeliveryModeOf,
  followUpModePatch,
  steeringModePatch,
} from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import {
  MobileActionRow,
  MobileField,
  MobileGroup,
  MobileOptionList,
  MobilePageBody,
  MobileReadOnlyRow,
  MobileRow,
  MobileSelect,
  MobileStatusLine,
  MobileSwitchRow,
} from "../atoms.tsx"

const START_VIEW_OPTIONS = [
  { value: "last", title: "上次会话" },
  { value: "list", title: "会话列表" },
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
  { value: "one-at-a-time", title: "逐条发送", description: "排队的消息逐条递给模型" },
  { value: "all", title: "全部一起", description: "排队的消息一次全部递给模型" },
] as const satisfies readonly { value: SettingsDeliveryMode; title: string; description: string }[]

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
  const { p, prefs, act } = useSettings()
  const { relay } = p
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
          description="关闭时用功能键唤出搜索"
          checked={prefs.sidebarPersistentSearch}
          onChange={(checked) => act.setPref("sidebarPersistentSearch", checked)}
        />
        <MobileReadOnlyRow title="界面语言" value="简体中文" />
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
          description="回答生成时始终显示最新内容"
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
          <div className="sm-field-title">插话消息投递</div>
          <div className="sm-field-description">生成时排队的插话，怎么递给模型</div>
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
          <div className="sm-field-title">收尾消息投递</div>
          <div className="sm-field-description">生成结束后排队的消息，怎么递给模型</div>
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
          description="大图自动缩到 2000px 内再发给模型"
          checked={autoResize === true}
          disabled={writeDisabled || autoResize === null}
          onChange={(checked) => {
            void writer.save("images.autoResize", autoResizeImagesPatch(checked))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      <MobileGroup label="语音输入">
        <MobileReadOnlyRow title="麦克风" value="系统默认" />
        <MobileSwitchRow
          title="语音转文字"
          description="在输入框旁显示麦克风按钮，说话直接转成文字"
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
        <MobileSwitchRow title="断线后自动重连" description="现有断线重连机制，始终保持开启" checked disabled />
        <MobileActionRow title="连接诊断" description="检查到中转服务器的连通性" status="bridge" disabled />
        <MobileActionRow title="重新配对" onClick={act.openPairing} />
      </MobileGroup>
    </MobilePageBody>
  )
}
