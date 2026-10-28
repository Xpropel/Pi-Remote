import { useEffect, useRef, useState } from "react"
import { PiDevicePairing } from "@/components/pi/shell"
import { PiButton, PiDialog, usePiStatic, type PiDevice } from "@/components/pi/shared"
import { useNow } from "@/pi/hooks/useNow"
import { sortShellDevices } from "@/shell/deviceStripModel"
import {
  ADMIN_TOKEN_COPY,
  adminTokenErrorText,
  adminTokenReady,
  canRevoke,
  COPY,
  newlyPaired,
  pairBaseline,
} from "@/relay/devices"
import { closePiDialog, PI_UI_IDS, piDialogOf, piLayoutOf, type PiContainerProps } from "./types"

type Pair = { code: string; expiresAt: number; baseline: Record<string, boolean> }

/**
 * 弹窗里的内容（开着时才挂载：配对码、撤销武装都是这一次打开的状态，关掉就丢）。
 * 口径照旧界面 chat/dialogs.tsx 的 DevicesDialog：管理员令牌只存本机（relay.adminToken / setAdminToken，不进日志）；
 * 生成配对码（pair_create）→ 倒计时 → 名册里出现新配上的设备（pairBaseline / newlyPaired）就换成"已配对"；撤销点两次。
 */
function PairingBody(props: PiContainerProps) {
  const { relay, variant } = props
  const isStatic = usePiStatic()
  const now = useNow(1000)
  const [pair, setPair] = useState<Pair | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [armed, setArmed] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [platform, setPlatform] = useState<"unix" | "windows">("unix")
  // 挂载时置回 true：StrictMode（开发态）会先卸再挂一次，只在卸载里置 false 的话之后永远是 false，"正在生成…"卡住不回
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const saved = adminTokenReady(relay.adminToken)
  const ready = saved && !editing
  const { adminToken, createPairCode, devices } = relay
  const generate = async () => {
    if (creating || !ready) return
    setCreating(true)
    setError(null)
    const baseline = pairBaseline(devices)
    try {
      const next = await createPairCode(adminToken)
      if (alive.current) setPair({ ...next, baseline })
    } catch (e) {
      if (alive.current) setError(adminTokenErrorText(e))
    } finally {
      if (alive.current) setCreating(false)
    }
  }
  // 静态态（#/live 对图）按画廊屏的摆法：令牌已存时已经生成过一个配对码（挂载时生成一次）
  useEffect(() => {
    if (!isStatic || !adminTokenReady(adminToken)) return
    let live = true
    const baseline = pairBaseline(devices)
    createPairCode(adminToken).then(
      (next) => {
        if (live) setPair({ ...next, baseline })
      },
      (e) => {
        if (live) setError(adminTokenErrorText(e))
      },
    )
    return () => {
      live = false
    }
  }, [isStatic, adminToken, createPairCode, devices])
  const revoke = async (device: PiDevice) => {
    if (revoking || !ready) return
    if (armed !== device.id) {
      setArmed(device.id)
      return
    }
    setRevoking(device.id)
    setError(null)
    try {
      await relay.revokeDevice(device.id, relay.adminToken)
      relay.pushNotice({ level: "success", title: `已撤销「${device.name}」，它要重新配对才能再连` })
      if (alive.current) setArmed(null)
    } catch (e) {
      if (alive.current) setError(adminTokenErrorText(e))
    } finally {
      if (alive.current) setRevoking(null)
    }
  }
  const paired = pair ? newlyPaired(pair.baseline, relay.devices) : null
  return (
    <PiDevicePairing
      variant={variant}
      devices={sortShellDevices(relay.devices)}
      pair={pair}
      now={now}
      commandPlatform={platform}
      onCommandPlatformChange={setPlatform}
      admin={{
        saved,
        editing: editing || !saved,
        value: editing || !saved ? draft : "",
        onChange: setDraft,
        onEdit: () => {
          setDraft("")
          setEditing(true)
        },
        onSave: () => {
          if (!adminTokenReady(draft)) return
          relay.setAdminToken(draft.trim())
          setDraft("")
          setEditing(false)
        },
        onCancel: () => {
          setDraft("")
          setEditing(false)
        },
        hint: ADMIN_TOKEN_COPY.hint,
        required: ADMIN_TOKEN_COPY.required,
      }}
      flow={{
        creating,
        pairedName: paired?.name ?? null,
        pairedHint: COPY.pairDone,
        expiredText: COPY.pairExpired,
        onGenerate: () => void generate(),
        error,
      }}
      revoke={{
        armedId: armed,
        busyId: revoking,
        canRevoke,
        disabled: !ready,
        onRevoke: (device) => void revoke(device),
        explain: COPY.revokeExplain,
      }}
    />
  )
}

/**
 * 设备与配对（plan §7.1 device-pairing，a 线）：devices / canManageDevices / adminToken / createPairCode / revokeDevice；
 * formatPairCode、pairCommands、pairRemainText 的口径在 components/pi/shell/pairing.ts；设备行"窗口剩余 21h"用 piDuration 整点写法（M-09）。
 * 打开：piDialogOf(p)?.id === PI_UI_IDS.pairing（c 的设置页、设备菜单、no-devices 的"配对新设备"都用这个 id）。
 * 桌面 PiDialog 560（overlay 槽，压暗），手机全高 sheet（sheet 槽）；relay 没声明 device.token 时只写不支持的说明。没开时什么都不画。
 * 手机上令牌输入框聚焦时按 sheetLayout 摆（P6.3）。
 */
export function PairingContainer(props: PiContainerProps) {
  const { relay, variant } = props
  const open = piDialogOf(props)?.id === PI_UI_IDS.pairing
  if (!open) return null
  const phone = variant === "phone"
  const close = () => closePiDialog(props)
  return (
    <PiDialog
      title="设备与配对"
      viewport={piLayoutOf(variant)}
      width={560}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      footer={
        <PiButton variant={variant} className={phone ? "w-full" : undefined} onClick={close}>
          完成
        </PiButton>
      }
    >
      {relay.canManageDevices ? (
        <PairingBody {...props} />
      ) : (
        <p className="m-0 text-(length:--cw-text-md) leading-[20px] text-(--cw-text-2)">
          当前服务端还不支持设备配对和撤销（需要协议 v4）。在要接入的电脑上运行 deploy/attach.sh（Windows：deploy\attach.cmd）打开连接窗口。
        </p>
      )}
    </PiDialog>
  )
}
