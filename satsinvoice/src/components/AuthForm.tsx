"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/lib/actions/auth";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary w-full" disabled={pending}>
      {pending ? "One moment…" : label}
    </button>
  );
}

export function AuthForm({
  mode,
  action,
}: {
  mode: "login" | "signup";
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, {});
  const isSignup = mode === "signup";

  return (
    <div className="card p-6 shadow-sm">
      <h1 className="text-xl font-semibold tracking-tight">
        {isSignup ? "Create your account" : "Sign in"}
      </h1>
      <p className="hint">
        {isSignup
          ? "One account, one freelancer. That is the whole product."
          : "Welcome back."}
      </p>

      <form action={formAction} className="mt-6 space-y-4">
        {isSignup && (
          <div>
            <label className="label" htmlFor="displayName">
              Your name or business
            </label>
            <input
              id="displayName"
              name="displayName"
              className="input"
              placeholder="Ada Lovelace"
              autoComplete="name"
              required
            />
            {state.fieldErrors?.displayName && (
              <p className="mt-1 text-sm text-bad">{state.fieldErrors.displayName}</p>
            )}
          </div>
        )}

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
          {state.fieldErrors?.email && (
            <p className="mt-1 text-sm text-bad">{state.fieldErrors.email}</p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            autoComplete={isSignup ? "new-password" : "current-password"}
            minLength={8}
            required
          />
          {state.fieldErrors?.password && (
            <p className="mt-1 text-sm text-bad">{state.fieldErrors.password}</p>
          )}
        </div>

        {state.error && (
          <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{state.error}</p>
        )}

        <Submit label={isSignup ? "Create account" : "Sign in"} />
      </form>

      <p className="mt-5 text-center text-sm text-muted">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-accent hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            No account yet?{" "}
            <Link href="/signup" className="font-medium text-accent hover:underline">
              Create one
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
