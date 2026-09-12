import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link href="/" className="mb-8 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-white">
          S
        </span>
        <span className="text-lg font-semibold tracking-tight">SatsInvoice</span>
      </Link>
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 max-w-sm text-center text-xs text-faint">
        SatsInvoice never holds your keys and never custodies your money. Payments settle through
        your payment provider straight to you.
      </p>
    </div>
  );
}
