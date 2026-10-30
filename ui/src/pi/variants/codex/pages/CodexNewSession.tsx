import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ChevronDown, Folder, Laptop, Plus, Send } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { modelPillName } from "@/pi/model/models"
import { browseAccessOf, initialBrowsePathOf, knownFoldersOf } from "@/pi/model/folderBrowser"
import { deviceScopeLabel, folderForDevice, newSessionDefaultsOf, offlineReasonOf, recentFoldersOf, sessionCountsOf, startingText } from "@/pi/model/newSession"
import { useMissingFolders } from "@/pi/model/folderExistence"
import { HARNESS_START_TIMEOUT_MS } from "@/relay/devices"
import { newSessionDraftOf, setNewSessionDraft, subscribeNewSessionDraft } from "@/relay/drafts"
import { useNow } from "../hooks/useCodex"
import { useComposerEnter } from "@/pi/headless/useComposerEnter"
import { piBaseName } from "../logic/view"
import { CodexSpinner } from "../primitives/primitives"
import { CodexFolderBrowser } from "./CodexFolderBrowser"
import { CodexRunLocation, type CodexRunMode, type CodexRunLocationValue } from "../sidebar/CodexRunLocation"

const SUGGESTIONS = ["看看测试为什么失败", "解释这个目录的结构", "列出代码里的 TODO"]
type Phase = "select" | "start" | "send" | "existing"
/** knownRoomIds (F3): rooms that existed when the start was issued; a
 *  switch to one of them is the already-running room, not the new room. */
type Starting = { deviceId: string; cwd: string; text: string; prevRoomId: string; at: number; phase: Phase; roomId?: string; knownRoomIds: readonly string[] }

/**
 * Codex 新建会话（[X-图4][X-图5] / X-05 / P9 C）：
 * `开始新对话` 大标题 + 设备/项目下拉 + 3 张建议卡 + 25 圆角 composer + 三段切换（当前设备 / 工作目录 / 打开文件夹…）。
 * 设备与目录行为复用 @/pi/model/newSession + folderBrowser（P9 C：设备-目录不串、list_dirs 错误码、隐藏开关），
 * 呈现 100% 自写（不 import NewSessionContainer / PiEmptyComposer / PiFolderPicker）。
 */
