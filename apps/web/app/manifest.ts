import type { MetadataRoute } from "next";

/** Installable PWA: dashboard, approvals and push on a phone's home screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Tab402 — agent wallet",
    short_name: "Tab402",
    description: "Approve what your AI agents buy, see receipts, and get paid for your APIs.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fbfcfd",
    theme_color: "#245fd4",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Approvals",
        url: "/approvals",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Receipts",
        url: "/receipts",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
