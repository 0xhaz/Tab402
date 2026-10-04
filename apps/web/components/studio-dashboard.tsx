"use client";

import { AgStudioAiModule, AgStudioLicenseManager } from "ag-studio";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { studioHarness } from "@/lib/studio-ai";

// AG Studio needs the DOM: load it in the browser only.
const AgStudio = dynamic(() => import("ag-studio-react").then((m) => m.AgStudio), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export interface StudioTable {
  id: string;
  name: string;
  description: string;
  /** Declared up front: a table can be empty (new seller, no payouts yet) and still needs fields. */
  columns: readonly string[];
  data: Record<string, unknown>[];
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const MONEY_FIELDS = new Set(["amount", "earned", "collected", "paid_out", "price", "fee"]);
const DATE_FIELDS = new Set(["day", "date"]);
const COUNT_FIELDS = new Set(["calls", "quotes", "paid", "count"]);

/** Field formats by column name: amounts are USD, days are dates, everything else is inferred. */
function withFields(t: StudioTable) {
  const { columns, ...table } = t;
  return {
    ...table,
    fields: columns.map((col) =>
      MONEY_FIELDS.has(col)
        ? {
            id: col,
            name: col.replace("_", " "),
            format: "currencyFormat" as const,
            formatOptions: { format: money },
          }
        : DATE_FIELDS.has(col)
          ? { id: col, name: col, format: "dateFormat" as const }
          : {
              id: col,
              name: col.replace("_", " "),
              format: COUNT_FIELDS.has(col) ? ("integerFormat" as const) : ("textFormat" as const),
            },
    ),
  };
}

let licensed = false;
let quietTrial = false;

/**
 * Without a license key AG Studio runs as a watermarked trial and prints a boxed banner, one
 * `console.error("****…")` per line — which Next's dev overlay shows as a pile of errors. Swap
 * that banner (and only it) for one info line. With a key set, every license message stays loud.
 */
function quietTrialBanner() {
  if (quietTrial || typeof window === "undefined") return;
  quietTrial = true;
  const error = console.error.bind(console);
  let noted = false;
  console.error = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("*")) {
      if (!noted) {
        noted = true;
        console.info("AG Studio: no AG_STUDIO_LICENSE_KEY — running as a watermarked trial.");
      }
      return;
    }
    error(...args);
  };
}

const WIDE = "(min-width: 640px)";
/** null during SSR/hydration, then whether the screen is wide enough for AG Studio. */
function useWide(): boolean | null {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => null,
  );
}
const MODULES = [AgStudioAiModule];

export function StudioDashboard({
  tables,
  report,
  licenseKey,
  ai,
  mobile,
}: {
  tables: StudioTable[];
  report: object;
  licenseKey?: string;
  /** Turn on the AI panel (edit mode) with Claude; sellers also get the revenue tools. */
  ai?: "seller" | "buyer";
  /** Shown instead on small screens: AG Studio (≈ 6 MB) only loads on wider ones. */
  mobile?: React.ReactNode;
}) {
  const wide = useWide();
  const [mode, setMode] = useState<"view" | "edit">("view");
  const { resolvedTheme } = useTheme();
  if (!licenseKey) quietTrialBanner();
  if (licenseKey && !licensed) {
    AgStudioLicenseManager.setLicenseKey(licenseKey);
    licensed = true;
  }
  const data = useMemo(() => ({ sources: tables.map(withFields) }), [tables]);
  const empty = tables.every((t) => t.data.length === 0);
  // biome-ignore lint/suspicious/noExplicitAny: report JSON matches AgReportState; typed loosely to keep it plain data
  const plainData = { data, initialState: report } as any;
  if (wide === null) return <Skeleton className="h-[640px] w-full" />;
  if (!wide && mobile) return <>{mobile}</>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        {empty && (
          <span className="mr-auto text-sm text-muted-foreground">
            No data yet — charts fill in as agents start paying.
          </span>
        )}
        <Button
          size="sm"
          variant={mode === "view" ? "secondary" : "outline"}
          onClick={() => setMode(mode === "view" ? "edit" : "view")}
        >
          {mode === "view" ? (ai ? "Edit / Ask AI" : "Edit dashboard") : "Done editing"}
        </Button>
      </div>
      <div
        className="h-[calc(100dvh-12rem)] min-h-[640px] overflow-hidden rounded-lg border"
        data-theme={resolvedTheme}
      >
        <AgStudio
          {...plainData}
          mode={mode}
          modules={ai ? MODULES : undefined}
          ai={ai ? ({ api }) => studioHarness(api, ai) : undefined}
        />
      </div>
    </div>
  );
}
