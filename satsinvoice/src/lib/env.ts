/** Typed, validated access to the environment. Fails loudly at first use. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  /** Public origin, no trailing slash. */
  get appUrl() {
    return optional("APP_URL", "http://localhost:3000").replace(/\/+$/, "");
  },
  get authSecret() {
    return required("AUTH_SECRET");
  },
  get paymentProvider() {
    return optional("PAYMENT_PROVIDER", "mock");
  },
  get mockBtcUsdRate() {
    return Number(optional("MOCK_BTC_USD_RATE", "65000"));
  },
  get mockWebhookSecret() {
    return optional("MOCK_WEBHOOK_SECRET");
  },
  get mockSkipSignature() {
    return bool("MOCK_SKIP_SIGNATURE", false);
  },
  get openNodeApiKey() {
    return optional("OPENNODE_API_KEY");
  },
  get openNodeWebhookSecret() {
    return optional("OPENNODE_WEBHOOK_SECRET");
  },
};

export function absoluteUrl(path: string): string {
  return `${env.appUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
