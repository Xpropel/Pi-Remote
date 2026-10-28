import type { ReactNode } from "react"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { PiComposerDock } from "@/components/pi/composer"
import { PiRoot } from "@/components/pi/shared"
import type { PiTheme, PiLayout } from "@/pi/dev/registry"

/*
 * P5 c 线弹窗家族的开发屏共用的舞台（下划线文件、没有 piScreen：registry 当辅助文件忽略）。
 * 桌面：c 区的会话外壳 + 弹窗放在 overlay 槽（同 c/dialog-usage）；手机：对话页 + 弹窗放在 sheet 槽（PiDialog 390 = 全高 sheet）。
 * 这些开发屏不进 80 张对图（R2/dialogs-review.md 是深浅两种主题的人工检查记录）。
 */
export const DIALOG_SESSION_TITLE = "修复手机键盘收起时输入框跳动"

export function DialogStage({ viewport, theme, children }: { viewport: PiLayout; theme: PiTheme; children: ReactNode }) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = <PiComposerDock static variant={variant} state="S0" model={C_MODEL_LABEL} tray={[TRAY_CHANGES]} status={{ device: "MacBook Pro", branch: "main" }} />
  return (
    <PiRoot viewport={viewport} theme={theme}>
      {phone ? (
        <CPhoneChat roomId="r-s1" dock={dock} sheet={children}>
          <CTranscript variant={variant} />
        </CPhoneChat>
      ) : (
        <CDesktop roomId="r-s1" dock={dock} overlay={children}>
          <CTranscript variant={variant} />
        </CDesktop>
      )}
    </PiRoot>
  )
}
