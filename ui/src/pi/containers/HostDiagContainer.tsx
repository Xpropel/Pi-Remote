import { useEffect, useState } from "react"
import { PiHostDiagDialog } from "@/components/pi/composer"
import { formatHostDiag, hostDiagUnavailableOf, hostDiagViewOf, normalizeHostDiag, type HostDiag } from "@/pi/model/hostDiag"
import { copyToClipboard } from "./cShared"
import { closePiDialog, PI_UI_IDS, piDialogOf, piLayoutOf, type PiContainerProps, type Relay } from "./types"

/**
 * 主机诊断（design B07「设置 › 设备 › 某台 › 诊断」，PLAN §7.3 settings / 弹窗家族行；P5 第 2 轮，审查 P5-R1-1）。
 * 打开：piDialogOf(p)?.id === PI_UI_IDS.hostDiag，arg = 设备 id（设置页的设备行开它）。桌面在外壳 overlay 槽（DialogsContainer 里），
 * 手机在 sheet 槽：设置页是自己的整页，SettingsContainer 把它放进自己的 sheet 槽；其余页面经 PhoneApp 的 DialogsContainer。
 * 取数：relay.runDeviceCommand(deviceId, "get_host_diag")。get_host_diag 是设备级只读命令（relay/commands.js 的 READONLY_DEVICE_COMMANDS），
 * 按设备寻址、不需要打开会话，所以名册里任何一台在线设备都能读；relay.getHostDiag() 只问选中的那台，这里不用。状态层不改。
 * 口径照旧界面 conversation/HostDiagView.tsx（纯函数在 pi/model/hostDiag.ts）：设备离线 / 没连上服务器时不发命令；不支持、出错、刷新失败分开写。
 */

type DiagResult = { sig: string; phase: "ready" | "error"; data: unknown; error: unknown }

/** 读一次 get_host_diag（deviceId 为 null = 不读）；reload 再读一次。last = 上一次成功读到的（刷新时、刷新失败时接着显示） */
function useHostDiag(run: Relay["runDeviceCommand"], deviceId: string | null) {
  const [nonce, setNonce] = useState(0)
  const [result, setResult] = useState<DiagResult | null>(null)
  const [last, setLast] = useState<HostDiag | null>(null)
  const sig = `${deviceId ?? ""}|${nonce}`
  useEffect(() => {
    if (!deviceId) return
    let alive = true
    Promise.resolve()
      .then(() => run(deviceId, "get_host_diag"))
      .then(
        (data) => {
          if (!alive) return
          setResult({ sig, phase: "ready", data, error: null })
          setLast(normalizeHostDiag(data))
        },
        (error: unknown) => {
          if (alive) setResult({ sig, phase: "error", data: undefined, error })
        },
      )
    return () => {
      alive = false
    }
  }, [run, deviceId, sig])
  const fresh = !!deviceId && result?.sig === sig
  return {
    phase: !deviceId ? ("idle" as const) : fresh && result ? result.phase : ("loading" as const),
    data: fresh ? result?.data : undefined,
    error: fresh ? result?.error : null,
    last,
    reload: () => setNonce((n) => n + 1),
  }
}

function HostDiagBody(props: PiContainerProps & { deviceId: string }) {
  const { relay, deviceId } = props
  const device = relay.devices.find((d) => d.id === deviceId) ?? null
  const unavailable = hostDiagUnavailableOf({ authed: relay.authed, browserOnline: relay.browserOnline, device })
  const res = useHostDiag(relay.runDeviceCommand, unavailable ? null : deviceId)
  const view = hostDiagViewOf({ unavailable, phase: res.phase, data: res.data, error: res.error, last: res.last })
  const copy = () => {
    if (view.kind !== "ready") return
    void copyToClipboard(formatHostDiag(view.diag)).then((ok) => relay.notify(ok ? "已复制主机诊断" : "复制失败：浏览器不允许剪贴板", ok ? "warn" : "bad"))
  }
  return (
    <PiHostDiagDialog
      viewport={piLayoutOf(props.variant)}
      subtitle={device?.name ?? null}
      view={view}
      onRetry={res.reload}
      onRefresh={res.reload}
      onCopy={copy}
      onOpenChange={(next) => {
        if (!next) closePiDialog(props)
      }}
    />
  )
}

/** 没开时什么都不画；换了设备就重置（key = 设备 id） */
export function HostDiagContainer(props: PiContainerProps) {
  const open = piDialogOf(props)
  if (open?.id !== PI_UI_IDS.hostDiag || !open.arg) return null
  return <HostDiagBody key={open.arg} {...props} deviceId={open.arg} />
}
