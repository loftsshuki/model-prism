"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { jsonHeaders, prepareCloudAccess } from "@/lib/client-api";
import { useAccount } from "./account-session";

type ImportStatus = { reviews: number; hooks: number; telemetry: number; active: number; imported: boolean };
type AgentAccessStatus = { enabled: boolean; provider?: "openrouter"; keyLast4?: string; verifiedAt?: string; updatedAt?: string };
type ServiceTokenStatus = { tokenId: string; label: string; scopes: string[]; createdAt: string; lastUsedAt: string | null };
type CreatedServiceToken = ServiceTokenStatus & { token: string };
export function AccountSettings() {
  const { enabled, userId } = useAccount();
  const [preview, setPreview] = useState<ImportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [agentAccess, setAgentAccess] = useState<AgentAccessStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState("");
  const [serviceTokens, setServiceTokens] = useState<ServiceTokenStatus[]>([]);
  const [createdServiceToken, setCreatedServiceToken] = useState<CreatedServiceToken | null>(null);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [serviceMessage, setServiceMessage] = useState("");
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
    void fetch("/api/account/review-service-tokens", { headers: jsonHeaders(), cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Unable to read service tokens");
        if (mounted) setServiceTokens(Array.isArray(data.tokens) ? data.tokens : []);
      })
      .catch(() => { if (mounted) setServiceTokens([]); });
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

  async function createHossServiceToken() {
    setServiceBusy(true); setServiceMessage(""); setCreatedServiceToken(null);
    try {
      const response = await fetch("/api/account/review-service-tokens", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          label: "HOSS",
          scopes: ["reviews:start", "reviews:read", "reviews:stop"],
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to create HOSS service token");
      const created: CreatedServiceToken = {
        tokenId: data.tokenId,
        token: data.token,
        label: data.label,
        scopes: data.scopes,
        createdAt: data.createdAt,
        lastUsedAt: null,
      };
      setCreatedServiceToken(created);
      setServiceTokens(current => [
        {
          tokenId: created.tokenId,
          label: created.label,
          scopes: created.scopes,
          createdAt: created.createdAt,
          lastUsedAt: null,
        },
        ...current.filter(item => item.tokenId !== created.tokenId),
      ]);
      setServiceMessage("HOSS service token created. Copy it now; only its hash is stored by Model Prism.");
    } catch (error) {
      setServiceMessage(error instanceof Error ? error.message : "Unable to create HOSS service token");
    } finally { setServiceBusy(false); }
  }

  async function revokeHossServiceToken(tokenId: string) {
    setServiceBusy(true); setServiceMessage("");
    try {
      const response = await fetch("/api/account/review-service-tokens", {
        method: "DELETE",
        headers: jsonHeaders(),
        body: JSON.stringify({ tokenId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to revoke service token");
      setServiceTokens(current => current.filter(item => item.tokenId !== tokenId));
      if (createdServiceToken?.tokenId === tokenId) setCreatedServiceToken(null);
      setServiceMessage("HOSS service token revoked.");
    } catch (error) {
      setServiceMessage(error instanceof Error ? error.message : "Unable to revoke service token");
    } finally { setServiceBusy(false); }
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
      <div className="border-t border-border pt-4 space-y-3">
        <h3 className="font-medium text-sm">HOSS / service review access</h3>
        <p className="text-xs text-grey-50">Create a revocable machine token for HOSS to start and read Model Prism council runs without using your Clerk browser session. HOSS receives this token only; your OpenRouter credential stays encrypted inside Model Prism.</p>
        {!agentAccess?.enabled && <p className="text-xs text-amber-900">Enable agent review access above before creating a HOSS token.</p>}
        <button disabled={serviceBusy || !agentAccess?.enabled} onClick={() => void createHossServiceToken()} className="min-h-11 border border-border px-3 text-sm text-green disabled:opacity-50">{serviceBusy ? "Working…" : "Create HOSS service token"}</button>
        {createdServiceToken && <div className="border border-border bg-grey-5 p-3 space-y-2">
          <p className="text-xs font-medium">Copy this token now. It will not be shown again.</p>
          <code className="block break-all text-xs">{createdServiceToken.token}</code>
          <button onClick={() => void navigator.clipboard.writeText(createdServiceToken.token)} className="min-h-10 border border-border px-3 text-xs text-green">Copy token</button>
        </div>}
        {serviceTokens.length > 0 && <div className="space-y-2">
          {serviceTokens.map(token => <div key={token.tokenId} className="border border-border p-3 text-xs space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>{token.label}</strong>
              <button disabled={serviceBusy} onClick={() => void revokeHossServiceToken(token.tokenId)} className="text-red-500 disabled:opacity-50">Revoke</button>
            </div>
            <p className="text-grey-50">{token.scopes.join(" · ")}</p>
            <p className="text-grey-50">Last used: {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "never"}</p>
          </div>)}
        </div>}
        <p className="text-xs text-grey-50">Service endpoint: <code>https://model-prism.vercel.app/api/review-fabric/v1/reviews</code></p>
        {serviceMessage && <output className="block text-sm">{serviceMessage}</output>}
      </div>
      <p className="text-xs text-grey-50">Reviews created before private key access require the deployment owner to verify ownership and recover selected records. They are retained privately.</p>
      <p className="text-xs text-grey-50">Signing out clears keys and cached review/source data on this device. Reviews saved to your account stay in History.</p>
    </> : <p className="text-sm"><Link href="/sign-in" className="text-green underline">Sign in</Link> or <Link href="/sign-up" className="text-green underline">create an account</Link> to keep history independent of your provider key.</p>}
    {message && <output className="block text-sm">{message}</output>}
  </section>;
}
