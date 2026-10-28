import { useMemo, useState } from "react"
import { Cloud, FolderClosed, Laptop, Plus } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { browseAccessOf, initialBrowsePathOf } from "@/pi/model/folderBrowser"
import { deviceScopeLabel, folderForDevice, newSessionDefaultsOf, offlineReasonOf } from "@/pi/model/newSession"
import { piBaseName } from "../logic/view"
import { CodexBadge, CodexCapabilityBadge } from "../primitives/CodexCapability"
import { useCodexCapability } from "../logic/capability"
import { CodexFolderBrowser } from "../pages/CodexFolderBrowser"
import { CodexBranchReadyDialog } from "../overlays/CodexBranchReadyDialog"

export type CodexRunMode = "local" | "folder" | "remote"

/** 运行位置（台账 §4 已批准映射：Local→当前设备 / Worktree→指定文件夹 / Cloud→远端设备） */
export type CodexRunLocationValue = { mode: CodexRunMode; deviceId: string | null; folder: string | null }

const MODES: { key: CodexRunMode; label: string; ref: string; hint: string }[] = [
  { key: "local", label: "当前设备", ref: "Local", hint: "在当前选中的设备 + 默认目录里直接开线程" },
  { key: "folder", label: "指定文件夹", ref: "Worktree", hint: "在这台设备上选一个独立工作目录（Pi 的隔离等价）" },
  { key: "remote", label: "远端设备", ref: "Cloud", hint: "选另一台已连接设备作为执行端" },
]
const MODE_ICON = { local: Laptop, folder: FolderClosed, remote: Cloud } as const

/**
 * 运行位置三段控件（P4 Wave1；台账 §4.1/§4.2 已批准）：
 * - 当前设备（Local）= 当前选中设备 + 默认目录，不用额外 UI；
 * - 指定文件夹（Worktree）= P9 C 文件夹浏览器选任意可浏览目录；git worktree 作为**独立 unavailable 能力**（禁用入口+徽标）；
 * - 远端设备（Cloud）= 选另一台已连接设备；没有其它设备时给「配对新设备」入口。
 * 交互只改新建会话的初始参数（设备/目录），提交仍走现有 P9 逻辑；data-p4-* 供验证线定位。
 */
