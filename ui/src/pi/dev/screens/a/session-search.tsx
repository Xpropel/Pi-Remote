import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import {
  A_BODY_SEARCH,
  A_SEARCH_QUERY,
  aTitleMatches,
} from "@/pi/dev/fixtures/gallery/a"
import {
  ADesktop,
  APhoneList,
} from "@/pi/dev/frames/AFrames"
import {
  ADock,
  ATranscript,
} from "@/pi/dev/frames/AConversation"
import {
  ASearchField,
  ATextButton,
  PiSearchResults,
  type PiSearchSection,
} from "@/components/pi/shell"
import { MOCK_NOW, mockDevice, mockSession, piSessionRow } from "@/pi/dev/fixtures/gallery/shared"
import { PiRoot, PiTopBar } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "session-search",
  area: "a",
  title: "搜索会话",
  states: [
    "无结果（「没有匹配的会话」+「清空搜索」）",
    "正文搜索中（Spinner +「正在 MacBook Pro 上搜索…」）",
    "正文搜索出错（设备未连接 / 没有在运行的会话 / 超时 / 扩展不支持，四种文案 + 重新搜索）",
    "截断（「已扫 50/120 个会话文件，结果可能不全」）",
    "查询不足 2 字（只做标题过滤，不出现「在正文中搜索」）",
  ],
  notes:
    "C10 C11。查询「键盘」：标题匹配 2（本地过滤标题 / 首条消息）+ 已点过「在正文中搜索」的内容匹配 2（search_session_bodies，在 MacBook Pro 上搜，扫完 13 个会话文件）。命中词加粗、不用底色。推断：搜索框做成白底细描边框（design 写 MenuSearch 样式：无框 + 下分隔线；放在侧栏灰底上不易辨认）、内容匹配行两行（标题 + 片段）+ 行尾「命中 N 条」。",
}

function sections(): PiSearchSection[] {
  const titles = aTitleMatches(A_SEARCH_QUERY).map((x) => ({ ...piSessionRow(x, MOCK_NOW), highlight: A_SEARCH_QUERY }))
  const device = mockDevice(mockSession(A_BODY_SEARCH.results[0]?.id ?? "")?.deviceId)
  const bodies = A_BODY_SEARCH.results.map((hit) => {
    const s = mockSession(hit.id)
    const base = s ? piSessionRow(s, MOCK_NOW) : { id: hit.id, title: hit.title, marker: "idle" as const }
    return {
      ...base,
      subtitle: hit.snippets[0]?.text ?? "",
      highlight: A_SEARCH_QUERY,
      trailingText: `命中 ${hit.matchCount} 条`,
    }
  })
  return [
    { key: "title", label: `标题匹配 ${titles.length}`, rows: titles },
    { key: "body", label: `内容匹配 ${bodies.length}${device ? ` · ${device.name}` : ""}`, rows: bodies },
  ]
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const results = sections()
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneList
          footer={null}
          topBar={
            <PiTopBar
              variant="phone-list"
              search={
                <>
                  <ASearchField variant="phone" value={A_SEARCH_QUERY} />
                  <ATextButton touch className="text-[16px] text-(--cw-text)">
                    取消
                  </ATextButton>
                </>
              }
            />
          }
          sidebarBody={<PiSearchResults variant="phone" sections={results} />}
        />
      ) : (
        <ADesktop
          selectedId="r-s1"
          navSelected="search"
          sidebarBody={
            <>
              <ASearchField variant="desktop" value={A_SEARCH_QUERY} className="mt-1.5 mr-0.5 ml-0.5" />
              <PiSearchResults variant="desktop" sections={results} selectedId="r-s1" />
            </>
          }
          dock={<ADock variant="desktop" />}
        >
          <ATranscript variant="desktop" />
        </ADesktop>
      )}
    </PiRoot>
  )
}
