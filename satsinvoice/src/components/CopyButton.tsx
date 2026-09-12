"use client";

import { useState } from "react";

export function CopyButton({
  value,
  label = "Copy",
  className = "btn-secondary",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API needs a secure context; fall back to a selection prompt.
      window.prompt("Copy this:", value);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button type="button" onClick={copy} className={className} aria-live="polite">
      {copied ? "Copied" : label}
    </button>
  );
}
