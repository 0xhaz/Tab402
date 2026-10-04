import { TAB_SCHEME } from "./scheme";

/**
 * `/.well-known/x402` manifests (draft-hawkins-x402-dns-discovery-01). Not part of the x402 spec,
 * so a convenience only — the Tab402 directory is the primary discovery path.
 * Unknown fields must be ignored by consumers, so prices ride along under `tab402`.
 */
export interface ManifestResource {
  url: string;
  method: string;
  description: string;
  tab402?: {
    scheme: typeof TAB_SCHEME;
    network: string;
    asset: "USD";
    pricing: "fixed" | "metered";
    /** Micro-USD: price (fixed) or maximum authorization (metered). */
    amount: string;
    category: string | null;
  };
}

export interface ResourceServerManifest {
  x402Version: 2;
  kind: "resource-server";
  name: string;
  description?: string;
  resources: ManifestResource[];
  docs?: string;
  updated: string;
}

export interface FacilitatorManifest {
  x402Version: 2;
  kind: "facilitator";
  name: string;
  description: string;
  facilitator: {
    baseUrl: string;
    endpoints: { supported: string; verify: string; settle: string };
    kinds: { x402Version: 2; scheme: string; network: string }[];
  };
  docs: string;
  updated: string;
}

export function resourceServerManifest(input: {
  name: string;
  description?: string;
  network: string;
  docs?: string;
  updated?: Date;
  endpoints: {
    url: string;
    method: string;
    description: string | null;
    category: string | null;
    pricing: "fixed" | "metered";
    priceMicros: number;
  }[];
}): ResourceServerManifest {
  return {
    x402Version: 2,
    kind: "resource-server",
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    resources: input.endpoints.map((e) => ({
      url: e.url,
      method: e.method,
      description: e.description ?? `${e.method} ${new URL(e.url).pathname}`,
      tab402: {
        scheme: TAB_SCHEME,
        network: input.network,
        asset: "USD",
        pricing: e.pricing,
        amount: String(e.priceMicros),
        category: e.category,
      },
    })),
    ...(input.docs ? { docs: input.docs } : {}),
    updated: (input.updated ?? new Date()).toISOString(),
  };
}

export function facilitatorManifest(input: {
  baseUrl: string;
  networks: string[];
  docs: string;
}): FacilitatorManifest {
  return {
    x402Version: 2,
    kind: "facilitator",
    name: "Tab402",
    description:
      "x402 facilitator for fiat tabs: signed cumulative vouchers, settled through PayPal.",
    facilitator: {
      baseUrl: input.baseUrl,
      endpoints: { supported: "/supported", verify: "/verify", settle: "/settle" },
      kinds: input.networks.map((network) => ({ x402Version: 2, scheme: TAB_SCHEME, network })),
    },
    docs: input.docs,
    updated: new Date().toISOString(),
  };
}
