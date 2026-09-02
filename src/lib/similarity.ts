// ═══════════════════════════════════════════════════════════════════════════
// Local, deterministic similarity between council members' outputs.
//
// The model-value report needs to know which members say the same things run
// after run: two models that agree 90% of the time are one vote, and the more
// expensive one can be dropped without losing coverage. Embeddings would do
// this better, but they cost a network call per response and make the number
// depend on whichever embedding model is current. TF-IDF + cosine over the
// shared vocabulary of one council run is good enough to flag near-duplicates
// and is reproducible byte-for-byte.
//
// Browser-safe: no node: imports, no network (the web app can show this too).
// ═══════════════════════════════════════════════════════════════════════════

// Same spirit as the list in findings.ts (which is private to that module),
// extended with words that are noise in long review prose rather than in a
// one-line claim.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "has", "have", "her", "was", "one", "our", "out",
  "this", "that", "these", "those", "with", "from", "they", "them", "their", "there", "then", "than", "into", "onto", "over",
  "will", "would", "could", "should", "may", "might", "must", "shall", "does", "did", "done", "been", "being", "were", "which",
  "when", "where", "what", "who", "whom", "why", "how", "also", "just", "very", "more", "most", "some", "such", "each", "here",
  "its", "your", "his", "she", "him", "per", "via", "etc", "use", "used", "using", "make", "makes", "made", "like",
  "only", "other", "same", "both", "either", "about", "after", "before", "because", "while", "since", "still", "even", "well",
]);

const SUFFIXES = ["ing", "ed", "es", "s"];

/** Lowercase words of length >= 3, stopwords removed, one suffix stripped (when that leaves >= 3 chars). */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    let w = raw;
    for (const s of SUFFIXES) {
      if (w.endsWith(s) && w.length - s.length >= 3) { w = w.slice(0, -s.length); break; }
    }
    out.push(w);
  }
  return out;
}

function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function l2normalize(v: Map<string, number>): Map<string, number> {
  let sum = 0;
  for (const x of v.values()) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  for (const [k, x] of v) v.set(k, x / norm);
  return v;
}

/**
 * TF-IDF vectors over the given documents (idf is computed from this set only),
 * each L2-normalized so `cosine` reduces to a dot product.
 */
export function tfidfVectors(docs: string[]): Map<string, number>[] {
  const tfs = docs.map(termFrequencies);
  const df = new Map<string, number>();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return tfs.map((tf) => {
    const v = new Map<string, number>();
    for (const [t, count] of tf) {
      // Smoothed idf (+1 inside and outside the log): a term present in every
      // document still contributes, so two identical documents score 1.0
      // instead of collapsing to zero vectors. Sublinear tf keeps a model that
      // repeats one word twenty times from dominating its own vector.
      const idf = Math.log((1 + n) / (1 + (df.get(t) ?? 0))) + 1;
      v.set(t, (1 + Math.log(count)) * idf);
    }
    return l2normalize(v);
  });
}

/** Cosine similarity in [0, 1]; 0 when either vector is empty. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of small) {
    const y = large.get(k);
    if (y !== undefined) dot += x * y;
  }
  for (const x of a.values()) na += x * x;
  for (const x of b.values()) nb += x * x;
  if (na === 0 || nb === 0) return 0;
  return Math.min(1, Math.max(0, dot / Math.sqrt(na * nb)));
}

export interface SimilarityPair {
  a: string;
  b: string;
  score: number;
}

/** Every unordered pair of responses, highest similarity first (ties broken by model id for determinism). */
export function pairwiseSimilarity(responses: Array<{ model: string; text: string }>): SimilarityPair[] {
  const vectors = tfidfVectors(responses.map((r) => r.text));
  const pairs: SimilarityPair[] = [];
  for (let i = 0; i < responses.length; i++) {
    for (let j = i + 1; j < responses.length; j++) {
      pairs.push({ a: responses[i].model, b: responses[j].model, score: cosine(vectors[i], vectors[j]) });
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return pairs;
}

/** Pairs at or above the threshold: candidates for "one vote, drop one". */
export function redundantPairs(pairs: SimilarityPair[], threshold = 0.85): SimilarityPair[] {
  return pairs.filter((p) => p.score >= threshold);
}

export interface SimilaritySummary {
  pairs: SimilarityPair[];
  meanSimilarity: number;
  redundant: SimilarityPair[];
  /** Model with the lowest mean similarity to the others: the one adding the most distinct signal. */
  mostDistinct: string | null;
}

export function summarizeSimilarity(responses: Array<{ model: string; text: string }>, threshold = 0.85): SimilaritySummary {
  const pairs = pairwiseSimilarity(responses);
  if (pairs.length === 0) return { pairs, meanSimilarity: 0, redundant: [], mostDistinct: null };
  const meanSimilarity = pairs.reduce((s, p) => s + p.score, 0) / pairs.length;

  const perModel = new Map<string, { sum: number; n: number }>();
  const bump = (m: string, score: number) => {
    const e = perModel.get(m) ?? { sum: 0, n: 0 };
    e.sum += score; e.n += 1;
    perModel.set(m, e);
  };
  for (const p of pairs) { bump(p.a, p.score); bump(p.b, p.score); }
  let mostDistinct: string | null = null;
  let lowest = Infinity;
  // Walk in input order so ties resolve to the earlier model, not Map insertion luck.
  for (const r of responses) {
    const e = perModel.get(r.model);
    if (!e) continue;
    const mean = e.sum / e.n;
    if (mean < lowest) { lowest = mean; mostDistinct = r.model; }
  }
  return { pairs, meanSimilarity, redundant: redundantPairs(pairs, threshold), mostDistinct };
}

/**
 * Across many runs, which pairs are *consistently* redundant. A single run can
 * agree by accident (an easy plan); a pair whose mean similarity over >= minRuns
 * runs clears the threshold is structural and worth a roster change.
 */
export function aggregateRedundancy(
  runs: Array<{ pairs: SimilarityPair[] }>,
  minRuns = 3,
  threshold = 0.8,
): Array<{ a: string; b: string; runs: number; meanScore: number }> {
  const acc = new Map<string, { a: string; b: string; sum: number; runs: number }>();
  for (const run of runs) {
    // A run should contribute one observation per pair; guard against callers
    // that pass duplicated pairs by keeping only the first per run.
    const seen = new Set<string>();
    for (const p of run.pairs) {
      const [a, b] = p.a <= p.b ? [p.a, p.b] : [p.b, p.a];
      const key = `${a} ${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const e = acc.get(key) ?? { a, b, sum: 0, runs: 0 };
      e.sum += p.score; e.runs += 1;
      acc.set(key, e);
    }
  }
  const out: Array<{ a: string; b: string; runs: number; meanScore: number }> = [];
  for (const e of acc.values()) {
    const meanScore = e.sum / e.runs;
    if (e.runs >= minRuns && meanScore >= threshold) out.push({ a: e.a, b: e.b, runs: e.runs, meanScore });
  }
  out.sort((x, y) => y.meanScore - x.meanScore || y.runs - x.runs || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return out;
}
