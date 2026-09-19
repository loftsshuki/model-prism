"use client";
import Link from "next/link";
import { useState } from "react";
import { jsonHeaders, prepareCloudAccess } from "@/lib/client-api";
import { useAccount } from "./account-session";

type ImportStatus = { reviews: number; hooks: number; telemetry: number; active: number; imported: boolean };
export function AccountSettings() {
  const { enabled, userId } = useAccount();
  const [preview, setPreview] = useState<ImportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function importHistory(apply: boolean) {
    setBusy(true); setMessage("");
    try {
      await prepareCloudAccess(sessionStorage.getItem("openrouter-api-key") || localStorage.getItem("openrouter-api-key") || "");
      const response = await fetch("/api/account/import", { method: apply ? "POST" : "GET", headers: jsonHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to import history");
      setPreview(apply ? null : data);
      if (apply) setMessage(`Imported ${data.reviews} reviews, ${data.hooks} hook jobs, and ${data.telemetry} telemetry records. Open History to view them.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to import history"); }
    finally { setBusy(false); }
  }
  if (!enabled) return null;
  return <section className="space-y-3 border border-border bg-white p-5">
    <h2 className="font-display text-xl">Your account</h2>
    {userId ? <>
      <p className="text-sm text-grey-60">New reviews belong to your account. Sign in on any device to view them, even after changing your OpenRouter key.</p>
      <h3 className="font-medium text-sm">Import previous reviews</h3>
      <p className="text-xs text-grey-50">Connect and save the OpenRouter key used for your old reviews below, then check its history. Importing also moves finding decisions. Afterwards, sign-in is required to access those records.</p>
      <button disabled={busy} onClick={() => void importHistory(false)} className="min-h-11 border border-border px-3 text-sm text-green">{busy ? "Working…" : "Check previous key history"}</button>
      {preview && <div className="space-y-3 text-sm">
        <p>{preview.reviews} reviews · {preview.hooks} hook jobs · {preview.telemetry} telemetry records</p>
        {preview.active > 0 && <p>Finish or stop {preview.active} background reviews before importing.</p>}
        {preview.imported && !preview.reviews && <p>This key’s saved history has already been imported.</p>}
        {!!(preview.reviews + preview.hooks + preview.telemetry) && <button disabled={busy || preview.active > 0} onClick={() => void importHistory(true)} className="min-h-11 bg-green text-white px-4 disabled:opacity-50">Import into this account</button>}
      </div>}
      <p className="text-xs text-grey-50">Reviews created before private key access require the deployment owner to verify ownership and recover selected records. They are retained privately.</p>
      <p className="text-xs text-grey-50">Signing out clears keys and cached review/source data on this device. Reviews saved to your account stay in History.</p>
    </> : <p className="text-sm"><Link href="/sign-in" className="text-green underline">Sign in</Link> or <Link href="/sign-up" className="text-green underline">create an account</Link> to keep history independent of your provider key.</p>}
    {message && <output className="block text-sm">{message}</output>}
  </section>;
}
