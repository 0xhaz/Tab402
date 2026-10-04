import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/server";

// Resolved per request so importing this route (e.g. during build) doesn't start Better Auth.
export const GET = (req: Request) => toNextJsHandler(getAuth()).GET(req);
export const POST = (req: Request) => toNextJsHandler(getAuth()).POST(req);
