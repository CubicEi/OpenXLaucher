"use client";

type Props = {
  percent: number | null;
  label: string;
};

export function LauncherUpdateProgressBar({ percent, label }: Props) {
  const value = typeof percent === "number" ? Math.min(100, Math.max(0, percent)) : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        {value !== null && <span className="font-mono text-sky-600">{value.toFixed(1)}%</span>}
      </div>
      {value !== null && (
        <div className="w-full h-2 rounded-full bg-sky-500/15 overflow-hidden">
          <div
            className="h-full bg-sky-500 transition-all duration-300"
            style={{ width: `${value}%` }}
          />
        </div>
      )}
    </div>
  );
}
