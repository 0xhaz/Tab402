import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      <section className="flex flex-col justify-center gap-8 px-4 py-12 sm:px-12">
        <div className="flex w-full max-w-sm items-center justify-between">
          <Brand className="text-lg" />
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </section>
      <aside className="hidden flex-col justify-center gap-6 bg-primary/5 p-12 lg:flex">
        <p className="max-w-md text-3xl font-semibold leading-tight tracking-tight">
          One agent wallet, any paid API.
        </p>
        <p className="max-w-md text-muted-foreground">
          Your agents pay per call on a running tab. Tab402 settles it in one PayPal charge, within
          the budget and rules you set.
        </p>
      </aside>
    </main>
  );
}
