"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Polls the invoice status while the client has the page open and refreshes
 * the server component when anything changes. Quiet by design: no spinner, no
 * "waiting for confirmations" jargon.
 */
export function PayStatusPoller({
  publicId,
  currentStatus,
  intervalMs = 4000,
}: {
  publicId: string;
  currentStatus: string;
  intervalMs?: number;
}) {
  const router = useRouter();
  const seen = useRef(currentStatus);

  useEffect(() => {
    seen.current = currentStatus;
  }, [currentStatus]);

  useEffect(() => {
    let stopped = false;

    const id = setInterval(async () => {
      if (stopped || document.hidden) return;
      try {
        const response = await fetch(`/api/p/${publicId}/status`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { status: string };
        if (data.status !== seen.current) {
          seen.current = data.status;
          router.refresh();
        }
      } catch {
        // Offline or a blip. Keep polling; nothing here is load-bearing.
      }
    }, intervalMs);

    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [publicId, intervalMs, router]);

  return null;
}
