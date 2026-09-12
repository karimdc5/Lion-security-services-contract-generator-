import { randomBytes } from "node:crypto";

// Crockford-ish base32 without look-alikes (no i, l, o, u, 0, 1).
const ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";

/**
 * A public invoice id. It appears in a URL anyone with the link can open, so
 * it must be unguessable: ~73 bits of entropy at 15 characters.
 */
export function publicInvoiceId(length = 15): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Stable key handed to the provider so a retried create is not a second charge. */
export function idempotencyKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts].join(":");
}
