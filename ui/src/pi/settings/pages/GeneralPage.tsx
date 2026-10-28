/**
 * 设置 › 通用（设计册第 3 节，v3 定稿）。
 *
 * 状态口径：
 *   ○ 本机项（打开时进入 / 常驻搜索 / 语言 / 发送键 / 自动滚底 / 自动归档 / 语音三项）
 *     改完立即写入本机偏好并呈现；
 *   ● 插话投递 / 收尾投递 / 图片自动缩小：设备端 pi 设置，经 settings_set 写全局 settings.json；
 *     保存后需重启 pi 生效，成功提示带 reloadHint；
 *   ● 连接状态 / 服务器地址 / 自动重连 / 重新配对：接真实 relay；自动重连机制常开，不伪造可关。
 *   ◌ 本页没有预留项。
 */
import { useEffect, useMemo, useState } from "react"
import { serverDisplayName } from "@/pi/model/serverName"
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
  effectiveSettingsBoolOf,
  effectiveSettingsDeliveryModeOf,
  followUpModePatch,
  autoResizeImagesPatch,
  steeringModePatch,
} from "./settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import {
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
  { value: "list", label: "会话列表" },
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

const MICROPHONE_SYSTEM = "system"

interface AudioInput {
  id: string
  label: string
}

/**
 * 麦克风清单（设计册 §3「语音输入 · 麦克风 ◯ 新建」）：浏览器侧列真实输入设备。
 * 不主动请求麦克风权限，所以未授权时拿不到设备名，用「麦克风 N」占位；
 * 设备热插拔靠 devicechange 事件刷新。
 */
function useAudioInputs(): AudioInput[] {
  const [inputs, setInputs] = useState<AudioInput[]>([])
  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices
    if (!media || typeof media.enumerateDevices !== "function") return
    let alive = true
    const refresh = () => {
      media.enumerateDevices().then(
        (devices) => {
          if (!alive) return
          const seen = new Set<string>()
          const rows: AudioInput[] = []
          for (const device of devices) {
            if (device.kind !== "audioinput" || !device.deviceId || seen.has(device.deviceId)) continue
            seen.add(device.deviceId)
            rows.push({ id: device.deviceId, label: device.label || `麦克风 ${rows.length + 1}` })
          }
          setInputs(rows)
        },
        () => {
          /* 隐私模式 / 设备不可用时静默降级：只留「系统默认」 */
        },
      )
    }
    refresh()
    media.addEventListener?.("devicechange", refresh)
    return () => {
      alive = false
      media.removeEventListener?.("devicechange", refresh)
    }
  }, [])
  return inputs
}

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
  const document = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const audioInputs = useAudioInputs()
  const microphoneOptions = useMemo(() => {
    const options = [{ value: MICROPHONE_SYSTEM, label: "系统默认" }]
    for (const input of audioInputs) options.push({ value: input.id, label: input.label })
    // 换过设备后旧的 deviceId 可能已经不在清单里：保留它，别让选择框变成空值。
    if (prefs.micDevice !== MICROPHONE_SYSTEM && !options.some((option) => option.value === prefs.micDevice)) {
      options.push({ value: prefs.micDevice, label: "已保存的麦克风" })
    }
    return options
  }, [audioInputs, prefs.micDevice])
  const connected = relay.authed && relay.browserOnline
  const connectionText = connected ? `已连接 · ${serverDisplayName(relay.serverName, hostname())}` : relay.browserOnline ? "未连接" : "浏览器离线"
  const dictationKeys = prefs.dictationShortcut.split(/\s+\+\s+/).filter(Boolean)

  const writeHint = readOnlyHintOf(document, writer)
  const busy = writer.saving !== null
  const writeDisabled = !writer.canWrite || document.phase !== "ready" || busy
  const steering = effectiveSettingsDeliveryModeOf(document.data, writer.applied, "steeringMode")
  const followUp = effectiveSettingsDeliveryModeOf(document.data, writer.applied, "followUpMode")
  const autoResize = effectiveSettingsBoolOf(document.data, writer.applied, "images.autoResize")

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
        <SettingsRow title="侧边栏常驻搜索框" description="关闭时用功能键唤出搜索">
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

      <SettingsGroup
        label="发送与会话"
        description="插话 / 收尾投递与图片缩放是设备端 pi 设置（写入全局 settings.json），不是本机偏好；保存后需重启 pi 生效。"
      >
        <SettingsRadioGroup
          label="发送消息"
          value={prefs.sendKey}
          options={SEND_KEY_OPTIONS}
          onChange={(value) => act.setPref("sendKey", value)}
        />
        <SettingsRow title="生成时自动滚到底部" description="回答生成时始终显示最新内容">
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
          description="生成时排队的插话，怎么递给模型"
          value={steering}
          options={DELIVERY_OPTIONS}
          disabled={writeDisabled}
          onChange={(value) => {
            void writer.save("steeringMode", steeringModePatch(value))
          }}
        />
        <SettingsRadioGroup
          label="收尾消息投递"
          description="生成结束后排队的消息，怎么递给模型"
          value={followUp}
          options={DELIVERY_OPTIONS}
          disabled={writeDisabled}
          onChange={(value) => {
            void writer.save("followUpMode", followUpModePatch(value))
          }}
        />
        <SettingsRow title="发送图片前自动缩小" description="大图自动缩到 2000px 内再发给模型">
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

      <SettingsGroup label="语音输入">
        <SettingsSelect
          label="麦克风"
          value={prefs.micDevice}
          options={microphoneOptions}
          onChange={(value) => act.setPref("micDevice", value)}
        />
        <SettingsRow title="语音转文字" description="在输入框旁显示麦克风按钮，说话直接转成文字">
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
        <SettingsRow title="断线后自动重连" description="现有断线重连机制，始终保持开启">
          <SettingsSwitch label="断线后自动重连（现有机制）" checked disabled />
        </SettingsRow>
        <SettingsActionRow
          title="连接诊断"
          description="检查到中转服务器的连通性"
          status="bridge"
          disabled
        />
        <SettingsActionRow title="重新配对" onClick={act.openPairing} />
      </SettingsGroup>
    </div>
  )
}
