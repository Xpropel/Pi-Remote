import { useMemo } from "react"
import { ChevronRight, Folder, FolderSearch } from "lucide-react"
import type { Device } from "@/relay/devices"
import type { SessionEntry } from "@/relay/devices"
import { browseAccessOf, knownFoldersOf } from "@/pi/model/folderBrowser"
import { homeShort, recentFoldersOf } from "@/pi/model/newSession"
import { ClaudeMenuItem, ClaudeMenuLabel, ClaudeMenuSeparator } from "../primitives/ClaudePrimitives"

/**
 * Claude v2 自有文件夹选择器（P9 C：只看这台设备自己的文件夹 —— 最近 + 已知白名单；不能浏览时给原因）。
 * 数据：@/pi/model/newSession（recentFoldersOf / homeShort）+ folderBrowser（knownFoldersOf / browseAccessOf）纯函数。
 */
export function ClaudeFolderPicker({
  device,
  sessions,
  value,
  onSelect,
  onBrowse,
}: {
  device: Device
  sessions: readonly SessionEntry[]
  value: string | null
  onSelect: (path: string) => void
  onBrowse: () => void
}) {
  const recent = useMemo(() => recentFoldersOf(sessions, device, 5), [sessions, device])
  const known = useMemo(() => knownFoldersOf(device, sessions), [device, sessions])
  const browse = browseAccessOf(device)
  const roots = device.browseRoots ?? []
  return (
    <>
      <ClaudeMenuLabel>{homeShort(value ?? "", roots) || "还没有选中文件夹"}</ClaudeMenuLabel>
      {recent.length > 0 ? (
        <>
          <ClaudeMenuLabel>最近</ClaudeMenuLabel>
          {recent.map((path) => (
            <ClaudeMenuItem key={`recent-${path}`} onClick={() => onSelect(path)}>
              <Folder size={13} strokeWidth={1.5} aria-hidden /> {homeShort(path, roots)}
            </ClaudeMenuItem>
          ))}
        </>
      ) : null}
      {known.filter((path) => !recent.includes(path)).length > 0 ? (
        <>
          <ClaudeMenuSeparator />
          <ClaudeMenuLabel>这台设备上的文件夹</ClaudeMenuLabel>
          {known
            .filter((path) => !recent.includes(path))
            .slice(0, 8)
            .map((path) => (
              <ClaudeMenuItem key={`known-${path}`} onClick={() => onSelect(path)}>
                <Folder size={13} strokeWidth={1.5} aria-hidden /> {homeShort(path, roots)}
              </ClaudeMenuItem>
            ))}
        </>
      ) : null}
      <ClaudeMenuSeparator />
      <ClaudeMenuItem disabled={!browse.canBrowse} hint={browse.reason ?? undefined} onClick={onBrowse}>
        <FolderSearch size={13} strokeWidth={1.5} aria-hidden /> 打开文件夹…
        <ChevronRight size={12} strokeWidth={2} aria-hidden className="claude-menu-item-chevron" />
      </ClaudeMenuItem>
    </>
  )
}
