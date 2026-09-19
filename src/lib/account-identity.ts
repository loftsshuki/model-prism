import { createHash } from "node:crypto";

export function accountOwner(userId: string) {
  if (!/^user_[a-zA-Z0-9]+$/.test(userId)) throw new Error("Invalid account identity");
  return createHash("sha256").update(`model-prism-account-v1:${userId}`).digest("hex");
}
