import type { VariantAppProps } from "@/pi/variants/types"
import { CodexCommandPalette } from "./CodexCommandPalette"
import { CodexDeleteDialog } from "./CodexDeleteDialog"
import { CodexDisplayOptions } from "./CodexDisplayOptions"
import { CodexPairingDialog } from "./CodexPairingDialog"
import { CodexRenameDialog } from "./CodexRenameDialog"
import { CodexSessionMenu } from "./CodexSessionMenu"

export interface CodexOverlayState {
  sessionMenu: { rowId: string; at: { x: number; y: number } } | null
  dialog: { kind: "delete" | "rename"; rowId: string } | null
  pairing: boolean
  displayOptions: boolean
}

/** 浮层宿主（checklist §0.3：渲染在变体根内部，不 portal 到 body）：会话菜单 / 删除 / 改名 / 配对 / 显示选项 / 命令面板 */
export function CodexOverlayHost({
  p,
  state,
  onChange,
}: {
  p: VariantAppProps
  state: CodexOverlayState
  onChange: (next: Partial<CodexOverlayState>) => void
}) {
  return (
    <>
      {state.sessionMenu ? (
        <CodexSessionMenu
          p={p}
          rowId={state.sessionMenu.rowId}
          at={state.sessionMenu.at}
          onClose={() => onChange({ sessionMenu: null })}
          onRename={(rowId) => onChange({ sessionMenu: null, dialog: { kind: "rename", rowId } })}
          onDelete={(rowId) => onChange({ sessionMenu: null, dialog: { kind: "delete", rowId } })}
        />
      ) : null}
      {state.dialog?.kind === "delete" ? <CodexDeleteDialog p={p} rowId={state.dialog.rowId} onClose={() => onChange({ dialog: null })} /> : null}
      {state.dialog?.kind === "rename" ? <CodexRenameDialog p={p} rowId={state.dialog.rowId} onClose={() => onChange({ dialog: null })} /> : null}
      {state.pairing ? <CodexPairingDialog p={p} onClose={() => onChange({ pairing: false })} /> : null}
      {state.displayOptions ? (
        <div className="cx-dialog-layer" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onChange({ displayOptions: false })}>
          <CodexDisplayOptions p={p} onClose={() => onChange({ displayOptions: false })} />
        </div>
      ) : null}
      {p.ui.paletteOpen ? <CodexCommandPalette p={p} onClose={() => p.act.setPaletteOpen(false)} /> : null}
    </>
  )
}
