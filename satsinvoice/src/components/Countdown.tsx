"use client";

import { useEffect, useState } from "react";

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Counts down to `expiresAt`. When it hits zero it refreshes the page once, so
 * the server re-evaluates the invoice rather than the client guessing.
 */
export function Countdown({
  expiresAt,
  onExpiredRefresh = true,
}: {
  expiresAt: string;
  onExpiredRefresh?: boolean;
}) {
  const target = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => target - Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      const next = target - Date.now();
      setRemaining(next);
      if (next <= 0) {
        clearInterval(id);
        if (onExpiredRefresh) window.location.reload();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [target, onExpiredRefresh]);

  if (remaining <= 0) return <span className="tnum">expired</span>;
  return (
    <span className="tnum" suppressHydrationWarning>
      {format(remaining)}
    </span>
  );
}
