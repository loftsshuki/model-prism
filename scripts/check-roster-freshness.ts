import * as fs from "node:fs";
import { configuredModelIds, fetchModelCatalog } from "../src/lib/model-catalog";
import { checkModelFreshness } from "../src/lib/model-freshness";

async function main() {
  const models = await fetchModelCatalog();
  const findings = checkModelFreshness(models);
  const dead = findings.filter((finding) => finding.kind === "DEAD").length;
  const report = [`# Model freshness · ${new Date().toISOString().slice(0, 10)}`, "",
    `Checked ${configuredModelIds().length} configured models, including council, synthesis, judge, enhancement, and fallback roles.`, "",
    ...findings.map((finding) => `- **${finding.kind}** \`${finding.id}\`: ${finding.detail}`),
    ...(findings.length ? [] : ["All configured models are available with matching prices and capabilities."]), "",
    "Catalog presence does not guarantee inference access. Verify candidates with the opt-in evaluation harness before changing curated IDs.", "",
    "Refresh reviewed metadata with `npm run refresh-models`. Council IDs and role choices live in `src/lib/model-catalog.ts`.", ""].join("\n");
  const index = process.argv.indexOf("--out");
  if (!process.argv.includes("--check")) fs.writeFileSync(index >= 0 ? process.argv[index + 1] : "roster-freshness-report.md", report);
  console.log(report);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings.length}\ndead=${dead}\n`);
  if (process.argv.includes("--check") && dead) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 3; });
