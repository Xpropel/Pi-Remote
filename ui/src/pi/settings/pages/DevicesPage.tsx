/**
 * 设置 › 设备（设计册 §8，源码 settings-set-devices.html）。
 *
 * 落地状态：
 *   ● 设备名册、在线状态、配对 / 添加设备、撤销设备：直接用 relay 的 devices /
 *     selectedDeviceId / createPairCode+revokeDevice 链路；「添加设备」开现有配对弹窗。
 *     撤销需要管理员令牌（relay.adminToken），没有时引导去配对弹窗填写。
 *   ● 延迟：relay 的心跳 ping/pong 已下发 devices[].latencyMs（整数毫秒）；在线且已有样本
 *     显示「延迟 <整数>ms」，无样本 / 离线 / 旧 relay 显示「延迟 —」，不外推。
 *   ● 测试连接：点一次真的发设备命令往返（当前会话用 get_state，其他在线设备用 get_host_diag），
 *     结果显示「设备 ↔ 服务器 · xx ms」；设备离线时按钮禁用。
 *   ● 设为默认：纯本机偏好（defaultDeviceId，写 pi_remote_pi_settings_v2），刷新后保持；
 *     不是 relay 的设备概念，也不改设备侧配置。
 *   ○ 新会话自动连上默认设备：本机偏好，改完立即写 pi_remote_pi_settings_v2。
 *   ◌ 阻止设备睡眠、常驻托盘/菜单栏：协议没有对应字段 / 概念，保留形态并标「设计预留」。
 *
 * 不伪造延迟数字；「默认设备」只表示本机偏好，不冒充 relay 的当前设备。
 *
 * Phase 4 T-1: below the identity section, a plaintext-room list groups every
 * room the relay explicitly states as plaintext (enc === false) by the
 * relay-derived encReason, each class carrying its design-bound action:
 * keyless host -> jump to that device's row (the key-upgrade flow lands
 * there), keyed backlog -> jump to the host device's row (the backlog view
 * lands there in T-2), orphan classes -> open the room itself (disposition
 * options live on the room). Presentation only; nothing here writes room
 * data or changes any policy.
 */
import { useEffect, useMemo, useState } from "react"
import { ChevronRight, Laptop, Monitor, Plus, Server } from "lucide-react"
import { adminTokenErrorText, adminTokenReady, canRevoke, deviceErrorText, ENC_FALLBACK_LABEL, ENC_REASON_LABELS, errorCode, type Device } from "@/relay/devices"
import { useNow } from "@/pi/hooks/useNow"
import { useSettings } from "../SettingsContext"
import {
  SettingsGroup,
  SettingsNote,
  SettingsPageTitle,
  SettingsRow,
  SettingsStatusDot,
  SettingsSwitch,
} from "../ui"
import {
  DEVICE_RTT_SCOPE,
  deviceLatencyTextOf,
  deviceNameOf,
  devicePlatformKindOf,
  deviceRoundTripTextOf,
  deviceStatusTextOf,
  PLAINTEXT_ACTION_LABELS,
  plaintextRoomGroupsOf,
  plaintextRoomTitleOf,
  type PlaintextRoomGroup,
  type PlaintextRoomLike,
} from "./devicesLogic"
import { IdentitySection } from "./IdentitySection"
import "./devices.css"

const REVOKE_ARM_MS = 3000

/** 测试连接的计时起点；浏览器有 performance 就用单调时钟。 */
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

interface DeviceProbe {
  phase: "probing" | "ready" | "error"
  /** ready 时的往返毫秒数。 */
  ms?: number
  /** error 时给用户看的一句话。 */
  text?: string
}

function DeviceGlyph({ device }: { device: Device }) {
  const kind = devicePlatformKindOf(device.platform)
  const Icon = kind === "mac" ? Laptop : kind === "linux" ? Server : Monitor
  return (
    <span className="settings-device-icon" aria-hidden="true">
      <Icon size={19} strokeWidth={1.7} />
    </span>
  )
}

