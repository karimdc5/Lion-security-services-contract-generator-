import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { signupAction } from "@/lib/actions/auth";
import { currentUser } from "@/lib/session";

export const metadata = { title: "Create account · SatsInvoice" };

export default async function SignupPage() {
  if (await currentUser()) redirect("/invoices");
  return <AuthForm mode="signup" action={signupAction} />;
}
