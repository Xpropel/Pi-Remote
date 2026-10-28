import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ChevronDown, Folder, Monitor, Plus, Sparkles } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { deviceScopeLabel, folderForDevice, newSessionDefaultsOf, offlineReasonOf, sessionCountsOf, startingText } from "@/pi/model/newSession"
import { initialBrowsePathOf } from "@/pi/model/folderBrowser"
import { HARNESS_START_TIMEOUT_MS } from "@/relay/devices"
import { newSessionDraftOf, setNewSessionDraft, subscribeNewSessionDraft } from "@/relay/drafts"
import { baseName } from "../model/format"
import { useComposerEnter } from "@/pi/headless/useComposerEnter"
import { CLAUDE_OVERLAY } from "../overlays/ids"
import { takeNewSessionSeed } from "../model/newSessionSeed"
import { ClaudeMenu, ClaudeMenuItem, ClaudeMenuLabel, ClaudeMenuSeparator, ClaudeSpinner } from "../primitives/ClaudePrimitives"
import { ClaudeFolderBrowser } from "./ClaudeFolderBrowser"
import { ClaudeFolderPicker } from "./ClaudeFolderPicker"
import { ClaudeBoot } from "./ClaudeBoot"

/**
 * Claude v2 自有新建会话页（C-05 / P9 C）：设备 chip + 文件夹 chip（只看这台设备的目录）+ 大 composer（20 圆角、≥98 高）
 * + 三张建议卡（10 圆角横排）；选目录 → 写第一条 → 发送时才启动 pi。
 * 逻辑移植自产品 new-session 口径（model/newSession 纯函数 + relay.createSession / selectDevice / sendText），不 import 任何容器。
 */

const SUGGESTIONS = ["看看测试为什么失败", "解释这个目录的结构", "列出代码里的 TODO"]

type Starting = { deviceId: string; cwd: string; text: string; prevRoomId: string; at: number; phase: "select" | "start" | "send" }
const START_IDLE_FAIL_MS = 600

