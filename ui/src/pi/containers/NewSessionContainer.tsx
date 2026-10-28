import { useEffect, useMemo, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from "react"
import { MenuItem } from "@/components/kit"
import { SuggestionPills } from "@/components/kit/composer/SuggestionPills"
import { PiAttachMenu, PiEmptyComposer, PiFolderBrowser, PiFolderPicker, type PiEmptyMenu } from "@/components/pi/composer"
import { PiDeviceMenu, PiPhonePage, PiSheet, PiTopBar } from "@/components/pi/shared"
import { piBaseName } from "@/components/pi/shared/format"
import { usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { useNow } from "@/pi/hooks/useNow"
import { browseAccessOf, initialBrowsePathOf, knownFoldersOf } from "@/pi/model/folderBrowser"
import { deviceScopeLabel, folderForDevice, newSessionDefaultsOf, offlineReasonOf, recentFoldersOf, sessionCountsOf, startingText } from "@/pi/model/newSession"
import { HARNESS_START_TIMEOUT_MS } from "@/relay/devices"
import { newSessionDraftOf, setNewSessionDraft, subscribeNewSessionDraft } from "@/relay/drafts"
import { C_IDS, modelPillOf, useModelData } from "./cShared"
import { ModelMenuContent, SheetHost } from "./ComposerContainer"
import { PairingContainer } from "./PairingContainer"
import { openPiDialog, PI_UI_IDS, type PiContainerProps, type Relay } from "./types"

/**
 * 新建会话（plan §7.3 new-session / new-session-picker，c 线）：devices / selectedDevice / createSession / pendingStart；
 * cwdInProjects、pickDefaultDevice、HARNESS_START_TIMEOUT_MS（model/newSession.ts）。
 * 选目录、写第一条、发送时才启动 pi（决定 12）：发送 → 选中设备 → createSession(cwd) → 新房间出现并连上 → 把第一条发出去 → 回到会话视图。
 * 启动中框下"正在 <设备> 上启动 pi… Ns"、输入锁定；启动失败红字 + "重试"，草稿保留。
 * 同目录已有会话在运行（already_running）：切到那个会话、草稿放进它的输入框不发，不算启动失败（联动测试 10）。设备在线但没有会话时预选这台设备和第一个目录（M-04）。
 * 设备菜单 / 目录选择器的"配对新设备…"开 a 的配对：openPiDialog(p, { id: PI_UI_IDS.pairing })。
 * 桌面放在外壳正文（ui.view === "new"），手机是整页（自己的 PiPhonePage 和 sheet 槽）。
 * 草稿、选中的设备 / 目录、启动进度放在本文件的模块级小 store 里：桌面 / 手机切换、离开再回来都还在（刷新即清）。
 */

/** 空会话建议（design c/new-session 的三颗；点一颗 = 填进输入框） */
const SUGGESTIONS = [
  { key: "tests", label: "看看测试为什么失败", primary: true },
  { key: "explain", label: "解释这个目录的结构" },
  { key: "todo", label: "列出代码里的 TODO" },
]

/** phase existing：同目录已有会话（already_running），roomId = 那个会话的房间 */
type Starting = { deviceId: string; cwd: string; text: string; prevRoomId: string; at: number; phase: "select" | "start" | "send" | "existing"; roomId?: string }
/** `draft` 只是旧 store 形状的兼容字段：真正的草稿源是 @/relay/drafts 的共享 store（切皮肤保留），
 *  经 setStore({ draft }) 写入时同步过去；读取一律用 useSyncExternalStore 的共享快照。 */
type NewState = { deviceId: string | null; folder: string | null; draft: string; starting: Starting | null; error: string | null; browsing: boolean }

let store: NewState = { deviceId: null, folder: null, draft: "", starting: null, error: null, browsing: false }
const listeners = new Set<() => void>()
function setStore(patch: Partial<NewState>) {
  if (patch.draft !== undefined) setNewSessionDraft(patch.draft)
  store = { ...store, ...patch }
  for (const fn of [...listeners]) fn()
}
/** 侧栏组头"+"（在这个目录新建会话，m6）：预选这一组的设备和目录，草稿留着；正在启动时不改（启动的是已经选好的那一组） */
export function presetNewSession(deviceId: string, folder: string) {
  if (store.starting) return
  setStore({ deviceId, folder, error: null })
}
function useNewState(): NewState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => store,
    () => store,
  )
}

