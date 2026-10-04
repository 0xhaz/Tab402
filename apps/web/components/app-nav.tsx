"use client";

import { authClient } from "@tab402/auth/client";
import {
  BadgeCheck,
  Bot,
  ChartArea,
  ChartColumn,
  CircleDollarSign,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  Search,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/analytics", label: "Analytics", icon: ChartArea },
  { href: "/approvals", label: "Approvals", icon: BadgeCheck, badge: "approvals" as const },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/policy", label: "Spending policy", icon: ShieldCheck },
  { href: "/agents", label: "Agents & keys", icon: Bot },
  { href: "/receipts", label: "Receipts", icon: Receipt },
  { href: "/directory", label: "Directory", icon: Search },
  { href: "/selling", label: "Selling", icon: CircleDollarSign },
  { href: "/selling/analytics", label: "Seller analytics", icon: ChartColumn },
  { href: "/security", label: "Security & alerts", icon: KeyRound },
];

function Links({ pending, onNavigate }: { pending: number; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon, badge }) => {
        // Most specific match wins (so /selling/analytics doesn't also light up /selling).
        const matches = NAV.filter((n) =>
          n.href === "/"
            ? pathname === "/"
            : pathname === n.href || pathname.startsWith(`${n.href}/`),
        );
        const active =
          matches.length > 0 &&
          matches.reduce((a, b) => (b.href.length > a.href.length ? b : a)).href === href;
        return (
          <Link
            key={href}
            href={href as never}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground",
              active && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
            )}
          >
            <Icon className="size-4" />
            {label}
            {badge && pending > 0 && <Badge className="ml-auto h-5 px-1.5">{pending}</Badge>}
          </Link>
        );
      })}
    </nav>
  );
}

function SignOut({ email }: { email: string }) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-2 border-t pt-4 text-sm">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{email}</span>
      <ThemeToggle />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        onClick={async () => {
          await authClient.signOut();
          router.replace("/sign-in");
        }}
      >
        <LogOut />
      </Button>
    </div>
  );
}

export function Sidebar({ email, pending }: { email: string; pending: number }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-8 border-r bg-sidebar px-4 py-6 md:flex">
      <Brand className="px-3" />
      <div className="flex-1">
        <Links pending={pending} />
      </div>
      <SignOut email={email} />
    </aside>
  );
}

export function MobileNav({ email, pending }: { email: string; pending: number }) {
  return (
    <header className="flex items-center justify-between border-b px-4 py-3 md:hidden">
      <Brand />
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Menu">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="flex flex-col gap-6 p-4">
          <SheetTitle>
            <Brand />
          </SheetTitle>
          <div className="flex-1">
            <Links pending={pending} />
          </div>
          <SignOut email={email} />
        </SheetContent>
      </Sheet>
    </header>
  );
}
