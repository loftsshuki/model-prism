import { writeFileSync } from "node:fs";
import { configuredModelIds, fetchModelCatalog } from "../src/lib/model-catalog";

async function main() {
  const catalog = await fetchModelCatalog();
  const ids = configuredModelIds();
  const missing = ids.filter((id) => !catalog.some((m) => m.id === id));
  if (missing.length) throw new Error(`Configured models are unavailable: ${missing.join(", ")}`);
  const models = ids.map((id) => catalog.find((m) => m.id === id)!);
  writeFileSync(new URL("../src/lib/model-catalog.json", import.meta.url), JSON.stringify({ checkedAt: models[0].verifiedAt, models }, null, 2) + "\n");
  console.log(`Refreshed metadata for ${models.length} configured text models. Model selections were preserved.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
