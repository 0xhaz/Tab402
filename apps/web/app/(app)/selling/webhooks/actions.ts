"use server";

import { schema as s } from "@tab402/db";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, requireBuyer, sellerFor } from "@/lib/server";

/** Queue an event for redelivery on the worker's next pass (every minute). */
export async function retryDelivery(eventId: string) {
  const { user } = await requireBuyer("/selling/webhooks");
  const seller = await sellerFor(user.id);
  if (!seller) return { error: "Not a seller." };
  const updated = await db
    .update(s.eventsOut)
    .set({ deliveryStatus: "pending", nextAttemptAt: new Date(), lastError: null })
    .where(
      and(
        eq(s.eventsOut.id, eventId),
        eq(s.eventsOut.sellerId, seller.id),
        ne(s.eventsOut.deliveryStatus, "delivered"),
      ),
    )
    .returning({ id: s.eventsOut.id });
  if (updated.length === 0) return { error: "Nothing to retry." };
  revalidatePath("/selling/webhooks");
  return { ok: true };
}
