"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * A date in the viewer's locale and time zone. The server (UTC, en-US on Render) and the browser
 * would format it differently, which breaks hydration, so the first render uses a fixed UTC format
 * and the browser switches to its own once hydrated.
 */
export function LocalDate({ iso, time = false }: { iso: string; time?: boolean }) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const d = new Date(iso);
  const text = hydrated
    ? time
      ? d.toLocaleString()
      : d.toLocaleDateString()
    : d.toLocaleString("en-US", {
        timeZone: "UTC",
        dateStyle: "medium",
        ...(time ? { timeStyle: "short" } : {}),
      });
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
