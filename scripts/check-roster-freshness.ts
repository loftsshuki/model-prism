/**
 * Roster freshness check — guards against "newest GA" silently rotting.
 *
 * Compares the live OpenRouter catalog against the council rosters in
 * src/lib/rosters.ts and reports three things:
 *   🔴 DEAD       — a roster model ID is no longer in the catalog (it was pulled).
 *   🟡 PRICE      — the catalog price no longer matches the price recorded in the roster.
 *   🔵 SUPERSEDED — a newer model exists in the same provider+family (advisory; a human
 *                   decides whether to adopt it — this never edits the roster).
 *
 * The /models endpoint is public (no API key needed). Run weekly by the
 * roster-freshness GitHub Action, which opens/updates an issue when there are findings
 * and fails the run if any model is DEAD.
 *
 * Usage: tsx scripts/check-roster-freshness.ts [--out <path>]
 * Exit:  0 always (the workflow decides failure from the `dead` output). Writes the
 *        markdown report to --out (default: roster-freshness-report.md) and, when running
 *        in GitHub Actions, sets the `findings` and `dead` step outputs.
 */
import * as fs from "node:fs";
import { ROSTERS } from "../src/lib/rosters";
import { ModelInfo } from "../src/lib/types";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
// Catalog entries whose id names a non-text modality are never roster successors.
const MODALITY_EXCLUDE = ["image", "audio", "tts", "embed", "-vl", "vision", "video", "-ocr", "whisper", "sora", "veo", "imagen"];
// Relative price tolerance before we call it drift (catalog prices wobble by rounding).
const PRICE_TOLERANCE = 0.02;

interface CatalogModel {
  id: string;
  inPer1k: number;
  outPer1k: number;
  created: number;
}

function getOutPath(): string {
  const i = process.argv.indexOf("--out");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "roster-freshness-report.md";
}

async function fetchCatalog(): Promise<Map<string, CatalogModel>> {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const json = (await res.json()) as { data: Array<{ id: string; created?: number; pricing?: { prompt?: string; completion?: string } }> };
  const map = new Map<string, CatalogModel>();
  for (const m of json.data) {
    map.set(m.id, {
      id: m.id,
      inPer1k: Number.parseFloat(m.pricing?.prompt ?? "0") * 1000,
      outPer1k: Number.parseFloat(m.pricing?.completion ?? "0") * 1000,
      created: m.created ?? 0,
    });
  }
  return map;
}

// Stem = the model-part of the id up to its first digit (": free" stripped), e.g.
// "gpt-5.5"→"gpt", "gpt-oss-120b"→"gpt-oss", "kimi-k2.6"→"kimi-k". Used to group a model
// with its same-line successors without brittle version parsing.
function stemOf(id: string): { provider: string; stem: string } {
  const [provider, rawName = ""] = id.split("/");
  const name = rawName.replace(/:free$/, "");
  const firstDigit = name.search(/\d/);
  const stem = (firstDigit === -1 ? name : name.slice(0, firstDigit)).replace(/[-.\s]+$/, "");
  return { provider, stem };
}

function priceDrift(recorded: number, live: number): boolean {
  if (recorded === 0 && live === 0) return false;
  if (recorded === 0 || live === 0) return Math.abs(recorded - live) > 1e-9;
  return Math.abs(recorded - live) / recorded > PRICE_TOLERANCE;
}

function rostersUsing(id: string): string[] {
  return Object.entries(ROSTERS).filter(([, models]) => models.some((m) => m.id === id)).map(([name]) => name);
}

interface Finding {
  kind: "DEAD" | "PRICE" | "SUPERSEDED";
  model: ModelInfo;
  detail: string;
}

