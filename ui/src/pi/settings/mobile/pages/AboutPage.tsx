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
import { normalizeHostDiag, type HostDiag } from "@/pi/model/hostDiag"
import { serverDisplayName } from "@/pi/model/serverName"
import { CLIENT_VERSION } from "@/relay/protocol"
import { useSettings } from "../../SettingsContext.tsx"
import { buildDiagnosticsExport, checkLatestRelease } from "../../pages/aboutData.ts"
import {
  clearBrowserCaches,
  clearCacheStorage,
  downloadTextFile,
  formatCacheSize,
  measureBrowserCacheBytes,
  measureCacheBytes,
} from "../../pages/dataTools.ts"
import {
  MobileActionRow,
  MobileCard,
  MobileGroup,
  MobileNote,
  MobilePageBody,
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

const LICENSE_TEXT = `Pi-Remote 个人远程会话工具

本仓库为个人项目，仅供本人使用。第三方依赖与字体的许可文本分别见各自包内的 LICENSE 文件。
本页不联网、不展示第三方版权全文，只提供本地静态说明入口。`

export function AboutPage() {
  const { p, act } = useSettings()
  const { relay } = p
  const [licensesOpen, setLicensesOpen] = useState(false)
  const [armedClear, setArmedClear] = useState(false)
  const [cacheBytes, setCacheBytes] = useState<number | null>(null)
  const [diag, setDiag] = useState<{ deviceId: string; value: HostDiag | null } | null>(null)
  const [diagPhase, setDiagPhase] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [exporting, setExporting] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateText, setUpdateText] = useState("")
  const relayVersion = relay.serverProto != null ? `v${relay.serverProto}` : "—"
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

  // pi 版本只认 get_host_diag；设备离线 / 旧扩展不支持时保持 —。
  const selectedDevice = relay.devices.find((device) => device.id === relay.selectedDeviceId) ?? null
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
        clientVersion: CLIENT_VERSION,
        browserOnline: relay.browserOnline,
        authed: relay.authed,
        deviceMode: relay.deviceMode,
      },
      devices: relay.devices,
      selectedDeviceId: relay.selectedDeviceId,
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

  const piVersion = effectiveDiag?.piVersion || "—"

  return (
    <MobilePageBody page="about">
      <MobileCard className="sm-identity">
        <span className="sm-identity-logo" aria-hidden="true">
          {">_"}
        </span>
        <span className="sm-identity-copy">
          <span className="sm-identity-name">Pi-Remote</span>
          <span className="sm-identity-sub">个人远程会话 · 单用户</span>
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
        <MobileRow title="会话数据">
          <span className="sm-value">来自设备上的 pi 会话记录</span>
        </MobileRow>
        <MobileRow title="pi 版本">
          <span className="sm-value">{!diagDeviceId ? "—" : diagPhase === "loading" ? "读取中…" : piVersion}</span>
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="数据">
        <MobileRow title="本机缓存" description="不影响设备上的会话记录">
          <span className="sm-value">{cacheLabel}</span>
          <button type="button" className="sm-clear-button" onClick={clearCache}>
            {armedClear ? "再点清理" : "清理"}
          </button>
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="支持">
        <MobileActionRow
          title="导出诊断信息"
          description="下载 JSON：主机诊断 + 中继 / 设备 / 版本；不含令牌与会话正文"
          value={exporting ? "导出中…" : undefined}
          disabled={exporting}
          onClick={() => {
            void exportDiagnostics()
          }}
        />
        <MobileActionRow title="开源许可" onClick={() => setLicensesOpen((open) => !open)} />
        <MobileActionRow
          title="检查更新"
          description={updateText || "从 GitHub Releases 读取最新版本并与当前版本比较"}
          value={checkingUpdate ? "检查中…" : undefined}
          disabled={checkingUpdate}
          onClick={() => {
            void checkUpdate()
          }}
        />
      </MobileGroup>

      {licensesOpen ? (
        <MobileCard className="sm-license">
          <div className="sm-license-title">开源许可</div>
          <pre className="sm-license-text">{LICENSE_TEXT}</pre>
          <button type="button" className="sm-license-close" onClick={() => setLicensesOpen(false)}>
            收起
          </button>
        </MobileCard>
      ) : null}

      <MobileNote>Pi-Remote 为个人项目，仅供本人使用。</MobileNote>
    </MobilePageBody>
  )
}
