import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiComposerDock } from "@/components/pi/composer"
import { CDesktop, CPhoneChat, CTranscript } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, slashBrowseGroups } from "@/pi/dev/fixtures/gallery/c"
import { PiSlashMenu } from "@/components/pi/composer/PiComposerMenu"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "slash-menu",
  area: "c",
  title: "斜杠命令",
  keyboard: true,
  states: [
    "前缀过滤（「/co」→ /compact、/copy、/clone、/commands，平铺不分组）",
    "带参数（「/model 」→ 模型列表子菜单）",
    "执行回执",
    "无匹配（「没有这个命令」）",
  ],
  notes:
    "E09。输入「/」、空查询分组浏览、第一行选中：常用（按 slashUsage 计数：/compact /model /fork）→ 内置（slash.tsx COMMANDS 其余 16 条，说明照抄）→ 本机资源（get_commands 的 1 个模板 + 1 个技能，名字是 mock）。分组规则照 slashParse.ts groupSlashBrowse（产品里内置主组没有组名、资源组叫「资源命令」，这里按 design 写「内置」「本机资源」）。手机键盘开着：菜单浮在 composer 上方、限在可视视口内（最高 288），行 48；桌面最高 360，行 32。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock static
      variant={variant}
      state="S1"
      draft="/"
      caret
      model={C_MODEL_LABEL}
      tray={[TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main" }}
      keyboardOpen={phone}
      menu={<PiSlashMenu variant={variant} groups={slashBrowseGroups()} maxHeight={phone ? 288 : 360} />}
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
