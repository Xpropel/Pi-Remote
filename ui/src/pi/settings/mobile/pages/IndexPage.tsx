/**
 * 手机端设置 · 首页（列表入口）。
 *
 * 设计：board-mobile.png 第一张 / m-settings-index.png。三张卡 + 唯一分组标题「移动端」。
 * 12 个入口对应 12 个内容界面；首页自身是第 13 个界面（title=设置）。
 */
import { PanelLeft } from "lucide-react"
import { SETTINGS_PAGE_META } from "../../types.ts"
import { SettingsIcon } from "../../ui.tsx"
import { MobileActionRow, MobileCard, MobileGroup, MobilePageBody } from "../atoms.tsx"
import {
  MOBILE_INDEX_GROUPS,
  MOBILE_SETTINGS_PAGE_LABELS,
  type MobileSettingsDestination,
  type MobileSettingsPageId,
} from "../types.ts"

function EntryIcon({ page }: { page: MobileSettingsDestination }) {
  if (page === "interaction") {
    return <PanelLeft size={17} strokeWidth={1.8} aria-hidden="true" className="sm-index-icon" />
  }
  return <SettingsIcon name={SETTINGS_PAGE_META[page].icon} size={17} />
}

export function MobileIndexPage({ onNavigate }: { onNavigate: (page: MobileSettingsPageId) => void }) {
  return (
    <MobilePageBody page="index">
      {MOBILE_INDEX_GROUPS.map((group) => (
        <MobileGroup key={group.id} label={group.label} stacked>
          <MobileCard className="sm-index-card">
            {group.entries.map((page) => (
              <MobileActionRow
                key={page}
                title={MOBILE_SETTINGS_PAGE_LABELS[page]}
                leading={<EntryIcon page={page} />}
                onClick={() => onNavigate(page)}
              />
            ))}
          </MobileCard>
        </MobileGroup>
      ))}
      <p className="sm-note">设置只保存在这个浏览器里；会话记录仍留在所连设备上。</p>
    </MobilePageBody>
  )
}
