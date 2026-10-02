import { stopAllBackgroundReviews } from "./background-store";
import { deleteMcpProviderCredential } from "./mcp-credential-store";
import { revokeAllReviewServiceTokens } from "./review-service-token-store";

/**
 * Cut off everything that keeps working without a Clerk session: Review Fabric
 * service tokens, the stored MCP OpenRouter key, and background reviews spending
 * on that key. Saved review history is left in place.
 */
export async function revokeAccountAccess(owner: string) {
  const revokedTokens = await revokeAllReviewServiceTokens(owner);
  await deleteMcpProviderCredential(owner);
  const stoppedRuns = await stopAllBackgroundReviews(owner);
  return { revokedTokens, stoppedRuns: stoppedRuns.length };
}

/** Events that must end a user's non-session access (service tokens, MCP key, running reviews). */
export function revocationTarget(event: { type: string; data: Record<string, unknown> }): string | null {
  const id = typeof event.data.id === "string" && /^user_[a-zA-Z0-9]+$/.test(event.data.id) ? event.data.id : null;
  if (!id) return null;
  if (event.type === "user.deleted") return id;
  if (event.type === "user.updated" && (event.data.banned === true || event.data.locked === true)) return id;
  return null;
}
