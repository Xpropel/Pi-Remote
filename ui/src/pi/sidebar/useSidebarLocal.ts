/**
 * P11 侧栏本机状态 hook（pin/archive/文件夹折叠；arch 共享模块，非变体代码）。
 *
 * 独立性守卫要求变体源码不得直接读写 localStorage —— 变体适配器只调本 hook；
 * 存储实现/容错/隔离仍在 storage.ts（纯函数），本文件只做 React 接线。
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  PI_SIDEBAR_LOCAL_STORAGE_KEY,
  emptySidebarLocalState,
  parseSidebarLocalState,
  serializeSidebarLocalState,
  setSidebarFolderCollapsed,
  sidebarScopeStateOf,
  sidebarStorageScope,
  toggleSidebarArchive,
  toggleSidebarPin,
  type PiSidebarLocalState,
  type PiSidebarScopeState,
} from "./storage.ts"

/**
 * 同一标签页内的 pin / archive 共享：侧栏与快捷键分发各持一个 useSidebarLocalState 实例，
 * 只写 storage 不会触发别的实例重渲染。模块级监听表只广播内存里的最新状态（写失败也同步），
 * 跨标签页仍由 storage 事件兜住。
 */
const localListeners = new Set<(state: PiSidebarLocalState) => void>()

function publishSidebarLocal(next: PiSidebarLocalState): void {
  for (const listener of [...localListeners]) listener(next)
}

function readSidebarLocal(): PiSidebarLocalState {
  if (typeof window === "undefined") return emptySidebarLocalState()
  try {
    return parseSidebarLocalState(window.localStorage.getItem(PI_SIDEBAR_LOCAL_STORAGE_KEY))
  } catch {
    return emptySidebarLocalState()
  }
}

export interface SidebarLocalState {
  scope: string
  scopeState: PiSidebarScopeState
  pins: readonly string[]
  archives: readonly string[]
  togglePin: (sessionKey: string) => void
  toggleArchive: (sessionKey: string) => void
  toggleFolder: (groupId: string) => void
  clearScope: () => void
}

export function useSidebarLocalState(accountId: string | undefined | null, deviceId: string | undefined | null): SidebarLocalState {
  const scope = useMemo(() => sidebarStorageScope(accountId, deviceId), [accountId, deviceId])
  const [state, setState] = useState<PiSidebarLocalState>(readSidebarLocal)
  useEffect(() => {
    const onLocal = (next: PiSidebarLocalState) => setState(next)
    localListeners.add(onLocal)
    const onStorage = (event: StorageEvent) => {
      if (event.key === PI_SIDEBAR_LOCAL_STORAGE_KEY) setState(readSidebarLocal())
    }
    window.addEventListener("storage", onStorage)
    return () => {
      localListeners.delete(onLocal)
      window.removeEventListener("storage", onStorage)
    }
  }, [])
  const scopeState = useMemo(() => sidebarScopeStateOf(state, scope), [state, scope])
  const persist = useCallback((next: PiSidebarLocalState) => {
    setState(next)
    try {
      window.localStorage.setItem(PI_SIDEBAR_LOCAL_STORAGE_KEY, serializeSidebarLocalState(next))
    } catch {
      // 隐私模式/配额满：本会话仍可用（不假装已持久化）
    }
    publishSidebarLocal(next)
  }, [])
  const togglePin = useCallback((key: string) => persist(toggleSidebarPin(state, scope, key)), [persist, state, scope])
  const toggleArchive = useCallback((key: string) => persist(toggleSidebarArchive(state, scope, key)), [persist, state, scope])
  const toggleFolder = useCallback((groupId: string) => {
    const cur = sidebarScopeStateOf(state, scope)
    persist(setSidebarFolderCollapsed(state, scope, groupId, !(cur.folders[groupId] ?? true)))
  }, [persist, state, scope])
  const clearScope = useCallback(() => {
    const next = parseSidebarLocalState(state)
    delete next.scopes[scope]
    persist(next)
  }, [persist, state, scope])
  return { scope, scopeState, pins: scopeState.pins, archives: scopeState.archives, togglePin, toggleArchive, toggleFolder, clearScope }
}
