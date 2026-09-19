"use client";
import Link from "next/link";
import { createContext, useContext, useEffect, useState } from "react";
import { UserButton, useAuth } from "@clerk/nextjs";
import { prepareDeviceSession } from "@/lib/device-session";

type AccountState = { enabled: boolean; userId: string | null };
const AccountContext = createContext<AccountState>({ enabled: false, userId: null });
export const useAccount = () => useContext(AccountContext);

export function AccountSession({ children }: Readonly<{ children: React.ReactNode }>) {
  const { userId, isLoaded } = useAuth();
  const identity = userId ?? null;
  const [prepared, setPrepared] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isLoaded) return;
    let mounted = true;
    void prepareDeviceSession(identity).then(changed => {
      if (!mounted) return;
      // End pending source-file reads and callbacks before another identity can
      // use this tab. The persisted scope prevents a reload loop.
      if (changed) { window.location.reload(); return; }
      setPrepared(identity); setError("");
    })
      .catch(() => { if (mounted) setError("Private device storage could not be cleared. Close this tab and reopen Model Prism before switching accounts."); });
    return () => { mounted = false; };
  }, [identity, isLoaded]);
  if (error) return <main className="p-6 text-sm"><p role="alert">{error}</p></main>;
  if (!isLoaded || prepared !== identity) return <main className="p-6 text-sm"><output>Loading your account…</output></main>;
  return <AccountContext.Provider value={{ enabled: true, userId: identity }}>
    <div className="bg-white border-b border-border px-4 py-2 text-xs text-grey-60 flex flex-wrap items-center justify-end gap-3">
      {identity ? <><Link href="/settings" className="underline min-h-9 inline-flex items-center">Account &amp; history</Link><UserButton /></>
        : <><span>Keep review history across devices and key changes.</span><Link className="text-green underline min-h-9 inline-flex items-center" href="/sign-in">Sign in</Link><Link className="text-green underline min-h-9 inline-flex items-center" href="/sign-up">Create account</Link></>}
    </div>
    <div key={identity ?? "guest"}>{children}</div>
  </AccountContext.Provider>;
}
