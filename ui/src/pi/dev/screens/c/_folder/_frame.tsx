import type { ReactNode } from "react"
import { SuggestionPills } from "@/components/kit/composer/SuggestionPills"
import { PiEmptyComposer } from "@/components/pi/composer/PiEmptyComposer"
import { PiPhonePage, PiRoot, PiTopBar } from "@/components/pi/shared"
import { CDesktop } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, NEW_SESSION_SUGGESTIONS } from "@/pi/dev/fixtures/gallery/c"
import type { PiLayout, PiTheme } from "@/pi/dev/registry"

/*
 * P9 C 文件夹浏览器开发屏共用的舞台（下划线文件、没有 piScreen：registry 当辅助文件忽略）。
 * 背景 = 新建会话页（同 c/new-session）；浏览器桌面挂在 CDesktop 的 overlay 槽、手机挂在 PiPhonePage 的 sheet 槽。
 * 这些屏不进 80 张对图，只给人看新部件的四种状态（加载 / 出错 / 空 / 截断）。
 */
export function BrowserStage({ viewport, theme, children }: { viewport: PiLayout; theme: PiTheme; children: ReactNode }) {
  const phone = viewport === "phone"
  const composer = (
    <PiEmptyComposer
      static
      variant={phone ? "phone" : "desktop"}
      device={{ name: "MacBook Pro", platform: "darwin" }}
      folder="pi-remote"
      model={C_MODEL_LABEL}
      below={phone ? undefined : <SuggestionPills data-cw-id="pi-new-suggestions" items={NEW_SESSION_SUGGESTIONS} />}
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme}>
      {phone ? (
        <PiPhonePage
          topBar={<PiTopBar variant="phone-page" title="新会话" />}
          contentClassName="h-full"
          dock={<div className="px-4 pt-2 pb-2">{composer}</div>}
          sheet={children}
        >
          <div className="flex h-full flex-col justify-center px-4">
            <SuggestionPills items={NEW_SESSION_SUGGESTIONS} className="flex-col items-stretch gap-2.5" pillClassName="h-11 w-full justify-center text-[15px]" />
          </div>
        </PiPhonePage>
      ) : (
        <CDesktop navSelected="new" overlay={children}>
          <div className="absolute inset-0 flex justify-center px-10 pt-[268px]">
            <div className="w-full max-w-[640px]">{composer}</div>
          </div>
        </CDesktop>
      )}
    </PiRoot>
  )
}
