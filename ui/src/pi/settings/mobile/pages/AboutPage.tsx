/**
 * 手机端设置 · 关于（移动压缩版）。
 *
 *   ○ 身份块 / 应用版本位 / 本机缓存与清理 / 开源许可：本地呈现与本地动作；
 *   ◐ 中继版本：握手信息可读（不做写入）；
 *   ● pi 版本：设备在线时读 get_host_diag.piVersion，离线 / 不支持显示 —；
 *   ● 导出诊断信息：客户端下载 JSON（host diag + 中继 / 设备 / 版本），白名单字段；
 *   ● 检查更新：客户端请求 GitHub Releases 列表比较版本；没有 Release 时 200 + []，失败说明 CSP / 网络原因，不假装最新。
 *
 * 身份位只显示中转服务器名（serverDisplayName），不出现用户本名。
 */
import { useEffect, useState } from "react"
import { PiMark } from "@/components/pi/shared"
import { useNow } from "@/pi/hooks/useNow"
import { normalizeHostDiag, type HostDiag } from "@/pi/model/hostDiag"
import { serverDisplayName } from "@/pi/model/serverName"
import { CLIENT_VERSION } from "@/relay/protocol"
import { useSettings } from "../../SettingsContext.tsx"
import {
  OPEN_SOURCE_LICENSES,
  buildDiagnosticsExport,
  checkLatestRelease,
  fetchRelayHealthVersion,
  formatRelayVersionText,
} from "../../pages/aboutData.ts"
import { resolveSettingsPiRestartDevice, settingsPiRestartBannerOf } from "../../pages/settingsPiRestart.ts"
import { settingsPiUpdateRowOf } from "../../pages/settingsPiUpdate.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "../../pages/useSettingsPiRestart.tsx"
import { SettingsPiUpdateDialog, useSettingsPiUpdate } from "../../pages/useSettingsPiUpdate.tsx"
import {
  clearBrowserCaches,
  clearCacheStorage,
  downloadTextFile,
  formatCacheSize,
  measureBrowserCacheBytes,
  measureCacheBytes,
} from "../../pages/dataTools.ts"
import {
  MobileActionBar,
  MobileActionButton,
  MobileCard,
  MobileGroup,
  MobilePageBody,
  MobileReadOnlyRow,
  MobileRow,
} from "../atoms.tsx"

