import type { SVGProps } from "react"

/** P11 图标（路径按桌面册 §4/§6 定稿原文；stroke 1.8 round）。size 有默认值，调用方传入的 size 优先。 */
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
  <svg {...base({ size: 15, ...p })}>
    <rect x="3" y="4" width="18" height="12.5" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </svg>
)
export const ChevronDownIcon = (p: IconProps) => (
  <svg {...base({ size: 13, strokeWidth: 2, ...p })}><path d="m6 9.5 6 6 6-6" /></svg>
)
export const SendIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <path d="M20.5 3.5 3.8 10.2a.6.6 0 0 0 .04 1.13l6.5 1.9 1.9 6.5a.6.6 0 0 0 1.13.04z" />
    <path d="M20.5 3.5 10.34 13.23" />
  </svg>
)
export const FolderClosedIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2.2 2.6h6.8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </svg>
)
export const FolderOpenIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </svg>
)
/** 图钉：内部 rotate(45°)（斜置），路径按定稿原文。 */
export const PinIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <g transform="rotate(45 12 12)">
      <path d="M8.2 3.8h7.6" />
      <path d="M9.6 3.8v3.1L8 9.7h8V3.8" />
      <path d="M12 9.7v7.4" />
    </g>
  </svg>
)
export const ArchiveIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M4.5 8v11a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8" />
    <path d="M10 12h4" />
  </svg>
)
/** 取消归档：归档盒 + 向上箭头 */
export const UnarchiveIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M4.5 8v11a1.5 1.5 0 0 0 1.5 1.5h2.5M19.5 8v11a1.5 1.5 0 0 1-1.5 1.5h-2.5" />
    <path d="m9.5 14.5 2.5-2.5 2.5 2.5M12 12v8.5" />
  </svg>
)
/** 待答（收件盒） */
export const InboxIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <path d="M21 12.5h-5.2l-1.6 2.6H9.8l-1.6-2.6H3" />
    <path d="M5.6 5.6 3 12.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5.5l-2.6-6.9A2 2 0 0 0 16.5 4.3h-9a2 2 0 0 0-1.9 1.3z" />
  </svg>
)
export const PlusIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}><path d="M12 5v14M5 12h14" /></svg>
)
export const MoreIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <circle cx="5.5" cy="12" r="0.9" />
    <circle cx="12" cy="12" r="0.9" />
    <circle cx="18.5" cy="12" r="0.9" />
  </svg>
)
export const CheckIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}><path d="M19.5 7 9.8 16.7 5 12" /></svg>
)
export const BranchIcon = (p: IconProps) => (
  <svg {...base({ size: 12, ...p })}>
    <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" />
    <path d="M6 7v10M18 9a5 5 0 0 1-5 5H8" />
  </svg>
)
export const FolderTinyIcon = (p: IconProps) => (
  <svg {...base({ size: 12, ...p })}>
    <path d="M3.5 7a2 2 0 0 1 2-2h3.2l1.8 2.2H18.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </svg>
)
export const ClockIcon = (p: IconProps) => (
  <svg {...base({ size: 12, ...p })}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
)
export const ServerIcon = (p: IconProps) => (
  <svg {...base({ size: 14, ...p })}>
    <rect x="3" y="4" width="18" height="7" rx="1.8" />
    <rect x="3" y="13" width="18" height="7" rx="1.8" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
)
export const FilterIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}><path d="M4 6.5h16M7 12h10M10 17.5h4" /></svg>
)
export const GearIcon = (p: IconProps) => (
  <svg {...base({ size: 15, ...p })}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.32.63.95 1.03 1.65 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.97z" />
  </svg>
)
