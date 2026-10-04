import { schema as s } from "@tab402/db";
import { and, count, eq, gt } from "drizzle-orm";
import { MobileNav, Sidebar } from "@/components/app-nav";
import { db, requireBuyer } from "@/lib/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, buyer } = await requireBuyer();
  const [pending] = await db
    .select({ n: count() })
    .from(s.approvals)
    .where(
      and(
        eq(s.approvals.buyerId, buyer.id),
        eq(s.approvals.status, "pending"),
        gt(s.approvals.expiresAt, new Date()),
      ),
    );
  return (
    <div className="flex min-h-dvh">
      <Sidebar email={user.email} pending={pending?.n ?? 0} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav email={user.email} pending={pending?.n ?? 0} />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
