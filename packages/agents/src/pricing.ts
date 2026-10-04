/**
 * Category price defaults. The model picks a category and a
 * price; code clamps it into the category's range. Replace with directory price data once it exists.
 */
export const CATEGORIES = ["lookup", "search", "llm", "media", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CategoryDefault {
  label: string;
  pricing: "fixed" | "metered";
  /** Micro-USD. For metered: the maximum authorization per call. */
  minMicros: number;
  maxMicros: number;
  defaultMicros: number;
}

export const CATEGORY_DEFAULTS: Record<Category, CategoryDefault> = {
  lookup: {
    label: "Lookup / data",
    pricing: "fixed",
    minMicros: 1_000,
    maxMicros: 10_000,
    defaultMicros: 2_000,
  },
  search: {
    label: "Search",
    pricing: "fixed",
    minMicros: 5_000,
    maxMicros: 20_000,
    defaultMicros: 10_000,
  },
  // LLM calls are metered at provider cost × 1.3; the price is the per-call ceiling.
  llm: {
    label: "LLM (metered, provider cost × 1.3)",
    pricing: "metered",
    minMicros: 10_000,
    maxMicros: 500_000,
    defaultMicros: 50_000,
  },
  media: {
    label: "Media generation",
    pricing: "fixed",
    minMicros: 20_000,
    maxMicros: 100_000,
    defaultMicros: 40_000,
  },
  other: {
    label: "Other",
    pricing: "fixed",
    minMicros: 1_000,
    maxMicros: 10_000,
    defaultMicros: 2_000,
  },
};

/** Keep a proposal inside its category's range, in whole tenths of a cent (100 micros). */
export function clampPrice(category: Category, micros: number): number {
  const d = CATEGORY_DEFAULTS[category];
  const n = Number.isFinite(micros) ? micros : d.defaultMicros;
  const rounded = Math.round(n / 100) * 100;
  return Math.min(d.maxMicros, Math.max(d.minMicros, rounded));
}
