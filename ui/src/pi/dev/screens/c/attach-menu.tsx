import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiAttachMenu } from "@/components/pi/composer/PiComposerMenu"
import { PiRoot, PiSheet } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "attach-menu",
  area: "c",
  title: "+ 菜单",
  states: [
    "键盘开着时（改为输入框上方浮层）",
    "图片被拒（warning「这张图压到 128 KB 也放不下」，同 key 合并计数）",
    "桌面拖入遮罩（「松开以添加图片」）",
    "未载入会话（「命令…」禁用）",
  ],
  notes:
    "E05 E06 E07。菜单项：图片…（png / jpeg / gif / webp，最多 5 张）、文本文件…（64 KB 以内的 UTF-8 文本，插进输入框）—— 命令…、用量与费用 —— 脚注 @ 引用说明；去掉了现状的「不支持 @ 引用」错误底注。桌面从 + 上方弹出、宽 280；手机键盘收起时用底部 PiSheet，行 52。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock static
      variant={variant}
      state="S0"
      model={C_MODEL_LABEL}
      tray={[TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main" }}
      plusOpen
      menu={phone ? undefined : <PiAttachMenu variant={variant} className="w-[280px]" />}
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <CPhoneChat
          roomId="r-s1"
          dock={dock}
          sheet={
            <PiSheet static title="添加" bodyClassName="px-2">
              <PiAttachMenu variant={variant} bare />
            </PiSheet>
          }
        >
          <CTranscript variant={variant} />
        </CPhoneChat>
      ) : (
        <CDesktop roomId="r-s1" dock={dock}>
          <CTranscript variant={variant} />
        </CDesktop>
      )}
    </PiRoot>
  )
}