/** 当前要用的设备与目录（没手选过就用预选；目录不在设备允许的范围里时换成第一个） */
function useSelection(relay: Relay, state: NewState) {
  const defaults = useMemo(
    () => newSessionDefaultsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, selectedDeviceId: relay.selectedDeviceId }),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.selectedDeviceId],
  )
  const device = relay.devices.find((d) => d.id === (state.deviceId ?? defaults.deviceId)) ?? null
  const folder = folderForDevice(device, state.folder ?? defaults.folder)
  const sessions = device ? (relay.sessionsByDevice[device.id] ?? []) : []
  // P9 C：这台设备自己的文件夹——最近用过的、白名单 + 最近（去重）、作用域说法、能不能打开浏览器
  const recent = device ? recentFoldersOf(sessions, device) : []
  const knownFolders = device ? knownFoldersOf(device, sessions) : []
  const scopeLabel = device ? deviceScopeLabel(device, relay.devices) : ""
  const browse = browseAccessOf(device)
  return { device, folder, recent, knownFolders, scopeLabel, browse }
}

/** 启动流程：选设备 → createSession → 等新房间 → 发第一条 → 回会话视图；失败 / 超时写原因（草稿保留） */
/** 启动后"既没在启动、也没换房间"持续这么久 = createSession 当场失败（原因在 relay.notice）；新房间连不上时最多等这么久再发（进 outbox） */
const START_IDLE_FAIL_MS = 600
const SEND_WAIT_MS = 3000

function useStartFlow(p: PiContainerProps, state: NewState) {
  const { relay, act } = p
  const s = state.starting
  // 用时间点而不是每次重新计时：relay 每次更新都会重跑 effect，计时器不能因此一直被推后
  const idleSince = useRef<number | null>(null)
  const sendBy = useRef<number | null>(null)
  useEffect(() => {
    if (!s) {
      idleSince.current = null
      sendBy.current = null
      return
    }
    // store.starting !== s：这一步已经被上一次 effect 推进过了（StrictMode 双跑 / 重渲），不重复启动、不重复发送
    if (store.starting !== s) return
    if (s.phase === "select") {
      if (relay.selectedDeviceId === s.deviceId) {
        const next: Starting = { ...s, phase: "start", at: Date.now() }
        setStore({ starting: next })
        void relay.createSession(s.cwd).then((result) => {
          // 同目录已有会话在运行（already_running）：useRelay 已切到它并提示"已切换到它…"。不算启动失败，第一条也不发（联动测试 10）。
          // 回包和切房在同一个任务里，先于下一次渲染，所以 start 阶段不会先把"换了房间"当成新房间去发
          if (store.starting === next && result?.ok && result.alreadyRunning && result.roomId) {
            idleSince.current = null
            setStore({ starting: { ...next, phase: "existing", roomId: result.roomId } })
          }
        })
      }
      return
    }
    if (s.phase === "existing") {
      // 回到那个已有会话：草稿原样放进它的输入框（它自己已有草稿就接在后面，不覆盖），不发送
      if (s.roomId && relay.roomId !== s.roomId) {
        // 平常 useRelay 已经切过去了；没切（例如被别的打开动作压掉）就补切一次，只试一次
        relay.selectRoom(s.roomId)
        setStore({ starting: { ...s, roomId: undefined } })
        return
      }
      const own = relay.draft
      const text = newSessionDraftOf()
      relay.setDraft(own.trim() && own.trim() !== text.trim() ? `${own}\n\n${text}` : text)
      setStore({ starting: null, error: null, draft: "" })
      act.openSession()
      return
    }
    if (s.phase === "start") {
      if (relay.roomId && relay.roomId !== s.prevRoomId) {
        idleSince.current = null
        setStore({ starting: { ...s, phase: "send" } })
        return
      }
      const pending = !!relay.pendingStart || !!relay.commandInFlight[s.deviceId]
      if (pending) {
        idleSince.current = null
        return
      }
      const since = idleSince.current ?? (idleSince.current = Date.now())
      const fail = () => {
        idleSince.current = null
        const reason = relay.notice?.tone === "bad" && relay.notice.text ? relay.notice.text : "启动失败"
        setStore({ starting: null, error: reason })
      }
      const left = START_IDLE_FAIL_MS - (Date.now() - since)
      if (left <= 0) {
        fail()
        return
      }
      const timer = window.setTimeout(fail, left)
      return () => window.clearTimeout(timer)
    }
    // send：新房间连上就发；一直连不上也发（进 outbox，连上后按顺序发）
    const send = () => {
      sendBy.current = null
      if (store.starting !== s) return
      void relay.sendText(s.text)
      setStore({ starting: null, error: null, draft: "" })
      act.openSession()
    }
    if (relay.online) {
      send()
      return
    }
    const by = sendBy.current ?? (sendBy.current = Date.now() + SEND_WAIT_MS)
    const left = by - Date.now()
    if (left <= 0) {
      send()
      return
    }
    const timer = window.setTimeout(send, left)
    return () => window.clearTimeout(timer)
  }, [s, relay, act])
  // 超时：pi 没有起来
  useEffect(() => {
    if (!s || s.phase !== "start") return
    const timer = window.setTimeout(() => setStore({ starting: null, error: "启动超时：pi 没有起来，可以重试" }), HARNESS_START_TIMEOUT_MS + 5000)
    return () => window.clearTimeout(timer)
  }, [s])
}

