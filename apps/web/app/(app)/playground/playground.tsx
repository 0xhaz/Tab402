"use client";

import {
  CircleCheck,
  CircleX,
  ExternalLink,
  Hourglass,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useId, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ToolInfo, ToolRun } from "@/lib/mcp";
import { cn } from "@/lib/utils";
import { callTool, listTools, setAskFirst } from "./actions";

type Args = Record<string, unknown>;
type Run = ToolRun & { id: number; label: string };
type Connection =
  | { state: "checking" }
  | { state: "online"; tools: ToolInfo[] }
  | { state: "offline"; error: string };

const NOTE = "Tab402 lets agents pay per call. Tabs settle in one PayPal charge.";

const needsApproval = (r: ToolRun) => r.text.startsWith("Needs the buyer's approval");
const linkIn = (text: string) => text.match(/https?:\/\/\S+\/approve\/[A-Za-z0-9_]+/)?.[0] ?? null;

function pretty(text: string) {
  try {
    const value = JSON.parse(text) as unknown;
    // call_paid returns the seller's response body as a string; show it as JSON too.
    if (value && typeof value === "object" && "body" in value && typeof value.body === "string") {
      try {
        (value as { body: unknown }).body = JSON.parse(value.body);
      } catch {}
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return text;
  }
}

function RunCard({ run, onRetry, busy }: { run: Run; onRetry: () => void; busy: boolean }) {
  const approval = needsApproval(run);
  const link = approval ? linkIn(run.text) : null;
  const Icon = approval ? Hourglass : run.isError ? CircleX : CircleCheck;
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4 animate-in fade-in slide-in-from-top-1",
        approval && "border-earned/50 bg-earned/5",
        run.isError && !approval && "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          aria-hidden
          className={cn(
            "size-4",
            approval ? "text-earned" : run.isError ? "text-destructive" : "text-paid-out",
          )}
        />
        <span className="font-medium">{run.label}</span>
        <Badge variant="secondary" className="font-mono">
          {run.tool}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{run.ms} ms</span>
      </div>
      {Object.keys(run.args).length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Arguments</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3">
            {JSON.stringify(run.args, null, 2)}
          </pre>
        </details>
      )}
      <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">
        {pretty(run.text)}
      </pre>
      {approval && (
        <div className="flex flex-wrap items-center gap-2">
          {link && (
            <Button asChild size="sm">
              <a href={link} target="_blank" rel="noreferrer">
                Open approval page <ExternalLink />
              </a>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
            <RotateCw /> Run again after approving
          </Button>
        </div>
      )}
    </article>
  );
}

export function Playground({
  mcpUrl,
  summarizeUrl: defaultSummarizeUrl,
  chatUrl,
  askFirst: initialAskFirst,
}: {
  mcpUrl: string;
  summarizeUrl: string | null;
  chatUrl: string | null;
  askFirst: boolean;
}) {
  const ids = { agent: useId(), note: useId(), tool: useId(), args: useId(), ask: useId() };
  const [agent, setAgent] = useState("Playground");
  const [connection, setConnection] = useState<Connection>({ state: "checking" });
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState(NOTE);
  const [subBudget, setSubBudget] = useState<string | null>(null);
  const [askFirst, setAskFirstState] = useState(initialAskFirst);
  const [savingPolicy, startPolicy] = useTransition();
  const [customTool, setCustomTool] = useState("get_budget");
  const [customArgs, setCustomArgs] = useState("{}");
  // Like an agent: once search finds a summarizer, the summarize steps use that result.
  const [summarizeUrl, setSummarizeUrl] = useState(defaultSummarizeUrl);

  const connect = useCallback(async () => {
    setConnection({ state: "checking" });
    const res = await listTools(agent);
    setConnection(
      res.ok ? { state: "online", tools: res.tools } : { state: "offline", error: res.error },
    );
  }, [agent]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: connect once on load; the agent name is applied by Reconnect
  useEffect(() => {
    void connect();
  }, []);

  async function run(label: string, tool: string, args: Args) {
    setBusy(label);
    try {
      const result = await callTool(agent, tool, args);
      if (tool === "search_services" && !result.isError) {
        try {
          const first = (JSON.parse(result.text) as { url?: string }[])[0]?.url;
          if (first) setSummarizeUrl(first);
        } catch {}
      }
      if (tool === "create_sub_budget" && !result.isError) {
        try {
          setSubBudget((JSON.parse(result.text) as { sub_budget?: string }).sub_budget ?? null);
        } catch {}
      }
      setRuns((rs) => [{ ...result, id: Date.now(), label }, ...rs]);
    } finally {
      setBusy(null);
    }
  }

  const summarize = (intent = "summarize a note for the user", extra: Args = {}) =>
    summarizeUrl ? { url: summarizeUrl, body: { text: note }, intent, ...extra } : null;

  const examples: Record<string, Args> = {
    search_services: { query: "summarize text" },
    call_paid: summarize() ?? { url: "", intent: "" },
    get_budget: {},
    get_tab: {},
    list_receipts: { period: "today" },
    create_sub_budget: { amount: "0.02", expires_in_minutes: 10 },
    request_approval: {
      url: summarizeUrl ?? "",
      amount: "0.05",
      reason: "summarize a long report",
    },
  };

  const steps: { label: string; hint: string; tool: string; args: Args | null }[] = [
    {
      label: "Check my budget",
      hint: "Daily budget and what's left",
      tool: "get_budget",
      args: {},
    },
    {
      label: "Find a summarizer",
      hint: "Search the directory",
      tool: "search_services",
      args: { query: "summarize text" },
    },
    {
      label: "Summarize the note",
      hint: summarizeUrl
        ? `Pays $0.01 · ${summarizeUrl.replace(/^https?:\/\//, "")}`
        : "No summarizer found",
      tool: "call_paid",
      args: summarize(),
    },
    {
      label: "Chat (metered)",
      hint: "Charged the real cost, up to $0.05",
      tool: "call_paid",
      args: chatUrl
        ? { url: chatUrl, body: { message: "Say hi in five words." }, intent: "say hi to the user" }
        : null,
    },
    {
      label: "Make a $0.02 sub-budget",
      hint: "For 10 minutes",
      tool: "create_sub_budget",
      args: { amount: "0.02", expires_in_minutes: 10 },
    },
    {
      label: "Summarize with the sub-budget",
      hint: subBudget ? "Refused once the $0.02 cap is used" : "Make a sub-budget first",
      tool: "call_paid",
      args: subBudget
        ? summarize("summarize a note for the helper", { sub_budget: subBudget })
        : null,
    },
    {
      label: "Off-purpose purchase",
      hint: "The spend guard checks the intent",
      tool: "call_paid",
      args: summarize("book me a flight to Paris"),
    },
    { label: "Show my tab", hint: "What's owed per seller", tool: "get_tab", args: {} },
    {
      label: "List receipts",
      hint: "Today's paid calls",
      tool: "list_receipts",
      args: { period: "today" },
    },
  ];

  function runCustom() {
    let args: Args;
    try {
      args = JSON.parse(customArgs || "{}") as Args;
    } catch {
      setRuns((rs) => [
        {
          id: Date.now(),
          label: "Run a tool",
          tool: customTool,
          args: {},
          text: "Arguments must be valid JSON.",
          isError: true,
          ms: 0,
        },
        ...rs,
      ]);
      return;
    }
    void run("Run a tool", customTool, args);
  }

  const online = connection.state === "online";
  const tools = online ? connection.tools : [];

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-2.5 rounded-full",
                  connection.state === "online" && "bg-paid-out",
                  connection.state === "offline" && "bg-destructive",
                  connection.state === "checking" && "animate-pulse bg-muted-foreground",
                )}
              />
              {connection.state === "online"
                ? `Connected · ${tools.length} tools`
                : connection.state === "offline"
                  ? "MCP server offline"
                  : "Connecting…"}
            </CardTitle>
            <CardDescription className="font-mono text-xs">{mcpUrl}</CardDescription>
          </div>
          <div className="flex items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.agent} className="text-xs">
                Agent name
              </Label>
              <Input
                id={ids.agent}
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="h-8 w-40"
              />
            </div>
            <Button size="sm" variant="outline" onClick={() => void connect()}>
              <RefreshCw /> Reconnect
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {connection.state === "offline" && (
            <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {connection.error}
            </p>
          )}
          {online && (
            <div className="flex flex-wrap gap-1.5">
              {tools.map((t) => (
                <Badge key={t.name} variant="outline" className="font-mono" title={t.description}>
                  {t.name}
                </Badge>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Calls show up under Agents & keys as "{agent.trim() || "Playground"}", with their own
            key and receipts.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Demo steps</CardTitle>
              <CardDescription>Each button makes one MCP tool call.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="grid gap-0.5">
                  <Label htmlFor={ids.ask}>Ask me before every purchase</Label>
                  <span className="text-xs text-muted-foreground">
                    {askFirst
                      ? "Approval threshold $0.005: even a 1¢ call needs your OK"
                      : "Approval threshold $2.00"}
                  </span>
                </div>
                <Switch
                  id={ids.ask}
                  checked={askFirst}
                  disabled={savingPolicy}
                  onCheckedChange={(on) => {
                    setAskFirstState(on);
                    startPolicy(() => setAskFirst(on));
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={ids.note}>Text to summarize</Label>
                <Textarea
                  id={ids.note}
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <ol className="flex flex-col gap-2">
                {steps.map((step, i) => (
                  <li key={step.label}>
                    <button
                      type="button"
                      disabled={!online || !step.args || busy !== null}
                      onClick={() => step.args && void run(step.label, step.tool, step.args)}
                      className="group flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-50"
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums">
                        {i + 1}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium">{step.label}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          <code>{step.tool}</code> · {step.hint}
                        </span>
                      </span>
                      {busy === step.label ? (
                        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
                      ) : (
                        <Play
                          className="size-4 text-muted-foreground group-hover:text-primary"
                          aria-hidden
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Run any tool</CardTitle>
              <CardDescription>Pick a tool and edit its arguments.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor={ids.tool}>Tool</Label>
                <select
                  id={ids.tool}
                  value={customTool}
                  onChange={(e) => {
                    setCustomTool(e.target.value);
                    setCustomArgs(JSON.stringify(examples[e.target.value] ?? {}, null, 2));
                  }}
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                >
                  {(tools.length ? tools.map((t) => t.name) : Object.keys(examples)).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {tools.find((t) => t.name === customTool)?.description}
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={ids.args}>Arguments (JSON)</Label>
                <Textarea
                  id={ids.args}
                  rows={6}
                  value={customArgs}
                  onChange={(e) => setCustomArgs(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <Button onClick={runCustom} disabled={!online || busy !== null} className="w-fit">
                {busy === "Run a tool" ? <Loader2 className="animate-spin" /> : <Play />} Run
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0">
          <CardHeader className="flex items-center justify-between">
            <div className="grid gap-1.5">
              <CardTitle>Activity</CardTitle>
              <CardDescription>Newest first. Approvals also arrive as a push.</CardDescription>
            </div>
            {runs.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setRuns([])}>
                Clear
              </Button>
            )}
          </CardHeader>
          <CardContent aria-live="polite" className="flex flex-col gap-3">
            {runs.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Run a step to see the tool call and its result here.
              </p>
            )}
            {runs.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                busy={busy !== null}
                onRetry={() => void run(r.label, r.tool, r.args)}
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
