/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula are prefixed with ' (seller text is untrusted). */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function csvResponse(name: string, body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}

/** Micro-USD as a plain decimal string, exact to the micro. */
export const usd = (micros: number) => (micros / 1e6).toFixed(6).replace(/\.?0+$/, "");
