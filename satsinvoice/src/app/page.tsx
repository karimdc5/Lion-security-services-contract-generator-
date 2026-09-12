import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export default async function Home() {
  redirect((await currentUser()) ? "/invoices" : "/login");
}
