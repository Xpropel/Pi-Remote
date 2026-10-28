import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhonePushed } from "@/pi/dev/frames/BFrames"
import { piBaseName } from "@/components/pi/shared/format"
import { CHANGES_TOTAL, CONVO_DONE, FILE_RESULT, NOW, TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiFilePane, PiFileToolbar } from "@/components/pi/conversation/PiFilePane"
import { PiPaneTabs, PiPaneTitle } from "@/components/pi/conversation/PiPaneTabs"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "file-pane",
  area: "b",
  title: "文件视图",
  states: [
    "手动打开（B09：顶部「打开文件…」输入行）",
    "加载中",
    "找不到（「找不到这个文件 · ENOENT」）",
    "截断（「只显示前 256 KB」）",
    "二进制（「二进制文件，不能预览 · 下载」）",
    "图片（MediaImage）",
  ],
  notes:
    "B09 B11 K11。从流里点 FileChip 打开 ui/src/mobile/useMobileViewport.ts（get_file 结果，内容 = 两次编辑之后的版本，与改动视图同源）。面包屑 + 「大小 · 语言」+ 下载；代码区行号浅灰、低饱和高亮、无 minimap / LSP / blame。面包屑按 kit 组合，不用 ch5/FileBreadcrumbs（它写死了大纲 / 文件内搜索 / 后退 / 前进四个钮，Pi 没有这些功能）。手机代码软换行、保留行号（推断）；手机工具行钉在顶栏下（PiPhonePage.subHeader，M-10）。文件大小按 mock 文本实际字节算。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  // 手机：面包屑 + 「大小 · 语言」钉在顶栏下（PiPhonePage.subHeader，M-10），pane 不再自带
  const pane = <PiFilePane file={FILE_RESULT} variant={phone ? "phone" : "desktop"} toolbar={!phone} />
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhonePushed title={<PiPaneTitle active="file" />} subHeader={<PiFileToolbar file={FILE_RESULT} variant="phone" />}>
          {pane}
        </BPhonePushed>
      ) : (
        <BDesktop
          roomId="r-s1"
          pane={
            <>
              <PiPaneTabs active="file" changes={CHANGES_TOTAL} file={{ name: piBaseName(FILE_RESULT.path), kind: "ts" }} />
              {pane}
            </>
          }
          dock={
            <PiComposerDock
              variant="desktop"
              state="S0"
              model={C_MODEL_LABEL}
              tray={[TRAY_CHANGES]}
              status={{ device: "MacBook Pro", branch: "main" }}
            />
          }
        >
          <PiTranscript static items={CONVO_DONE} variant="desktop" now={NOW} />
        </BDesktop>
      )}
    </PiRoot>
  )
}