function NewComposer(p: PiContainerProps) {
  const { relay, ui, act, variant } = p
  const phone = variant === "phone"
  const isStatic = usePiStatic()
  const now = useNow(1000)
  const state = useNewState()
  const draft = useSyncExternalStore(subscribeNewSessionDraft, newSessionDraftOf, newSessionDraftOf)
  const { device, folder, recent, knownFolders, scopeLabel, browse } = useSelection(relay, state)
  useStartFlow(p, state)
  const starting = state.starting
  const counts = sessionCountsOf(relay.sessionsByDevice, relay.devices)
  const openId = phone ? ui.sheet?.id : ui.menu?.id
  const open: PiEmptyMenu | null =
    openId === C_IDS.newDevice ? "device" : openId === C_IDS.newFolder ? "folder" : openId === C_IDS.newPlus ? "plus" : openId === C_IDS.newModel ? "model" : null
  const idOf: Record<PiEmptyMenu, string> = { device: C_IDS.newDevice, folder: C_IDS.newFolder, plus: C_IDS.newPlus, model: C_IDS.newModel }
  const onOpenChange = (which: PiEmptyMenu | null) => {
    if (phone) {
      if (which) act.openSheet({ id: idOf[which] })
      else act.closeSheet()
    } else if (which) act.openMenu({ id: idOf[which] })
    else act.closeMenu()
  }
  const modelData = useModelData(relay, open === "model" && !phone)
  const selectDevice = (id: string) => {
    const next = relay.devices.find((d) => d.id === id)
    if (!next) return
    setStore({ deviceId: id, folder: folderForDevice(next, state.folder ?? folder), error: null, browsing: false })
  }
  const pair = <MenuItem onSelect={() => openPiDialog(p, { id: PI_UI_IDS.pairing })}>配对新设备…</MenuItem>
  const start = () => {
    const text = draft.trim()
    if (!device || !folder || !text || !device.online || starting) return
    setStore({ error: null, starting: { deviceId: device.id, cwd: folder, text, prevRoomId: relay.roomId, at: Date.now(), phase: "select" } })
    if (relay.selectedDeviceId !== device.id) relay.selectDevice(device.id)
  }
  // 框下：启动中 / 失败 + 重试 / 设备离线的原因；都没有时桌面放建议 pill
  let note: ReactNode = null
  if (starting) {
    note = (
      <p role="status" className="m-0 px-1 text-(length:--cw-text-sm) text-[color:var(--cw-pi-text-secondary,var(--cw-text-3))]">
        {startingText(relay.devices.find((d) => d.id === starting.deviceId)?.name ?? "设备", starting.at, now)}
      </p>
    )
  } else if (state.error) {
    note = (
      <p role="alert" className="m-0 flex items-center gap-2 px-1 text-(length:--cw-text-sm) text-[color:var(--cw-pi-error,var(--cw-red))]">
        <span className="min-w-0 truncate">{state.error}</span>
        <button type="button" className="shrink-0 font-(--cw-weight-medium) underline" onClick={start}>
          重试
        </button>
      </p>
    )
  } else if (device && !device.online) {
    note = <p className="m-0 px-1 text-(length:--cw-text-sm) text-(--cw-text-2)">{offlineReasonOf(device.name)}</p>
  }
  const pickSuggestion = (event: MouseEvent<HTMLDivElement>) => {
    const id = (event.target as Element).closest("[data-cw-id]")?.getAttribute("data-cw-id") ?? ""
    const hit = SUGGESTIONS.find((s) => id.endsWith(`-${s.key}`))
    if (hit) setNewSessionDraft(hit.label)
  }
  const below =
    note ?? (phone ? undefined : <SuggestionPills data-cw-id="pi-new-suggestions" items={SUGGESTIONS} onClick={isStatic ? undefined : pickSuggestion} />)
  // P9 C：文件夹菜单 / 浏览器都只看这台设备自己的文件夹（scopeLabel = 「在这台 Mac 上」）
  const folderPicker = (v: "desktop" | "phone") =>
    device ? (
      <PiFolderPicker
        variant={v}
        scopeLabel={scopeLabel}
        platform={device.platform}
        recent={recent}
        knownFolders={knownFolders}
        canBrowse={browse.canBrowse}
        browseReason={browse.reason}
        homeRoots={device.browseRoots}
        value={folder ?? undefined}
        onBrowse={() => setStore({ browsing: true })}
        onSelect={(path) => setStore({ folder: path, error: null })}
      />
    ) : null
  // 浏览器：桌面 PiDialog（portal 到 body，从 composer 里开没关系）；手机在 NewSheets 的 sheet 槽里画
  const browser = !phone && device && state.browsing ? (
    <PiFolderBrowser
      viewport="desktop"
      scopeLabel={scopeLabel}
      initialPath={initialBrowsePathOf(device, folder)}
      listDirs={(path, showHidden) => relay.listDirs(device.id, path, showHidden)}
      open={state.browsing}
      onOpenChange={(open) => {
        if (!open) setStore({ browsing: false })
      }}
      onPick={(path) => setStore({ folder: path, error: null, browsing: false })}
    />
  ) : null
  return (
    <>
      <PiEmptyComposer
        variant={variant}
        device={relay.devices.length > 1 && device ? { name: device.name, platform: device.platform, offline: !device.online } : null}
        folder={folder ? piBaseName(folder) : null}
        model={modelPillOf(relay)}
        draft={draft}
        onDraftChange={setNewSessionDraft}
        onSend={start}
        open={isStatic ? (open === "device" || open === "folder" ? open : null) : open}
        onOpenChange={onOpenChange}
        // 静态态：打开中的选择器下方垂下的菜单（桌面）；可交互时由四个锚定菜单画
        menu={isStatic && !phone && open === "folder" ? folderPicker("desktop") : undefined}
        deviceMenu={
          phone ? undefined : (
            <PiDeviceMenu devices={relay.devices} counts={counts} value={device?.id} title="运行在" now={now} onSelect={selectDevice} footer={pair} />
          )
        }
        folderMenu={phone ? undefined : folderPicker("desktop")}
        plusMenu={phone ? undefined : <PiAttachMenu variant="desktop" className="w-[280px]" commandsDisabled onPick={() => relay.notify("新会话的第一条先发文字；图片和文件在会话开始后再加", "warn")} />}
        modelMenu={phone || !relay.roomId ? undefined : <ModelMenuContent relay={relay} variant="desktop" data={modelData} isStatic={false} />}
        below={below}
        className={cn(starting && "pointer-events-none opacity-90")}
      />
      {browser}
    </>
  )
}

