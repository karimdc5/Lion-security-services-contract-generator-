# SatsInvoice

Invoice your clients in dollars. Get paid in Bitcoin.

The client sees a US dollar amount, a QR code, and a countdown. You see whether
the money arrived, arrived short, arrived twice, or arrived too late — and you
get a PDF receipt and a tax CSV out the other end.

SatsInvoice runs **no Lightning node**, holds **no private keys**, and custodies
**nothing**. Every satoshi moves through a payment processor behind a
`PaymentProvider` interface. v1 ships a mock provider so you can build and test
the whole money path before signing up for anything.

---

## Quick start

```bash
cp .env.example .env          # then set AUTH_SECRET: openssl rand -base64 32
npm install
npm run db:migrate            # creates the schema
npm run db:seed               # optional demo data
npm run dev
```

Open http://localhost:3000, create an account, and make an invoice.

Seeded login: `demo@satsinvoice.test` / `demo-password`.

You need a Postgres database. Anything works — local, Docker, Neon, Supabase.
Point `DATABASE_URL` at it.

```bash
# A local Postgres, if you don't have one:
createdb satsinvoice && createdb satsinvoice_test
```

---

## Testing the money path

There are three layers, and they are meant to be run in this order.

```bash
npm test        # 67 tests. Pure logic. No database needed.
npm run test:db # 18 tests. Real Postgres. Needs TEST_DATABASE_URL.
npm run smoke   # 44 checks. Real HTTP against a running server.
```

`npm test` covers the state machine and the webhook rules in-memory.
`npm run test:db` runs the same rules through Prisma against a throwaway
database, because some bugs only exist in Postgres — see *A bug worth knowing
about* below. `npm run smoke` drives the built app over HTTP: real signup, real
session cookie, real webhook endpoint, real PDF, real CSV.

```bash
# smoke needs the app running:
npm run build && npm start   # in one terminal
npm run smoke                # in another
```

### Testing each mock payment case by hand

Create an invoice, open it, and click **Checkout** (or open the client link and
then the mock checkout). Every button on `/mock-pay/[id]` POSTs a signed webhook
to `/api/webhooks/mock` — *the same endpoint a real processor will call*. There
is no back door into the database from that page.

| Button | What it sends | What should happen |
|---|---|---|
| **Pay exact** | one settled payment for the full amount | invoice → `paid`, receipt available |
| **Underpay** | one settled payment for 60% | invoice → `underpaid`, client page shows the remaining USD |
| **Overpay** | one settled payment for 115% | invoice → `paid`, `overpaySats` / `overpayUsdCents` recorded |
| **Pay after expiry** | full amount, timestamped past the deadline | invoice stays **not paid**, money credited and flagged, entry in `/unmatched` |
| **Pay twice** | two payments, two payment ids | invoice paid **once**; the second lands in `/unmatched` |
| **Replay same webhook** | one payment id, delivered twice | exactly one `PaymentEvent`; nothing moves the second time |
| **Mark in-flight** | a pending notice | invoice → `pending`, no sats credited |

To expire an invoice on demand, open it and hit **Expire now**, then use
**Pay after expiry**.

You can also drive the endpoint with curl (signature checking is skipped while
`MOCK_SKIP_SIGNATURE=true`):

```bash
curl -X POST http://localhost:3000/api/webhooks/mock \
  -H 'content-type: application/json' \
  -d '{"type":"payment.settled","provider_invoice_id":"mock_…","provider_payment_id":"pay_1","amount_sats":76923}'
```

Send it twice. The second response says `"status":"duplicate"` and nothing
changes.

---

## How it is put together

```
src/lib/invoice-state.ts     the state machine — pure, no Prisma, no clock
src/lib/money.ts             every conversion and the only two rounding points
src/lib/payments/provider.ts the PaymentProvider interface
src/lib/payments/mock.ts     MockPaymentProvider
src/lib/payments/opennode.ts OpenNodeProvider — a stub with TODOs
src/lib/payments/apply.ts    idempotent application of a provider event
src/lib/payments/store.ts    the persistence seam apply.ts is written against
src/lib/csv.ts               the tax export
src/lib/pdf/receipt.tsx      the receipt
```

