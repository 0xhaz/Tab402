/**
 * Generate a VAPID key pair for Web Push and print the .env lines.
 *   npx tsx scripts/vapid.ts            # print
 *   npx tsx scripts/vapid.ts >> .env    # append (only if .env has no VAPID_ keys yet)
 * Rotating keys invalidates every existing push subscription.
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`
# Web Push (VAPID) — generated ${new Date().toISOString().slice(0, 10)}
VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:ops@tab402.dev`);