export function DevicesPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const now = useNow(60_000)
  const devices = useMemo(() => {
    const list = [...relay.devices]
    const rank = (device: Device) => (device.id === relay.selectedDeviceId ? 0 : device.online ? 1 : 2)
    return list.sort((a, b) => rank(a) - rank(b))
  }, [relay.devices, relay.selectedDeviceId])
  const [armed, setArmed] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, DeviceProbe>>({})
  const [probingId, setProbingId] = useState<string | null>(null)

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

  /**
   * 「测试连接」：真的等一次命令回包再算 RTT。
   * 当前会话已载入时用 get_state（最轻的房间命令）；其他在线设备走设备级 get_host_diag，
   * 这样不必先替它打开会话。设备离线 / 无命令通道时不发。
   */
  const probeDevice = (device: Device) => {
    if (!device.online || probingId) return
    const roomReady =
      relay.authed &&
      relay.online &&
      !!relay.roomId &&
      !(relay.lazySession && relay.lazySession.id === relay.roomId)
    const current = device.id === relay.selectedDeviceId
    setProbingId(device.id)
    setProbes((prev) => ({ ...prev, [device.id]: { phase: "probing" } }))
    const started = nowMs()
    const command =
      current && roomReady ? relay.runCommand("get_state") : relay.runDeviceCommand(device.id, "get_host_diag")
    void command.then(
      () => {
        const finished = nowMs()
        setProbes((prev) => ({ ...prev, [device.id]: { phase: "ready", ms: finished - started } }))
        setProbingId(null)
      },
      (error: unknown) => {
        const hint =
          errorCode(error) === "device_no_active_session"
            ? "先在左侧打开一个会话再测"
            : deviceErrorText(error)
        setProbes((prev) => ({ ...prev, [device.id]: { phase: "error", text: `测试失败：${hint}` } }))
        setProbingId(null)
      },
    )
  }

  const makeDefault = (device: Device) => {
    if (prefs.defaultDeviceId === device.id) return
    act.setPref("defaultDeviceId", device.id)
    act.notify(`已将「${deviceNameOf(device)}」设为本机默认设备`)
  }

  // Phase 4 T-1: plaintext rooms grouped by the relay's encReason. Rooms the
  // relay never stated a state for (enc undefined) are not listed.
  const plaintextGroups = useMemo(() => plaintextRoomGroupsOf(relay.rooms), [relay.rooms])
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices])

  /** Deep-link to a device entry on this page: scroll it into view and flash it. */
  const focusDevice = (deviceId: string | undefined) => {
    if (!deviceId) return
    const el = document.querySelector(`[data-settings-device="${deviceId.replace(/"/g, "")}"]`)
    if (!el) return
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    el.classList.add("is-focus")
    window.setTimeout(() => el.classList.remove("is-focus"), 1600)
  }

  /** Deep-link to a room: select its device when it is still on the roster, open the room, leave settings. */
  const openPlaintextRoom = (room: PlaintextRoomLike) => {
    if (room.deviceId && room.deviceId !== relay.selectedDeviceId && deviceById.has(room.deviceId)) {
      relay.selectDevice(room.deviceId)
    }
    relay.selectRoom(room.id)
    act.back()
  }

  const runPlaintextAction = (group: PlaintextRoomGroup, room: PlaintextRoomLike) => {
    if (group.action === "orphan_disposal") openPlaintextRoom(room)
    else focusDevice(room.deviceId)
  }

  return (
    <div className="settings-page settings-devices" data-settings-page="devices">
      <SettingsPageTitle title="设备" />

      <SettingsGroup label="我的设备" first>
        {devices.length === 0 ? (
          <div className="settings-row">
            <span className="settings-device-empty">尚未连接任何设备</span>
          </div>
        ) : (
          devices.map((device) => {
            const current = device.id === relay.selectedDeviceId
            const isDefault = prefs.defaultDeviceId === device.id
            const name = deviceNameOf(device)
            const removeLabel = revoking === device.id ? "撤销中…" : armed === device.id ? "再点一次移除" : "移除"
            const probe = probes[device.id]
            return (
              <div className="settings-device-row" key={device.id} data-settings-device={device.id}>
                <DeviceGlyph device={device} />
                <span className="settings-device-meta">
                  <span className="settings-device-name">
                    {name}
                    {isDefault ? <span className="settings-device-default">默认设备</span> : null}
                  </span>
                  <span className="settings-device-status">
                    <SettingsStatusDot tone={device.online ? (device.bridgeOnline === false ? "waiting" : "online") : "offline"} />
                    <span>{deviceStatusTextOf(device, current, now)}</span>
                    {device.online ? (
                      <>
                        <span className="settings-device-sep">·</span>
                        <span className="settings-device-latency">{deviceLatencyTextOf(device.latencyMs)}</span>
                      </>
                    ) : null}
                    {probe?.phase === "probing" ? (
                      <span className="settings-device-probe">正在测试连接…</span>
                    ) : null}
                    {probe?.phase === "ready" ? (
                      <span className="settings-device-probe" data-device-probe="ready">
                        {DEVICE_RTT_SCOPE} · {deviceRoundTripTextOf(probe.ms)}
                      </span>
                    ) : null}
                    {probe?.phase === "error" ? (
                      <span className="settings-device-probe is-error" data-device-probe="error">
                        {probe.text}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="settings-device-actions">
                  <button
                    type="button"
                    className="settings-device-action"
                    disabled={!device.online || probingId === device.id}
                    title={device.online ? "向设备发一次只读命令，测到回包为止" : "设备离线，无法测试连接"}
                    onClick={() => probeDevice(device)}
                  >
                    {probingId === device.id ? "测试中…" : "测试连接"}
                  </button>
                  {isDefault ? (
                    <span className="settings-device-default is-action">已设为默认</span>
                  ) : (
                    <button type="button" className="settings-device-action" onClick={() => makeDefault(device)}>
                      设为默认
                    </button>
                  )}
                  {!current && canRevoke(device) ? (
                    <button
                      type="button"
                      className="settings-device-action is-danger"
                      disabled={revoking === device.id}
                      onClick={() => revoke(device)}
                    >
                      {removeLabel}
                    </button>
                  ) : null}
                </span>
              </div>
            )
          })
        )}
      </SettingsGroup>

      <IdentitySection />

      {plaintextGroups.length ? (
        <SettingsGroup label="未加密会话">
          <div className="settings-row">
            <span className="settings-plaintext-intro">
              以下会话的正文没有加密、在中转服务器上以明文保存。按成因分组，处理入口在每行右侧。
            </span>
          </div>
          {plaintextGroups.map((group) => (
            <div key={group.key} className="settings-plaintext-group">
              <div className="settings-plaintext-class">
                {group.key === "unknown" ? ENC_FALLBACK_LABEL : ENC_REASON_LABELS[group.key]}
                <span className="settings-plaintext-count">{group.rooms.length} 个会话</span>
              </div>
              {group.rooms.map((room) => {
                const host = room.deviceId ? deviceById.get(room.deviceId) : undefined
                return (
                  <div className="settings-plaintext-row" key={room.id}>
                    <span className="settings-device-meta">
                      <span className="settings-plaintext-title">{plaintextRoomTitleOf(room)}</span>
                      <span className="settings-device-status">
                        <span>{host ? deviceNameOf(host) : "原设备已不在名册"}</span>
                        {room.cwd ? (
                          <>
                            <span className="settings-device-sep">·</span>
                            <span className="settings-plaintext-cwd">{room.cwd}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    {group.action ? (
                      <span className="settings-device-actions">
                        <button type="button" className="settings-device-action" onClick={() => runPlaintextAction(group, room)}>
                          {PLAINTEXT_ACTION_LABELS[group.action]}
                        </button>
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup label="主机行为">
        <SettingsRow
          title="长任务运行时阻止设备睡眠"
          description="在被控设备上生效，长任务过夜跑不会被系统睡眠打断"
          status="reserved"
        >
          <SettingsSwitch label="长任务运行时阻止设备睡眠（设计预留）" checked disabled />
        </SettingsRow>
        <SettingsRow title="新会话自动连上默认设备" description="新建会话时自动归属默认设备">
          <SettingsSwitch
            label="新会话自动连上默认设备"
            checked={prefs.autoConnectDevice}
            onChange={(checked) => act.setPref("autoConnectDevice", checked)}
          />
        </SettingsRow>
        <SettingsRow
          title="在设备上常驻托盘/菜单栏"
          description="Pi-Remote 的小图标常驻被控设备，随手看会话状态"
          status="reserved"
        >
          <SettingsSwitch label="在设备上常驻托盘/菜单栏（设计预留）" checked disabled />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="添加">
        <button type="button" className="settings-device-add" onClick={act.openPairing}>
          <span className="settings-device-icon" aria-hidden="true">
            <Plus size={17} strokeWidth={1.8} />
          </span>
          <span className="settings-device-meta">
            <span className="settings-device-name">添加设备</span>
            <span className="settings-device-add-desc">在新设备浏览器打开后，输入这里显示的配对码</span>
          </span>
          <ChevronRight size={15} strokeWidth={2} aria-hidden="true" className="settings-device-chevron" />
        </button>
      </SettingsGroup>

      <SettingsNote>
        在侧边栏顶部的设备选择器也可切换当前设备。延迟来自设备心跳；「测试连接」会发一次只读命令并显示「
        {DEVICE_RTT_SCOPE}」往返时间；「设为默认」只保存在本机浏览器，不改设备侧配置。
      </SettingsNote>
    </div>
  )
}
