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
import { ChevronRight, Terminal } from "lucide-react"
import { normalizeHostDiag, type HostDiag } from "@/pi/model/hostDiag"
import { serverDisplayName } from "@/pi/model/serverName"
import { CLIENT_VERSION } from "@/relay/protocol"
import { useSettings } from "../SettingsContext"
import { SettingsPageTitle, SettingsStatusBadge } from "../ui"
import { buildDiagnosticsExport, checkLatestRelease } from "./aboutData"
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

const LICENSES = [
  { name: "React", license: "MIT" },
  { name: "Vite", license: "MIT" },
  { name: "Tailwind CSS", license: "MIT" },
  { name: "lucide-react", license: "ISC" },
  { name: "marked", license: "MIT" },
  { name: "Shiki", license: "MIT" },
] as const

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

function AboutActionRow({
  label,
  description,
  status,
  value,
  onClick,
  disabled,
}: {
  label: string
  description?: string
  status?: "reserved"
  value?: string
  onClick?: () => void
  disabled?: boolean
}) {
  const inert = disabled || status === "reserved"
  return (
    <button
      type="button"
      className={description ? "settings-about-row settings-about-row--desc settings-about-row--action" : "settings-about-row settings-about-row--action"}
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
      disabled={inert}
      onClick={() => {
        if (!inert) onClick?.()
      }}
    >
      <span className="settings-about-text">
        <span className="settings-about-kd">
          {label}
          {status ? <SettingsStatusBadge status={status} /> : null}
        </span>
        {description ? <span className="settings-about-rd">{description}</span> : null}
      </span>
      <span className="settings-about-row-end">
        {value ? <span className="settings-about-action-value">{value}</span> : null}
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" className="settings-about-chevron" />
      </span>
    </button>
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
  const { p, act } = useSettings()
  const { relay } = p
  // 先同步量本机可清缓存，CacheStorage 的部分再由 effect 补上；首帧不显示「读取中」。
  const [cacheBytes, setCacheBytes] = useState<number | null>(initialCacheBytes)
  const [clearing, setClearing] = useState(false)
  const [licensesOpen, setLicensesOpen] = useState(false)
  const [diag, setDiag] = useState<{ deviceId: string; value: HostDiag | null } | null>(null)
  const [diagPhase, setDiagPhase] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [exporting, setExporting] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateText, setUpdateText] = useState("")

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

  // pi 版本只认 get_host_diag；设备离线 / 旧扩展不支持时保持 —，不拿客户端版本冒充。
  const selectedDevice = relay.devices.find((device) => device.id === relay.selectedDeviceId) ?? null
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

  const relayVersion = relay.serverProto ? `relay · v${relay.serverProto}` : "—"
  const server = serverDisplayName(relay.serverName, hostname())
  const piVersion = effectiveDiag?.piVersion || "—"
  const piVersionText = !diagDeviceId ? "—" : diagPhase === "loading" ? "读取中…" : piVersion

  return (
    <div className="settings-page settings-about" data-settings-page="about">
      <SettingsPageTitle title="关于" />

      <div className="settings-about-ident">
        <span className="settings-about-tile" aria-hidden="true">
          <Terminal size={27} strokeWidth={1.9} />
        </span>
        <span>
          <span className="settings-about-appname">Pi-Remote</span>
          <span className="settings-about-appsub">个人远程会话 · 单用户</span>
        </span>
      </div>

      <div className="settings-about-panel settings-about-panel--info" aria-label="应用信息">
        <AboutValueRow label="应用版本" value={CLIENT_VERSION} />
        <AboutValueRow label="中转服务器" value={server} />
        <AboutValueRow label="中继版本" value={relayVersion} status="bridge" />
        <AboutValueRow label="pi 版本" value={piVersionText} />
        <AboutValueRow label="会话数据" value="来自所连设备上的 pi 会话记录" />
      </div>

      <h2 className="settings-group-label">数据</h2>
      <div className="settings-about-panel" aria-label="数据">
        <AboutValueRow label="本机缓存" value={cacheBytes == null ? "读取中…" : formatCacheSize(cacheBytes)} />
        <div className="settings-about-row settings-about-row--desc">
          <span className="settings-about-text">
            <span className="settings-about-kd">清理缓存</span>
            <span className="settings-about-rd">不影响设备上的会话记录</span>
          </span>
          <button
            type="button"
            className="settings-about-button"
            disabled={clearing}
            onClick={() => {
              void clearCache()
            }}
          >
            {clearing ? "清理中…" : "清理"}
          </button>
        </div>
      </div>

      <h2 className="settings-group-label">支持</h2>
      <div className="settings-about-panel" aria-label="支持">
        <AboutActionRow
          label="导出诊断信息"
          description="下载 JSON：主机诊断 + 中继 / 设备 / 版本；不含令牌与会话正文"
          value={exporting ? "导出中…" : undefined}
          disabled={exporting}
          onClick={() => {
            void exportDiagnostics()
          }}
        />
        <AboutActionRow
          label="开源许可"
          onClick={() => setLicensesOpen((open) => !open)}
          value={licensesOpen ? "收起" : undefined}
        />
        <AboutActionRow
          label="检查更新"
          description={updateText || "从 GitHub Releases 读取最新版本并与当前版本比较"}
          value={checkingUpdate ? "检查中…" : undefined}
          disabled={checkingUpdate}
          onClick={() => {
            void checkUpdate()
          }}
        />
      </div>

      {licensesOpen ? (
        <section className="settings-about-licenses" aria-label="开源许可">
          <h3 className="settings-about-licenses-title">开源许可</h3>
          <p className="settings-about-licenses-note">Pi-Remote 使用以下开源软件；许可见各自项目仓库。本页为本地静态说明，不联网。</p>
          <ul className="settings-about-licenses-list">
            {LICENSES.map((item) => (
              <li key={item.name}>
                <span>{item.name}</span>
                <span>{item.license}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="settings-about-footnote">Pi-Remote 为个人项目，仅供本人使用。</p>
    </div>
  )
}
