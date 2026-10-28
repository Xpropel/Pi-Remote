/** 首连 / 清单加载中的骨架行（[C-图12] 列表骨架） */
export function ClaudeSidebarSkeleton() {
  return (
    <div className="claude-skeleton">
      {Array.from({ length: 6 }).map((_, i) => (
        <span key={i} style={{ width: `${[88, 72, 80, 60, 76, 66][i]}%` }} />
      ))}
    </div>
  )
}
