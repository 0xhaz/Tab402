"use client";

import { SerwistProvider } from "@serwist/turbopack/react";

/** Registers the service worker in production builds (dev keeps Turbopack HMR simple). */
export function Pwa({ children }: { children: React.ReactNode }) {
  return (
    <SerwistProvider swUrl="/serwist/sw.js" disable={process.env.NODE_ENV === "development"}>
      {children}
    </SerwistProvider>
  );
}
