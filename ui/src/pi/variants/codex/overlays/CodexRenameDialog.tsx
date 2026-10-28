import { useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { sidebarDataOf } from "@/pi/model/sidebarSource"
import { deviceErrorText } from "@/relay/devices"
import { CodexButton, CodexDialog } from "../primitives/primitives"

/** 重命名会话对话框（[X-图5①] 表单语言）：label 小字 + 单行输入 + 黑胶囊主按钮；失败红字不关窗 */
export function CodexRenameDialog({ p, rowId, onClose }: { p: VariantAppProps; rowId: string; onClose: () => void }) {
  const { relay } = p
  const data = sidebarDataOf({
    devices: relay.devices,
    rooms: relay.rooms,
    sessionsByDevice: relay.sessionsByDevice,
    roomId: relay.roomId,
    dialogs: relay.dialogs,
    uiPrompt: relay.uiPrompt,
    turnEnd: relay.turnEnd,
    roomTurnEnds: relay.roomTurnEnds,
    selectedDevice: relay.selectedDevice,
  })
  const row = data.sessions.find((x) => x.id === rowId)
  const active = relay.roomId === rowId
  const [name, setName] = useState(row?.title ?? "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  if (!row) return null
  const save = async () => {
    const next = name.trim()
    if (!next || pending) return
    setPending(true)
    setError("")
    try {
      if (active) await relay.runCommand("set_session_name", { name: next })
      else if (row.path) await relay.renameSessionFile(row.path, next)
      else throw new Error("这个会话没有文件路径")
      relay.pushNotice({ level: "success", title: "已修改会话名" })
      onClose()
    } catch (e) {
      setError(deviceErrorText(e))
      setPending(false)
    }
  }
  return (
    <CodexDialog
      title="重命名会话"
      onClose={onClose}
      width={400}
      footer={
        <>
          <CodexButton kind="outline" onClick={onClose}>
            取消
          </CodexButton>
          <CodexButton kind="primary" disabled={pending || !name.trim()} onClick={() => void save()}>
            {pending ? "保存中…" : "保存"}
          </CodexButton>
        </>
      }
    >
      <label className="cx-field">
        <span className="cx-field-label">会话名</span>
        <input className="cx-field-input" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void save()} />
      </label>
      {error ? (
        <p role="alert" className="cx-dialog-error">
          {error}
        </p>
      ) : null}
    </CodexDialog>
  )
}
