import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/server";

export const GET = (req: Request) => oauthProviderOpenIdConfigMetadata(getAuth())(req);
