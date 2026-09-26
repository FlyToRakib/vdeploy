import { cn } from '@/lib/cn';

/** One reading, as `project.metrics` returns it. */
export interface Reading {
  at: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimit: number;
}

/**
 * A day of readings, drawn plainly (§27). No chart library: the shape of a
 * line over time is what people read, and the number they compare it
 * against is written next to it rather than inferred from an axis.
 */
export function UsageGraph({
  readings,
  pick,
  ceiling,
  label,
  className,
}: {
  readings: Reading[];
  pick: (reading: Reading) => number;
  /** What full looks like; the line is drawn against this. */
  ceiling: number;
  label: string;
  className?: string;
}) {
  if (readings.length < 2 || ceiling <= 0) {
    return (
      <p className="text-sm text-muted-foreground">Not enough readings yet to draw {label}.</p>
    );
  }
  const width = 600;
  const height = 80;
  const top = Math.max(ceiling, ...readings.map(pick));
  const points = readings.map((reading, index) => {
    const x = (index / (readings.length - 1)) * width;
    const y = height - (pick(reading) / top) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  // The limit line, so "busy" is visible without reading an axis.
  const limit = height - (ceiling / top) * height;

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={cn('h-20 w-full', className)}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <polyline
        points={`0,${String(height)} ${points.join(' ')} ${String(width)},${String(height)}`}
        className="fill-accent/15 stroke-none"
      />
      <polyline points={points.join(' ')} className="fill-none stroke-accent" strokeWidth={1.5} />
      {limit > 0 && limit < height && (
        <line
          x1={0}
          x2={width}
          y1={limit}
          y2={limit}
          className="stroke-status-warning"
          strokeDasharray="4 4"
          strokeWidth={1}
        />
      )}
    </svg>
  );
}
