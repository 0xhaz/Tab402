"use client";

import { Check, Copy, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { confirm, propose } from "./actions";

type Category = {
  id: string;
  label: string;
  pricing: "fixed" | "metered";
  minMicros: number;
  maxMicros: number;
};
type Proposed = Extract<Awaited<ReturnType<typeof propose>>, { ok: true }>;
type Done = Extract<Awaited<ReturnType<typeof confirm>>, { ok: true }>;
type Row = Proposed["proposals"][number] & { priceUsd: string };

const toUsd = (micros: number) => (micros / 1e6).toFixed(4).replace(/0{1,2}$/, "");
const fmt = (micros: number) => `$${toUsd(micros)}`;

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        className="absolute top-2 right-2"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
      </Button>
      <pre className="max-h-[28rem] overflow-auto rounded-md bg-muted p-4 pr-24 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

export function OnboardFlow({ categories, ai }: { categories: Category[]; ai: boolean }) {
  const [spec, setSpec] = useState("");
  const [proposal, setProposal] = useState<Proposed | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [pending, start] = useTransition();
  const cat = (id: string) => categories.find((c) => c.id === id) ?? categories[0];
  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>You're priced</CardTitle>
          <CardDescription>
            The routes are live in the{" "}
            <Link className="underline" href="/directory">
              directory
            </Link>{" "}
            and agents can find them now. Add the gate to your API so calls get a 402 and pay. The
            gate's <code className="font-mono text-xs">routes</code> block is the source of truth:
            it registers these prices whenever your API starts, so change prices there.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="gate">
            <TabsList>
              <TabsTrigger value="gate">Gate config</TabsTrigger>
              <TabsTrigger value="discovery">/.well-known/x402</TabsTrigger>
              <TabsTrigger value="docs">Docs</TabsTrigger>
            </TabsList>
            <TabsContent value="gate">
              <CopyBlock label="gate config" text={done.snippet} />
            </TabsContent>
            <TabsContent value="discovery">
              <CopyBlock label="discovery file" text={done.manifest} />
            </TabsContent>
            <TabsContent value="docs">
              <CopyBlock label="docs" text={done.docs} />
            </TabsContent>
          </Tabs>
          <Button className="mt-4" asChild>
            <Link href="/selling">Back to Selling</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!proposal) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your API spec</CardTitle>
          <CardDescription>OpenAPI 3.0 or 3.1, or Swagger 2.0 — JSON or YAML.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!ai && (
            <Alert>
              <AlertDescription>
                No ANTHROPIC_API_KEY on this server: prices come from simple keyword rules instead
                of Claude.
              </AlertDescription>
            </Alert>
          )}
          <Textarea
            aria-label="OpenAPI spec"
            className="min-h-64 font-mono text-xs"
            placeholder={
              "openapi: 3.1.0\ninfo:\n  title: My API\npaths:\n  /v1/search:\n    post:\n      summary: Search …"
            }
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending || !spec.trim()}
              onClick={() =>
                start(async () => {
                  const r = await propose(spec);
                  if ("error" in r) {
                    toast.error(r.error);
                    return;
                  }
                  setProposal(r);
                  setBaseUrl(r.api.baseUrl ?? "");
                  setRows(r.proposals.map((p) => ({ ...p, priceUsd: toUsd(p.priceMicros) })));
                })
              }
            >
              <Sparkles /> {pending ? "Reading your API…" : "Propose prices"}
            </Button>
            <Label className="text-sm font-normal text-muted-foreground">
              or load a file
              <Input
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml"
                className="w-56"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setSpec(await f.text());
                }}
              />
            </Label>
          </div>
        </CardContent>
      </Card>
    );
  }

  const charged = rows.filter((r) => r.charge);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {proposal.api.title}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            OpenAPI {proposal.api.version} · proposed by {proposal.model}
          </span>
        </CardTitle>
        <CardDescription>
          Check each route. Nothing is charged until you confirm; you can change prices any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid max-w-xl gap-2">
          <Label htmlFor="base-url">Public base URL of your API</Label>
          <Input
            id="base-url"
            value={baseUrl}
            placeholder="https://api.example.com"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Charge</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Price per call (USD)</TableHead>
                <TableHead>Description for agents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const c = cat(r.category);
                const micros = Math.round(Number(r.priceUsd) * 1e6);
                const outside = c && r.charge && (micros < c.minMicros || micros > c.maxMicros);
                return (
                  <TableRow key={r.key} className={r.charge ? undefined : "opacity-60"}>
                    <TableCell>
                      <Switch
                        checked={r.charge}
                        onCheckedChange={(v) => update(r.key, { charge: v })}
                        aria-label={`Charge for ${r.key}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs" title={r.rationale}>
                      <span className="font-semibold">{r.method}</span> {r.path}
                      <div className="max-w-64 font-sans whitespace-normal text-muted-foreground">
                        {r.rationale}
                      </div>
                    </TableCell>
                    <TableCell>
                      <select
                        aria-label={`Category for ${r.key}`}
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                        value={r.category}
                        disabled={!r.charge}
                        onChange={(e) => {
                          const next = cat(e.target.value);
                          if (next)
                            update(r.key, {
                              category: next.id as Row["category"],
                              pricing: next.pricing,
                              rangeMicros: [next.minMicros, next.maxMicros],
                            });
                        }}
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {r.pricing === "metered" && <span className="text-xs">up to</span>}
                        <Input
                          aria-label={`Price for ${r.key}`}
                          className="w-28 tabular-nums"
                          inputMode="decimal"
                          value={r.priceUsd}
                          disabled={!r.charge}
                          onChange={(e) => update(r.key, { priceUsd: e.target.value })}
                        />
                      </div>
                      {c && (
                        <div
                          className={
                            outside ? "text-xs text-amber-600" : "text-xs text-muted-foreground"
                          }
                        >
                          usual {fmt(c.minMicros)}–{fmt(c.maxMicros)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label={`Description for ${r.key}`}
                        className="min-w-56"
                        value={r.description}
                        maxLength={200}
                        disabled={!r.charge}
                        onChange={(e) => update(r.key, { description: e.target.value })}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending || charged.length === 0 || !baseUrl}
            onClick={() =>
              start(async () => {
                const r = await confirm({
                  aiDecisionId: proposal.aiDecisionId,
                  baseUrl,
                  routes: charged.map((x) => ({
                    method: x.method as "GET",
                    path: x.path,
                    pricing: x.pricing,
                    priceMicros: Math.round(Number(x.priceUsd) * 1e6),
                    description: x.description,
                    category: x.category,
                  })),
                });
                if ("error" in r) toast.error(r.error);
                else setDone(r);
              })
            }
          >
            Confirm {charged.length} {charged.length === 1 ? "route" : "routes"}
          </Button>
          <Button variant="ghost" onClick={() => setProposal(null)} disabled={pending}>
            Start over
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
