import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey() {
  const key = process.env.MODEL_PRISM_ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("Background review encryption is not configured");
  return Buffer.from(key, "hex");
}
export function encryptCredential(secret: string, binding: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}
export function decryptCredential(encoded: string, binding: string) {
  const [version, nonce, tag, ciphertext] = encoded.split(":");
  if (version !== "v1" || !nonce || !tag || !ciphertext) throw new Error("Invalid encrypted credential");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
