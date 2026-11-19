/**
 * 设置 › 数据与隐私（设计册 §11 / 源码 settings-set-privacy-v3.html）。
 *
 * 状态口径：
 *   ○ 隐私模式：本机偏好（prefs.privacyMode），只影响本机渲染层脱敏，不改设备数据；
 *   ● 匿名安装统计 / 禁止发送图片：经 settings_set 写全局 settings.json（enableInstallTelemetry /
 *      images.blockImages）；成功后提示重启 pi，写失败回滚并说明原因。
 *   ◐ 数据存放 / 删除会话时同步删记录：继续只读（写桥白名单没有对应键）。
 *   ○ 本机记录保留 / 导入设置 / 清除本机缓存：浏览器侧即时生效并持久化。
 *   ● 导出我的数据：当前会话 export_session 已有桥；导出内容由用户显式点击下载，不打印。
 */
import { useRef, useState, type ChangeEvent } from "react"
import { exportViewOf } from "@/pi/model/dialogsData"
import { CLIENT_VERSION } from "@/relay/protocol"
import { useSettings } from "../SettingsContext"
import {
  SETTINGS_RETENTION,
  SETTINGS_RETENTION_LABELS,
  type SettingsRetention,
} from "../types"
import {
  SettingsActionBar,
  SettingsActionButton,
  SettingsGroup,
  SettingsInlineRadio,
  SettingsPageTitle,
  SettingsReadOnlyRow,
  SettingsRow,
  SettingsSwitch,
} from "../ui"
import {
  blockImagesPatch,
  effectiveSettingsBoolOf,
  installTelemetryPatch,
} from "./settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import {
  buildDataExport,
  clearBrowserCaches,
  clearCacheStorage,
  downloadTextFile,
  parseSettingsImport,
} from "./dataTools"
import "./privacy.css"

const RETENTION_OPTIONS = SETTINGS_RETENTION.map((value) => ({ value, label: SETTINGS_RETENTION_LABELS[value] })) as readonly {
  value: SettingsRetention
  label: string
}[]

export function PrivacyPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null
  const installTelemetry = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "enableInstallTelemetry")
  const blockImages = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "images.blockImages")
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [exporting, setExporting] = useState(false)
  const [clearing, setClearing] = useState(false)

  const ready =
    relay.authed &&
    relay.browserOnline &&
    relay.online &&
    !!relay.roomId &&
    !(relay.lazySession && relay.lazySession.id === relay.roomId)

  const exportData = async () => {
    if (exporting) return
    setExporting(true)
    let sessionText: string | null = null
    let sessionTruncated = false
    if (ready) {
      try {
        const result = await relay.runCommand("export_session")
        const view = exportViewOf(result)
        sessionText = view.text
        sessionTruncated = view.truncated
      } catch {
        // 会话正文导出失败不影响设置 + 会话索引导出；不把错误原文塞进界面。
      }
    }
    const file = buildDataExport({
      prefs,
      sessions: relay.listedSessions,
      sessionText,
      sessionTruncated,
      appVersion: CLIENT_VERSION,
    })
    const ok = downloadTextFile(file.fileName, file.text, file.mime)
    setExporting(false)
    if (!ok) {
      act.notify("无法下载导出文件", "warn")
      return
    }
    act.notify(sessionText ? "已导出我的数据" : "已导出设置与会话索引（当前会话正文未导出）")
  }

  const openImport = () => {
    fileInput.current?.click()
  }

  const importSettings = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    let text = ""
    try {
      text = await file.text()
    } catch {
      act.notify("读取设置文件失败", "warn")
      return
    }
    const parsed = parseSettingsImport(text)
    if (!parsed.ok) {
      act.notify(parsed.error, "warn")
      return
    }
    act.mergePrefs(parsed.prefs)
    p.act.setPref("theme", parsed.prefs.appearanceTheme)
    act.notify("已导入本机设置")
  }

  const clearCache = async () => {
    if (clearing) return
    setClearing(true)
    let removed = false
    try {
      removed = clearCacheStorage(window.localStorage, window.sessionStorage)
    } catch {
      removed = false
    }
    const browserCleared = await clearBrowserCaches()
    setClearing(false)
    act.notify(removed || browserCleared ? "已清除本机缓存与索引" : "本机没有可清理的缓存")
  }

  return (
    <div className="settings-page settings-privacy" data-settings-page="privacy">
      <SettingsPageTitle title="数据与隐私" />

      <SettingsGroup
        label="隐私"
        tooltip="Pi-Remote 仅把设备会话镜像到本浏览器，中转服务器不保存会话内容"
        first
      >
        <SettingsRow
          title="隐私模式"
          tooltip="仅本机显示脱敏，不改设备数据；只模糊本机界面里的会话标题与摘要（悬停或聚焦可临时看清），也不同步到其它设备"
        >
          <SettingsSwitch
            label="隐私模式"
            checked={prefs.privacyMode}
            onChange={(checked) => act.setPref("privacyMode", checked)}
          />
        </SettingsRow>
        <SettingsRow
          title="匿名安装统计"
          tooltip="pi 默认开启：匿名上报安装与更新统计，与会话内容无关"
        >
          <SettingsSwitch
            label="匿名安装统计"
            checked={installTelemetry === true}
            disabled={writeDisabled || installTelemetry === null}
            onChange={(checked) => {
              void writer.save("enableInstallTelemetry", installTelemetryPatch(checked))
            }}
          />
        </SettingsRow>
        <SettingsRow title="禁止发送图片">
          <SettingsSwitch
            label="禁止发送图片"
            checked={blockImages === true}
            disabled={writeDisabled}
            onChange={(checked) => {
              void writer.save("images.blockImages", blockImagesPatch(checked))
            }}
          />
        </SettingsRow>
        <SettingsReadOnlyRow title="数据存放" value="所连设备本机" status="existing" />
      </SettingsGroup>
      <SettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      <SettingsGroup label="保留">
        <SettingsInlineRadio
          label="本机记录保留"
          tooltip="本机索引按此保留并立即生效；设备侧旧会话记录自动清理需扩展桥支持"
          value={prefs.retention}
          options={RETENTION_OPTIONS}
          onChange={(value) => act.setPref("retention", value)}
        />
        <SettingsRow
          title="删除会话时同步删记录"
          tooltip="开启时同时删除设备上的会话文件；关闭后仅在本机浏览器隐藏该会话（防止历史同步拉回）"
        >
          <SettingsSwitch
            label="删除会话时同步删记录"
            checked={prefs.syncDeleteSession}
            onChange={(checked) => act.setPref("syncDeleteSession", checked)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="我的数据">
        <SettingsActionBar
          title="我的数据与本机缓存"
          tooltip="导出会打包本机设置与会话索引；导入只更新当前浏览器的本机偏好；清除缓存不删除设备上的原始会话记录"
        >
          <SettingsActionButton
            title="导出我的数据"
            label={exporting ? "导出中…" : undefined}
            hint="打包设置与会话索引为一个文件"
            disabled={exporting}
            onClick={() => {
              void exportData()
            }}
          />
          <SettingsActionButton
            title="导入设置"
            hint="从文件导入本机设置与偏好"
            onClick={openImport}
          />
          <SettingsActionButton
            title="清除本机缓存与索引"
            label={clearing ? "清理中…" : "清除缓存"}
            hint="不删除设备上的原始会话记录"
            tone="danger"
            disabled={clearing}
            onClick={() => {
              void clearCache()
            }}
          />
        </SettingsActionBar>
      </SettingsGroup>

      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="settings-privacy-file"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          void importSettings(event)
        }}
      />
    </div>
  )
}
