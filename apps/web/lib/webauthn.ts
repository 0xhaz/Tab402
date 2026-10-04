import "server-only";
import { randomUUID } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { schema as s } from "@tab402/db";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./server";

/**
 * Step-up WebAuthn for one action (approving a purchase). Unlike a passkey sign-in, the challenge
 * is bound to the action and the user, and user verification (Face ID / fingerprint / PIN) is
 * required. Verifies against the passkeys Better Auth stored for this user.
 */
const web = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
const CHALLENGE_TTL_MS = 5 * 60_000;

export async function startStepUp(
  userId: string,
  action: string,
): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const keys = await db.select().from(s.passkey).where(eq(s.passkey.userId, userId));
  if (keys.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: web.hostname,
    userVerification: "required",
    allowCredentials: keys.map((k) => ({
      id: k.credentialID,
      transports: k.transports?.split(",") as never,
    })),
  });
  const identifier = `tab402-stepup:${userId}:${action}`;
  await db.delete(s.verification).where(eq(s.verification.identifier, identifier));
  await db.insert(s.verification).values({
    id: randomUUID(),
    identifier,
    value: options.challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return options;
}

/** One-time: the stored challenge is consumed whether or not verification succeeds. */
export async function finishStepUp(
  userId: string,
  action: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const identifier = `tab402-stepup:${userId}:${action}`;
  const [challenge] = await db
    .delete(s.verification)
    .where(and(eq(s.verification.identifier, identifier), gt(s.verification.expiresAt, new Date())))
    .returning({ value: s.verification.value });
  if (!challenge) return false;
  const [key] = await db
    .select()
    .from(s.passkey)
    .where(and(eq(s.passkey.userId, userId), eq(s.passkey.credentialID, response.id)));
  if (!key) return false;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.value,
      expectedOrigin: web.origin,
      expectedRPID: web.hostname,
      requireUserVerification: true,
      credential: {
        id: key.credentialID,
        publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64")),
        counter: key.counter,
      },
    });
    if (!result.verified) return false;
    await db
      .update(s.passkey)
      .set({ counter: result.authenticationInfo.newCounter })
      .where(eq(s.passkey.id, key.id));
    return true;
  } catch {
    return false;
  }
}
