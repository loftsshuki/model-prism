export function jsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window === "undefined") return headers;

  const token = localStorage.getItem("model-prism-admin-token");
  if (token) headers["x-model-prism-token"] = token;
  return headers;
}

export function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};

  const token = localStorage.getItem("model-prism-admin-token");
  return token ? { "x-model-prism-token": token } : {};
}
