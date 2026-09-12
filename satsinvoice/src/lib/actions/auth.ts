"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { credentialsSchema, hashPassword, signIn, signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const signupSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1, "Tell your clients who is invoicing them").max(120),
});

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

export async function signupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    return { fieldErrors: { email: "An account with that email already exists" } };
  }

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      displayName: parsed.data.displayName,
    },
  });

  await audit({ actor: `user:${user.id}`, action: "user.signed_up", userId: user.id });

  await signIn("credentials", {
    email: parsed.data.email,
    password: parsed.data.password,
    redirectTo: "/invoices",
  });

  return {};
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  try {
    await signIn("credentials", { ...parsed.data, redirectTo: "/invoices" });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "That email and password do not match an account." };
    }
    throw error; // redirect() throws; let Next handle it.
  }

  return {};
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirect: false });
  redirect("/login");
}
