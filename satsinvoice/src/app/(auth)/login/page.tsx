import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { loginAction } from "@/lib/actions/auth";
import { currentUser } from "@/lib/session";

export const metadata = { title: "Sign in · SatsInvoice" };

export default async function LoginPage() {
  if (await currentUser()) redirect("/invoices");
  return <AuthForm mode="login" action={loginAction} />;
}
