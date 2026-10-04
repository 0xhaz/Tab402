import { directoryCategories, searchDirectory } from "@tab402/db";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { db } from "@/lib/server";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Directory",
  description: "Paid APIs your agents can call per request, priced in dollars.",
};

const API = (process.env.TAB402_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

/** The public Tab402 directory. No sign-in; no buyer data. */
export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const { q = "", category } = await searchParams;
  const [listings, categories] = await Promise.all([
    searchDirectory(db, { q: q.slice(0, 200), category, limit: 50 }),
    directoryCategories(db),
  ]);
  const href = (c?: string) =>
    `/directory?${new URLSearchParams({ ...(q ? { q } : {}), ...(c ? { category: c } : {}) })}`;

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <Link href="/">
          <Brand />
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="outline" asChild>
            <Link href="/">Open your wallet</Link>
          </Button>
        </div>
      </header>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Directory</h1>
        <p className="text-sm text-muted-foreground">
          Paid APIs your agents can call per request. Add the Tab402 MCP server and they find these
          with <code className="font-mono text-xs">search_services</code>; you pay one PayPal charge
          for the whole tab.
        </p>
      </div>
      <form className="flex gap-2" action="/directory">
        <Input
          name="q"
          defaultValue={q}
          placeholder="What do you need? e.g. summarize text"
          aria-label="Search"
        />
        {category && <input type="hidden" name="category" value={category} />}
        <Button type="submit">Search</Button>
      </form>
      {categories.length > 0 && (
        <nav className="flex flex-wrap gap-2" aria-label="Categories">
          <Link href={href()}>
            <Badge variant={category ? "outline" : "default"}>All</Badge>
          </Link>
          {categories.map((c) => (
            <Link key={c.category} href={href(c.category)}>
              <Badge variant={category === c.category ? "default" : "outline"}>
                {c.category} · {c.endpoints}
              </Badge>
            </Link>
          ))}
        </nav>
      )}
      <section className="grid gap-4 sm:grid-cols-2" aria-label="Results">
        {listings.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing matches{q ? ` "${q}"` : ""} yet.</p>
        )}
        {listings.map((l) => (
          <Card key={l.id} className="gap-2">
            <CardHeader>
              <CardDescription className="flex items-center justify-between gap-2">
                <span>{l.seller}</span>
                {l.category && <Badge variant="secondary">{l.category}</Badge>}
              </CardDescription>
              <CardTitle className="text-base">
                {l.description ?? new URL(l.url).pathname}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <code className="truncate font-mono text-xs text-muted-foreground" title={l.url}>
                <span className="font-semibold">{l.method}</span> {l.url}
              </code>
              <div className="flex items-center justify-between gap-2">
                <span className={cn("font-semibold tabular-nums")}>
                  {l.price}
                  <span className="font-normal text-muted-foreground"> per call</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {l.paidCalls30d.toLocaleString()} paid calls · 30 days ·{" "}
                  <a className="underline" href={`${API}/directory/sellers/${l.sellerId}/x402`}>
                    x402
                  </a>
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
