import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/** Browser auth client for the web app (same origin as /api/auth). */
export const authClient = createAuthClient({ plugins: [passkeyClient(), oauthProviderClient()] });
