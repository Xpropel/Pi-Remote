/**
 * 手机端设置 · 数据与隐私（移动压缩版）。
 *
 *   ○ 隐私模式：本机偏好（prefs.privacyMode），只影响本机渲染层脱敏，不改设备数据；
 *   ● 匿名安装统计 / 禁止发送图片：经 settings_set 写全局 settings.json；
 *   ◐ 数据存放 / 删除会话时同步删记录：继续只读（写桥白名单没有对应键）；
 *   ○ 本机记录保留 / 导出 / 导入 / 清除本机缓存：浏览器侧实现，改完即存。
 *
 * 导出文件含本机设置与会话索引（只留 id / 标题 / 时间 / 设备 / 在线态），不含会话正文与路径；
 * 导入只接受设置文件（信封或裸偏好），校验后合并。
 */
import { useRef, type ChangeEvent } from "react"
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
import {
  MobileActionRow,
  MobileGroup,
  MobileNote,
  MobilePageBody,
  MobileReadOnlyRow,
  MobileRow,
  MobileSegmented,
  MobileSwitch,
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

  const sessions = Object.entries(relay.sessionsByDevice ?? {}).flatMap(([deviceId, list]) =>
    (list ?? []).map((session) => ({
      id: session.id,
      title: session.name,
      updatedAt: session.updatedAt,
      deviceId,
      online: session.online,
    })),
  )

  const exportData = () => {
    const exported = buildDataExport({ prefs, sessions, appVersion: CLIENT_VERSION })
    if (downloadTextFile(exported.fileName, exported.text, exported.mime)) {
      act.notify(`已导出设置与会话索引（${exported.sessionCount} 个会话）`)
    } else {
      act.notify("导出失败：浏览器不支持下载", "bad")
    }
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
          description="仅本机显示脱敏，不改设备数据"
          checked={prefs.privacyMode}
          onChange={(checked) => act.setPref("privacyMode", checked)}
        />
        <MobileSwitchRow
          title="匿名安装统计"
          description="pi 默认开启：匿名上报安装与更新统计，与会话内容无关，可关闭"
          checked={telemetry === true}
          disabled={writeDisabled || telemetry === null}
          onChange={(checked) => {
            void writer.save("enableInstallTelemetry", installTelemetryPatch(checked))
          }}
        />
        <MobileSwitchRow
          title="禁止发送图片"
          description="任何图片都不发给模型"
          checked={blockImages === true}
          disabled={writeDisabled || blockImages === null}
          onChange={(checked) => {
            void writer.save("images.blockImages", blockImagesPatch(checked))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={writer.feedback} fallback={writeHint} />
      <MobileNote>隐私模式只模糊本机界面里的会话标题与摘要，不修改设备上的会话数据，也不同步到其它设备。</MobileNote>
      <MobileNote>仍只读：数据存放与「删除会话时同步删记录」没有对应的 pi 设置字段（写桥白名单未开放）。</MobileNote>

      <MobileGroup label="数据存放" footnote="Pi-Remote 只是把设备上的会话镜像到你的浏览器，中转服务器不保存会话内容。">
        <MobileReadOnlyRow title="会话记录" value="所连设备本机" status="bridge" />
      </MobileGroup>

      <MobileGroup label="保留">
        <div className="sm-pad">
          <div className="sm-field-title">本机记录保留</div>
          <div className="sm-field-description">到期自动清理设备上的旧会话记录</div>
          <MobileSegmented
            label="本机记录保留"
            value={prefs.retention}
            options={RETENTION_OPTIONS}
            onChange={(value) => act.setPref("retention", value)}
          />
        </div>
        <MobileRow title="删除会话时同步删记录" status="bridge">
          <MobileSwitch label="删除会话时同步删记录（只读）" checked={false} disabled />
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="我的数据">
        <MobileActionRow title="导出我的数据" description="打包设置与会话索引为一个文件" onClick={exportData} />
        <MobileActionRow title="导入设置" description="从文件导入设置与偏好" onClick={() => fileRef.current?.click()} />
        <MobileActionRow
          title="清除本机缓存与索引"
          description="不删除设备上的原始会话记录"
          danger
          onClick={() => {
            const cleared = clearCacheStorage(window.localStorage, window.sessionStorage)
            void clearBrowserCaches().then(() => {
              act.notify(cleared ? "已清除本机缓存与索引" : "本机缓存已经是空的")
            })
          }}
        />
      </MobileGroup>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="sm-visually-hidden"
        aria-label="选择设置文件"
        onChange={importFile}
      />

      <MobileNote>导出含设置与会话索引，不含会话正文与路径；清除本机缓存不会删除设备上的原始记录。</MobileNote>
      <MobileNote>本机记录保留的到期清理在设备侧执行时仍需扩展桥；页面先保存你的选择。</MobileNote>
    </MobilePageBody>
  )
}
