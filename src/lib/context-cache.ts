import { createStore, get, set, del, keys, clear } from "idb-keyval";
import { RepoFile } from "./types";

// Custom store for model-prism cache data
const cacheStore = createStore("model-prism-cache", "context-data");

// --- Key helpers ---

function treeKey(repo: string, branch: string): string {
  return `tree:${repo}:${branch}`;
}

function fileKey(repo: string, branch: string, path: string): string {
  return `file:${repo}:${branch}:${path}`;
}

// --- Tree cache ---

interface CachedTree {
  files: RepoFile[];
  truncated: boolean;
  fetchedAt: string;
}

export async function getCachedTree(repo: string, branch: string): Promise<CachedTree | null> {
  try {
    const data = await get<CachedTree>(treeKey(repo, branch), cacheStore);
    return data ?? null;
  } catch {
    return null;
  }
}

export async function setCachedTree(
  repo: string,
  branch: string,
  files: RepoFile[],
  truncated: boolean
): Promise<void> {
  try {
    await set(
      treeKey(repo, branch),
      { files, truncated, fetchedAt: new Date().toISOString() },
      cacheStore
    );
  } catch {
    // IndexedDB write failed — non-fatal
  }
}

// --- File content cache ---

interface CachedFile {
  content: string;
  fetchedAt: string;
  size: number;
}

export async function getCachedFileContent(
  repo: string,
  branch: string,
  path: string
): Promise<CachedFile | null> {
  try {
    const data = await get<CachedFile>(fileKey(repo, branch, path), cacheStore);
    return data ?? null;
  } catch {
    return null;
  }
}

export async function setCachedFileContent(
  repo: string,
  branch: string,
  path: string,
  content: string,
  size: number
): Promise<void> {
  try {
    await set(
      fileKey(repo, branch, path),
      { content, fetchedAt: new Date().toISOString(), size },
      cacheStore
    );
  } catch {
    // IndexedDB write failed — non-fatal
  }
}

// --- Invalidation ---

export async function invalidateBranch(repo: string, branch: string): Promise<void> {
  try {
    const prefix = `file:${repo}:${branch}:`;
    const treeK = treeKey(repo, branch);
    const allKeys = await keys(cacheStore);

    const toDelete = allKeys.filter(
      (k) => k === treeK || (typeof k === "string" && k.startsWith(prefix))
    );

    for (const k of toDelete) {
      await del(k, cacheStore);
    }
  } catch {
    // Non-fatal
  }
}

// --- Storage info ---

export async function getCacheSize(): Promise<number> {
  try {
    // Estimate size by counting entries and their rough sizes
    const allKeys = await keys(cacheStore);
    // Rough estimate: each entry averages ~5KB for files, ~50KB for trees
    const fileEntries = allKeys.filter((k) => typeof k === "string" && k.startsWith("file:"));
    const treeEntries = allKeys.filter((k) => typeof k === "string" && k.startsWith("tree:"));
    return fileEntries.length * 5000 + treeEntries.length * 50000;
  } catch {
    return 0;
  }
}

export async function getCacheEntryCount(): Promise<number> {
  try {
    const allKeys = await keys(cacheStore);
    return allKeys.length;
  } catch {
    return 0;
  }
}

export async function clearAllCache(): Promise<void> {
  try {
    await clear(cacheStore);
  } catch {
    // Non-fatal
  }
}
