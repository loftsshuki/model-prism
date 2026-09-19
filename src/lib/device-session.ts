import { clearLocalCheckpoints } from "./run-checkpoint";
import { clearAllCache } from "./context-cache";

export async function prepareDeviceSession(userId: string | null) {
  const previous = localStorage.getItem("model-prism-last-account");
  const tabScope = sessionStorage.getItem("model-prism-session-scope");
  const nextScope = userId ? `account:${userId}` : "guest";
  if ((previous && previous !== userId) || (tabScope?.startsWith("account:") && tabScope !== nextScope)) {
    // Clear the prior account's private device data before rendering another
    // account or a signed-out page. Cloud reviews remain in their account.
    const privateKeys = ["openrouter-api-key", "model-prism-cloud-access", "model-prism-admin-token", "github-pat", "context-packs", "active-context-pack", "custom-templates", "model-prism-project-profiles", "model-prism-active-profile", "model-prism-plan-statuses", "rerun"];
    for (const key of privateKeys) { localStorage.removeItem(key); sessionStorage.removeItem(key); }
    await Promise.all([clearLocalCheckpoints(), clearAllCache(true)]);
  }
  if (userId) localStorage.setItem("model-prism-last-account", userId);
  else localStorage.removeItem("model-prism-last-account");
  sessionStorage.setItem("model-prism-session-scope", nextScope);
  return Boolean(tabScope && tabScope !== nextScope);
}
