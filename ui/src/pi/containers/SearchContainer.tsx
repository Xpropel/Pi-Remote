import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { ASearchField, ATextButton, PiSearchResults, type PiSearchSection } from "@/components/pi/shell"
import { PiSpinner, PiTopBar, piSidebarRowData, usePiStatic, type PiSessionRowData } from "@/components/pi/shared"
import { useNow } from "@/pi/hooks/useNow"
import { highlightPartOf } from "@/pi/model/highlightMatch"
import { rowMarkerOf } from "@/pi/model/rowMarker"
import { openSessionRow, sidebarDataOf, type PiDeviceListedSession, type PiSidebarData } from "@/pi/model/sidebarSource"
import { attentionForRoom } from "@/relay/attention"
import { errorCode } from "@/relay/devices"
import {
  BODY_SEARCH_QUERY_MIN,
  bodySearchErrorText,
  bodySearchPageOf,
  bodySearchPartialText,
  bodySearchTruncatedText,
  searchSessions,
  type BodySearchHit,
  type BodySearchPage,
} from "@/shell/searchModel"
import type { PiContainerProps } from "./types"

/** 正文搜索（search_session_bodies，选中设备的各项目并发，relay/bodySearch.ts）的状态；换词或换设备就作废 */
type BodyState =
  | { phase: "idle" }
  | { phase: "searching"; query: string }
  | { phase: "done"; query: string; page: BodySearchPage }
  | { phase: "error"; query: string; text: string }

const SEARCH_NAV = '[data-pi-sidebar] [data-pi-nav="search"]'
const PHONE_SEARCH_BTN = '[data-pi-topbar="phone-list"] button[aria-label="搜索会话"]'

/** 退出搜索：清掉 ui.search，焦点回"搜索"行（桌面）/ 搜索钮（手机） */
function exitSearch(p: PiContainerProps) {
  p.act.setSearch(null)
  const target = p.variant === "phone" ? PHONE_SEARCH_BTN : SEARCH_NAV
  requestAnimationFrame(() => document.querySelector<HTMLElement>(target)?.focus())
}

function rowOf(x: PiDeviceListedSession, data: PiSidebarData, now: number): PiSessionRowData {
  const device = data.devices.find((d) => d.id === x.deviceId)
  return piSidebarRowData(
    {
      id: x.id,
      title: x.title,
      marker: rowMarkerOf(attentionForRoom(data.attention, x.id), x.busy, x.online, x.openable),
      at: x.updatedAt > 0 ? x.updatedAt : undefined,
      deviceId: x.deviceId,
      dimmed: device ? !device.online : undefined,
    },
    now,
  )
}

const norm = (path: string) => path.replace(/\\/g, "/")

/** search_session_bodies 的回包 → 结果态（形状不对按出错算：宁可不出结果，不呈假数据） */
function pageState(query: string, data: unknown): BodyState {
  const page = bodySearchPageOf(data)
  return page ? { phase: "done", query, page } : { phase: "error", query, text: "正文搜索回包形状不对，请重试" }
}

/** 失败 → 四种诚实态文案（离线 / 无活动会话 / 超时 / 不支持，searchModel） */
function errorState(query: string, error: unknown): BodyState {
  return { phase: "error", query, text: bodySearchErrorText(errorCode(error), error instanceof Error ? error.message : "") }
}

function SearchNote({ phone, children }: { phone: boolean; children: ReactNode }) {
  return (
    <div
      data-pi-search-note=""
      className={cn(
        "flex flex-wrap items-center gap-x-1 gap-y-0.5 text-(--cw-pi-text-secondary)",
        phone ? "min-h-11 px-2 text-[15px] leading-5" : "min-h-8 px-1.5 text-(length:--cw-text-sm) leading-(--cw-leading-sm)",
      )}
    >
      {children}
    </div>
  )
}

/**
 * 搜索会话（plan §7.1 session-search，a 线）：标题过滤在本地做（shell/searchModel.ts 的 searchSessions，所有设备的会话，
 * 顺序同列表：在线在前、再按最近活动）；正文搜索至少 2 个字、点"在正文中搜索"才发 search_session_bodies（relay.searchSessionBodies：
 * 选中设备的在线房间每个项目一个、按房间并发，结果合并去重；没有在线房间才按设备发），四种错误文案、截断说明和部分结果说明照 searchModel；
 * 命中词加粗用 model/highlightMatch.ts（不用底色）。
 * 搜索词在 ui.search（null = 没在搜）。桌面放在侧栏分组区（含搜索框），手机放在列表页正文（搜索框在 SearchTopBar）。
 * 静态态（#/live 对图）按画廊屏的摆法：已经点过"在正文中搜索"（挂载时发一次）。
 */
