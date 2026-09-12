import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { User } from "@prisma/client";

/** The signed-in freelancer, or a redirect to /login. */
export async function requireUser(): Promise<User> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) redirect("/login");

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) redirect("/login");
  return user;
}

export async function currentUser(): Promise<User | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return prisma.user.findUnique({ where: { id } });
}
