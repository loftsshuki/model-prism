import { SYNTHESIS_IDS, type SynthesisModelKey } from "./model-catalog";

const DEFAULT_KEY = "model-prism-fable-default-v1";
const STORAGE_KEY = "synthesis-model";

/** Apply the new default once; later explicit choices remain persistent. */
export function getSynthesisPreference(): SynthesisModelKey {
  if (localStorage.getItem(DEFAULT_KEY) !== "1") {
    localStorage.setItem(STORAGE_KEY, "fable");
    localStorage.setItem(DEFAULT_KEY, "1");
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && stored in SYNTHESIS_IDS ? stored as SynthesisModelKey : "fable";
}