function main(): void {
  const outPath = getOutPath();
  void (async () => {
    let catalog: Map<string, CatalogModel>;
    try {
      catalog = await fetchCatalog();
    } catch (e) {
      console.error(`Failed to fetch catalog: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 3;
      return;
    }

    // Unique roster models by id (a model can appear in more than one roster).
    const seen = new Map<string, ModelInfo>();
    for (const models of Object.values(ROSTERS)) for (const m of models) if (!seen.has(m.id)) seen.set(m.id, m);
    const rosterModels = [...seen.values()];

    const findings: Finding[] = [];

    for (const model of rosterModels) {
      const live = catalog.get(model.id);

      // 🔴 DEAD — id no longer in catalog.
      if (!live) {
        findings.push({ kind: "DEAD", model, detail: "not found in the OpenRouter catalog (model pulled)" });
        continue; // can't price- or supersession-check a model that's gone
      }

      // 🟡 PRICE drift.
      if (priceDrift(model.inputCostPer1k, live.inPer1k) || priceDrift(model.outputCostPer1k, live.outPer1k)) {
        const fmt = (n: number) => `$${(n * 1000).toFixed(2)}/M`;
        findings.push({
          kind: "PRICE",
          model,
          detail: `recorded ${fmt(model.inputCostPer1k)} in / ${fmt(model.outputCostPer1k)} out → catalog ${fmt(live.inPer1k)} in / ${fmt(live.outPer1k)} out`,
        });
      }

      // 🔵 SUPERSEDED — newer same-provider, same-stem catalog model.
      const { provider, stem } = stemOf(model.id);
      const bareName = (model.id.split("/")[1] ?? "").replace(/:free$/, "");
      const successors = [...catalog.values()].filter((c) => {
        if (c.id === model.id || c.created <= live.created) return false;
        const s = stemOf(c.id);
        if (s.provider !== provider || s.stem !== stem) return false;
        const lower = c.id.toLowerCase();
        if (MODALITY_EXCLUDE.some((x) => lower.includes(x))) return false;
        // Skip same-version tier variants (e.g. gpt-5.5 → gpt-5.5-pro): a pricier sibling
        // of the SAME version isn't a successor. A real successor has a different version.
        const cBare = (c.id.split("/")[1] ?? "").replace(/:free$/, "");
        if (cBare.startsWith(bareName)) return false;
        return true;
      }).sort((a, b) => b.created - a.created);

      if (successors.length > 0) {
        const newest = successors[0];
        const date = new Date(newest.created * 1000).toISOString().slice(0, 10);
        const extra = successors.length > 1 ? ` (+${successors.length - 1} more newer in family)` : "";
        findings.push({ kind: "SUPERSEDED", model, detail: `newer in family: \`${newest.id}\` (${date})${extra}` });
      }
    }

    const dead = findings.filter((f) => f.kind === "DEAD");
    const report = buildReport(findings, rosterModels.length);
    fs.writeFileSync(outPath, report, "utf-8");
    console.log(report);

    // Hand structured signals to the GitHub Action (open issue if findings>0; fail if dead>0).
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings.length}\ndead=${dead.length}\n`);
    }
  })();
}

function buildReport(findings: Finding[], checked: number): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  if (findings.length === 0) {
    return `# Roster freshness — ✅ all fresh\n\nChecked ${checked} roster models against the live OpenRouter catalog (${stamp}). No dead IDs, price drift, or newer same-family models.\n`;
  }
  const byKind = (k: Finding["kind"]) => findings.filter((f) => f.kind === k);
  const lines: string[] = [];
  lines.push(`# Roster freshness — ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
  lines.push("");
  lines.push(`Checked ${checked} roster models against the live OpenRouter catalog (${stamp}).`);
  lines.push("");
  const section = (emoji: string, title: string, kind: Finding["kind"], blurb: string) => {
    const items = byKind(kind);
    if (items.length === 0) return;
    lines.push(`## ${emoji} ${title} (${items.length})`);
    lines.push(`_${blurb}_`);
    lines.push("");
    for (const f of items) {
      lines.push(`- **${f.model.name}** \`${f.model.id}\` [${rostersUsing(f.model.id).join(", ")}] — ${f.detail}`);
    }
    lines.push("");
  };
  section("🔴", "Dead IDs — fix now", "DEAD", "These models were pulled from the catalog and will fail at request time.");
  section("🟡", "Price drift", "PRICE", "Catalog price no longer matches what the roster records. Update the numbers.");
  section("🔵", "Superseded — review", "SUPERSEDED", "A newer same-family model exists. Advisory only — a human decides whether to adopt.");
  lines.push("---");
  lines.push("_Generated by `scripts/check-roster-freshness.ts`. Edit rosters in `src/lib/rosters.ts`._");
  return lines.join("\n") + "\n";
}

main();
