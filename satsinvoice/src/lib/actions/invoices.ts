"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { toState, toUpdateData } from "@/lib/invoice-mapper";
import {
  TransitionError,
  cancelInvoice,
  expireNow,
  recordRefund,
  writeOff,
} from "@/lib/invoice-state";
import { createInvoice, isValidExpiry } from "@/lib/invoices";
import { MoneyError, parseUsdToCents } from "@/lib/money";
import { requireUser } from "@/lib/session";

export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const newInvoiceSchema = z.object({
  clientName: z.string().trim().min(1, "Who is this invoice for?").max(120),
  clientEmail: z.union([z.string().trim().email("Enter a valid email"), z.literal("")]),
  description: z.string().trim().min(1, "Describe the work").max(500),
  amountUsd: z.string().trim().min(1, "Enter an amount"),
  expirySeconds: z.coerce.number().int(),
});

/** Loads an invoice and proves it belongs to the signed-in freelancer. */
async function ownedInvoice(invoiceId: string) {
  const user = await requireUser();
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, userId: user.id } });
  if (!invoice) throw new Error("Invoice not found");
  return { user, invoice };
}

export async function createInvoiceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();

  const parsed = newInvoiceSchema.safeParse({
    clientName: formData.get("clientName"),
    clientEmail: formData.get("clientEmail") ?? "",
    description: formData.get("description"),
    amountUsd: formData.get("amountUsd"),
    expirySeconds: formData.get("expirySeconds"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    return { fieldErrors };
  }

  let amountUsdCents: number;
  try {
    amountUsdCents = parseUsdToCents(parsed.data.amountUsd);
  } catch (error) {
    if (error instanceof MoneyError) {
      return { fieldErrors: { amountUsd: "Enter an amount like 50 or 50.00" } };
    }
    throw error;
  }

  if (amountUsdCents < 100) {
    return { fieldErrors: { amountUsd: "Minimum invoice is $1.00" } };
  }
  if (!isValidExpiry(parsed.data.expirySeconds)) {
    return { fieldErrors: { expirySeconds: "Pick one of the offered expiry windows" } };
  }

  let invoiceId: string;
  try {
    const invoice = await createInvoice({
      userId: user.id,
      clientName: parsed.data.clientName,
      clientEmail: parsed.data.clientEmail || null,
      description: parsed.data.description,
      amountUsdCents,
      expirySeconds: parsed.data.expirySeconds,
    });
    invoiceId = invoice.id;
  } catch (error) {
    return {
      error: `Could not reach the payment provider: ${
        error instanceof Error ? error.message : "unknown error"
      }. The invoice was saved as a draft.`,
    };
  }

  revalidatePath("/invoices");
  redirect(`/invoices/${invoiceId}`);
}

async function transition(
  invoiceId: string,
  action: string,
  apply: (state: ReturnType<typeof toState>, now: Date) => ReturnType<typeof toState>,
  extra: Record<string, unknown> = {},
): Promise<ActionState> {
  const { user, invoice } = await ownedInvoice(invoiceId);
  const now = new Date();

  let next;
  try {
    next = apply(toState(invoice), now);
  } catch (error) {
    if (error instanceof TransitionError) return { error: error.message };
    throw error;
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { ...toUpdateData(next), ...extra },
  });

  await audit({
    actor: `user:${user.id}`,
    action,
    userId: user.id,
    invoiceId: invoice.id,
    meta: { from: invoice.status, to: next.status, ...extra },
  });

  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath("/invoices");
  return {};
}

export async function expireNowAction(invoiceId: string): Promise<ActionState> {
  return transition(invoiceId, "invoice.expired_manually", (state, now) => expireNow(state, now));
}

export async function cancelInvoiceAction(invoiceId: string): Promise<ActionState> {
  return transition(invoiceId, "invoice.canceled", (state) => cancelInvoice(state));
}

export async function writeOffAction(invoiceId: string): Promise<ActionState> {
  return transition(invoiceId, "invoice.written_off", (state) => writeOff(state));
}

/**
 * Records a refund. SatsInvoice does NOT send coins — it has no keys and no
 * node. This marks the books and leaves a note; the actual send happens in
 * your provider's dashboard until `PaymentProvider.refund` exists.
 */
export async function refundInvoiceAction(
  invoiceId: string,
  note: string,
): Promise<ActionState> {
  return transition(
    invoiceId,
    "invoice.refund_recorded",
    (state, now) => recordRefund(state, now),
    { refundedAt: new Date(), refundNote: note.trim().slice(0, 500) },
  );
}

export async function setAutoReissueAction(enabled: boolean): Promise<void> {
  const user = await requireUser();
  await prisma.user.update({ where: { id: user.id }, data: { autoReissue: enabled } });
  await audit({
    actor: `user:${user.id}`,
    action: "settings.auto_reissue",
    userId: user.id,
    meta: { enabled },
  });
  revalidatePath("/settings");
}

export async function setPayoutNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const payoutNote = String(formData.get("payoutNote") ?? "").trim().slice(0, 500);
  const displayName = String(formData.get("displayName") ?? "").trim().slice(0, 120);
  if (!displayName) return { fieldErrors: { displayName: "Your clients need a name to see" } };

  await prisma.user.update({ where: { id: user.id }, data: { payoutNote, displayName } });
  revalidatePath("/settings");
  return {};
}