Three rules shape all of it:

**USD is the contract, Bitcoin is a settlement fact.** The client agrees to a
dollar amount. Sats are how it arrives. The dollar figure on the invoice never
moves, whatever Bitcoin does afterwards.

**All money is integer math.** USD is integer cents. BTC is integer sats. The
rate is integer cents per BTC, frozen onto the invoice when it is created. No
float ever touches a stored amount.

**The database enforces idempotency, not the application code.**
`PaymentEvent.providerPaymentId` is UNIQUE. Applying a payment inserts that row
first, inside the same transaction that moves the invoice. A conflict means
"already processed", and the invoice is not touched.

### The state machine

Invoice statuses: `draft` `unpaid` `pending` `paid` `underpaid` `overpaid`
`expired` `canceled` `refunded`.

A settled payment is checked in this order:

1. **Draft or canceled invoice** → the money cannot be applied. It goes to the
   unmatched inbox and the invoice is flagged.
2. **Already settled invoice** → never marked paid twice. The second payment
   goes to the inbox.
3. **After `expiresAt`** → recorded as `late`. The sats are credited to the
   invoice so they are *visible*, the invoice is flagged for review, and an
   entry appears in the inbox. It is never silently treated as on-time.
4. **Otherwise** → short becomes `underpaid`, exact becomes `paid`, over becomes
   `paid` with the surplus recorded.

Expiry itself is applied lazily on read (there is no scheduler in v1): any page
that shows an invoice sweeps it first, so an expired invoice is never displayed
as still payable.

### Two deliberate calls

**An overpaid invoice is marked `paid`, not `overpaid`.** The acceptance
criteria ask for `paid` plus a recorded overpay, and that is the truthful
reading: the invoice *is* paid, and the surplus is a separate decision. The
`overpaid` enum value is kept for forward compatibility and never auto-assigned.
`displayStatus()` renders it as "paid (overpaid)".

**A written-off invoice keeps status `underpaid`.** Writing off closes the
invoice — `writtenOff` is the flag that does it — but the status stays
`underpaid` because less money arrived than was invoiced, and the tax export
must not claim otherwise.

### A bug worth knowing about

The in-memory tests passed a duplicate-webhook case that the Postgres tests
failed. In Postgres, a statement that raises inside a transaction poisons the
whole transaction: every later write fails with `25P02`, "current transaction is
aborted". Catching the Prisma unique-violation error in JavaScript is not
enough, because the damage is on the connection. The fix is to let the database
absorb the conflict with `INSERT … ON CONFLICT DO NOTHING`, so the transaction
stays usable and the duplicate can still be written to the audit log. See
`src/lib/payments/prisma-store.ts`. This is why `npm run test:db` exists.

---

## Swapping in a real provider

Implement three methods and change one env var.

```ts
interface PaymentProvider {
  createInvoice(input): Promise<CreatedInvoice>
  getInvoice(providerInvoiceId): Promise<ProviderInvoiceStatus>
  verifyWebhook(headers, rawBody): Promise<ProviderEvent>
}
```

`src/lib/payments/opennode.ts` is a stub carrying the real signatures and
step-by-step TODOs — including the parts that bite: OpenNode posts
form-encoded rather than JSON, signs the charge id rather than the body, has no
idempotency-key header, caps invoice TTL at 24 hours, and reuses the charge id
across a charge's lifecycle so `providerPaymentId` has to be derived rather than
copied. Setting `PAYMENT_PROVIDER=opennode` throws on startup rather than
quietly doing nothing with real money.

Everything downstream of `verifyWebhook` already speaks `ProviderEvent`, so
nothing else needs to change.

