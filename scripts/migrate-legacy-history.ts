import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createClerkClient } from "@clerk/nextjs/server";
import { accountOwner } from "../src/lib/account-identity";
import { recoverUnownedHistory } from "../src/lib/server/account-store";

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const file = value("--env") ?? ".env.local";
  if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, "utf8")));
  const email = value("--email")?.trim().toLowerCase();
  const ids = [...new Set((value("--run-ids") ?? "").split(",").filter(Boolean))];
  if (!email || !ids.length || ids.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error("Provide --email <verified account email> --run-ids <comma-separated selected IDs>. Dry run is the default; --apply performs recovery.");
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const { data: users } = await clerk.users.getUserList({ emailAddress: [email], limit: 100 });
  const verified = users.filter(user => user.emailAddresses.some(address => address.emailAddress.toLowerCase() === email && address.verification?.status === "verified"));
  if (verified.length !== 1) throw new Error("The exact email must belong to one verified account in this Clerk instance");
  const apply = args.includes("--apply");
  console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", ...await recoverUnownedHistory(accountOwner(verified[0].id), ids, apply) }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Recovery failed"); process.exitCode = 1; });
