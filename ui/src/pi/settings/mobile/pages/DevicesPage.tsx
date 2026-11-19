/**
 * 手机端设置 · 设备（移动压缩版）。
 *
 *   ● 设备名册 / 在线状态：relay.devices 现成；配对开配对浮层，移除走二次确认 + relay.revokeDevice；
 *   ● 延迟：relay 心跳下发的 devices[].latencyMs；在线且有样本显示「延迟 <整数>ms」，否则「延迟 —」；
 *   ● 测试连接：点击时真的发一次命令往返（当前会话 get_state，其他在线设备 get_host_diag），
 *     显示「设备 ↔ 服务器 · xx ms」；设备离线时禁用；
 *   ● 设为默认：纯本机偏好 defaultDeviceId，刷新后保持，不改设备侧配置；
 *   ● 系统操作：设备行「系统操作」点进单设备系统操作页（SystemOpsPage，与桌面
 *     展开区共用 useSystemOps / systemOpsLogic），返回行回设备列表；
 *   ○ 新会话自动连上默认设备：本机偏好，即时生效；
 *   ● 阻止设备睡眠：走设备级 get_prevent_sleep / set_prevent_sleep 命令。
 *   Viewer identity + authorized viewers: MobileIdentitySection, mounted
 *     between the device roster and the plaintext-room groups (same slot as
 *     the desktop devices page); it shares the desktop identity bridge.
 */
import { useEffect, useMemo, useState } from "react"
import { adminTokenErrorText, adminTokenReady, canRevoke, deviceErrorText, ENC_FALLBACK_LABEL, ENC_REASON_LABELS, errorCode, type Device } from "@/relay/devices"
import { useReducedMotion } from "@/pi/hooks/useReducedMotion"
import { useSettings } from "../../SettingsContext.tsx"
import { usePreventSleepToggle } from "../../pages/deviceBehaviorHook.ts"
import { hostCommandsReady, useHostCommand } from "../data.ts"
import { SettingsStatusDot } from "../../ui.tsx"
import {
  DEVICE_RTT_SCOPE,
  deviceLatencyTextOf,
  deviceNameOf,
  deviceRoundTripTextOf,
  PLAINTEXT_ACTION_LABELS,
  plaintextRoomGroupsOf,
  plaintextRoomTitleOf,
  type PlaintextRoomGroup,
  type PlaintextRoomLike,
} from "../../pages/devicesLogic.ts"
import {
  MobileActionRow,
  MobileCard,
  MobileEmpty,
  MobileGroup,
  MobilePageBody,
  MobileRow,
  MobileSwitch,
  MobileTag,
} from "../atoms.tsx"
import { MobileIdentitySection } from "./IdentitySection.tsx"
import { MobileSystemOpsPage } from "./SystemOpsPage.tsx"