function hostname(): string {
  try {
    return typeof window === "undefined" ? "" : window.location.hostname
  } catch {
    return ""
  }
}

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
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
  const [licensesOpen, setLicensesOpen] = useState(false)
  const [armedClear, setArmedClear] = useState(false)
  const [cacheBytes, setCacheBytes] = useState<number | null>(null)
  const [diag, setDiag] = useState<{ deviceId: string; value: HostDiag | null } | null>(null)
  const [diagPhase, setDiagPhase] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [exporting, setExporting] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateText, setUpdateText] = useState("")
  const [relayHealthVersion, setRelayHealthVersion] = useState<string | null>(null)
  const relayVersion = formatRelayVersionText(relayHealthVersion, relay.serverProto)

  useEffect(() => {
    let active = true
    void fetchRelayHealthVersion().then((info) => {
      if (active && info?.version) setRelayHealthVersion(info.version)
    })
    return () => {
      active = false
    }
  }, [relay.serverProto, relay.authed])
  const cacheLabel = formatCacheSize(cacheBytes)

  useEffect(() => {
    let alive = true
    const localBytes = measureCacheBytes(localStore(), sessionStore())
    measureBrowserCacheBytes().then((browserBytes) => {
      if (alive) setCacheBytes(localBytes + browserBytes)
    })
    return () => {
      alive = false
    }
  }, [])

  // pi 版本只认 get_host_diag；未显式选设备时按同一目标解析规则锚定到在线设备。
  const resolvedTarget = resolveSettingsPiRestartDevice(relay)
  const selectedDevice = resolvedTarget ? (relay.devices.find((device) => device.id === resolvedTarget.id) ?? null) : null
  const diagDeviceId = selectedDevice?.online ? selectedDevice.id : null
  const sessionReady =
    relay.authed &&
    relay.browserOnline &&
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

  const clearCache = () => {
    if (!armedClear) {
      setArmedClear(true)
      window.setTimeout(() => setArmedClear(false), 3000)
      return
    }
    setArmedClear(false)
    const cleared = clearCacheStorage(localStore(), sessionStore())
    void clearBrowserCaches().then(() => {
      setCacheBytes(measureCacheBytes(localStore(), sessionStore()))
      act.notify(cleared ? "已清理本机缓存" : "本机缓存已经是空的")
    })
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
    act.notify(ok ? "已导出诊断信息（不含令牌与会话正文）" : "无法下载诊断文件", ok ? undefined : "warn")
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

  const piVersion = effectiveDiag?.piVersion || piUpdate.update?.currentVersion || "—"
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
    <MobilePageBody page="about">
      <MobileCard className="sm-identity">
        <span className="sm-identity-logo" aria-hidden="true">
          <PiMark size={48} />
        </span>
        <span className="sm-identity-copy">
          <span className="sm-identity-name">Pi-Remote</span>
        </span>
      </MobileCard>

      <MobileGroup label="信息">
        <MobileRow title="应用版本">
          <span className="sm-value">{CLIENT_VERSION}</span>
        </MobileRow>
        <MobileRow title="中转服务器">
          <span className="sm-value">{serverDisplayName(relay.serverName, hostname())}</span>
        </MobileRow>
        <MobileRow title="中继版本">
          <span className="sm-value">{relayVersion}</span>
        </MobileRow>
        <MobileRow title="pi 版本">
          <span className="sm-value">{!diagDeviceId ? "—" : diagPhase === "loading" && !piUpdate.update?.currentVersion ? "读取中…" : piVersion}</span>
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="设备运行与升级">
        <MobileActionBar description={restartDescription}>
          <MobileActionButton
            title="更新 Pi"
            label={updateRow.actionLabel}
            hint={updateRow.description}
            disabled={updateRow.disabled}
            onClick={() => piUpdate.triggerPrimaryAction(restart.running)}
          />
          <MobileActionButton
            title="重启 Pi"
            label={restart.running ? "重启中…" : restartBanner.buttonLabel}
            hint={restartDescription}
            disabled={restartBanner.buttonDisabled || piUpdate.running}
            onClick={restart.requestRestart}
          />
          <MobileActionButton
            title="设备端更新与系统操作"
            label="系统操作"
            hint="前往「设备」查看完整版本矩阵，或执行重启设备端、更新设备端组件"
            onClick={() => setPage("devices")}
          />
        </MobileActionBar>
      </MobileGroup>
      <SettingsPiUpdateDialog viewport="phone" piUpdate={piUpdate} />
      <SettingsPiRestartDialog viewport="phone" restart={restart} />

      <MobileGroup label="数据">
        <MobileRow title="本机缓存" tooltip="清理后只移除本机浏览器缓存，不影响设备上的会话记录">
          <span className="sm-value">{cacheLabel}</span>
          <button type="button" className="sm-clear-button" onClick={clearCache}>
            {armedClear ? "再点清理" : "清理"}
          </button>
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="支持" tooltip="可导出脱敏诊断 JSON（不含令牌与会话正文）、检查 GitHub 新版本或查看开源许可">
        <MobileActionBar description={updateText || undefined}>
          <MobileActionButton
            title="导出诊断信息"
            label={exporting ? "导出中…" : "导出诊断信息"}
            hint="下载 JSON：主机诊断 + 中继 / 设备 / 版本；不含令牌与会话正文"
            disabled={exporting}
            onClick={() => {
              void exportDiagnostics()
            }}
          />
          <MobileActionButton
            title="检查更新"
            label={checkingUpdate ? "检查中…" : "检查更新"}
            hint="从 GitHub Releases 读取最新版本并与当前版本比较"
            disabled={checkingUpdate}
            onClick={() => {
              void checkUpdate()
            }}
          />
          <MobileActionButton
            title="开源许可"
            label={licensesOpen ? "收起许可" : "开源许可"}
            ariaExpanded={licensesOpen}
            onClick={() => setLicensesOpen((open) => !open)}
          />
        </MobileActionBar>
      </MobileGroup>

      {licensesOpen ? (
        <MobileGroup label="开源许可">
          {OPEN_SOURCE_LICENSES.map((item) => (
            <MobileReadOnlyRow key={item.name} title={item.name} value={item.license} />
          ))}
        </MobileGroup>
      ) : null}
    </MobilePageBody>
  )
}
