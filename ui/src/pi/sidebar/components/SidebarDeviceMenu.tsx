import { useEffect, useRef, useState } from "react"
import { ChevronDownIcon, MonitorIcon } from "./icons"
import type { PiSidebarActions, PiSidebarData } from "../types"

/** P11-SIDE-02/03：设备选择器收起行（34px）+ 展开菜单（32px 行、248 宽、下 6px 锚定）。 */
export function SidebarDeviceMenu({ data, actions }: { data: PiSidebarData; actions: PiSidebarActions }) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = data.deviceMenuOpen ?? internalOpen
  const toggle = (next?: boolean) => {
    if (data.deviceMenuOpen === undefined) setInternalOpen(next ?? !open)
    actions.toggleDeviceMenu?.(next ?? !open)
  }
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [open])
  const current = data.devices.find((device) => device.current) ?? data.devices[0]
  if (!current) {
    return (
      <div className="sb-devwrap">
        <div className="sb-devrow sb-devrow-empty" data-p11-surface="P11-SIDE-02">
          <MonitorIcon size={16} />
          <span className="sb-devname">未选择设备</span>
        </div>
      </div>
    )
  }
  return (
    <div className="sb-devwrap">
      <button type="button" className="sb-devrow" data-p11-surface="P11-SIDE-02" aria-expanded={open} onClick={() => toggle()}>
        <MonitorIcon size={16} />
        <span className="sb-devname">{current.name}</span>
        <span className="sb-online" data-online={current.online ? "" : undefined} aria-label={current.online ? "在线" : "离线"} />
        <ChevronDownIcon size={13} />
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
            if (event.key === "Escape") {
              toggle(false)
              return
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
            event.preventDefault()
            const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length
            items[next]?.focus()
          }}
        >
          {data.devices.map((device) => (
            <button
              key={device.id}
              type="button"
              role="menuitem"
              className="sb-devmenu-row"
              data-selected={device.id === data.selectedDeviceId ? "" : undefined}
              onClick={() => {
                actions.selectDevice(device.id)
                toggle(false)
              }}
            >
              <MonitorIcon size={15} />
              <span className="sb-devmenu-name">{device.name}</span>
              <span className="sb-devmenu-status">
                <span className="sb-online" data-online={device.online ? "" : undefined} />
                {device.statusLabel ?? (device.current ? "当前" : device.online ? "在线" : "离线")}
              </span>
            </button>
          ))}
          <div className="sb-devmenu-sep" />
          <button type="button" role="menuitem" className="sb-devmenu-row sb-devmenu-add" onClick={() => actions.addDevice?.()}>
            <span className="sb-devmenu-plus">+</span>
            <span className="sb-devmenu-name">添加设备…</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