/** 测试连接的计时起点；浏览器有 performance 就用单调时钟。 */
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function clockLabel(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(now - 86_400_000)
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (sameDay(date, today)) return `今天 ${time}`
  if (sameDay(date, yesterday)) return `昨天 ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

const REVOKE_ARM_MS = 3000

function deviceMetaOf(device: Device): string {
  if (!device.online) {
    const last = device.lastAttachAt ? ` · 上次在线 ${clockLabel(device.lastAttachAt)}` : ""
    return `离线${last}`
  }
  const status = device.bridgeOnline === false ? "仅远程窗口在线" : "在线"
  return `${status} · ${deviceLatencyTextOf(device.latencyMs)}`
}

interface DeviceProbe {
  phase: "probing" | "ready" | "error"
  ms?: number
  text?: string
}

function MobilePreventSleepRow() {
  const { p } = useSettings()
  const { relay } = p
  const ready = hostCommandsReady(relay) && relay.browserOnline
  const query = useHostCommand(relay, "get_prevent_sleep", ready, relay.selectedDeviceId ?? "")
  const sleep = usePreventSleepToggle(relay, ready, query)
  const sleepDesc =
    sleep.description === "在被控设备上生效，长任务过夜跑不会被系统睡眠打断" ? undefined : sleep.description
  return (
    <MobileRow
      title="长任务运行时阻止设备睡眠"
      tooltip="在被控设备上生效；开启后长任务过夜运行不会被系统睡眠打断"
      description={sleepDesc}
    >
      <MobileSwitch
        label="长任务运行时阻止设备睡眠"
        checked={sleep.checked}
        disabled={sleep.disabled}
        onChange={(next) => {
          void sleep.toggle(next)
        }}
      />
    </MobileRow>
  )
}

export function DevicesPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const reducedMotion = useReducedMotion()
  const devices = relay.devices ?? []
  const [armed, setArmed] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, DeviceProbe>>({})
  const [probingId, setProbingId] = useState<string | null>(null)
  const [opsDeviceId, setOpsDeviceId] = useState<string | null>(null)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(null), REVOKE_ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  /** 第一次点只武装，第二次才真的 device_revoke；缺令牌时转去配对弹窗填写。 */
  const revoke = (device: Device) => {
    if (revoking) return
    if (armed !== device.id) {
      setArmed(device.id)
      return
    }
    if (!relay.canManageDevices) {
      setArmed(null)
      act.notify("当前服务端不支持撤销设备（需要协议 v4）", "warn")
      return
    }
    if (!adminTokenReady(relay.adminToken)) {
      setArmed(null)
      act.notify("需要管理员令牌才能撤销设备，请先在配对里填写", "warn")
      act.openPairing()
      return
    }
    setRevoking(device.id)
    void relay.revokeDevice(device.id, relay.adminToken).then(
      () => {
        setArmed(null)
        setRevoking(null)
        relay.pushNotice({ level: "success", title: `已撤销「${deviceNameOf(device)}」，它要重新配对才能再连` })
      },
      (error: unknown) => {
        setRevoking(null)
        act.notify(adminTokenErrorText(error), "bad")
      },
    )
  }

  const makeDefault = (device: Device) => {
    if (prefs.defaultDeviceId === device.id) return
    act.setPref("defaultDeviceId", device.id)
    act.notify(`已将「${deviceNameOf(device)}」设为本机默认设备`)
  }

  // Phase 4 T-1: plaintext rooms grouped by the relay's encReason (same
  // derivation and bound actions as the desktop devices page).
  const plaintextGroups = useMemo(() => plaintextRoomGroupsOf(relay.rooms), [relay.rooms])
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices])

  /** Deep-link to a device entry on this page: scroll it into view and flash it.
   *  The scroll is instant when reduced motion applies (OS setting or the in-app
   *  setting, via useReducedMotion); an explicit "smooth" would ignore both. */
  const focusDevice = (deviceId: string | undefined) => {
    if (!deviceId) return
    const el = document.querySelector(`[data-settings-device="${deviceId.replace(/"/g, "")}"]`)
    if (!el) return
    el.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" })
    el.classList.add("is-focus")
    window.setTimeout(() => el.classList.remove("is-focus"), 1600)
  }

  /** Deep-link to a room: select its device when it is still on the roster, open the room, leave settings. */
  const openPlaintextRoom = (room: PlaintextRoomLike) => {
    if (room.deviceId && room.deviceId !== relay.selectedDeviceId && deviceById.has(room.deviceId)) {
      relay.selectDevice(room.deviceId)
    }
    relay.selectRoom(room.id)
    p.act.openSession()
  }

  const runPlaintextAction = (group: PlaintextRoomGroup, room: PlaintextRoomLike) => {
    if (group.action === "orphan_disposal") openPlaintextRoom(room)
    else focusDevice(room.deviceId)
  }

  /** 真的等一次命令回包再算往返；离线设备不发。 */
  const probeDevice = (device: Device) => {
    if (!device.online || probingId) return
    const current = device.id === relay.selectedDeviceId
    const room = relay.rooms.find((r) => r.id === relay.roomId)
    const roomOwned = !room?.deviceId || room.deviceId === device.id
    const roomReady =
      relay.authed &&
      relay.browserOnline &&
      relay.online &&
      !!relay.roomId &&
      roomOwned &&
      !(relay.lazySession && relay.lazySession.id === relay.roomId)
    const runDeviceCommand = typeof relay.runDeviceCommand === "function" ? relay.runDeviceCommand : null
    let command: Promise<unknown>
    if (current && roomReady) {
      command = relay.runCommand("get_state")
    } else if (runDeviceCommand) {
      command = runDeviceCommand(device.id, "get_host_diag")
    } else {
      setProbes((prev) => ({ ...prev, [device.id]: { phase: "error", text: "当前版本没有可用的设备命令" } }))
      return
    }
    setProbingId(device.id)
    setProbes((prev) => ({ ...prev, [device.id]: { phase: "probing" } }))
    const started = nowMs()
    void command.then(
      () => {
        const finished = nowMs()
        setProbes((prev) => ({ ...prev, [device.id]: { phase: "ready", ms: finished - started } }))
        setProbingId(null)
      },
      (error: unknown) => {
        const hint =
          errorCode(error) === "device_no_active_session" ? "先在左侧打开一个会话再测" : deviceErrorText(error)
        setProbes((prev) => ({ ...prev, [device.id]: { phase: "error", text: `测试失败：${hint}` } }))
        setProbingId(null)
      },
    )
  }

  const opsDevice = opsDeviceId ? devices.find((device) => device.id === opsDeviceId) : undefined
  if (opsDevice) {
    return (
      <MobileSystemOpsPage relay={relay} device={opsDevice} rooms={relay.rooms ?? []} onBack={() => setOpsDeviceId(null)} />
    )
  }

  return (
    <MobilePageBody page="devices">
      <MobileGroup
        label="我的设备"
        tooltip={`延迟来自设备心跳（${DEVICE_RTT_SCOPE}）；「测试连接」会发一次只读命令实测往返耗时；「设为默认」只保存在本机浏览器，不改设备侧配置。`}
        stacked
      >
        {devices.length === 0 ? (
          <MobileCard>
            <MobileEmpty title="还没有设备" body="在另一台设备上打开 Pi-Remote 完成配对后，名册会出现在这里。" />
          </MobileCard>
        ) : (
          <MobileCard>
            {devices.map((device) => {
              const selected = device.id === relay.selectedDeviceId
              const isDefault = prefs.defaultDeviceId === device.id
              const probe = probes[device.id]
              const removeLabel = revoking === device.id ? "撤销中…" : armed === device.id ? "再点一次移除" : "移除"
              return (
                <div key={device.id} className="sm-device" data-settings-device={device.id}>
                  <div className="sm-device-head">
                    <SettingsStatusDot tone={device.online ? (device.bridgeOnline === false ? "waiting" : "online") : "offline"} />
                    <span className="sm-device-name">{device.name}</span>
                    {selected ? <MobileTag>当前设备</MobileTag> : null}
                    {isDefault ? <MobileTag>默认设备</MobileTag> : null}
                    {device.paired ? <MobileTag>已配对</MobileTag> : null}
                  </div>
                  <div className="sm-device-meta">
                    <span>{deviceMetaOf(device)}</span>
                    {probe?.phase === "probing" ? <span className="sm-device-probe">正在测试连接…</span> : null}
                    {probe?.phase === "ready" ? (
                      <span className="sm-device-probe" data-device-probe="ready">
                        {DEVICE_RTT_SCOPE} · {deviceRoundTripTextOf(probe.ms)}
                      </span>
                    ) : null}
                    {probe?.phase === "error" ? (
                      <span className="sm-device-probe is-error" data-device-probe="error">
                        {probe.text}
                      </span>
                    ) : null}
                  </div>
                  <div className="sm-device-actions">
                    <button
                      type="button"
                      className="sm-device-action"
                      disabled={!device.online || probingId === device.id}
                      title={device.online ? "向设备发一次只读命令，测到回包为止" : "设备离线，无法测试连接"}
                      onClick={() => probeDevice(device)}
                    >
                      {probingId === device.id ? "测试中…" : "测试连接"}
                    </button>
                    <button
                      type="button"
                      className="sm-device-action"
                      disabled={!device.online}
                      title={device.online ? "查看这台设备上 pi、扩展与运行环境的诊断信息" : "设备离线，无法诊断"}
                      onClick={() => act.openHostDiag(device.id)}
                    >
                      诊断
                    </button>
                    <button
                      type="button"
                      className="sm-device-action"
                      disabled={!device.online}
                      title={device.online ? "版本、更新 Pi、重启 Pi、重启设备端、更新设备端组件" : "设备离线，无法执行系统操作"}
                      onClick={() => setOpsDeviceId(device.id)}
                    >
                      系统操作
                    </button>
                    {isDefault ? (
                      <span className="sm-device-default">已设为默认</span>
                    ) : (
                      <button type="button" className="sm-device-action" onClick={() => makeDefault(device)}>
                        设为默认
                      </button>
                    )}
                    {!selected && canRevoke(device) ? (
                      <button
                        type="button"
                        className="sm-device-action sm-device-action--danger"
                        disabled={revoking === device.id}
                        onClick={() => revoke(device)}
                      >
                        {removeLabel}
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </MobileCard>
        )}
        <MobileCard>
          <MobileActionRow title="添加设备" onClick={act.openPairing} />
        </MobileCard>
      </MobileGroup>

      <MobileIdentitySection />

      {plaintextGroups.length ? (
        <MobileGroup label="未加密会话" stacked>
          <MobileCard>
            <div className="sm-plaintext-intro">以下会话的正文没有加密、在中转服务器上以明文保存。按成因分组，处理入口在每行右侧。</div>
            {plaintextGroups.map((group) => (
              <div key={group.key} className="sm-plaintext-group">
                <div className="sm-plaintext-class">
                  {group.key === "unknown" ? ENC_FALLBACK_LABEL : ENC_REASON_LABELS[group.key]}
                  <span className="sm-plaintext-count">{group.rooms.length} 个会话</span>
                </div>
                {group.rooms.map((room) => {
                  const host = room.deviceId ? deviceById.get(room.deviceId) : undefined
                  return (
                    <div key={room.id} className="sm-plaintext-row">
                      <div className="sm-plaintext-meta">
                        <span className="sm-plaintext-title">{plaintextRoomTitleOf(room)}</span>
                        <span className="sm-plaintext-sub">
                          {host ? deviceNameOf(host) : "原设备已不在名册"}
                          {room.cwd ? ` · ${room.cwd}` : ""}
                        </span>
                      </div>
                      {group.action ? (
                        <button type="button" className="sm-device-action" onClick={() => runPlaintextAction(group, room)}>
                          {PLAINTEXT_ACTION_LABELS[group.action]}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))}
          </MobileCard>
        </MobileGroup>
      ) : null}

      <MobileGroup label="主机行为">
        <MobilePreventSleepRow />
        <MobileSwitchRowLocal checked={prefs.autoConnectDevice} onChange={(checked) => act.setPref("autoConnectDevice", checked)} />
      </MobileGroup>
    </MobilePageBody>
  )
}

/** 避免把长标题折叠成一行；单独抽出来只为让分组读起来紧凑。 */
function MobileSwitchRowLocal({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <MobileRow title="新会话自动连上默认设备">
      <MobileSwitch label="新会话自动连上默认设备" checked={checked} onChange={onChange} />
    </MobileRow>
  )
}
