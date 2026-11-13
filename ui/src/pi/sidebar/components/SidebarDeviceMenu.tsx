import { useEffect, useRef, useState } from "react"
import { CheckIcon, ChevronDownIcon, MonitorIcon, PlusIcon } from "./icons"
import type { PiSidebarActions, PiSidebarData } from "../types"

/** P11-SIDE-02/03：设备选择器收起行（32px）+ 展开菜单（30px 行、与收起行同宽、下 4px 锚定）。 */
export function SidebarDeviceMenu({ data, actions }: { data: PiSidebarData; actions: PiSidebarActions }) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = data.deviceMenuOpen ?? internalOpen
  const toggle = (next?: boolean) => {
    if (data.deviceMenuOpen === undefined) setInternalOpen(next ?? !open)
    actions.toggleDeviceMenu?.(next ?? !open)
  }
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const toggleRef = useRef(toggle)
  useEffect(() => {
    toggleRef.current = toggle
  })
  const close = (refocus: boolean) => {
    toggle(false)
    if (refocus) triggerRef.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    ;(menu?.querySelector<HTMLButtonElement>('[role="menuitem"][data-selected]') ?? menu?.querySelector<HTMLButtonElement>('[role="menuitem"]'))?.focus()
    // 点菜单外任何地方都收起（不抢焦点，落点自己拿焦点）
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return
      toggleRef.current(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [open])
  const current = data.devices.find((device) => device.current) ?? data.devices[0]
  if (!current) {
    return (
      <div className="sb-devwrap">
        <div className="sb-devrow sb-devrow-empty" data-p11-surface="P11-SIDE-02">
          <MonitorIcon />
          <span className="sb-devname">{data.online ? "还没有设备" : "未连接"}</span>
        </div>
      </div>
    )
  }
  const reachable = data.online && current.online
  const stateLabel = !data.online ? "未连接服务器" : current.online ? "在线" : "离线"
  return (
    <div className="sb-devwrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sb-devrow"
        data-p11-surface="P11-SIDE-02"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`设备：${current.name}，${stateLabel}`}
        title={`切换设备（当前：${current.name}）`}
        onClick={() => toggle()}
      >
        <MonitorIcon />
        <span className="sb-devname">{current.name}</span>
        <span className="sb-online" data-online={reachable ? "" : undefined} aria-hidden />
        <ChevronDownIcon />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="sb-devmenu"
          aria-label="选择设备"
          data-p11-surface="P11-SIDE-03"
          role="menu"
          onKeyDown={(event) => {
            const items = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") event.preventDefault()
              close(event.key === "Escape")
              return
            }
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault()
              items[event.key === "Home" ? 0 : items.length - 1]?.focus()
              return
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
            event.preventDefault()
            const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length
            items[next]?.focus()
          }}
        >
          <p className="sb-devmenu-head" aria-hidden>设备</p>
          {data.devices.map((device) => {
            const selected = device.id === data.selectedDeviceId
            const online = data.online && device.online
            return (
              <button
                key={device.id}
                type="button"
                role="menuitem"
                className="sb-devmenu-row"
                data-selected={selected ? "" : undefined}
                aria-current={selected ? "true" : undefined}
                onClick={() => {
                  actions.selectDevice(device.id)
                  close(true)
                }}
              >
                <MonitorIcon />
                <span className="sb-devmenu-name">{device.name}</span>
                <span className="sb-devmenu-status">
                  <span className="sb-online" data-online={online ? "" : undefined} aria-hidden />
                  {device.statusLabel ?? (online ? "在线" : "离线")}
                </span>
                <span className="sb-devmenu-check" aria-hidden>{selected ? <CheckIcon size={14} /> : null}</span>
              </button>
            )
          })}
          {actions.addDevice ? (
            <>
              <div className="sb-devmenu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="sb-devmenu-row sb-devmenu-add"
                onClick={() => {
                  close(false)
                  actions.addDevice?.()
                }}
              >
                <PlusIcon />
                <span className="sb-devmenu-name">添加设备…</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
