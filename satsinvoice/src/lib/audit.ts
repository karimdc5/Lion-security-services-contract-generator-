import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export async function audit(entry: {
  actor: string;
  action: string;
  userId?: string | null;
  invoiceId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor: entry.actor,
      action: entry.action,
      userId: entry.userId ?? null,
      invoiceId: entry.invoiceId ?? null,
      meta: (entry.meta ?? {}) as Prisma.InputJsonValue,
    },
  });
}
