import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, MENTION_POOL, MENTION_QUERY, MENTION_SELECTED, MENTION_TEXT_BEFORE } from "@/pi/dev/fixtures/gallery/c"
import { PiMentionMenu } from "@/components/pi/composer/PiComposerMenu"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "mention-menu",
  area: "c",
  title: "@ 引用文件",
  keyboard: true,
  states: [
    "没有候选（「这个会话里还没出现过匹配的文件」）",
    "引用满 10 个（不再弹候选，灰字说明）",
  ],
  notes:
    "E08。输入「看一下 @mob」，已选一个引用 shell.css（输入框上沿的蓝色 FileChip）。候选池 = 本会话工具入参 + 文件视图读过的文件（上限 20）；排序照 mention.ts filterMentionFiles：文件名开头 > 文件名包含 > 路径包含，所以 useMobileViewport.ts 排在最后；命中段加粗（推断）。菜单头灰字说明「发送时附上路径」【测试 mention】。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock static
      variant={variant}
      state="S1"
      draft={`${MENTION_TEXT_BEFORE}@${MENTION_QUERY}`}
      mentions={MENTION_SELECTED}
      caret
      model={C_MODEL_LABEL}
      tray={[TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main" }}
      keyboardOpen={phone}
      menu={
        <PiMentionMenu variant={variant} pool={MENTION_POOL} query={MENTION_QUERY} selected={MENTION_SELECTED} maxHeight={phone ? 220 : 300} />
      }
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <CPhoneChat roomId="r-s1" dock={dock} keyboardOpen>
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
