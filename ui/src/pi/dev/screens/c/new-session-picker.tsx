import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { SuggestionPills } from "@/components/kit/composer/SuggestionPills"
import { PiFolderPicker } from "@/components/pi/composer/PiFolderPicker"
import { PiEmptyComposer } from "@/components/pi/composer/PiEmptyComposer"
import { PiPhonePage, PiRoot, PiSheet, PiTopBar } from "@/components/pi/shared"
import { CDesktop } from "@/pi/dev/frames/CFrames"
import { C_MODEL_LABEL, NEW_SESSION_SUGGESTIONS, RECENT_FOLDERS } from "@/pi/dev/fixtures/gallery/c"
import { mockDevice } from "@/pi/dev/fixtures/gallery/shared"

export const piScreen: PiScreenMeta = {
  id: "new-session-picker",
  area: "c",
  title: "选择文件夹",
  states: [
    "文件夹菜单打开（搜索「搜索文件夹…」→ 最近 → 分隔线 → 工作区「在这台 Mac 上 ›」）",
    "二级菜单打开（搜索「搜索这台 Mac…」→ 白名单 + 最近用过的文件夹 → 分隔线 →「打开文件夹…」）",
    "这台设备没有浏览根目录（旧 attach / 关闭浏览）：「打开文件夹…」置灰并写原因，最近和白名单照常可选",
    "设备离线：文件夹菜单只列这台设备最近用过的 / 白名单目录，「打开文件夹…」置灰",
    "搜索无匹配（「没有匹配的文件夹」）",
  ],
  notes:
    "C06 C02 + P9 C（spec §5.1-2 / §5.1-3）。先选设备、再只列这台设备的文件夹，两台设备的目录不混在一起；顶层「最近」路径用 ~/ 开头，当前项打勾。桌面两级菜单同时展开（照 replica kit RepoPicker 的图 18 版式）；手机是 PiSheet 二级页，顶部返回箭头，行高 52。静态帧用 mock 的新 attach（浏览根目录 = 家目录 /Users/dev）。",
}

const DEVICE = mockDevice("d-mbp")
const PROJECTS = DEVICE?.projects ?? []
/** P9 C：白名单 + 最近用过的，去重（生产口径 = folderBrowser.knownFoldersOf） */
const KNOWN_FOLDERS = [...PROJECTS, ...RECENT_FOLDERS.filter((p) => !PROJECTS.includes(p))]
/** 设备用户的家目录 = 默认浏览根目录；把它的前缀显示成 ~/ */
const HOME_ROOTS = ["/Users/dev"]
const SCOPE_LABEL = "在这台 Mac 上"
const PLATFORM = "darwin"
const CURRENT = "/Users/dev/code/pi-remote"

const picker = (variant: "desktop" | "phone") => (
  <PiFolderPicker
    static
    variant={variant}
    scopeLabel={SCOPE_LABEL}
    platform={PLATFORM}
    recent={RECENT_FOLDERS}
    knownFolders={KNOWN_FOLDERS}
    canBrowse
    browseReason={null}
    homeRoots={HOME_ROOTS}
    value={CURRENT}
    initialPage="folders"
  />
)

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <PiPhonePage
          topBar={<PiTopBar variant="phone-page" title="新会话" />}
          contentClassName="h-full"
          dock={
            <div className="px-4 pt-2 pb-2">
              <PiEmptyComposer static variant="phone" device={{ name: "MacBook Pro", platform: PLATFORM }} folder="pi-remote" open="folder" model={C_MODEL_LABEL} />
            </div>
          }
          sheet={
            <PiSheet static title="选择文件夹" bodyClassName="px-4">
              {picker("phone")}
            </PiSheet>
          }
        >
          <div className="flex h-full flex-col justify-center px-4">
            <SuggestionPills items={NEW_SESSION_SUGGESTIONS} className="flex-col items-stretch gap-2.5" pillClassName="h-11 w-full justify-center text-[15px]" />
          </div>
        </PiPhonePage>
      ) : (
        <CDesktop navSelected="new">
          <div className="absolute inset-0 flex justify-center px-10 pt-[268px]">
            <div className="w-full max-w-[640px]">
              <PiEmptyComposer
                static
                variant="desktop"
                device={{ name: "MacBook Pro", platform: PLATFORM }}
                folder="pi-remote"
                open="folder"
                model={C_MODEL_LABEL}
                menu={picker("desktop")}
                below={<SuggestionPills items={NEW_SESSION_SUGGESTIONS} />}
              />
            </div>
          </div>
        </CDesktop>
      )}
    </PiRoot>
  )
}
