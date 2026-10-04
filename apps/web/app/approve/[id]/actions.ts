"use server";

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { decideApproval } from "@tab402/guard";
import { revalidatePath } from "next/cache";
import { db, requireBuyer } from "@/lib/server";
import { finishStepUp, startStepUp } from "@/lib/webauthn";

export async function beginApprove(
  approvalId: string,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON } | { error: "no_passkey" }> {
  const { user } = await requireBuyer(`/approve/${approvalId}`);
  const options = await startStepUp(user.id, `approve:${approvalId}`);
  return options ? { options } : { error: "no_passkey" };
}

export async function finishApprove(approvalId: string, response: AuthenticationResponseJSON) {
  const { user, buyer } = await requireBuyer(`/approve/${approvalId}`);
  if (!(await finishStepUp(user.id, `approve:${approvalId}`, response)))
    return { error: "Passkey check failed — try again." };
  const result = await decideApproval({ db }, approvalId, buyer.id, true);
  revalidatePath("/approvals");
  return result === "approved"
    ? { ok: true }
    : {
        error:
          result === "expired" ? "This request expired." : "This request is no longer pending.",
      };
}

/** Declining needs no passkey: it can only stop money moving. */
export async function decline(approvalId: string) {
  const { buyer } = await requireBuyer(`/approve/${approvalId}`);
  const result = await decideApproval({ db }, approvalId, buyer.id, false);
  revalidatePath("/approvals");
  return result === "denied" ? { ok: true } : { error: "This request is no longer pending." };
}