/** 新建会话页手机的 sheet（设备、目录、+、模型） */
function NewSheets(p: PiContainerProps) {
  const { relay, ui, act } = p
  const now = useNow(1000)
  const state = useNewState()
  const isStatic = usePiStatic()
  const { device, folder, recent, knownFolders, scopeLabel, browse } = useSelection(relay, state)
  const id = ui.sheet?.id
  const modelData = useModelData(relay, id === C_IDS.newModel)
  const close = act.closeSheet
  const onOpenChange = (open: boolean) => {
    if (!open) close()
  }
  const byCwId = (cw: string) => () => document.querySelector<HTMLElement>(`[data-cw-id="${cw}"]`)
  // P9 C：浏览器是手机上的全高 sheet，从「打开文件夹…」进来；关掉 / 取消时回到文件夹 sheet，不直接回 composer
  const closeBrowser = (open: boolean) => {
    if (open) return
    setStore({ browsing: false })
    act.openSheet({ id: C_IDS.newFolder })
  }
  if (state.browsing && device) {
    return (
      <PiFolderBrowser
        viewport="phone"
        scopeLabel={scopeLabel}
        initialPath={initialBrowsePathOf(device, folder)}
        listDirs={(path, showHidden) => relay.listDirs(device.id, path, showHidden)}
        open={state.browsing}
        onOpenChange={closeBrowser}
        onPick={(path) => setStore({ folder: path, error: null, browsing: false })}
      />
    )
  }
  if (id === C_IDS.newDevice) {
    return (
      <PiSheet title="运行在" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-device")}>
        <PiDeviceMenu
          devices={relay.devices}
          counts={sessionCountsOf(relay.sessionsByDevice, relay.devices)}
          value={device?.id}
          asSheet
          now={now}
          onSelect={(next) => {
            const d = relay.devices.find((x) => x.id === next)
            setStore({ deviceId: next, folder: folderForDevice(d, state.folder ?? folder), error: null, browsing: false })
            close()
          }}
          footer={<MenuItem onSelect={() => openPiDialog(p, { id: PI_UI_IDS.pairing })}>配对新设备…</MenuItem>}
        />
      </PiSheet>
    )
  }
  if (id === C_IDS.newFolder && device) {
    return (
      <PiSheet title="选择文件夹" bodyClassName="px-4" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-folder")}>
        <SheetHost close={close}>
          <PiFolderPicker
            variant="phone"
            scopeLabel={scopeLabel}
            platform={device.platform}
            recent={recent}
            knownFolders={knownFolders}
            canBrowse={browse.canBrowse}
            browseReason={browse.reason}
            homeRoots={device.browseRoots}
            value={folder ?? undefined}
            onBrowse={() => {
              close()
              setStore({ browsing: true })
            }}
            onSelect={(path) => setStore({ folder: path, error: null })}
          />
        </SheetHost>
      </PiSheet>
    )
  }
  if (id === C_IDS.newPlus) {
    return (
      <PiSheet title="添加" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-plus")}>
        <PiAttachMenu
          variant="phone"
          bare
          commandsDisabled
          onPick={() => {
            close()
            relay.notify("新会话的第一条先发文字；图片和文件在会话开始后再加", "warn")
          }}
        />
      </PiSheet>
    )
  }
  if (id === C_IDS.newModel && relay.roomId) {
    return (
      <PiSheet title="模型与思考" bodyClassName="px-4" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-model")}>
        <SheetHost close={close}>
          <ModelMenuContent relay={relay} variant="phone" data={modelData} isStatic={isStatic} />
        </SheetHost>
      </PiSheet>
    )
  }
  return null
}

