export async function prepareCloudAccess(apiKey: string) {
  if (typeof window === "undefined") return;
  if (!apiKey) { sessionStorage.removeItem("model-prism-cloud-access"); localStorage.removeItem("model-prism-cloud-access"); return; }
  // A domain-separated, high-entropy capability for private history access.
  // Background jobs separately encrypt the provider key for temporary execution.
  // The same key can restore history on a phone until account sign-in is available.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`model-prism-cloud-v1:${apiKey}`));
  const token = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem("model-prism-cloud-access", token);
  if (localStorage.getItem("openrouter-api-key")) localStorage.setItem("model-prism-cloud-access", token);
  else localStorage.removeItem("model-prism-cloud-access");
}

export function jsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window === "undefined") return headers;

  const token = localStorage.getItem("model-prism-admin-token");
  if (token) headers["x-model-prism-token"] = token;
  const owner = sessionStorage.getItem("model-prism-cloud-access") || localStorage.getItem("model-prism-cloud-access");
  if (owner) headers["x-model-prism-owner"] = owner;
  return headers;
}

export function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};

  return jsonHeaders();
}
