import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface SummarySegment {
  name: string;
  value: number;
  /** Tailwind background class, e.g. "bg-earned". */
  color: string;
}

export interface MobileSummaryProps {
  tiles: { label: string; value: string; hint?: string; color?: string }[];
  chart: {
    title: string;
    legend: { name: string; color: string }[];
    bars: { label: string; segments: SummarySegment[] }[];
  };
  list: {
    title: string;
    empty: string;
    items: { key: string; title: string; subtitle?: string; value: string }[];
  };
}

/** USD amounts as in the dashboards: cents, or tenths of a cent below $1. */
export const usd = (n: number): string =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 3 : 2,
  });

/**
 * Small-screen analytics: tiles, one chart and a card list. Plain server-rendered HTML —
 * the full AG Studio dashboard (≈ 6 MB) only loads on wider screens.
 */
export function MobileSummary({ tiles, chart, list }: MobileSummaryProps) {
  const max = Math.max(1e-9, ...chart.bars.map((b) => b.segments.reduce((s, x) => s + x.value, 0)));
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <Card key={t.label} className="gap-1 py-3">
            <CardHeader className="px-3">
              <CardDescription className="flex items-center gap-2">
                {t.color && <span className={`size-2 rounded-full ${t.color}`} />}
                {t.label}
              </CardDescription>
              <CardTitle className="text-xl tabular-nums">{t.value}</CardTitle>
            </CardHeader>
            {t.hint && (
              <CardContent className="px-3 text-xs text-muted-foreground">{t.hint}</CardContent>
            )}
          </Card>
        ))}
      </section>
      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-base">{chart.title}</CardTitle>
          {chart.legend.length > 1 && (
            <CardDescription className="flex flex-wrap gap-3 text-xs">
              {chart.legend.map((l) => (
                <span key={l.name} className="flex items-center gap-1">
                  <span className={`size-2 rounded-full ${l.color}`} />
                  {l.name}
                </span>
              ))}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex h-40 items-end gap-1.5" role="img" aria-label={chart.title}>
            {chart.bars.map((b) => {
              const total = b.segments.reduce((s, x) => s + x.value, 0);
              return (
                <div
                  key={b.label}
                  className="flex h-full flex-1 flex-col items-center justify-end gap-1"
                >
                  <div
                    className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
                    style={{ height: `${(total / max) * 100}%` }}
                    title={`${b.label}: ${usd(total)}`}
                  >
                    {b.segments.map((s) => (
                      <div
                        key={s.name}
                        className={s.color}
                        style={{ height: `${total ? (s.value / total) * 100 : 0}%` }}
                      />
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{b.label}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-base">{list.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {list.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{list.empty}</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {list.items.map((i) => (
                <li key={i.key} className="flex items-baseline justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{i.title}</div>
                    {i.subtitle && (
                      <div className="truncate text-xs text-muted-foreground">{i.subtitle}</div>
                    )}
                  </div>
                  <span className="font-semibold tabular-nums">{i.value}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Open on a larger screen for the full AG Studio dashboard.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Last `n` UTC days as YYYY-MM-DD, oldest first. */
export function lastDays(n: number, now = new Date()): string[] {
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (n - 1 - i)))
      .toISOString()
      .slice(0, 10),
  );
}
