/**
 * 手机端设置 · 设备（移动压缩版）。
 *
 *   ● 设备名册 / 在线状态：relay.devices 现成；配对新设备与撤销走现有配对流程（含管理员令牌），
 *     本页只开配对浮层，不自己直发 device_revoke；
 *   ● 延迟：relay 心跳下发的 devices[].latencyMs；在线且有样本显示「延迟 <整数>ms」，否则「延迟 —」；
 *   ● 测试连接：点击时真的发一次命令往返（当前会话 get_state，其他在线设备 get_host_diag），
 *     显示「设备 ↔ 服务器 · xx ms」；设备离线时禁用；
 *   ● 设为默认：纯本机偏好 defaultDeviceId，刷新后保持，不改设备侧配置；
 *   ○ 新会话自动连上默认设备：本机偏好，即时生效；
 *   ◌ 阻止睡眠 / 常驻托盘：设计预留，不可用。
 */
import { useState } from "react"
import { deviceErrorText, errorCode, type Device } from "@/relay/devices"
import { useSettings } from "../../SettingsContext.tsx"
import { SettingsStatusDot } from "../../ui.tsx"
import {
  DEVICE_RTT_SCOPE,
  deviceLatencyTextOf,
  deviceNameOf,
  deviceRoundTripTextOf,
} from "../../pages/devicesLogic.ts"
import {
  MobileActionRow,
  MobileCard,
  MobileEmpty,
  MobileGroup,
  MobileNote,
  MobilePageBody,
  MobileRow,
  MobileSwitch,
  MobileTag,
} from "../atoms.tsx"

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

function deviceMetaOf(device: Device): string {
  if (!device.online) {
    const last = device.lastAttachAt ? ` · 上次在线 ${clockLabel(device.lastAttachAt)}` : ""
    return `离线${last}`
  }
  return `在线 · ${deviceLatencyTextOf(device.latencyMs)}`
}

interface DeviceProbe {
  phase: "probing" | "ready" | "error"
  ms?: number
  text?: string
}

export function DevicesPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const devices = relay.devices ?? []
  const [probes, setProbes] = useState<Record<string, DeviceProbe>>({})
  const [probingId, setProbingId] = useState<string | null>(null)

  const makeDefault = (device: Device) => {
    if (prefs.defaultDeviceId === device.id) return
    act.setPref("defaultDeviceId", device.id)
    act.notify(`已将「${deviceNameOf(device)}」设为本机默认设备`)
  }

  /** 真的等一次命令回包再算往返；离线设备不发。 */
  const probeDevice = (device: Device) => {
    if (!device.online || probingId) return
    const current = device.id === relay.selectedDeviceId
    const roomReady =
      relay.authed &&
      relay.browserOnline &&
      relay.online &&
      !!relay.roomId &&
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

  return (
    <MobilePageBody page="devices">
      <MobileGroup label="我的设备" stacked>
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
              return (
                <div key={device.id} className="sm-device">
                  <div className="sm-device-head">
                    <SettingsStatusDot tone={device.online ? "online" : "offline"} />
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
                    {isDefault ? (
                      <span className="sm-device-default">已设为默认</span>
                    ) : (
                      <button type="button" className="sm-device-action" onClick={() => makeDefault(device)}>
                        设为默认
                      </button>
                    )}
                    <button
                      type="button"
                      className="sm-device-action sm-device-action--danger"
                      title="在配对 / 设备管理浮层里撤销（需管理员令牌）"
                      onClick={act.openPairing}
                    >
                      移除
                    </button>
                  </div>
                </div>
              )
            })}
          </MobileCard>
        )}
        <MobileCard>
          <MobileActionRow title="添加设备" description="在新设备浏览器打开后，输入这里显示的配对码" onClick={act.openPairing} />
        </MobileCard>
      </MobileGroup>

      <MobileGroup label="主机行为">
        <MobileRow title="长任务运行时阻止设备睡眠" description="在被控设备上生效，长任务过夜跑不会被系统睡眠打断" status="reserved">
          <MobileSwitch label="阻止设备睡眠（设计预留）" checked disabled />
        </MobileRow>
        <MobileRow title="在设备上常驻托盘 / 菜单栏" description="Pi-Remote 的小图标常驻被控设备，随手看会话状态" status="reserved">
          <MobileSwitch label="常驻托盘（设计预留）" checked={false} disabled />
        </MobileRow>
        <MobileSwitchRowLocal checked={prefs.autoConnectDevice} onChange={(checked) => act.setPref("autoConnectDevice", checked)} />
      </MobileGroup>

      <MobileNote>
        在侧边栏顶部的设备选择器也可切换当前设备。延迟来自设备心跳；「测试连接」会发一次只读命令并显示「
        {DEVICE_RTT_SCOPE}」往返时间；「设为默认」只保存在本机浏览器，不改设备侧配置；移除走现有配对 / 设备管理浮层（需管理员令牌）。
      </MobileNote>
    </MobilePageBody>
  )
}

/** 避免把长标题折叠成一行；单独抽出来只为让分组读起来紧凑。 */
function MobileSwitchRowLocal({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <MobileRow title="新会话自动连上默认设备" description="新建会话时自动归属默认设备">
      <MobileSwitch label="新会话自动连上默认设备" checked={checked} onChange={onChange} />
    </MobileRow>
  )
}
