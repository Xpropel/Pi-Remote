/**
 * 设置 › 关于（设计册 §13 / 源码 settings-set-about.html）。
 *
 * ○ 身份块 / 应用版本 / 中转服务器 / 本机缓存清理 / 开源许可：浏览器侧本地呈现。
 * ◐ 中继版本：握手里的协议版本可读，只读呈现 +「需扩展桥」；不在客户端伪造 relay 包版本。
 * ● pi 版本：设备在线时读 get_host_diag.piVersion（按当前设备发设备级命令），离线 / 不支持显示 —；
 * ● 导出诊断信息：客户端下载 JSON（host diag + 中继 / 设备 / 版本），白名单字段，不含令牌与正文；
 * ● 检查更新：客户端请求 GitHub Releases 列表比较版本；没有 Release 时 200 + []（不制造 404），
 *   网络 / CSP / 404 都显示明确状态，不假装最新。读取失败时保留可重试的入口，不标「设计预留」。
 */
import { useEffect, useState } from "react"
import { PiMark } from "@/components/pi/shared"
import { useNow } from "@/pi/hooks/useNow"
import { normalizeHostDiag, type HostDiag } from "@/pi/model/hostDiag"
import { serverDisplayName } from "@/pi/model/serverName"
import { CLIENT_VERSION } from "@/relay/protocol"
import { useSettings } from "../SettingsContext"
import { SettingsHoverTitle, SettingsPageTitle, SettingsStatusBadge } from "../ui"
import {
  OPEN_SOURCE_LICENSES,
  buildDiagnosticsExport,
  checkLatestRelease,
  fetchRelayHealthVersion,
  formatRelayVersionText,
} from "./aboutData"
import { resolveSettingsPiRestartDevice, settingsPiRestartBannerOf } from "./settingsPiRestart.ts"
import { settingsPiUpdateRowOf } from "./settingsPiUpdate.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "./useSettingsPiRestart.tsx"
import { SettingsPiUpdateDialog, useSettingsPiUpdate } from "./useSettingsPiUpdate.tsx"
import {
  clearBrowserCaches,
  clearCacheStorage,
  downloadTextFile,
  formatCacheSize,
  measureBrowserCacheBytes,
  measureCacheBytes,
} from "./dataTools"
import "./about.css"

function hostname(): string {
  try {
    return typeof window === "undefined" ? "" : window.location.hostname
  } catch {
    return ""
  }
}

function AboutValueRow({
  label,
  value,
  status,
}: {
  label: string
  value: string
  status?: "bridge" | "reserved"
}) {
  const inert = status === "bridge" || status === "reserved"
  return (
    <div className="settings-about-row" data-settings-status={status} data-settings-inert={inert ? "true" : undefined}>
      <span className="settings-about-key">{label}</span>
      <span className="settings-about-value">
        {status ? <SettingsStatusBadge status={status} /> : null}
        {value}
      </span>
    </div>
  )
}

function initialCacheBytes(): number | null {
  try {
    if (typeof window === "undefined") return null
    return measureCacheBytes(window.localStorage, window.sessionStorage)
  } catch {
    return null
  }
}