export function ClaudeNewSession({ p, phone = false }: { p: PiContainerProps; phone?: boolean }) {
  const { relay } = p
  const defaults = useMemo(
    () => newSessionDefaultsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, selectedDeviceId: relay.selectedDeviceId }),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.selectedDeviceId],
  )
  const [deviceId, setDeviceId] = useState<string | null>(() => takeNewSessionSeed()?.deviceId ?? defaults.deviceId)
  const [folder, setFolder] = useState<string | null>(() => takeNewSessionSeed()?.folder ?? defaults.folder)
  const draft = useSyncExternalStore(subscribeNewSessionDraft, newSessionDraftOf, newSessionDraftOf)
  const [building, setBuilding] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [starting, setStarting] = useState<Starting | null>(null)
  const [error, setError] = useState("")
  const idleSince = useRef<number | null>(null)
  const device = relay.devices.find((d) => d.id === (deviceId ?? defaults.deviceId)) ?? null
  // P9 C：未显式选设备时回退到在线设备，避免「选择文件夹」静默无响应（真实 relay 下设备端收不到 list_dirs）
  const activeDevice = device ?? relay.devices.find((d) => d.online) ?? relay.devices[0] ?? null
  const hour = new Date().getHours()
  const greeting = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好"
  const currentDeviceName = device?.name ?? relay.selectedDeviceId ?? "未选择设备"
  const currentFolder = folderForDevice(device, folder ?? defaults.folder)
  const sessions = device ? (relay.sessionsByDevice[device.id] ?? []) : []
  const counts = useMemo(() => sessionCountsOf(relay.sessionsByDevice, relay.devices), [relay.sessionsByDevice, relay.devices])
  const scopeLabel = device ? deviceScopeLabel(device, relay.devices) : ""
  const online = !!device?.online

  const start = () => {
    const text = draft.trim()
    if (!device || !currentFolder || !text || !online || starting || building) return
    setError("")
    setStarting({ deviceId: device.id, cwd: currentFolder, text, prevRoomId: relay.roomId, at: Date.now(), phase: "select" })
    if (relay.selectedDeviceId !== device.id) relay.selectDevice(device.id)
  }

  // 启动流程：createSession → 等新房间出现 → 把第一条放进输入框并发送 → 回会话视图
  useEffect(() => {
    if (!starting) {
      idleSince.current = null
      return
    }
    if (starting.phase === "select") {
      if (relay.selectedDeviceId !== starting.deviceId) return
      const next: Starting = { ...starting, phase: "start" }
      setStarting(next)
      setBuilding(true)
      void relay.createSession(starting.cwd).then(
        (result) => {
          setBuilding(false)
          if (result && typeof result === "object" && "alreadyRunning" in result && result.alreadyRunning) {
            const target = (result as { roomId?: string }).roomId
            if (target) relay.selectRoom(target)
            relay.setDraft(starting.text)
            setNewSessionDraft("")
            setStarting(null)
            p.act.openSession()
          }
        },
        (e: unknown) => {
          setBuilding(false)
          setStarting(null)
          setError(e instanceof Error ? e.message : "启动失败")
        },
      )
      return
    }
    if (starting.phase === "start") {
      if (relay.roomId && relay.roomId !== starting.prevRoomId) {
        const next: Starting = { ...starting, phase: "send" }
        setStarting(next)
        return
      }
      const since = idleSince.current ?? (idleSince.current = Date.now())
      if (Date.now() - since > START_IDLE_FAIL_MS + HARNESS_START_TIMEOUT_MS) {
        setStarting(null)
        setError("启动超时：pi 没有起来，可以重试")
      }
      return
    }
    // send：新房间连上（或等 3 秒兜底）后发送
    relay.setDraft(starting.text)
    const timer = window.setTimeout(() => {
      void relay.sendText()
      setNewSessionDraft("")
      setStarting(null)
      p.act.openSession()
    }, relay.online ? 0 : 3000)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starting, relay.roomId, relay.online, relay.selectedDeviceId])

  // 发送键偏好：默认 Enter 发送（与旧行为一致）；Ctrl 发送模式时 Enter 换行、Ctrl/Cmd+Enter 发送。
  // 手机壳：裸 Enter 仍原生换行；外接键盘的 Ctrl/Cmd+Enter 按同一偏好处理。
  const onComposerEnter = useComposerEnter({
    value: draft,
    setValue: (next) => setNewSessionDraft(next),
    send: start,
    canSend: !!draft.trim() && online && !starting,
    disabled: !!starting,
    mobile: phone,
  })

  if (relay.devices.length === 0) return <ClaudeBoot p={p} />

  const note = starting
    ? startingText(relay.devices.find((d) => d.id === starting.deviceId)?.name ?? "设备", starting.at, Date.now())
    : error
      ? error
      : device && !device.online
        ? offlineReasonOf(device.name)
        : ""

  return (
    <div data-pi-ui-part="page" className="claude-newpage">
      <div className="claude-newpage-inner">
        <section className="claude-chat-home" data-p4-surface="CL-CHAT-02" data-p4-ready="">
          <p className="claude-chat-home-eyebrow">
            <span className="claude-mark" aria-hidden>✳</span>
            {greeting} · 当前设备：{currentDeviceName}
          </p>
          <h1 className="claude-chat-home-title">今天想让 pi 做什么？</h1>
          <div className="claude-chat-home-chips" data-p4-surface="CL-CHAT-03" data-p4-ready="">
            {["列出这个目录最近改动的文件", "跑一遍测试并说明失败原因", "解释这段代码的调用链", "把这次改动整理成提交说明"].map((chip) => (
              <button key={chip} type="button" className="claude-chip" data-p4-action="example-chip" onClick={() => setNewSessionDraft(chip)}>
                {chip}
              </button>
            ))}
          </div>
        </section>
        <h1 className="claude-newpage-title">开始一段新对话</h1>
        <p className="claude-newpage-sub">先选设备与文件夹，写第一句，pi 会在电脑上接住。</p>

        <div className="claude-newpage-chips">
          <ClaudeMenu
            width={260}
            trigger={
              <button type="button" className="claude-chip claude-chip-btn" aria-label="选择运行设备">
                <Monitor size={14} strokeWidth={1.5} aria-hidden />
                {device ? `${device.name}${device.online ? "" : "（未连接）"}` : "选择设备"}
                <ChevronDown size={12} strokeWidth={2} aria-hidden />
              </button>
            }
          >
            <ClaudeMenuLabel>运行在</ClaudeMenuLabel>
            {relay.devices.map((item) => (
              <ClaudeMenuItem
                key={item.id}
                disabled={!item.online}
                hint={item.online ? undefined : "设备未连接"}
                onClick={() => {
                  setDeviceId(item.id)
                  setFolder(folderForDevice(item, folder))
                }}
              >
                {item.name}
                <span className="claude-menu-item-hint">{counts[item.id] ?? 0} 个会话</span>
              </ClaudeMenuItem>
            ))}
            <ClaudeMenuSeparator />
            <ClaudeMenuItem onClick={() => p.act.openDialog({ id: CLAUDE_OVERLAY.pairing })}>配对新设备…</ClaudeMenuItem>
          </ClaudeMenu>

          <ClaudeMenu
            width={300}
            trigger={
              <button type="button" className="claude-chip claude-chip-btn" aria-label="选择文件夹" disabled={!activeDevice} title={!activeDevice ? "还没有可用设备：先在电脑上配对一台设备" : undefined}>
                <Folder size={14} strokeWidth={1.5} aria-hidden />
                {currentFolder ? baseName(currentFolder) : "选择文件夹"}
                <ChevronDown size={12} strokeWidth={2} aria-hidden />
              </button>
            }
          >
            {device ? (
              <ClaudeFolderPicker
                device={activeDevice}
                sessions={sessions}
                value={currentFolder}
                onSelect={(path) => setFolder(path)}
                onBrowse={() => {
                  if (!activeDevice) return
                  if (!device) setDeviceId(activeDevice.id)
                  setBrowsing(true)
                }}
              />
            ) : (
              <ClaudeMenuLabel>先选设备</ClaudeMenuLabel>
            )}
          </ClaudeMenu>
        </div>

        <div className="claude-newpage-composer" data-building={building ? "" : undefined}>
          {building ? (
            <div className="claude-newpage-building">
              <ClaudeSpinner label="正在启动 pi" />
              <span>{startingText(device?.name ?? "设备", starting?.at ?? Date.now(), Date.now())}</span>
            </div>
          ) : (
            <textarea
              className="claude-newpage-input"
              rows={3}
              value={draft}
              placeholder="要 pi 做什么？输入 / 用命令，@ 引用文件"
              aria-label="第一条消息"
              disabled={!!starting}
              onChange={(event) => setNewSessionDraft(event.target.value)}
              onKeyDown={onComposerEnter}
            />
          )}
          <div className="claude-newpage-toolbar">
            <button type="button" className="claude-newpage-tool" onClick={() => setNewSessionDraft((d) => `${d}${d ? " " : ""}@`)} disabled={!device}>
              <Plus size={14} strokeWidth={1.75} aria-hidden />
              引用
            </button>
            <span className="claude-newpage-tool-spacer" />
            <button type="button" className="claude-send-btn" aria-label="开始" disabled={!draft.trim() || !online || !!starting} onClick={start}>
              <Sparkles size={15} strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>

        {note ? <p className="claude-newpage-note" role="status">{note}</p> : null}

        <div className="claude-newpage-suggestions">
          {SUGGESTIONS.map((text) => (
            <button key={text} type="button" className="claude-newpage-suggestion" onClick={() => setNewSessionDraft(text)}>
              {text}
            </button>
          ))}
        </div>
        <p className="claude-newpage-hint">建议提示词：点一张卡填进输入框；Tab 不适用（浏览器里用鼠标）。</p>

        {activeDevice && browsing ? (
          <ClaudeFolderBrowser
            open={browsing}
            variant={p.variant}
            device={activeDevice}
            listDirs={relay.listDirs}
            initialPath={initialBrowsePathOf(activeDevice, currentFolder)}
            scopeLabel={scopeLabel}
            onClose={() => setBrowsing(false)}
            onPick={(path) => {
              setFolder(path)
              setBrowsing(false)
            }}
          />
        ) : null}
        <section className="claude-chat-recent" data-p4-surface="CL-CHAT-06" data-p4-ready="">
          <h2 className="claude-chat-recent-title">最近的会话</h2>
          <div className="claude-chat-recent-grid">
            {(relay.rooms ?? []).slice(0, 6).map((session) => (
              <button
                key={session.id}
                type="button"
                className="claude-chat-recent-card"
                data-p4-row=""
                data-p4-action="open-recent"
                onClick={() => {
                  relay.selectRoom(session.id)
                }}
              >
                <span className="claude-chat-recent-name">{session.name || session.label || session.firstMessage || session.id}</span>
                <span className="claude-chat-recent-meta">{session.cwd ?? ""}</span>
              </button>
            ))}
            {(relay.rooms ?? []).length === 0 ? <p className="claude-list-empty">还没有最近的会话。</p> : null}
          </div>
        </section>
      </div>
    </div>
  )
}
