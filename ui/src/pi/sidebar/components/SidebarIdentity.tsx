import { GearIcon, ServerIcon } from "./icons"

/** P11-SIDE-11：底部身份行（服务器名 + 右锚齿轮）；serverName 由宿主/model 归纳。 */
export function SidebarIdentity({ serverName, online, onSettings }: { serverName: string; online: boolean; onSettings: () => void }) {
  return (
    <div className="sb-identity" data-p11-surface="P11-SIDE-11">
      <div className="sb-identity-row">
        <span className="sb-identity-tile" data-online={online ? "" : undefined}>
          <ServerIcon size={14} />
        </span>
        <span className="sb-identity-name" title={serverName}>{serverName}</span>
        <button type="button" className="sb-iconbtn sb-iconbtn-weak sb-identity-gear" aria-label="设置" onClick={onSettings}>
          <GearIcon size={17} />
        </button>
      </div>
    </div>
  )
}
