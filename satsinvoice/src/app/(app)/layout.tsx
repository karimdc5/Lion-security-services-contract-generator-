import Link from "next/link";
import { prisma } from "@/lib/db";
import { logoutAction } from "@/lib/actions/auth";
import { requireUser } from "@/lib/session";

const NAV = [
  { href: "/invoices", label: "Invoices" },
  { href: "/unmatched", label: "Unmatched" },
  { href: "/export", label: "Export" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const openUnmatched = await prisma.unmatchedPayment.count({
    where: { resolution: "open", OR: [{ userId: user.id }, { userId: null }] },
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <Link href="/invoices" className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-accent text-xs font-bold text-white">
              S
            </span>
            <span className="font-semibold tracking-tight">SatsInvoice</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-1.5 font-medium text-muted transition hover:bg-canvas hover:text-ink"
              >
                {item.label}
                {item.href === "/unmatched" && openUnmatched > 0 && (
                  <span className="ml-1.5 rounded-full bg-bad-soft px-1.5 py-0.5 text-xs font-semibold text-bad">
                    {openUnmatched}
                  </span>
                )}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-muted sm:inline">{user.email}</span>
            <form action={logoutAction}>
              <button type="submit" className="btn-ghost text-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