export function SearchContainer(props: PiContainerProps) {
  const { relay, ui, act, variant } = props
  const phone = variant === "phone"
  const isStatic = usePiStatic()
  const now = useNow(30_000)
  const query = ui.search ?? ""
  const trimmed = query.trim()
  const tooShort = trimmed.length < BODY_SEARCH_QUERY_MIN
  const { devices: rawDevices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice } = relay
  const data = useMemo(
    () => sidebarDataOf({ devices: rawDevices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice }),
    [rawDevices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice],
  )
  const titles = useMemo(
    () =>
      trimmed
        ? searchSessions(data.sessions, trimmed).sort((a, b) => Number(b.online) - Number(a.online) || b.updatedAt - a.updatedAt)
        : [],
    [data.sessions, trimmed],
  )
  const deviceId = relay.selectedDeviceId
  const deviceName = relay.selectedDevice?.name ?? ""
  const searchBodies = relay.searchSessionBodies
  // 正文搜索的结果记着它是哪个词、哪台设备的：换词或换设备时直接按"没搜过"算，不能把上一台设备的命中挂在新设备名下（同旧界面 BodySearchSection）
  const [result, setResult] = useState<{ query: string; deviceId: string | null; state: BodyState } | null>(null)
  const ticket = useRef(0)
  const body: BodyState = result && result.query === trimmed && result.deviceId === deviceId ? result.state : { phase: "idle" }
  const run = async () => {
    if (tooShort) return
    const mine = ++ticket.current
    const key = { query: trimmed, deviceId }
    setResult({ ...key, state: { phase: "searching", query: trimmed } })
    try {
      const state = pageState(trimmed, await searchBodies(trimmed))
      if (ticket.current === mine) setResult({ ...key, state })
    } catch (error) {
      if (ticket.current === mine) setResult({ ...key, state: errorState(trimmed, error) })
    }
  }
  // 静态态（#/live 对图）：画廊屏是"已经点过在正文中搜索"的样子，挂载时发一次
  useEffect(() => {
    if (!isStatic || tooShort) return
    let alive = true
    const key = { query: trimmed, deviceId }
    searchBodies(trimmed).then(
      (data) => {
        if (alive) setResult({ ...key, state: pageState(trimmed, data) })
      },
      (error) => {
        if (alive) setResult({ ...key, state: errorState(trimmed, error) })
      },
    )
    return () => {
      alive = false
    }
  }, [isStatic, tooShort, trimmed, deviceId, searchBodies])

  const open = (x: PiDeviceListedSession) => {
    act.setSearch(null)
    openSessionRow(relay, x, act.openSession)
  }
  const openHit = (hit: BodySearchHit) => {
    const known = data.sessions.find((x) => x.id === hit.id || (!!x.path && norm(x.path) === norm(hit.session)))
    if (known) {
      open(known)
      return
    }
    // 不在清单窗口里（清单有 200 上限）：按回包合成一行，走同样的打开路径（同旧界面 openHit）
    const online = relay.rooms.some((r) => r.id === hit.id && r.online)
    open({
      id: hit.id,
      title: hit.title,
      path: hit.session,
      cwd: hit.cwd,
      online,
      busy: false,
      viewers: 0,
      messageCount: 0,
      updatedAt: hit.mtime,
      openable: online,
      deviceId: deviceId ?? "",
    })
  }

  const titleRows = titles.map((x) => ({ ...rowOf(x, data, now), highlight: highlightPartOf(x.title, trimmed) }))
  const shownIds = new Set(titles.flatMap((x) => [x.id, ...(x.path ? [norm(x.path)] : [])]))
  const hits = body.phase === "done" ? body.page.results.filter((hit) => !shownIds.has(hit.id) && !shownIds.has(norm(hit.session))) : []
  const bodyRows: PiSessionRowData[] = hits.map((hit) => {
    const known = data.sessions.find((x) => x.id === hit.id)
    const base = known ? rowOf(known, data, now) : { id: hit.id, title: hit.title, marker: "idle" as const }
    const subtitle = hit.snippets[0]?.text ?? ""
    return { ...base, subtitle, highlight: highlightPartOf(base.title, trimmed) ?? highlightPartOf(subtitle, trimmed), trailingText: `命中 ${hit.matchCount} 条` }
  })

  const trigger =
    body.phase === "idle" && !tooShort ? (
      <SearchNote phone={phone}>
        <ATextButton tone="link" touch={phone} className="-ml-1.5" onClick={() => void run()}>
          在正文中搜索「{trimmed}」
        </ATextButton>
      </SearchNote>
    ) : null
  const sections: PiSearchSection[] = []
  if (titleRows.length) sections.push({ key: "title", label: `标题匹配 ${titleRows.length}`, rows: titleRows, note: trigger })
  if (body.phase === "searching") {
    sections.push({
      key: "body",
      label: `内容匹配${deviceName ? ` · ${deviceName}` : ""}`,
      rows: [],
      note: (
        <SearchNote phone={phone}>
          <PiSpinner size={12} tone="muted" label="正在搜索正文" />
          {deviceName ? `正在 ${deviceName} 上搜索…` : "正在搜索…"}
        </SearchNote>
      ),
    })
  } else if (body.phase === "error") {
    sections.push({
      key: "body",
      label: "内容匹配",
      rows: [],
      note: (
        <SearchNote phone={phone}>
          <span role="alert">{body.text}</span>
          <ATextButton tone="link" touch={phone} onClick={() => void run()}>
            重新搜索
          </ATextButton>
        </SearchNote>
      ),
    })
  } else if (body.phase === "done") {
    const truncated = body.page.truncated ? bodySearchTruncatedText(body.page) : null
    // 部分结果（8.1b）：并发搜的项目里有超时 / 失败的，写明是哪个项目（relay/bodySearch.ts 合并时记下）
    const partial = bodySearchPartialText(body.page)
    sections.push({
      key: "body",
      label: `内容匹配 ${bodyRows.length}${deviceName ? ` · ${deviceName}` : ""}`,
      rows: bodyRows,
      note:
        truncated || partial || bodyRows.length === 0 ? (
          <SearchNote phone={phone}>
            {bodyRows.length === 0 ? (body.page.results.length ? "正文命中的会话已在上面列出" : `正文里没有找到「${body.query}」`) : null}
            {partial ? <span role="status">{partial}</span> : null}
            {truncated ? <span role="status">{truncated}</span> : null}
          </SearchNote>
        ) : undefined,
    })
  }

  const results =
    sections.length > 0 ? (
      <PiSearchResults
        variant={variant}
        sections={sections}
        selectedId={!phone && relay.roomId ? relay.roomId : undefined}
        onOpenRow={(row) => {
          const known = data.sessions.find((x) => x.id === row.id)
          const hit = body.phase === "done" ? body.page.results.find((h) => h.id === row.id) : undefined
          if (hit && !titles.some((x) => x.id === row.id)) openHit(hit)
          else if (known) open(known)
        }}
      />
    ) : trimmed ? (
      // 无结果（design session-search states）："没有匹配的会话" + "清空搜索"；够 2 个字时仍可以去正文里搜
      <div data-pi-search-empty="" className={cn("flex flex-col items-start gap-1", phone ? "px-2 pt-4" : "px-1.5 pt-3")}>
        <p className={cn("m-0 text-(--cw-pi-text-secondary)", phone ? "text-[15px] leading-5" : "text-(length:--cw-text-sm) leading-(--cw-leading-sm)")}>
          没有匹配的会话
        </p>
        <div className="-ml-1.5 flex flex-wrap items-center">
          <ATextButton
            tone="link"
            touch={phone}
            onClick={() => {
              act.setSearch("")
              requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-pi-search-field] input")?.focus())
            }}
          >
            清空搜索
          </ATextButton>
          {!tooShort && body.phase === "idle" ? (
            <ATextButton tone="link" touch={phone} onClick={() => void run()}>
              在正文中搜索「{trimmed}」
            </ATextButton>
          ) : null}
        </div>
      </div>
    ) : null

  if (phone) return results
  return (
    <>
      <ASearchField
        variant="desktop"
        value={query}
        autoFocus
        onValueChange={(value) => act.setSearch(value)}
        onClear={() => act.setSearch("")}
        onEscape={() => exitSearch(props)}
        className="mt-1.5 mr-0.5 ml-0.5"
      />
      {results}
    </>
  )
}

/** 手机列表页搜索态的顶栏：搜索框 + "取消"（同画廊屏 a/session-search 390） */
export function SearchTopBar(props: PiContainerProps) {
  const { ui, act } = props
  return (
    <PiTopBar
      variant="phone-list"
      search={
        <>
          <ASearchField
            variant="phone"
            value={ui.search ?? ""}
            autoFocus
            onValueChange={(value) => act.setSearch(value)}
            onClear={() => act.setSearch("")}
            onEscape={() => exitSearch(props)}
          />
          <ATextButton touch className="text-[16px] text-(--cw-text)" onClick={() => exitSearch(props)}>
            取消
          </ATextButton>
        </>
      }
    />
  )
}
