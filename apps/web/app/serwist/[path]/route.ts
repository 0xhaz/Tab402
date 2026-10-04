import { randomUUID } from "node:crypto";
import { createSerwistRoute } from "@serwist/turbopack";

// Built once per `next build` (force-static): the revision changes every build.
const revision = randomUUID();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute(
  {
    swSrc: "app/sw.ts",
    useNativeEsbuild: true,
    additionalPrecacheEntries: [{ url: "/~offline", revision }],
  },
);