export function CodexNewSession({ p, phone = false, onOpenPairing }: { p: VariantAppProps; phone?: boolean; onOpenPairing: () => void }) {
  const { relay, act } = p
  const now = useNow(1000)
  const defaults = useMemo(
    () => newSessionDefaultsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, selectedDeviceId: relay.selectedDeviceId }),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.selectedDeviceId],
  )
  const [deviceId, setDeviceId] = useState<string | null>(defaults.deviceId)
  const [folder, setFolder] = useState<string | null>(null)
  const draft = useSyncExternalStore(subscribeNewSessionDraft, newSessionDraftOf, newSessionDraftOf)
  const [starting, setStarting] = useState<Starting | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deviceOpen, setDeviceOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [runMode, setRunMode] = useState<CodexRunMode>("local")
  const imageInput = useRef<HTMLInputElement>(null)
  const device = relay.devices.find((d) => d.id === (deviceId ?? defaults.deviceId)) ?? null
  // F3: probe the folder that would be preselected; folders proven missing
  // on the device are excluded from the defaults, the lists and the folder.
  const provisionalCwd = folderForDevice(device, folder ?? defaults.folder)
  const missing = useMissingFolders(relay, device, provisionalCwd)
  const effectiveDefaults = missing.size ? newSessionDefaultsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, selectedDeviceId: relay.selectedDeviceId }, missing) : defaults
  const cwd = missing.size ? folderForDevice(device, folder ?? effectiveDefaults.folder, missing) : provisionalCwd
  const recent = device ? recentFoldersOf(relay.sessionsByDevice[device.id] ?? [], device, 5, missing) : []
  const known = device ? knownFoldersOf(device, relay.sessionsByDevice[device.id] ?? [], missing) : []
  const scopeLabel = device ? deviceScopeLabel(device, relay.devices) : ""
  const browse = device ? browseAccessOf(device) : null
  const counts = sessionCountsOf(relay.sessionsByDevice, relay.devices)
  const offlineReason = device && !device.online ? offlineReasonOf(device.name) : null
  const folderRequired = runMode === "folder" && !folder
  const canStart = !!device && !!cwd && !folderRequired && draft.trim().length > 0 && device.online && !starting && !error
  const pickDevice = (id: string) => {
    const next = relay.devices.find((d) => d.id === id)
    setDeviceId(id)
    setFolder(next ? folderForDevice(next, folder ?? cwd, missing) : null)
    setDeviceOpen(false)
  }
  const start = () => {
    if (!device || !cwd || !draft.trim() || !device.online || starting) return
    setError(null)
    setStarting({ deviceId: device.id, cwd, text: draft.trim(), prevRoomId: relay.roomId, at: Date.now(), phase: "select", knownRoomIds: relay.rooms.map((room) => room.id) })
    if (relay.selectedDeviceId !== device.id) relay.selectDevice(device.id)
  }
  // 发送键偏好：默认 Enter 发送（与旧行为一致）；Ctrl 发送模式时 Enter 换行、Ctrl/Cmd+Enter 发送。
  // 手机壳：裸 Enter 仍原生换行；外接键盘的 Ctrl/Cmd+Enter 按同一偏好处理。
  const onComposerEnter = useComposerEnter({
    value: draft,
    setValue: (next) => setNewSessionDraft(next),
    send: start,
    canSend: canStart,
    disabled: !!starting,
    mobile: phone,
  })
  useEffect(() => {
    if (!starting) return
    const s = starting
    if (s.phase === "select") {
      if (relay.selectedDeviceId === s.deviceId) {
        setStarting({ ...s, phase: "start", at: Date.now() })
        void relay.createSession(s.cwd).then((result) => {
          if (result?.ok && result.alreadyRunning && result.roomId) setStarting({ ...s, phase: "existing", roomId: result.roomId })
        })
      }
      return
    }
    if (s.phase === "existing") {
      if (s.roomId && relay.roomId !== s.roomId) {
        relay.selectRoom(s.roomId)
        return
      }
      const own = relay.draft
      relay.setDraft(own.trim() && own.trim() !== s.text.trim() ? `${own}\n\n${s.text}` : s.text)
      setNewSessionDraft("")
      setStarting(null)
      act.openSession()
      return
    }
    if (s.phase === "start") {
      if (relay.roomId && relay.roomId !== s.prevRoomId) {
        // F3: a switch to a room that already existed at start time is the
        // already-running room -- route it to the existing-room path (the
        // draft lands in its composer, nothing is sent). Treating any room
        // change as the new room raced the createSession promise and
        // silently delivered the prompt into the existing session.
        if (s.knownRoomIds.includes(relay.roomId)) {
          setStarting({ ...s, phase: "existing", roomId: relay.roomId })
          return
        }
        setStarting({ ...s, phase: "send" })
        return
      }
      if (relay.pendingStart || relay.commandInFlight[s.deviceId]) return
      const timer = window.setTimeout(() => {
        setStarting(null)
        setError(relay.notice?.text && relay.notice.tone === "bad" ? relay.notice.text : "启动失败，可以重试")
      }, 600)
      return () => window.clearTimeout(timer)
    }
    if (relay.online) {
      void relay.sendText(s.text)
      setNewSessionDraft("")
      setStarting(null)
      act.openSession()
      return
    }
    const timer = window.setTimeout(() => {
      void relay.sendText(s.text)
      setNewSessionDraft("")
      setStarting(null)
      act.openSession()
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [starting, relay, act])
  useEffect(() => {
    if (!starting || starting.phase !== "start") return
    const timer = window.setTimeout(() => {
      setStarting(null)
      setError("启动超时：pi 没有起来，可以重试")
    }, HARNESS_START_TIMEOUT_MS + 5000)
    return () => window.clearTimeout(timer)
  }, [starting])
  const note = starting ? (
    <p className="cx-new-note" role="status">
      {startingText(relay.devices.find((d) => d.id === starting.deviceId)?.name ?? "设备", starting.at, now)}
    </p>
  ) : error ? (
    <p className="cx-new-note cx-new-note-bad" role="alert">
      {error}
      <button type="button" className="cx-inline-link" onClick={start}>
        重试
      </button>
    </p>
  ) : offlineReason ? (
    <p className="cx-new-note">{offlineReason}</p>
  ) : null
  return (
    <div className="cx-new" data-variant={phone ? "phone" : "desktop"} data-pi-ui-part="page">
      <div className="cx-new-inner">
        <h1 className="cx-new-title">开始新对话</h1>
        <button type="button" className="cx-new-project" onClick={() => setDeviceOpen((open) => !open)} aria-expanded={deviceOpen}>
          <span>{device?.name ?? "选择设备"}</span>
          {cwd ? <span className="cx-new-project-folder">{piBaseName(cwd)}</span> : null}
          <ChevronDown aria-hidden size={13} strokeWidth={1.75} />
        </button>
        {deviceOpen ? (
          <div className="cx-new-pop cx-new-pop-device">
            {relay.devices.length === 0 ? <p className="cx-new-note">还没有配对设备</p> : null}
            {relay.devices.map((item) => (
              <button key={item.id} type="button" className="cx-pop-row" onClick={() => pickDevice(item.id)}>
                <Laptop aria-hidden size={14} strokeWidth={1.5} />
                <span className="cx-pop-row-main">{item.name}</span>
                <span className="cx-pop-row-desc">
                  {item.online ? "在线" : "未连接"} · {counts[item.id] ?? 0} 个会话
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="cx-new-suggest">
          {SUGGESTIONS.map((label) => (
            <button key={label} type="button" className="cx-new-suggest-card" onClick={() => setNewSessionDraft(label)}>
              {label}
            </button>
          ))}
        </div>
        <div className="cx-composer cx-composer-new" data-blocked={!device?.online ? "" : undefined}>
          <div className="cx-composer-top">
            <textarea
              className="cx-composer-input"
              rows={2}
              value={draft}
              placeholder="询问 Codex 任何事…"
              aria-label="新会话的第一条消息"
              disabled={!!starting}
              onChange={(event) => setNewSessionDraft(event.target.value)}
              onKeyDown={onComposerEnter}
            />
          </div>
          <div className="cx-composer-controls">
            <div className="cx-composer-left">
              <button type="button" className="cx-ctrl-btn" aria-label="添加" onClick={() => imageInput.current?.click()}>
                <Plus aria-hidden size={16} strokeWidth={1.75} />
              </button>
              <button type="button" className="cx-approval-chip" aria-label="审批模式：自动审查">
                <span className="cx-approval-dot" aria-hidden />
                自动审查
              </button>
              <button type="button" className="cx-new-chip" onClick={() => setFolderOpen((open) => !open)} aria-expanded={folderOpen}>
                <Folder aria-hidden size={13} strokeWidth={1.5} />
                {cwd ? piBaseName(cwd) : "选择工作目录"}
                <ChevronDown aria-hidden size={11} strokeWidth={1.75} />
              </button>
            </div>
            <div className="cx-composer-right">
              <span className="cx-model-chip cx-model-chip-static">
                <span className="cx-model-name">{modelPillName(relay) ?? "选择模型"}</span>
              </span>
              <button type="button" className="cx-send" data-variant={canStart ? "send" : "send-muted"} disabled={!canStart} aria-label="发送" onClick={start}>
                <Send aria-hidden size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
          {folderOpen ? (
            <div className="cx-composer-pop cx-new-pop-folder">
              {device ? (
                <>
                  {recent.map((path) => (
                    <button key={path} type="button" className="cx-pop-row" onClick={() => { setFolder(path); setFolderOpen(false) }}>
                      <Folder aria-hidden size={13} strokeWidth={1.5} />
                      <span className="cx-pop-row-main">{piBaseName(path)}</span>
                      <span className="cx-pop-row-desc">{path}</span>
                    </button>
                  ))}
                  {known.filter((path) => !recent.includes(path)).map((path) => (
                    <button key={path} type="button" className="cx-pop-row" onClick={() => { setFolder(path); setFolderOpen(false) }}>
                      <Folder aria-hidden size={13} strokeWidth={1.5} />
                      <span className="cx-pop-row-main">{piBaseName(path)}</span>
                    </button>
                  ))}
                  <button type="button" className="cx-pop-row" onClick={() => { setFolderOpen(false); setBrowsing(true) }}>
                    <span className="cx-pop-row-main">打开文件夹…</span>
                    <span className="cx-pop-row-desc">{browse?.canBrowse ? scopeLabel : browse?.reason ?? "这台设备不支持浏览目录"}</span>
                  </button>
                </>
              ) : (
                <p className="cx-new-note">先选择设备</p>
              )}
            </div>
          ) : null}
        </div>
        <CodexRunLocation
          p={p}
          value={{ mode: runMode, deviceId, folder } satisfies CodexRunLocationValue}
          onChange={(next) => {
            setRunMode(next.mode)
            setDeviceId(next.deviceId)
            setFolder(next.folder)
          }}
          onPair={onOpenPairing}
        />
        {note}
        <input ref={imageInput} type="file" accept="image/*" hidden onChange={() => relay.notify("新会话的第一条先发文字；图片和文件在会话开始后再加", "warn")} />
      </div>
      {browsing && device ? (
        <CodexFolderBrowser
          p={p}
          deviceId={device.id}
          scopeLabel={scopeLabel}
          initialPath={initialBrowsePathOf(device, cwd)}
          open={browsing}
          onOpenChange={(open) => {
            if (!open) setBrowsing(false)
          }}
          onPick={(path) => {
            setFolder(path)
            setBrowsing(false)
          }}
        />
      ) : null}
      {starting ? (
        <div className="cx-new-starting" role="status">
          <CodexSpinner size={14} /> 正在启动…
        </div>
      ) : null}
    </div>
  )
}
