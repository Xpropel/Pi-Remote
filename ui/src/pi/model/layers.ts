/**
 * 浮层登记表（PLAN 4.1 / 4.2；design B14、K06 的 Esc 分层）。
 *
 * 每个可交互的菜单 / 浮层在打开时登记、关闭时注销，外壳据此拼 usePiShortcuts 的 escState：
 *   - menuOpen：有 kind = "menu" 的层（锚定菜单、斜杠 / @ 菜单）
 *   - overlayOpen：有 kind = "overlay" 的层（PiDialog、PiSheet、命令面板、灯箱、标题悬停卡）
 * Esc 落到"关菜单 / 关浮层"那一层时，closeTop(kind) 关掉同类里最后打开的那一个。
 * Radix 原语（Dialog、DropdownMenu、ContextMenu、HoverCard）自己在 document 捕获阶段处理 Esc 并 preventDefault，
 * usePiShortcuts 会跳过这些事件；所以登记表对它们只用来挡 ⌘ 快捷键（浮层开着时 ⌘K / ⌘B 等不触发），
 * 对不走 Radix 的层（挂在输入框上的斜杠 / @ 菜单等）才真正负责关闭。
 *
 * 纯逻辑，不依赖 React / DOM（Node 单测直接测）；React 接线在 components/pi/shared/layers.ts（PiLayerProvider、usePiLayer、usePiLayerState）。
 */

export type PiLayerKind = "menu" | "overlay"

export interface PiLayerSnapshot {
  readonly menuOpen: boolean
  readonly overlayOpen: boolean
  /** 当前登记的层数 */
  readonly count: number
}

export interface PiLayerHandle {
  readonly id: number
  /** 注销（重复调用无副作用） */
  dispose(): void
}

export interface PiLayerStore {
  /** 登记一个已经打开的层；close 是 Esc 落到这一层时调用的关闭函数（Radix 层可以不传） */
  open(kind: PiLayerKind, close?: () => void): PiLayerHandle
  /** 关掉 kind 类里最后打开、且带 close 的那一层；没有可关的返回 false */
  closeTop(kind: PiLayerKind): boolean
  /** 引用稳定：内容不变时返回同一个对象（给 useSyncExternalStore） */
  getSnapshot(): PiLayerSnapshot
  subscribe(listener: () => void): () => void
}

interface Entry {
  id: number
  kind: PiLayerKind
  close?: () => void
}

export const PI_LAYERS_EMPTY: PiLayerSnapshot = Object.freeze({ menuOpen: false, overlayOpen: false, count: 0 })

export function createPiLayerStore(): PiLayerStore {
  let entries: Entry[] = []
  let nextId = 1
  let snapshot: PiLayerSnapshot = PI_LAYERS_EMPTY
  const listeners = new Set<() => void>()

  const publish = () => {
    const menuOpen = entries.some((e) => e.kind === "menu")
    const overlayOpen = entries.some((e) => e.kind === "overlay")
    const count = entries.length
    if (snapshot.menuOpen === menuOpen && snapshot.overlayOpen === overlayOpen && snapshot.count === count) return
    snapshot = count === 0 ? PI_LAYERS_EMPTY : Object.freeze({ menuOpen, overlayOpen, count })
    for (const listener of [...listeners]) listener()
  }

  return {
    open(kind, close) {
      const entry: Entry = { id: nextId++, kind, close }
      entries = [...entries, entry]
      publish()
      let disposed = false
      return {
        id: entry.id,
        dispose() {
          if (disposed) return
          disposed = true
          entries = entries.filter((e) => e !== entry)
          publish()
        },
      }
    },
    closeTop(kind) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (entry.kind === kind && entry.close) {
          entry.close()
          return true
        }
      }
      return false
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