export function AboutPage() {
  const { p, act, setPage } = useSettings()
  const { relay } = p
  const restart = useSettingsPiRestart(relay, act.notify)
  const piUpdate = useSettingsPiUpdate(relay, act.notify)
  const now = useNow(piUpdate.running ? 1000 : 60_000)
  // 先同步量本机可清缓存，CacheStorage 的部分再由 effect 补上；首帧不显示「读取中」。
  const [cacheBytes, setCacheBytes] = useState<number | null>(initialCacheBytes)
  const [clearing, setClearing] = useState(false)
  const [licensesOpen, setLicensesOpen] = useState(false)
  const [diag, setDiag] = useState<{ deviceId: string; value: HostDiag | null } | null>(null)
  const [diagPhase, setDiagPhase] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [exporting, setExporting] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateText, setUpdateText] = useState("")
  const [relayHealthVersion, setRelayHealthVersion] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void fetchRelayHealthVersion().then((info) => {
      if (active && info?.version) setRelayHealthVersion(info.version)
    })
    return () => {
      active = false
    }
  }, [relay.serverProto, relay.authed])

  const refreshCache = async () => {
    let local = 0
    try {
      local = measureCacheBytes(window.localStorage, window.sessionStorage)
    } catch {
      local = 0
    }
    const extra = await measureBrowserCacheBytes()
    return local + extra
  }

  useEffect(() => {
    let alive = true
    void refreshCache().then((bytes) => {
      if (alive) setCacheBytes(bytes)
    })
    return () => {
      alive = false
    }
    // 只在挂载时量一次；清理动作会自己刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // pi 版本只认 get_host_diag；未显式选设备时按同一目标解析规则锚定到在线设备。
  const resolvedTarget = resolveSettingsPiRestartDevice(relay)
  const selectedDevice = resolvedTarget ? (relay.devices.find((device) => device.id === resolvedTarget.id) ?? null) : null
  const diagDeviceId = selectedDevice?.online ? selectedDevice.id : null
  const sessionReady =
    relay.authed &&
    relay.online &&
    !!relay.roomId &&
    !(relay.lazySession && relay.lazySession.id === relay.roomId)
  const runDeviceCommand = typeof relay.runDeviceCommand === "function" ? relay.runDeviceCommand : null
  const runRoomCommand = relay.runCommand
  useEffect(() => {
    if (!diagDeviceId) return
    let alive = true
    setDiagPhase("loading")
    const command = runDeviceCommand
      ? runDeviceCommand(diagDeviceId, "get_host_diag")
      : sessionReady
        ? runRoomCommand("get_host_diag")
        : null
    if (!command) {
      setDiagPhase("error")
      return
    }
    void command.then(
      (data: unknown) => {
        if (!alive) return
        setDiag({ deviceId: diagDeviceId, value: normalizeHostDiag(data) })
        setDiagPhase("ready")
      },
      () => {
        if (!alive) return
        setDiag({ deviceId: diagDeviceId, value: null })
        setDiagPhase("error")
      },
    )
    return () => {
      alive = false
    }
  }, [diagDeviceId, runDeviceCommand, sessionReady, runRoomCommand])

  const clearCache = async () => {
    if (clearing) return
    setClearing(true)
    try {
      clearCacheStorage(window.localStorage, window.sessionStorage)
    } catch {
      // 隐私模式 / 存储被禁用：清不掉本机缓存也要把 CacheStorage 清掉。
    }
    await clearBrowserCaches()
    setCacheBytes(await refreshCache())
    setClearing(false)
    act.notify("已清除本机缓存，不影响设备上的会话记录")
  }

  const effectiveDiag = diag && diag.deviceId === diagDeviceId ? diag.value : null

  const exportDiagnostics = async () => {
    if (exporting) return
    setExporting(true)
    // 诊断文件尽量带上刚读到的 host diag；首屏还没回来时点导出，先补读一次。
    let hostDiag = effectiveDiag
    if (!hostDiag && diagDeviceId) {
      const command = runDeviceCommand
        ? runDeviceCommand(diagDeviceId, "get_host_diag")
        : sessionReady
          ? runRoomCommand("get_host_diag")
          : null
      if (command) {
        try {
          hostDiag = normalizeHostDiag(await command)
          setDiag({ deviceId: diagDeviceId, value: hostDiag })
          setDiagPhase("ready")
        } catch {
          hostDiag = null
        }
      }
    }
    const file = buildDiagnosticsExport({
      hostDiag,
      relay: {
        serverName: relay.serverName,
        serverProto: relay.serverProto,
        relayVersion: relayHealthVersion,
        clientVersion: CLIENT_VERSION,
        browserOnline: relay.browserOnline,
        authed: relay.authed,
        deviceMode: relay.deviceMode,
      },
      devices: relay.devices,
      selectedDeviceId: selectedDevice?.id ?? relay.selectedDeviceId,
      appVersion: CLIENT_VERSION,
    })
    const ok = downloadTextFile(file.fileName, file.text, file.mime)
    setExporting(false)
    act.notify(
      ok ? "已导出诊断信息（不含令牌与会话正文）" : "无法下载诊断文件",
      ok ? undefined : "warn",
    )
  }

  const checkUpdate = async () => {
    if (checkingUpdate) return
    setCheckingUpdate(true)
    setUpdateText("正在检查 GitHub Releases…")
    const result = await checkLatestRelease(CLIENT_VERSION)
    setCheckingUpdate(false)
    setUpdateText(result.text)
    act.notify(result.text, result.status === "error" ? "warn" : undefined)
  }

  const relayVersion = formatRelayVersionText(relayHealthVersion, relay.serverProto)
  const server = serverDisplayName(relay.serverName, hostname())
  const piVersion = effectiveDiag?.piVersion || piUpdate.update?.currentVersion || "—"
  const piVersionText = !diagDeviceId ? "—" : diagPhase === "loading" && !piUpdate.update?.currentVersion ? "读取中…" : piVersion
  const updateRow = settingsPiUpdateRowOf({
    target: piUpdate.target,
    checking: piUpdate.checking,
    update: piUpdate.update,
    checkError: piUpdate.checkError,
    status: piUpdate.status,
    otherRunning: restart.running,
    now,
  })
  const restartBanner = settingsPiRestartBannerOf({
    pendingRestart: restart.pendingRestart,
    phase: restart.phase,
    error: restart.error,
    canRestart: restart.target.canRestart,
    unsupportedReason: restart.target.reason,
  })
  const restartDescription = piUpdate.running
    ? "正在更新 Pi，更新完成后会自动重启"
    : restartBanner.title !== "重启 Pi"
      ? `${restartBanner.title} · ${restartBanner.description}`
      : restartBanner.description

  return (
    <div className="settings-page settings-about" data-settings-page="about">
      <SettingsPageTitle title="关于" />

      <div className="settings-about-ident">
        <span className="settings-about-tile" aria-hidden="true">
          <PiMark size={52} />
        </span>
        <span>
          <span className="settings-about-appname">Pi-Remote</span>
        </span>
      </div>

      <div className="settings-about-panel settings-about-panel--info" aria-label="应用信息">
        <AboutValueRow label="应用版本" value={CLIENT_VERSION} />
        <AboutValueRow label="中转服务器" value={server} />
        <AboutValueRow label="中继版本" value={relayVersion} />
        <AboutValueRow label="pi 版本" value={piVersionText} />
      </div>

      <h2 className="settings-group-label">设备运行与升级</h2>
      <div className="settings-about-panel" aria-label="设备运行与升级">
        <div className="settings-about-row settings-about-row--desc settings-about-row--bar">
          <span className="settings-about-text">
            <span className="settings-about-rd">{restart.pendingRestart ? restartDescription : updateRow.description}</span>
          </span>
          <span className="settings-about-actions">
            <button
              type="button"
              className={updateRow.canUpdate ? "settings-about-button is-primary" : "settings-about-button"}
              title="更新 Pi"
              disabled={updateRow.disabled}
              onClick={() => piUpdate.triggerPrimaryAction(restart.running)}
            >
              {updateRow.canUpdate ? updateRow.actionLabel : piUpdate.checking ? "检查中…" : piUpdate.running ? "更新中…" : "检查更新"}
            </button>
            <button
              type="button"
              className={restart.pendingRestart ? "settings-about-button is-primary" : "settings-about-button"}
              title="重启 Pi"
              disabled={restartBanner.buttonDisabled || piUpdate.running}
              onClick={restart.requestRestart}
            >
              {restart.running ? "重启中…" : restartBanner.buttonLabel}
            </button>
            <button
              type="button"
              className="settings-about-button"
              title="设备端更新与系统操作"
              onClick={() => setPage("devices")}
            >
              系统操作
            </button>
          </span>
        </div>
      </div>
      <SettingsPiUpdateDialog viewport="desktop" piUpdate={piUpdate} />
      <SettingsPiRestartDialog viewport="desktop" restart={restart} />

      <h2 className="settings-group-label">数据</h2>
      <div className="settings-about-panel" aria-label="数据">
        <div className="settings-about-row settings-about-row--desc">
          <span className="settings-about-text">
            <span className="settings-about-kd">
              <SettingsHoverTitle tooltip="清理后只移除本机浏览器缓存，不影响设备上的会话记录">本机缓存</SettingsHoverTitle>
            </span>
          </span>
          <span className="settings-about-row-end">
            <span className="settings-about-value">{cacheBytes == null ? "读取中…" : formatCacheSize(cacheBytes)}</span>
            <button
              type="button"
              className="settings-about-button"
              disabled={clearing}
              onClick={() => {
                void clearCache()
              }}
            >
              {clearing ? "清理中…" : "清理缓存"}
            </button>
          </span>
        </div>
      </div>

      <h2 className="settings-group-label">
        <SettingsHoverTitle tooltip="可导出脱敏诊断 JSON（不含令牌与会话正文）、检查 GitHub 新版本或查看开源许可">支持</SettingsHoverTitle>
      </h2>
      <div className="settings-about-panel" aria-label="支持">
        <div className="settings-about-row settings-about-row--desc settings-about-row--bar">
          <span className="settings-about-text">
            {updateText ? <span className="settings-about-rd">{updateText}</span> : null}
          </span>
          <span className="settings-about-actions">
            <button
              type="button"
              className="settings-about-button"
              disabled={exporting}
              title="下载 JSON：主机诊断 + 中继 / 设备 / 版本；不含令牌与会话正文"
              onClick={() => {
                void exportDiagnostics()
              }}
            >
              {exporting ? "导出中…" : "导出诊断信息"}
            </button>
            <button
              type="button"
              className="settings-about-button"
              disabled={checkingUpdate}
              title="从 GitHub Releases 读取最新版本并与当前版本比较"
              onClick={() => {
                void checkUpdate()
              }}
            >
              {checkingUpdate ? "检查中…" : "检查更新"}
            </button>
            <button
              type="button"
              className="settings-about-button"
              aria-expanded={licensesOpen}
              onClick={() => setLicensesOpen((open) => !open)}
            >
              {licensesOpen ? "收起许可" : "开源许可"}
            </button>
          </span>
        </div>
      </div>

      {licensesOpen ? (
        <section className="settings-about-licenses" aria-label="开源许可">
          <h3 className="settings-about-licenses-title">开源许可</h3>
          <ul className="settings-about-licenses-list">
            {OPEN_SOURCE_LICENSES.map((item) => (
              <li key={item.name}>
                <span>{item.name}</span>
                <span>{item.license}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
