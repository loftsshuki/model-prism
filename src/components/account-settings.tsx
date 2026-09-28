"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { jsonHeaders, prepareCloudAccess } from "@/lib/client-api";
import { useAccount } from "./account-session";

type ImportStatus = { reviews: number; hooks: number; telemetry: number; active: number; imported: boolean };
type AgentAccessStatus = { enabled: boolean; provider?: "openrouter"; keyLast4?: string; verifiedAt?: string; updatedAt?: string };
export function AccountSettings() {
  const { enabled, userId } = useAccount();
  const [preview, setPreview] = useState<ImportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [agentAccess, setAgentAccess] = useState<AgentAccessStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState("");
  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    void fetch("/api/account/mcp-credential", { headers: jsonHeaders(), cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Unable to read agent access");
        if (mounted) setAgentAccess(data);
      })
      .catch(() => { if (mounted) setAgentAccess(null); });
    return () => { mounted = false; };
  }, [userId]);

  async function setAgentReviewAccess(enable: boolean) {
    setAgentBusy(true); setAgentMessage("");
    try {
      const apiKey = sessionStorage.getItem("openrouter-api-key") || localStorage.getItem("openrouter-api-key") || "";
      if (enable && !apiKey) throw new Error("Save your OpenRouter key below first, then enable agent access.");
      const response = await fetch("/api/account/mcp-credential", {
        method: enable ? "POST" : "DELETE",
        headers: jsonHeaders(),
        body: enable ? JSON.stringify({ apiKey }) : undefined,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to update agent access");
      setAgentAccess(data);
      setAgentMessage(enable
        ? "Agent review access enabled. Your provider key is encrypted server-side and is never returned through MCP."
        : "Agent review access revoked.");
    } catch (error) { setAgentMessage(error instanceof Error ? error.message : "Unable to update agent access"); }
    finally { setAgentBusy(false); }
  }

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
      <div className="border-t border-border pt-4 space-y-3">
        <h3 className="font-medium text-sm">ChatGPT / agent review access</h3>
        <p className="text-xs text-grey-50">Allow OAuth-authenticated MCP clients signed into this Model Prism account to start durable council reviews. The OpenRouter key is encrypted with the existing Model Prism server key and is never returned to the client.</p>
        {agentAccess?.enabled ? <p className="text-xs text-green">Enabled · OpenRouter key ending in {agentAccess.keyLast4}</p> : <p className="text-xs text-grey-50">Not enabled</p>}
        <div className="flex flex-wrap gap-2">
          <button disabled={agentBusy} onClick={() => void setAgentReviewAccess(true)} className="min-h-11 border border-border px-3 text-sm text-green disabled:opacity-50">{agentBusy ? "Working…" : agentAccess?.enabled ? "Refresh saved key" : "Enable agent access"}</button>
          {agentAccess?.enabled && <button disabled={agentBusy} onClick={() => void setAgentReviewAccess(false)} className="min-h-11 border border-border px-3 text-sm text-red-500 disabled:opacity-50">Revoke</button>}
        </div>
        {agentAccess?.enabled && <p className="text-xs text-grey-50">MCP endpoint: <code>https://model-prism.vercel.app/api/mcp</code></p>}
        {agentMessage && <output className="block text-sm">{agentMessage}</output>}
      </div>
      <p className="text-xs text-grey-50">Reviews created before private key access require the deployment owner to verify ownership and recover selected records. They are retained privately.</p>
      <p className="text-xs text-grey-50">Signing out clears keys and cached review/source data on this device. Reviews saved to your account stay in History.</p>
    </> : <p className="text-sm"><Link href="/sign-in" className="text-green underline">Sign in</Link> or <Link href="/sign-up" className="text-green underline">create an account</Link> to keep history independent of your provider key.</p>}
    {message && <output className="block text-sm">{message}</output>}
  </section>;
}
