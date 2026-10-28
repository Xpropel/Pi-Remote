import type { SVGProps } from "react"

/** P11 图标（路径按桌面册 §4/§6 定稿原文；stroke 1.8 round；尺寸由 size 控制）。 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const base = ({ size = 15, ...rest }: IconProps) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...rest,
})

export const PanelIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
  </svg>
)
export const SearchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
)
export const BackIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="m14.5 6-6 6 6 6" /></svg>
)
export const ForwardIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="m9.5 6 6 6-6 6" /></svg>
)
export const MonitorIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 16 })}>
    <rect x="3" y="4" width="18" height="12.5" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </svg>
)
export const ChevronDownIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 13 })} strokeWidth={2}><path d="m6 9.5 6 6 6-6" /></svg>
)
export const SendIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 16 })}>
    <path d="M20.5 3.5 3.8 10.2a.6.6 0 0 0 .04 1.13l6.5 1.9 1.9 6.5a.6.6 0 0 0 1.13.04z" />
    <path d="M20.5 3.5 10.34 13.23" />
  </svg>
)
export const FolderClosedIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 15 })}>
    <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2.2 2.6h6.8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </svg>
)
export const FolderOpenIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 15 })}>
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </svg>
)
/** 图钉：19×19 盒、内部 rotate(45°)（斜置），路径按定稿原文。 */
export const PinIcon = ({ size = 19, ...rest }: IconProps) => (
  <svg {...base({ ...rest, size })}>
    <g transform="rotate(45 12 12)">
      <path d="M8.2 3.8h7.6" />
      <path d="M9.6 3.8v3.1L8 9.7h8V3.8" />
      <path d="M12 9.7v7.4" />
    </g>
  </svg>
)
export const ArchiveIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 14 })}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M4.5 8v11a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8" />
    <path d="M10 12h4" />
  </svg>
)
export const BranchIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 12 })}>
    <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" />
    <path d="M6 7v10M18 9a5 5 0 0 1-5 5H8" />
  </svg>
)
export const FolderTinyIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 12 })}>
    <path d="M3.5 7a2 2 0 0 1 2-2h3.2l1.8 2.2H18.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </svg>
)
export const ServerIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 14 })}>
    <rect x="3" y="4" width="18" height="7" rx="1.8" />
    <rect x="3" y="13" width="18" height="7" rx="1.8" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
)
export const GearIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: 17 })}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.32.63.95 1.03 1.65 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.97z" />
  </svg>
)
