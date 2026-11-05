import {
  ArrowRight,
  BadgeCheck,
  Bell,
  Bot,
  Fingerprint,
  Gauge,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { FlowDiagram } from "@/components/landing/flow-diagram";
import { PaymentCompare } from "@/components/landing/payment-compare";
import { PayPalProducts } from "@/components/landing/paypal-products";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/server";

export const metadata: Metadata = {
  title: { absolute: "Tab402: pay-per-call for AI agents, settled on PayPal" },
  description:
    "AI agents pay for APIs by the cent over HTTP 402. Tab402 keeps a tab, settles it in one PayPal charge and pays sellers with PayPal Payouts.",
};

/** Real numbers from the PayPal sandbox run. */
const CALLS = 300;
const PER_CALL_FEE = 0.49 + 0.0349 * 0.01; // PayPal fixed + percentage fee on one $0.01 charge
const usd = (n: number) => `$${n.toFixed(2)}`;

function Feature({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Bot;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex gap-3 rounded-xl border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="flex flex-col gap-0.5">
        <h3 className="font-semibold leading-tight">{title}</h3>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

/** The tab a buyer actually saw in sandbox: 300 one-cent calls, one PayPal charge. */
function TabReceipt() {
  return (
    <section
      className="w-full max-w-sm rounded-2xl border bg-card p-5 shadow-lg"
      aria-label="Example tab"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Claude Code · this week</span>
        <span className="rounded-full bg-earned/15 px-2 py-0.5 text-xs text-earned">tab</span>
      </div>
      <ul className="mt-4 flex flex-col gap-2 font-mono text-xs">
        {[
          ["/v1/summarize", "$0.01"],
          ["/v1/summarize", "$0.01"],
          ["/v1/summarize", "$0.01"],
        ].map(([path, price], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static illustration
          <li key={i} className="flex justify-between text-muted-foreground">
            <span>POST {path}</span>
            <span>{price}</span>
          </li>
        ))}
        <li className="text-center text-muted-foreground">⋯ {CALLS - 3} more calls</li>
      </ul>
      <div className="mt-4 flex flex-col gap-2 border-t pt-4 text-sm">
        <div className="flex justify-between">
          <span>One PayPal charge</span>
          <span className="font-semibold tabular-nums">$3.00</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>PayPal fee</span>
          <span className="tabular-nums">$0.59</span>
        </div>
        <div className="flex justify-between text-muted-foreground line-through decoration-destructive/60">
          <span>{CALLS} separate charges</span>
          <span className="tabular-nums">{usd(CALLS * PER_CALL_FEE)} in fees</span>
        </div>
        <div className="mt-1 flex justify-between rounded-lg bg-paid-out/10 px-3 py-2 text-paid-out">
          <span>Paid out to the seller</span>
          <span className="font-semibold tabular-nums">$2.35</span>
        </div>
      </div>
    </section>
  );
}

export default async function WelcomePage() {
  const session = await getSession().catch(() => null);
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 sm:px-6">
          <Link href="/welcome" aria-label="Tab402 home">
            <Brand />
          </Link>
          <div className="ml-auto hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#how" className="hover:text-foreground">
              How it works
            </a>
            <a href="#compare" className="hover:text-foreground">
              Why a tab
            </a>
            <a href="#paypal" className="hover:text-foreground">
              PayPal products
            </a>
            <Link href="/directory" className="hover:text-foreground">
              Directory
            </Link>
          </div>
          <ThemeToggle className="ml-auto md:ml-0" />
          {session ? (
            <Button asChild size="sm">
              <Link href="/">Open dashboard</Link>
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button asChild size="sm" variant="ghost">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/sign-up">Get started</Link>
              </Button>
            </div>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:py-24">
          <div className="flex flex-col gap-6">
            <span className="w-fit rounded-full border border-[#0070e0]/30 bg-[#0070e0]/5 px-3 py-1 text-xs font-medium text-[#003087] dark:text-[#7fb6ff]">
              Built on PayPal · x402-compatible
            </span>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Let AI agents pay for APIs by the cent, settled on PayPal.
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground text-pretty">
              Each call goes on a tab. PayPal charges the buyer once for hundreds of calls and pays
              the seller out.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href={session ? "/wallet" : "/sign-up"}>
                  Connect your PayPal wallet <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href={session ? "/selling" : "/sign-up?callbackURL=%2Fselling"}>
                  Sell your API
                </Link>
              </Button>
            </div>
          </div>
          <div className="flex justify-center lg:justify-end">
            <TabReceipt />
          </div>
        </section>

        <section id="compare" className="border-y bg-muted/30">
          <div className="mx-auto flex max-w-6xl scroll-mt-20 flex-col gap-8 px-4 py-20 sm:px-6">
            <div className="flex max-w-2xl flex-col gap-3">
              <h2 className="text-3xl font-semibold tracking-tight">Why a tab?</h2>
              <p className="text-muted-foreground">
                A PayPal charge costs at least $0.49, which is 49 times a one-cent API call. Drag
                the slider to compare.
              </p>
            </div>
            <PaymentCompare />
          </div>
        </section>

        <section
          id="how"
          className="mx-auto flex max-w-6xl scroll-mt-20 flex-col gap-8 px-4 py-20 sm:px-6"
        >
          <div className="flex max-w-2xl flex-col gap-3">
            <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
            <p className="text-muted-foreground">
              Each arrow is labeled with the PayPal API it uses. PayPal only moves money in step 3.
            </p>
          </div>
          <FlowDiagram />
        </section>

        <section id="paypal" className="border-t bg-muted/20">
          <div className="mx-auto flex max-w-6xl scroll-mt-20 flex-col gap-8 px-4 py-20 sm:px-6">
            <div className="flex max-w-2xl flex-col gap-3">
              <h2 className="text-3xl font-semibold tracking-tight">PayPal products in Tab402</h2>
              <p className="text-muted-foreground">
                Every product plugs into the same funding or payout adapter. Hover or tap one for
                details.
              </p>
            </div>
            <PayPalProducts />
          </div>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-20 sm:px-6">
          <h2 className="text-3xl font-semibold tracking-tight">Other features</h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Feature icon={ShieldCheck} title="Spend guard">
              Budgets and caps checked on every call. Claude Haiku reviews borderline buys.
            </Feature>
            <Feature icon={Fingerprint} title="Passkey approval">
              Purchases over your limit wait for Face ID or Touch ID.
            </Feature>
            <Feature icon={Bell} title="Push and email alerts">
              Approval requests reach your phone or inbox. Decline right from the email.
            </Feature>
            <Feature icon={Bot} title="Works in Claude">
              Add one MCP URL and sign in with OAuth.
            </Feature>
            <Feature icon={Sparkles} title="OpenAPI onboarding">
              Paste a spec and Claude suggests a price per route.
            </Feature>
            <Feature icon={Gauge} title="Revenue analytics">
              Ask the dashboard why revenue dropped on Tuesday.
            </Feature>
          </div>
        </section>

        <section className="border-t">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-col gap-2">
              <h2 className="text-2xl font-semibold tracking-tight">
                Your agents already speak 402. Let them pay with PayPal.
              </h2>
              <p className="text-muted-foreground">
                Runs on the PayPal sandbox. Use a sandbox account to try it.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href={session ? "/" : "/sign-up"}>
                  {session ? "Open dashboard" : "Get started"} <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/directory">Browse paid APIs</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <Brand />
          <span className="flex items-center gap-1">
            <BadgeCheck className="size-4" aria-hidden /> Built for the PayPal developer hackathon
          </span>
          <span className="sm:ml-auto">
            PayPal and Venmo are trademarks of PayPal, Inc. Tab402 is an independent project.
          </span>
        </div>
      </footer>
    </div>
  );
}