export function NewSessionContainer(props: PiContainerProps) {
  const { act, variant } = props
  if (variant === "phone") {
    return (
      <PiPhonePage
        topBar={<PiTopBar variant="phone-page" title="新会话" onBack={() => act.openSession()} />}
        contentClassName="h-full"
        dock={
          <div className="px-4 pt-2 pb-2">
            <NewComposer {...props} />
          </div>
        }
        sheet={
          <>
            <NewSheets {...props} />
            {/* 新建会话在手机上是整页（不在 PhoneApp 的共用 sheet 槽里）：设备菜单的"配对新设备…"要的 a 的配对 sheet 放在本页 */}
            <PairingContainer {...props} />
          </>
        }
      >
        <div className="flex h-full flex-col justify-center px-4">
          <SuggestionPills
            data-cw-id="pi-new-suggestions"
            items={SUGGESTIONS}
            className="flex-col items-stretch gap-2.5"
            pillClassName="h-11 w-full justify-center text-[15px]"
            onClick={(event) => {
              const id = (event.target as Element).closest("[data-cw-id]")?.getAttribute("data-cw-id") ?? ""
              const hit = SUGGESTIONS.find((s) => id.endsWith(`-${s.key}`))
              if (hit) setNewSessionDraft(hit.label)
            }}
          />
        </div>
      </PiPhonePage>
    )
  }
  return (
    <div className="absolute inset-0 flex justify-center px-10 pt-[268px]">
      <div className="w-full max-w-[640px]">
        <NewComposer {...props} />
      </div>
    </div>
  )
}
