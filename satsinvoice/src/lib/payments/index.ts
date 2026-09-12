import { env } from "@/lib/env";
import { MockPaymentProvider } from "./mock";
import { OpenNodeProvider } from "./opennode";
import { type PaymentProvider, ProviderError } from "./provider";

export * from "./provider";
export { MockPaymentProvider } from "./mock";
export { OpenNodeProvider } from "./opennode";

const cache = new Map<string, PaymentProvider>();

/** Resolve a provider by name. Defaults to PAYMENT_PROVIDER from the env. */
export function getProvider(name: string = env.paymentProvider): PaymentProvider {
  const cached = cache.get(name);
  if (cached) return cached;

  let provider: PaymentProvider;
  switch (name) {
    case "mock":
      provider = new MockPaymentProvider();
      break;
    case "opennode":
      provider = new OpenNodeProvider(env.openNodeApiKey, env.openNodeWebhookSecret);
      break;
    default:
      throw new ProviderError(
        `Unknown PAYMENT_PROVIDER "${name}". Supported: mock, opennode (stub).`,
      );
  }

  cache.set(name, provider);
  return provider;
}

export function isMockProvider(name: string): boolean {
  return name === "mock";
}
