/**
 * 手机端设置 · 数据与隐私（移动压缩版）。
 *
 *   ○ 隐私模式：本机偏好（prefs.privacyMode），只影响本机渲染层脱敏，不改设备数据；
 *   ● 匿名安装统计 / 禁止发送图片：经 settings_set 写全局 settings.json；
 *   ◐ 数据存放 / 删除会话时同步删记录：继续只读（写桥白名单没有对应键）；
 *   ○ 本机记录保留 / 导出 / 导入 / 清除本机缓存：浏览器侧实现，改完即存。
 *
 * 导出文件含本机设置、会话索引（只留 id / 标题 / 时间 / 设备 / 在线态）与当前已载入会话正文（如有）；
 * 导入只接受设置文件（信封或裸偏好），校验后合并。
 */
import { useRef, useState, type ChangeEvent } from "react"
import { exportViewOf } from "@/pi/model/dialogsData"
import { CLIENT_VERSION } from "@/relay/protocol"
import { useSettings } from "../../SettingsContext.tsx"
import {
  SETTINGS_RETENTION,
  SETTINGS_RETENTION_LABELS,
  type SettingsRetention,
} from "../../types.ts"
import {
  buildDataExport,
  clearBrowserCaches,
  clearCacheStorage,
  downloadTextFile,
  parseSettingsImport,
} from "../../pages/dataTools.ts"
import { blockImagesPatch, effectiveSettingsBoolOf, installTelemetryPatch } from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import { SettingsHoverTitle } from "../../ui.tsx"
import {
  MobileActionBar,
  MobileActionButton,
  MobileGroup,
  MobilePageBody,
  MobileReadOnlyRow,
  MobileSegmented,
  MobileSwitchRow,
} from "../atoms.tsx"

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
  const telemetry = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "enableInstallTelemetry")
  const blockImages = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "images.blockImages")
  const fileRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)

  const sessions = Object.entries(relay.sessionsByDevice ?? {}).flatMap(([deviceId, list]) =>
    (list ?? []).map((session) => ({
      id: session.id,
      title: session.name,
      updatedAt: session.updatedAt,
      deviceId,
      online: session.online,
    })),
  )

  const sessionReady =
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
    if (sessionReady) {
      try {
        const result = await relay.runCommand("export_session")
        const view = exportViewOf(result)
        sessionText = view.text
        sessionTruncated = view.truncated
      } catch {
        // 会话正文导出失败不影响设置 + 会话索引导出；不把错误原文塞进界面。
      }
    }
    const exported = buildDataExport({
      prefs,
      sessions,
      sessionText,
      sessionTruncated,
      appVersion: CLIENT_VERSION,
    })
    const ok = downloadTextFile(exported.fileName, exported.text, exported.mime)
    setExporting(false)
    if (!ok) {
      act.notify("导出失败：浏览器不支持下载", "bad")
      return
    }
    act.notify(
      sessionText
        ? `已导出我的数据（${exported.sessionCount} 个会话）`
        : `已导出设置与会话索引（${exported.sessionCount} 个会话，当前会话正文未导出）`,
    )
  }

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    file.text().then(
      (text) => {
        const parsed = parseSettingsImport(text)
        if (!parsed.ok) {
          act.notify(`导入失败：${parsed.error}`, "bad")
          return
        }
        act.mergePrefs(parsed.prefs)
        p.act.setPref("theme", parsed.prefs.appearanceTheme)
        act.notify("已导入设置")
      },
      () => act.notify("导入失败：无法读取文件", "bad"),
    )
  }

  return (
    <MobilePageBody page="privacy">
      <MobileGroup label="隐私">
        <MobileSwitchRow
          title="隐私模式"
          tooltip="仅本机显示脱敏，不改设备数据；只模糊本机界面里的会话标题与摘要，也不同步到其它设备"
          checked={prefs.privacyMode}
          onChange={(checked) => act.setPref("privacyMode", checked)}
        />
        <MobileSwitchRow
          title="匿名安装统计"
          tooltip="pi 默认开启：匿名上报安装与更新统计，与会话内容无关"
          checked={telemetry === true}
          disabled={writeDisabled || telemetry === null}
          onChange={(checked) => {
            void writer.save("enableInstallTelemetry", installTelemetryPatch(checked))
          }}
        />
        <MobileSwitchRow
          title="禁止发送图片"
          checked={blockImages === true}
          disabled={writeDisabled}
          onChange={(checked) => {
            void writer.save("images.blockImages", blockImagesPatch(checked))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      <MobileGroup label="数据存放" tooltip="Pi-Remote 仅把设备会话镜像到本浏览器，中转服务器不保存会话内容">
        <MobileReadOnlyRow title="会话记录" value="所连设备本机" />
      </MobileGroup>

      <MobileGroup label="保留">
        <div className="sm-pad">
          <div className="sm-field-title">
            <SettingsHoverTitle tooltip="本机索引按此保留并立即生效；设备侧旧会话记录自动清理需扩展桥支持">
              本机记录保留
            </SettingsHoverTitle>
          </div>
          <MobileSegmented
            label="本机记录保留"
            value={prefs.retention}
            options={RETENTION_OPTIONS}
            onChange={(value) => act.setPref("retention", value)}
          />
        </div>
        <MobileSwitchRow
          title="删除会话时同步删记录"
          tooltip="开启时同时删除设备上的会话文件；关闭后仅在本机浏览器隐藏（防止同步回流）"
          checked={prefs.syncDeleteSession}
          onChange={(checked) => act.setPref("syncDeleteSession", checked)}
        />
      </MobileGroup>

      <MobileGroup label="我的数据">
        <MobileActionBar
          title="我的数据与本机缓存"
          tooltip="导出含设置与会话索引，不含正文与路径；清除缓存不影响设备原始记录"
        >
          <MobileActionButton
            title="导出我的数据"
            label={exporting ? "导出中…" : undefined}
            hint="打包设置、会话索引与当前会话为一个文件"
            disabled={exporting}
            onClick={() => {
              void exportData()
            }}
          />
          <MobileActionButton
            title="导入设置"
            hint="从文件导入设置与偏好"
            onClick={() => fileRef.current?.click()}
          />
          <MobileActionButton
            title="清除本机缓存与索引"
            label="清除缓存"
            hint="不删除设备上的原始会话记录"
            tone="danger"
            onClick={() => {
              const cleared = clearCacheStorage(window.localStorage, window.sessionStorage)
              void clearBrowserCaches().then((browserCleared) => {
                act.notify(cleared || browserCleared ? "已清除本机缓存与索引" : "本机缓存已经是空的")
              })
            }}
          />
        </MobileActionBar>
      </MobileGroup>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="sm-visually-hidden"
        aria-label="选择设置文件"
        onChange={importFile}
      />
    </MobilePageBody>
  )
}