---

## The CSV

`/export` gives you a date range and a download. One row per money fact, not one
row per invoice, so nothing is invisible:

```
date_utc, invoice_public_id, client, description, status, amount_usd,
amount_sats_expected, amount_sats_received, btc_usd_rate,
payment_hash_or_provider_id, kind
```

| `kind` | meaning |
|---|---|
| `invoice` | the invoice itself — what you billed |
| `settled` | a payment that landed on time |
| `late` | a payment that landed after expiry |
| `unmatched` | money that could not be applied to an invoice |
| `refund` | a refund you recorded |
| `pending` | a provider notice that a payment was in flight |

Sum `amount_usd` over `kind=settled` for revenue received. Sum over
`kind=invoice` for revenue billed. When those two differ, something needed a
human — that is what the unmatched inbox is for.

---

## What is NOT in v1

Deliberately absent, and not "coming soon":

- **No Lightning node, channel manager, wallet, or custody.** No keys are
  generated, stored, or touched. If you want that, run BTCPay.
- **No real refunds.** "Issue refund" records the decision and logs a note. It
  does not send coins — SatsInvoice has nothing to send them with. Do the actual
  send in your provider's dashboard. `PaymentProvider.refund` is the place to
  add it later.
- **No altcoins.** Bitcoin only.
- **No Shopify / WooCommerce / Square plugins.**
- **No user roles, teams, or multi-seat.** One account is one freelancer.
- **No social features, tips marketplace, or price charts.**
- **No live BTC price feed.** The mock provider takes its rate from
  `MOCK_BTC_USD_RATE`, so tests are deterministic. A real provider quotes the
  rate itself, and that quote is what gets frozen onto the invoice.
- **No scheduler.** Expiry is applied on read. An invoice nobody looks at stays
  `unpaid` in the table until something reads it — the moment it is read, or a
  payment arrives for it, the rule applies. If you want eager expiry, call
  `sweepAll()` from a cron job.
- **No emails.** Invoices are links you send yourself.
- **No partial-payment tolerance.** A payment one sat short is underpaid. Real
  Lightning invoices settle exactly; if your provider rounds, add a tolerance
  constant in `invoice-state.ts` and test it.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `TEST_DATABASE_URL` | throwaway database for `npm run test:db` |
| `APP_URL` | public origin; builds payment links and webhook URLs |
| `AUTH_SECRET` | session secret — `openssl rand -base64 32` |
| `PAYMENT_PROVIDER` | `mock` or `opennode` |
| `MOCK_BTC_USD_RATE` | rate the mock provider freezes onto invoices |
| `MOCK_WEBHOOK_SECRET` | HMAC secret the mock pay page signs with |
| `MOCK_SKIP_SIGNATURE` | `true` to accept unsigned mock webhooks (curl/Postman) |
| `OPENNODE_API_KEY` | for the unimplemented OpenNode provider |
| `OPENNODE_WEBHOOK_SECRET` | for the unimplemented OpenNode provider |

`MOCK_SKIP_SIGNATURE` only affects the mock provider. A real provider's
`verifyWebhook` has no such escape hatch, and should never get one — an
unverified webhook is an attacker marking your invoices paid.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | development server |
| `npm run build` / `npm start` | production build and serve |
| `npm test` | unit tests, no database |
| `npm run test:db` | Postgres-backed tests |
| `npm run test:all` | both |
| `npm run smoke` | end-to-end checks against a running server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run db:migrate` | create/apply migrations |
| `npm run db:reset` | drop and rebuild the database |
| `npm run db:seed` | demo freelancer and invoices |
| `npm run db:studio` | Prisma Studio |

---

## Known issues

`npm audit` reports advisories in the Prisma CLI's dependency tree
(`deepmerge-ts`) and in `@vitest/mocker`. Both are development-only tooling and
neither ships in the built application. Clearing them means a Prisma major
upgrade; they are not worth chasing yet.