export function CodexRunLocation({
  p,
  value,
  onChange,
  onPair,
  compact = false,
  surface = "CX-COMP-07",
}: {
  p: VariantAppProps
  value: CodexRunLocationValue
  onChange: (next: CodexRunLocationValue) => void
  onPair: () => void
  compact?: boolean
  surface?: string
}) {
  const { relay } = p
  const worktreeCap = useCodexCapability("worktree")
  const [browserOpen, setBrowserOpen] = useState(false)
  const [branchInfo, setBranchInfo] = useState<{ path: string; branch: string; repoPath?: string } | null>(null)
  const defaults = useMemo(
    () => newSessionDefaultsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, selectedDeviceId: relay.selectedDeviceId }),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.selectedDeviceId],
  )
  const device = relay.devices.find((d) => d.id === (value.deviceId ?? defaults.deviceId)) ?? null
  const folder = folderForDevice(device, value.folder ?? defaults.folder)
  const others = relay.devices.filter((d) => d.id !== defaults.deviceId)
  const onlineOthers = others.filter((d) => d.online)
  const localReady = !!device?.online && !!folder
  const remoteReady = !!device?.online && !!folder && value.mode === "remote"
  const ready = value.mode === "local" ? localReady : value.mode === "folder" ? !!device?.online && !!value.folder : remoteReady
  const scope = device ? deviceScopeLabel(device, relay.devices) : ""
  const browse = browseAccessOf(device)
  const explain = (reason: string) => relay.notify(reason, "warn")
  const pickMode = (mode: CodexRunMode) => {
    if (mode === value.mode) return
    if (mode === "local") {
      onChange({ mode, deviceId: defaults.deviceId, folder: defaults.folder })
      return
    }
    if (mode === "folder") {
      const target = defaults.deviceId ?? value.deviceId ?? null
      onChange({ mode, deviceId: target, folder: value.folder ?? defaults.folder })
      if (!value.folder) setBrowserOpen(true)
      else onChange({ mode, deviceId: target, folder: value.folder })
      return
    }
    const first = onlineOthers[0]
    if (!first) {
      explain("暂无其它在线设备：先在「设备与配对」里配对新设备，才能把任务放到远端设备上")
      onChange({ mode, deviceId: null, folder: null })
      return
    }
    onChange({ mode, deviceId: first.id, folder: folderForDevice(first, null) })
  }
  const summaryDevice = device?.name ?? "未选择设备"
  const summaryFolder = value.mode === "remote" ? (folder ? piBaseName(folder) : "未选目录") : folder ? piBaseName(folder) : "未选目录"
  return (
    <div className="cx-run-location" data-variant={compact ? "compact" : "full"} data-p4-surface={surface} data-capability-state={value.mode === "folder" ? "simulated" : ready ? "available" : "unavailable"} data-p4-ready={ready ? "" : undefined}>
      <div className="cx-run-seg" role="tablist" aria-label="运行位置">
        {MODES.map((item) => {
          const Icon = MODE_ICON[item.key]
          const active = value.mode === item.key
          const disabled = item.key === "remote" && others.length === 0 && value.mode !== "remote"
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-disabled={disabled ? true : undefined}
              className="cx-run-btn"
              data-active={active ? "" : undefined}
              data-p4-action={`run-${item.key}`}
              title={item.hint}
              onClick={() => pickMode(item.key)}
            >
              <Icon aria-hidden size={12} strokeWidth={1.5} />
              {item.label}
            </button>
          )
        })}
      </div>
      <div className="cx-run-summary" data-p4-action="run-summary">
        <span className="cx-run-summary-device" title={device ? `${device.name}${device.platform ? ` · ${device.platform}` : ""}` : undefined}>
          {summaryDevice}
        </span>
        <span className="cx-run-summary-sep">·</span>
        <span className="cx-run-summary-folder" title={folder ?? undefined}>
          {summaryFolder}
        </span>
        {value.mode === "remote" ? <CodexBadge tone="warn">远端</CodexBadge> : null}
        {worktreeCap.simulated && value.mode === "folder" ? <CodexBadge tone="warn">模拟演示</CodexBadge> : null}
        {!ready ? <span className="cx-run-summary-note">{value.mode === "folder" ? "先选择工作文件夹" : "暂不可用"}</span> : null}
      </div>
      {value.mode === "folder" ? (
        <div className="cx-run-detail">
          <button type="button" className="cx-run-folder" data-p4-action="browse-folder" onClick={() => setBrowserOpen(true)}>
            <FolderClosed aria-hidden size={13} strokeWidth={1.5} />
            <span>{value.folder ? `${value.folder}` : "选择工作文件夹…"}</span>
            <span className="cx-run-folder-change">更换…</span>
          </button>
          <p className="cx-run-hint">{browse.canBrowse ? "可浏览这台设备上的任意目录（隐藏文件可切换）。" : browse.reason ?? "这台设备不支持浏览目录"}</p>
          <button
            type="button"
            className="cx-run-worktree"
            data-p4-action="create-isolated-copy"
            data-capability-state={worktreeCap.status}
            data-pi-capability-disabled={!worktreeCap.interactive ? "" : undefined}
            title={!worktreeCap.interactive ? "本机 pi 未提供 git worktree 能力，可接入扩展" : "dev mock：创建隔离副本（模拟演示）"}
            onClick={() => {
              if (!worktreeCap.interactive) {
                explain(`本机 pi 未提供 git worktree 能力；接入 worktree 扩展后可一键创建隔离副本${worktreeCap.view ? `（见 ${worktreeCap.view.docsPath}）` : ""}`)
                return
              }
              const base = value.folder ?? folder
              const actions = worktreeCap.actions
              if (base && actions?.createWorktree) {
                actions.createWorktree(base, "codex/isolation")
                const created = worktreeCap.data?.worktrees?.[worktreeCap.data.worktrees.length - 1]
                const path = created?.path ?? `${base.replace(/\/+$/, "")}-worktree`
                onChange({ mode: "folder", deviceId: device?.id ?? null, folder: path })
                setBranchInfo({ path, branch: created?.branch ?? "codex/isolation", repoPath: created?.repoPath ?? base })
                return
              }
              if (base) onChange({ mode: "folder", deviceId: device?.id ?? null, folder: `${base.replace(/\/+$/, "")}-worktree-demo` })
              relay.notify("已创建隔离副本（模拟演示），并回填为当前工作文件夹")
            }}
          >
            <CodexCapabilityBadge view={worktreeCap.view} />
            {!worktreeCap.interactive ? "创建隔离副本（worktree）…" : "创建隔离副本（模拟演示）…"}
          </button>
        </div>
      ) : null}
      {value.mode === "remote" ? (
        <div className="cx-run-detail">
          {others.length === 0 ? (
            <div className="cx-run-empty">
              <p className="cx-run-hint">暂无其它在线设备。先在「设备与配对」里添加设备，再把它作为远端执行端。</p>
              <button type="button" className="cx-run-pair" data-p4-action="pair-device" onClick={onPair}>
                <Plus aria-hidden size={12} strokeWidth={2} />
                配对新设备…
              </button>
            </div>
          ) : (
            <div className="cx-run-devices" role="listbox" aria-label="远端设备">
              {others.map((item) => {
                const selected = item.id === device?.id
                const fail = !item.online
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-disabled={fail ? true : undefined}
                    className="cx-run-device"
                    data-active={selected ? "" : undefined}
                    data-p4-action="select-remote-device"
                    title={fail ? offlineReasonOf(item.name) : `${item.name} · ${scope || item.platform || "设备"}`}
                    onClick={() => {
                      if (fail) {
                        explain(offlineReasonOf(item.name))
                        return
                      }
                      onChange({ mode: "remote", deviceId: item.id, folder: folderForDevice(item, null) })
                    }}
                  >
                    <Laptop aria-hidden size={12} strokeWidth={1.5} />
                    <span className="cx-run-device-name">{item.name}</span>
                    <span className="cx-run-device-sub">{fail ? "未连接" : deviceScopeLabel(item, relay.devices)}</span>
                  </button>
                )
              })}
              <button type="button" className="cx-run-pair" data-p4-action="pair-device" onClick={onPair}>
                <Plus aria-hidden size={12} strokeWidth={2} />
                配对新设备…
              </button>
            </div>
          )}
          <p className="cx-run-hint">Pi 没有云端托管；「远端设备」= 你已配对、在线的另一台设备（任务在其上真实执行）。</p>
        </div>
      ) : null}
      {value.mode === "local" && compact ? <p className="cx-run-hint">用当前设备 + 最近目录直接开线程；要固定目录请选「指定文件夹」。</p> : null}
      {branchInfo ? <CodexBranchReadyDialog p={p} info={branchInfo} onClose={() => setBranchInfo(null)} /> : null}
      {browserOpen && device ? (
        <CodexFolderBrowser
          p={p}
          deviceId={device.id}
          scopeLabel={scope || "选择工作文件夹"}
          initialPath={initialBrowsePathOf(device, value.folder ?? folder)}
          open={browserOpen}
          onOpenChange={(open) => {
            if (!open) setBrowserOpen(false)
          }}
          onPick={(path) => {
            setBrowserOpen(false)
            onChange({ mode: "folder", deviceId: device.id, folder: path })
          }}
        />
      ) : null}
    </div>
  )
}
