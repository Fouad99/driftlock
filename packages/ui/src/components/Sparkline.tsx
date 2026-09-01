// Recharts is held for M4b (05-UI.md §4.3) — this 14-point sparkline is
// intentionally a plain inline SVG, not a charting library.
export function Sparkline({ points }: { points: { day: string; count: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const width = 84;
  const height = 20;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = i * step;
    const y = height - (p.count / max) * height;
    return `${x},${y}`;
  });
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="14-day finding rate"
      className="text-neutral-400 dark:text-neutral-500"
    >
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
