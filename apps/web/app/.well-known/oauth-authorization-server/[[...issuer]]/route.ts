import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/server";

/**
 * RFC 8414 discovery at the root. The issuer is `<web>/api/auth`, so clients look for
 * `/.well-known/oauth-authorization-server/api/auth`; the bare path is served too.
 */
export const GET = (req: Request) => oauthProviderAuthServerMetadata(getAuth())(req);
