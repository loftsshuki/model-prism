"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ContextPack, RepoFile, GitHubRepo, RateLimitInfo } from "@/lib/types";
import {
  fetchRepos, fetchBranches, fetchTree, fetchDirectory,
  fetchFileContent, getRateLimitInfo, isBlockedFile, isAllowedExtension, scanForSecrets,
} from "@/lib/github";
import {
  getContextPacks, saveContextPack, deleteContextPack, setActivePackId,
  generateTemplateBrief, enhanceBrief, detectKeyFiles, detectReferencedFiles,
  buildContextString, exportPack, importPack,
} from "@/lib/context-packs";
import {
  getCachedTree, setCachedTree, getCachedFileContent, setCachedFileContent,
  invalidateBranch, getCacheSize, clearAllCache,
} from "@/lib/context-cache";
import { CONTEXT_PACK_TEMPLATES, getContextTemplate, suggestFilesForContextTemplate } from "@/lib/context-templates";
import { estimateTokens } from "@/lib/model-registry";
import { cn } from "@/lib/utils";

interface ContextPanelProps {
  githubPat: string;
  anthropicKey: string;
  activePack: ContextPack | null;
  contextEnabled: boolean;
  contentText: string; // user's pasted content — for file reference detection
  fileContents: Record<string, string>;
  onPackChange: (pack: ContextPack | null) => void;
  onContextEnabledChange: (enabled: boolean) => void;
  onFileContentsChange: (contents: Record<string, string>) => void;
  onContextTokensChange: (tokens: number) => void;
}

// --- File tree node type ---
interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  children: TreeNode[];
  expanded: boolean;
  loading: boolean;
}

function buildTreeNodes(files: RepoFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  // Sort: dirs first, then alpha
  const sorted = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  for (const f of sorted) {
    const parts = f.path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");

    const node: TreeNode = {
      name, path: f.path, type: f.type, size: f.size,
      children: [], expanded: false, loading: false,
    };

    if (f.type === "dir") dirMap.set(f.path, node);

    if (parentPath && dirMap.has(parentPath)) {
      dirMap.get(parentPath)!.children.push(node);
    } else if (!parentPath) {
      root.push(node);
    } else {
      // Create implicit parent directories
      let current = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join("/");
        let dir = dirMap.get(dirPath);
        if (!dir) {
          dir = {
            name: parts[i], path: dirPath, type: "dir", size: 0,
            children: [], expanded: false, loading: false,
          };
          dirMap.set(dirPath, dir);
          current.push(dir);
        }
        current = dir.children;
      }
      current.push(node);
    }
  }

  return root;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// --- File Tree Node Component ---
function FileTreeNode({
  node, depth, selectedFiles, onToggleFile, onExpandDir,
  suggestedFiles, blockedTooltip,
}: {
  node: TreeNode;
  depth: number;
  selectedFiles: Set<string>;
  onToggleFile: (path: string) => void;
  onExpandDir: (path: string) => void;
  suggestedFiles: Set<string>;
  blockedTooltip: (path: string) => string | null;
}) {
  const isFile = node.type === "file";
  const isSelected = selectedFiles.has(node.path);
  const blocked = isFile ? blockedTooltip(node.path) : null;
  const isSuggested = suggestedFiles.has(node.path);
  const tooLarge = isFile && node.size > 500_000;

  // Tri-state for directories
  const childFiles = isFile ? [] : getAllFiles(node);
  const selectedChildCount = childFiles.filter((f) => selectedFiles.has(f)).length;
  const isPartial = !isFile && selectedChildCount > 0 && selectedChildCount < childFiles.length;
  const isAllSelected = !isFile && childFiles.length > 0 && selectedChildCount === childFiles.length;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 px-1 hover:bg-grey-5 transition-colors cursor-pointer text-xs",
          isSelected && "bg-green-light",
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => {
          if (isFile) {
            if (!blocked && !tooLarge) onToggleFile(node.path);
          } else {
            onExpandDir(node.path);
          }
        }}
      >
        {/* Expand arrow for dirs */}
        {!isFile && (
          <span className="w-3 text-grey-30 text-[10px] select-none">
            {node.loading ? "..." : node.expanded ? "▾" : "▸"}
          </span>
        )}
        {isFile && <span className="w-3" />}

        {/* Checkbox for files */}
        {isFile && (
          <span
            className={cn(
              "w-3.5 h-3.5 border flex items-center justify-center flex-shrink-0",
              blocked || tooLarge
                ? "border-grey-10 bg-grey-5 cursor-not-allowed"
                : isSelected
                  ? "border-green bg-green text-cream"
                  : "border-grey-20 hover:border-green"
            )}
          >
            {isSelected && <span className="text-[9px]">✓</span>}
          </span>
        )}

        {/* Tri-state checkbox for dirs */}
        {!isFile && (
          <span
            className={cn(
              "w-3.5 h-3.5 border flex items-center justify-center flex-shrink-0",
              isAllSelected
                ? "border-green bg-green text-cream"
                : isPartial
                  ? "border-green bg-green/30"
                  : "border-grey-20"
            )}
            onClick={(e) => {
              e.stopPropagation();
              // Toggle all children
              for (const f of childFiles) {
                if (!isBlockedFile(f)) onToggleFile(f);
              }
            }}
          >
            {isAllSelected && <span className="text-[9px]">✓</span>}
            {isPartial && <span className="text-[9px] text-green">─</span>}
          </span>
        )}

        {/* Icon */}
        <span className="text-[10px] text-grey-30 select-none">
          {isFile ? "📄" : node.expanded ? "📂" : "📁"}
        </span>

        {/* Name */}
        <span
          className={cn(
            "truncate flex-1",
            blocked || tooLarge ? "text-grey-20 line-through" : "text-grey-60"
          )}
          title={blocked || (tooLarge ? "File too large (>500KB)" : node.path)}
        >
          {node.name}
        </span>

        {/* Badges */}
        {isSuggested && !isSelected && (
          <span className="text-[8px] text-gold bg-gold/10 px-1 py-0.5 uppercase tracking-wider">Suggested</span>
        )}
        {isFile && (
          <span className="text-[9px] text-grey-20 tabular-nums">{formatSize(node.size)}</span>
        )}
      </div>

      {/* Children */}
      {!isFile && node.expanded && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFiles={selectedFiles}
              onToggleFile={onToggleFile}
              onExpandDir={onExpandDir}
              suggestedFiles={suggestedFiles}
              blockedTooltip={blockedTooltip}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getAllFiles(node: TreeNode): string[] {
  if (node.type === "file") return [node.path];
  return node.children.flatMap(getAllFiles);
}

// --- Main Component ---
export function ContextPanel({
  githubPat, anthropicKey, activePack, contextEnabled, contentText,
  fileContents, onPackChange, onContextEnabledChange, onFileContentsChange, onContextTokensChange,
}: ContextPanelProps) {
  const [collapsed, setCollapsed] = useState(!activePack);
  const [mode, setMode] = useState<"view" | "create" | "edit">(activePack ? "view" : "create");
  const [packs, setPacks] = useState<ContextPack[]>([]);

  // Create/edit state
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [branches, setBranches] = useState<{ name: string }[]>([]);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [repoFilter, setRepoFilter] = useState("");

  // Tree state
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const [treeFilter, setTreeFilter] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Brief state
  const [brief, setBrief] = useState("");
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  // Pack name
  const [packName, setPackName] = useState("");

  // Secret warnings
  const [secretWarnings, setSecretWarnings] = useState<Map<string, string[]>>(new Map());

  // Rate limit
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);

  // Detected file references
  const [detectedFiles, setDetectedFiles] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateSuggestedFiles, setTemplateSuggestedFiles] = useState<string[]>([]);

  // Loading file contents
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());

  // Error state
  const [error, setError] = useState<string | null>(null);

  // Import + local files
  const importRef = useRef<HTMLInputElement>(null);
  const localFilesRef = useRef<HTMLInputElement>(null);
  const localFolderRef = useRef<HTMLInputElement>(null);

  // Load packs on mount
  useEffect(() => {
    setPacks(getContextPacks());
  }, []);

  // Browser-only folder picker attributes are not part of React's standard input props.
  useEffect(() => {
    localFolderRef.current?.setAttribute("webkitdirectory", "");
    localFolderRef.current?.setAttribute("directory", "");
  }, []);

  // Update rate limit display
  useEffect(() => {
    const interval = setInterval(() => {
      setRateLimit(getRateLimitInfo());
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Detect file references in content
  useEffect(() => {
    if (!contentText || treeNodes.length === 0) {
      setDetectedFiles([]);
      return;
    }
    const timer = setTimeout(() => {
      const allFiles: RepoFile[] = [];
      function collectFiles(nodes: TreeNode[]) {
        for (const n of nodes) {
          if (n.type === "file") allFiles.push({ path: n.path, size: n.size, type: "file" });
          if (n.children) collectFiles(n.children);
        }
      }
      collectFiles(treeNodes);
      const refs = detectReferencedFiles(contentText, allFiles);
      setDetectedFiles(refs);
    }, 500);
    return () => clearTimeout(timer);
  }, [contentText, treeNodes]);

  // Recalculate context tokens
  useEffect(() => {
    if (!activePack || !contextEnabled) {
      onContextTokensChange(0);
      return;
    }
    const contextStr = buildContextString(activePack, fileContents);
    // Code-aware: 2.5 chars/token, 20% buffer + 200 overhead
    const tokens = contextStr ? Math.ceil(contextStr.length / 2.5 * 1.2) + 200 : 0;
    onContextTokensChange(tokens);
  }, [activePack, fileContents, contextEnabled, onContextTokensChange]);

  // --- Handlers ---

  const loadRepos = useCallback(async () => {
    if (!githubPat) return;
    setReposLoading(true);
    setError(null);
    try {
      const data = await fetchRepos(githubPat);
      setRepos(data);
    } catch (err) {
      setError((err as Error).message || "Failed to load repos");
    }
    setReposLoading(false);
  }, [githubPat]);

  const handleRepoSelect = useCallback(async (repoName: string) => {
    setSelectedRepo(repoName);
    setError(null);
    const repo = repos.find((r) => r.full_name === repoName);
    if (!repo) return;

    // Load branches
    try {
      const branchData = await fetchBranches(githubPat, repoName);
      setBranches(branchData);
      setSelectedBranch(repo.default_branch);
    } catch {
      setBranches([{ name: repo.default_branch }]);
      setSelectedBranch(repo.default_branch);
    }

    // Load tree
    await loadTree(repoName, repo.default_branch);
  }, [githubPat, repos]);

  const loadTree = useCallback(async (repo: string, branch: string) => {
    setTreeLoading(true);
    setError(null);
    try {
      // Check cache first
      const cached = await getCachedTree(repo, branch);
      if (cached) {
        const nodes = buildTreeNodes(cached.files);
        setTreeNodes(nodes);
        setTreeTruncated(false); // We don't cache truncation state simply
        generateBriefFromTree(repo, branch, cached.files);
        setTreeLoading(false);
        return;
      }

      const result = await fetchTree(githubPat, repo, branch);
      setTreeTruncated(result.truncated);
      await setCachedTree(repo, branch, result.files, result.truncated);
      const nodes = buildTreeNodes(result.files);
      setTreeNodes(nodes);
      generateBriefFromTree(repo, branch, result.files);
    } catch (err) {
      setError((err as Error).message || "Failed to load repository tree");
    }
    setTreeLoading(false);
  }, [githubPat]);

  const generateBriefFromTree = useCallback(async (repo: string, branch: string, files: RepoFile[]) => {
    // Try to fetch package.json for stack detection
    let pkg: object | undefined;
    try {
      const result = await fetchFileContent(githubPat, repo, "package.json", branch);
      if (result.ok) {
        pkg = JSON.parse(result.content);
      }
    } catch { /* ignore */ }

    const text = generateTemplateBrief(repo, branch, files, pkg);
    setBrief(text);
    setPackName(repo.split("/").pop() || "");
  }, [githubPat]);

  const handleBranchChange = useCallback(async (branch: string) => {
    setSelectedBranch(branch);
    setSelectedFiles(new Set());
    setSelectedTemplateId("");
    setTemplateSuggestedFiles([]);
    onFileContentsChange({});
    if (selectedRepo) {
      await invalidateBranch(selectedRepo, branch);
      await loadTree(selectedRepo, branch);
    }
  }, [selectedRepo, loadTree, onFileContentsChange]);

  const collectRepoFiles = useCallback((): RepoFile[] => {
    const allFiles: RepoFile[] = [];
    function collectFiles(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.type === "file") allFiles.push({ path: n.path, size: n.size, type: "file" });
        if (n.children) collectFiles(n.children);
      }
    }
    collectFiles(treeNodes);
    return allFiles;
  }, [treeNodes]);

  const loadSelectedFileContents = useCallback(async (paths: string[]) => {
    const nextContents = { ...fileContents };
    const nextWarnings = new Map(secretWarnings);
    const safePaths = paths.filter((path) => !isBlockedFile(path) && isAllowedExtension(path));
    setLoadingFiles((current) => new Set([...current, ...safePaths.filter((path) => !nextContents[path])]));

    for (const path of safePaths) {
      if (nextContents[path]) continue;
      try {
        const cached = await getCachedFileContent(selectedRepo, selectedBranch, path);
        if (cached) {
          nextContents[path] = cached.content;
          const secrets = scanForSecrets(cached.content);
          if (secrets.length > 0) nextWarnings.set(path, secrets);
          continue;
        }
        const result = await fetchFileContent(githubPat, selectedRepo, path, selectedBranch);
        if (result.ok) {
          nextContents[path] = result.content;
          await setCachedFileContent(selectedRepo, selectedBranch, path, result.content, result.size);
          const secrets = scanForSecrets(result.content);
          if (secrets.length > 0) nextWarnings.set(path, secrets);
        }
      } catch { /* skip individual file failures */ }
    }

    setSecretWarnings(nextWarnings);
    onFileContentsChange(nextContents);
    setLoadingFiles((current) => {
      const next = new Set(current);
      safePaths.forEach((path) => next.delete(path));
      return next;
    });
  }, [fileContents, githubPat, onFileContentsChange, secretWarnings, selectedBranch, selectedRepo]);

  const handleApplyTemplate = useCallback(async (templateId: string) => {
    const template = getContextTemplate(templateId);
    if (!template) return;

    const suggested = suggestFilesForContextTemplate(templateId, collectRepoFiles())
      .filter((path) => !isBlockedFile(path) && isAllowedExtension(path));
    setSelectedTemplateId(templateId);
    setTemplateSuggestedFiles(suggested);
    setShowTree(true);
    setSelectedFiles((prev) => new Set([...prev, ...suggested]));
    setBrief((current) => current.includes(template.briefNote) ? current : `${current.trim()}\n\n${template.briefNote}`.trim());
    if (!packName.trim() && selectedRepo) setPackName(`${selectedRepo.split("/").pop()} ${template.name}`);
    await loadSelectedFileContents(suggested);
  }, [collectRepoFiles, loadSelectedFileContents, packName, selectedRepo]);

  const handleEnhance = useCallback(async () => {
    if (!anthropicKey || !selectedRepo || !selectedBranch) return;
    setEnhancing(true);
    setEnhanceError(null);

    try {
      // Detect key files and fetch their contents
      const keyFilePaths = detectKeyFiles(collectRepoFiles());
      const keyContents: Record<string, string> = {};

      for (const path of keyFilePaths) {
        try {
          // Check IndexedDB cache first
          const cached = await getCachedFileContent(selectedRepo, selectedBranch, path);
          if (cached) {
            keyContents[path] = cached.content;
            continue;
          }
          const result = await fetchFileContent(githubPat, selectedRepo, path, selectedBranch);
          if (result.ok) {
            keyContents[path] = result.content;
            await setCachedFileContent(selectedRepo, selectedBranch, path, result.content, result.size);
          }
        } catch { /* skip individual file failures */ }
      }

      const enhanced = await enhanceBrief(anthropicKey, brief, keyContents);
      setBrief(enhanced);
    } catch (err) {
      setEnhanceError((err as Error).message || "Enhancement failed");
    }
    setEnhancing(false);
  }, [anthropicKey, selectedRepo, selectedBranch, collectRepoFiles, brief, githubPat]);

  const handleToggleFile = useCallback(async (path: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        // Remove from file contents
        const updated = { ...fileContents };
        delete updated[path];
        onFileContentsChange(updated);
      } else {
        next.add(path);
        // Fetch content if not cached
        if (!fileContents[path]) {
          setLoadingFiles((lf) => new Set([...lf, path]));
          (async () => {
            try {
              // Check IndexedDB cache
              const cached = await getCachedFileContent(selectedRepo, selectedBranch, path);
              if (cached) {
                onFileContentsChange({ ...fileContents, [path]: cached.content });
                // Check for secrets
                const secrets = scanForSecrets(cached.content);
                if (secrets.length > 0) {
                  setSecretWarnings((prev) => new Map([...prev, [path, secrets]]));
                }
                setLoadingFiles((lf) => { const n = new Set(lf); n.delete(path); return n; });
                return;
              }

              const result = await fetchFileContent(githubPat, selectedRepo, path, selectedBranch);
              if (result.ok) {
                await setCachedFileContent(selectedRepo, selectedBranch, path, result.content, result.size);
                onFileContentsChange({ ...fileContents, [path]: result.content });
                // Check for secrets
                const secrets = scanForSecrets(result.content);
                if (secrets.length > 0) {
                  setSecretWarnings((prev) => new Map([...prev, [path, secrets]]));
                }
              }
            } catch { /* ignore */ }
            setLoadingFiles((lf) => { const n = new Set(lf); n.delete(path); return n; });
          })();
        }
      }
      return next;
    });
  }, [fileContents, onFileContentsChange, githubPat, selectedRepo, selectedBranch]);

  const handleExpandDir = useCallback(async (path: string) => {
    setTreeNodes((prev) => {
      function toggle(nodes: TreeNode[]): TreeNode[] {
        return nodes.map((n) => {
          if (n.path === path) return { ...n, expanded: !n.expanded };
          if (n.children.length > 0) return { ...n, children: toggle(n.children) };
          return n;
        });
      }
      return toggle(prev);
    });

    // If tree was truncated and dir has no children, lazy-load
    if (treeTruncated) {
      const findNode = (nodes: TreeNode[]): TreeNode | null => {
        for (const n of nodes) {
          if (n.path === path) return n;
          const found = findNode(n.children);
          if (found) return found;
        }
        return null;
      };
      const node = findNode(treeNodes);
      if (node && node.type === "dir" && node.children.length === 0) {
        // Mark loading
        setTreeNodes((prev) => {
          function mark(nodes: TreeNode[]): TreeNode[] {
            return nodes.map((n) => {
              if (n.path === path) return { ...n, loading: true, expanded: true };
              return { ...n, children: mark(n.children) };
            });
          }
          return mark(prev);
        });

        try {
          const files = await fetchDirectory(githubPat, selectedRepo, path, selectedBranch);
          setTreeNodes((prev) => {
            function addChildren(nodes: TreeNode[]): TreeNode[] {
              return nodes.map((n) => {
                if (n.path === path) {
                  const childNodes: TreeNode[] = files.map((f) => ({
                    name: f.path.split("/").pop() || f.path,
                    path: f.path,
                    type: f.type,
                    size: f.size,
                    children: [],
                    expanded: false,
                    loading: false,
                  }));
                  return { ...n, children: childNodes, loading: false, expanded: true };
                }
                return { ...n, children: addChildren(n.children) };
              });
            }
            return addChildren(prev);
          });
        } catch {
          setTreeNodes((prev) => {
            function unmark(nodes: TreeNode[]): TreeNode[] {
              return nodes.map((n) => {
                if (n.path === path) return { ...n, loading: false };
                return { ...n, children: unmark(n.children) };
              });
            }
            return unmark(prev);
          });
        }
      }
    }
  }, [treeTruncated, treeNodes, githubPat, selectedRepo, selectedBranch]);

  const handleSavePack = useCallback(() => {
    if (!packName.trim() || !selectedRepo) return;

    const pack: ContextPack = activePack && mode === "edit"
      ? {
        ...activePack,
        name: packName.trim(),
        repo: selectedRepo,
        branch: selectedBranch,
        brief,
        briefEnhanced: activePack.briefEnhanced || enhancing === false, // preserve if already enhanced
        selectedFiles: [...selectedFiles],
        templateId: selectedTemplateId || activePack.templateId,
        updatedAt: new Date().toISOString(),
      }
      : {
        version: 1,
        id: `pack_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: packName.trim(),
        repo: selectedRepo,
        branch: selectedBranch,
        brief,
        briefEnhanced: false,
        selectedFiles: [...selectedFiles],
        templateId: selectedTemplateId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

    saveContextPack(pack);
    setActivePackId(pack.id);
    onPackChange(pack);
    onContextEnabledChange(true);
    setPacks(getContextPacks());
    setMode("view");
  }, [activePack, mode, packName, selectedRepo, selectedBranch, brief, selectedFiles, selectedTemplateId, enhancing, onPackChange, onContextEnabledChange]);

  const handleDeletePack = useCallback((id: string) => {
    deleteContextPack(id);
    if (activePack?.id === id) {
      onPackChange(null);
      onContextEnabledChange(false);
    }
    setPacks(getContextPacks());
  }, [activePack, onPackChange, onContextEnabledChange]);

  const handleSwitchPack = useCallback((pack: ContextPack) => {
    setActivePackId(pack.id);
    onPackChange(pack);
    onContextEnabledChange(true);
    setMode("view");
    // Load file contents for selected files
    (async () => {
      const contents: Record<string, string> = {};
      for (const path of pack.selectedFiles) {
        const cached = await getCachedFileContent(pack.repo, pack.branch, path);
        if (cached) contents[path] = cached.content;
      }
      onFileContentsChange(contents);
    })();
  }, [onPackChange, onContextEnabledChange, onFileContentsChange]);

  const handleEditPack = useCallback(() => {
    if (!activePack) return;
    setMode("edit");
    setSelectedRepo(activePack.repo);
    setSelectedBranch(activePack.branch);
    setBrief(activePack.brief);
    setPackName(activePack.name);
    setSelectedFiles(new Set(activePack.selectedFiles));
    setSelectedTemplateId(activePack.templateId || "");
    setTemplateSuggestedFiles([]);
    setShowTree(activePack.selectedFiles.length > 0);
    // Load tree for GitHub-backed packs only. Local packs are edited by replacing files.
    if (activePack.repo !== "local") {
      loadTree(activePack.repo, activePack.branch);
      if (!repos.length) loadRepos();
    }
  }, [activePack, loadTree, loadRepos, repos]);

  const handleExport = useCallback(() => {
    if (!activePack) return;
    const json = exportPack(activePack);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activePack.name.replace(/\s+/g, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activePack]);

  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pack = importPack(reader.result as string);
        saveContextPack(pack);
        setPacks(getContextPacks());
        handleSwitchPack(pack);
      } catch (err) {
        setError((err as Error).message || "Invalid pack file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, [handleSwitchPack]);

  const handleLocalFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);

    const accepted = Array.from(files)
      .map((file) => ({ file, path: (file.webkitRelativePath || file.name).replace(/\\/g, "/") }))
      .filter(({ file, path }) => file.size <= 500_000 && !isBlockedFile(path) && isAllowedExtension(path))
      .slice(0, 40);

    if (!accepted.length) {
      setError("No usable local files selected. Files may be too large, blocked, or unsupported.");
      return;
    }

    const contents: Record<string, string> = {};
    const warnings = new Map<string, string[]>();
    const paths: string[] = [];

    for (const { file, path } of accepted) {
      try {
        const text = await file.text();
        contents[path] = text;
        paths.push(path);
        await setCachedFileContent("local", "local", path, text, file.size);
        const secrets = scanForSecrets(text);
        if (secrets.length > 0) warnings.set(path, secrets);
      } catch { /* skip unreadable local files */ }
    }

    if (!paths.length) {
      setError("Could not read the selected local files.");
      return;
    }

    const pack: ContextPack = {
      version: 1,
      id: `pack_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: paths.length === 1 ? `Local: ${paths[0].split("/").pop()}` : `Local files (${paths.length})`,
      repo: "local",
      branch: "local",
      brief: `LOCAL FILE CONTEXT\n\nThese files were selected from this computer and cached locally in the browser for Model Prism review context.\n\nFILES:\n${paths.map((path) => `- ${path}`).join("\n")}`,
      briefEnhanced: false,
      selectedFiles: paths,
      templateId: "local-files",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveContextPack(pack);
    setActivePackId(pack.id);
    setSecretWarnings(warnings);
    setSelectedFiles(new Set(paths));
    setPacks(getContextPacks());
    onFileContentsChange(contents);
    onPackChange(pack);
    onContextEnabledChange(true);
    setCollapsed(false);
    setMode("view");
  }, [onContextEnabledChange, onFileContentsChange, onPackChange]);

  // Filtered tree for search
  const filteredTree = treeFilter
    ? treeNodes.map((n) => filterTreeNode(n, treeFilter.toLowerCase())).filter(Boolean) as TreeNode[]
    : treeNodes;

  const contextTokens = activePack && contextEnabled
    ? (() => {
      const cs = buildContextString(activePack, fileContents);
      return cs ? Math.ceil(cs.length / 2.5 * 1.2) + 200 : 0;
    })()
    : 0;

  // --- Render ---

  if (!githubPat && !activePack) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-px bg-green" />
          <span className="overline text-green">Codebase Context</span>
        </div>
        <div className="border border-dashed border-border p-4 text-center space-y-3">
          <div>
            <p className="text-xs text-grey-30 mb-2">Attach local files now, or connect GitHub for repository context packs.</p>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <button onClick={() => localFilesRef.current?.click()} className="cta-text px-3 py-1.5 border border-green text-green hover:bg-green-light transition-colors duration-300">
                Attach Files
              </button>
              <button onClick={() => localFolderRef.current?.click()} className="cta-text px-3 py-1.5 border border-border text-grey-50 hover:border-green hover:text-green transition-colors duration-300">
                Attach Folder
              </button>
            </div>
          </div>
          <a href="/settings" className="cta-text text-green hover:text-green-hover transition-colors duration-300">
            Add GitHub Token in Settings →
          </a>
          {error && <p className="text-[10px] text-red-500">{error}</p>}
          <input ref={localFilesRef} type="file" multiple onChange={(e) => { handleLocalFiles(e.target.files); e.target.value = ""; }} className="hidden" />
          <input ref={localFolderRef} type="file" multiple onChange={(e) => { handleLocalFiles(e.target.files); e.target.value = ""; }} className="hidden" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-px bg-green" />
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="overline text-green hover:text-green-hover transition-colors flex items-center gap-2"
        >
          Codebase Context
          <span className="text-[10px]">{collapsed ? "▸" : "▾"}</span>
        </button>
        {activePack && (
          <label className="flex items-center gap-1.5 ml-auto cursor-pointer">
            <input
              type="checkbox"
              checked={contextEnabled}
              onChange={(e) => onContextEnabledChange(e.target.checked)}
              className="accent-green w-3 h-3"
            />
            <span className="text-[10px] text-grey-40">Active</span>
          </label>
        )}
      </div>

      {collapsed && activePack && contextEnabled && (
        <div className="text-[10px] text-grey-30 flex items-center gap-2">
          <span className="text-green">●</span>
          {activePack.name} · ~{contextTokens.toLocaleString()} tokens
        </div>
      )}

      {!collapsed && (
        <div className="space-y-3">
          {/* Error display */}
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 p-2">
              {error}
              <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
            </div>
          )}

          {/* Active pack view */}
          {mode === "view" && activePack && (
            <div className="space-y-3">
              <div className="border border-border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-grey-60">{activePack.name}</span>
                  {activePack.briefEnhanced && (
                    <span className="text-[8px] text-gold bg-gold/10 px-1.5 py-0.5 uppercase tracking-wider">AI Enhanced</span>
                  )}
                </div>
                <p className="text-[10px] text-grey-30">
                  {activePack.repo} · {activePack.branch}
                </p>
                <p className="text-[10px] text-grey-40 line-clamp-3 whitespace-pre-wrap">
                  {activePack.brief.slice(0, 200)}...
                </p>
                <div className="text-[10px] text-grey-30">
                  {activePack.selectedFiles.length > 0
                    ? `${activePack.selectedFiles.length} files attached · ~${contextTokens.toLocaleString()} tokens`
                    : `Brief only · ~${contextTokens.toLocaleString()} tokens`}
                </div>
              </div>

              <div className="flex gap-1.5 flex-wrap">
                <button onClick={handleEditPack}
                  className="cta-text px-3 py-1.5 border border-border text-grey-50 hover:border-green hover:text-green transition-colors duration-300">
                  Edit
                </button>
                <button onClick={() => { setMode("create"); loadRepos(); }}
                  className="cta-text px-3 py-1.5 border border-border text-grey-50 hover:border-green hover:text-green transition-colors duration-300">
                  Switch
                </button>
                <button onClick={handleExport}
                  className="cta-text px-3 py-1.5 border border-border text-grey-50 hover:border-green hover:text-green transition-colors duration-300">
                  Export
                </button>
                <button onClick={() => { onPackChange(null); onContextEnabledChange(false); setActivePackId(null); setMode("create"); }}
                  className="cta-text px-3 py-1.5 border border-border text-grey-40 hover:border-red-300 hover:text-red-500 transition-colors duration-300">
                  Disable
                </button>
              </div>

              {/* Other packs */}
              {packs.length > 1 && (
                <div className="space-y-1">
                  <span className="text-[10px] text-grey-30 uppercase tracking-wider">Other Packs</span>
                  {packs.filter((p) => p.id !== activePack.id).map((p) => (
                    <button key={p.id} onClick={() => handleSwitchPack(p)}
                      className="w-full text-left text-xs px-3 py-2 border border-border hover:border-green/40 transition-colors flex items-center justify-between">
                      <span className="text-grey-60">{p.name}</span>
                      <span className="text-[9px] text-grey-20">{p.repo.split("/").pop()}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Rate limit */}
              {rateLimit && rateLimit.remaining < 500 && (
                <div className="text-[9px] text-gold">
                  ⚠ {rateLimit.remaining} GitHub API calls remaining (resets {new Date(rateLimit.resetAt * 1000).toLocaleTimeString()})
                </div>
              )}
            </div>
          )}

          {/* Create / edit mode */}
          {(mode === "create" || mode === "edit") && (
            <div className="space-y-3">
              {/* Repo selector */}
              <div>
                <input
                  type="text"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  onFocus={() => { if (repos.length === 0) loadRepos(); }}
                  placeholder="Search repositories..."
                  className="w-full bg-grey-5 border border-border px-3 py-2 text-xs text-ink placeholder:text-grey-30 focus:outline-none focus:border-green"
                />
                {reposLoading && <p className="text-[10px] text-grey-30 mt-1">Loading repos...</p>}
                {repos.length > 0 && !selectedRepo && (
                  <div className="max-h-40 overflow-y-auto border border-border border-t-0 bg-white">
                    {repos
                      .filter((r) => !repoFilter || r.full_name.toLowerCase().includes(repoFilter.toLowerCase()))
                      .slice(0, 50)
                      .map((r) => (
                        <button key={r.full_name} onClick={() => { handleRepoSelect(r.full_name); setRepoFilter(""); }}
                          className="w-full text-left text-xs px-3 py-1.5 hover:bg-grey-5 transition-colors flex items-center justify-between">
                          <span className="text-grey-60">{r.full_name}</span>
                          {r.private && <span className="text-[8px] text-grey-20">private</span>}
                        </button>
                      ))}
                  </div>
                )}
                {selectedRepo && (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-grey-60">{selectedRepo}</span>
                    <button onClick={() => { setSelectedRepo(""); setTreeNodes([]); setBrief(""); setSelectedTemplateId(""); setTemplateSuggestedFiles([]); }}
                      className="text-[10px] text-grey-30 hover:text-grey-60">✕</button>
                  </div>
                )}
              </div>

              {/* Branch selector */}
              {selectedRepo && branches.length > 0 && (
                <select
                  value={selectedBranch}
                  onChange={(e) => handleBranchChange(e.target.value)}
                  className="w-full bg-grey-5 border border-border px-3 py-2 text-xs text-ink focus:outline-none focus:border-green appearance-none cursor-pointer"
                >
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>{b.name}</option>
                  ))}
                </select>
              )}

              {/* Context templates */}
              {treeNodes.length > 0 && (
                <div className="border border-border bg-grey-5/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-grey-30 uppercase tracking-wider">Context Template</span>
                    {selectedTemplateId && (
                      <span className="text-[9px] text-gold">
                        {templateSuggestedFiles.length} suggested files
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {CONTEXT_PACK_TEMPLATES.map((template) => (
                      <button
                        key={template.id}
                        onClick={() => handleApplyTemplate(template.id)}
                        className={cn(
                          "text-left border px-2.5 py-2 transition-colors",
                          selectedTemplateId === template.id
                            ? "border-green bg-green-light"
                            : "border-border bg-white hover:border-green/50"
                        )}
                      >
                        <span className="block text-xs font-medium text-grey-60">{template.name}</span>
                        <span className="block text-[10px] text-grey-30 leading-relaxed mt-0.5">{template.description}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-grey-30">
                    Templates preselect likely useful files and add a review-focus note to the repo brief. You can still edit everything before saving.
                  </p>
                </div>
              )}

              {/* Brief editor */}
              {brief && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-grey-30 uppercase tracking-wider">Repo Brief</span>
                    <span className="text-[9px] text-grey-20">~{estimateTokens(brief).toLocaleString()} tokens</span>
                  </div>
                  <textarea
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    rows={8}
                    className="w-full bg-grey-5 border border-border px-3 py-2 text-xs text-ink font-mono leading-relaxed focus:outline-none focus:border-green resize-y"
                  />
                  {anthropicKey && (
                    <button
                      onClick={handleEnhance}
                      disabled={enhancing}
                      className={cn(
                        "cta-text px-4 py-2 transition-colors duration-300",
                        enhancing
                          ? "bg-grey-5 text-grey-30 cursor-wait"
                          : "border border-gold text-gold hover:bg-gold/10"
                      )}
                    >
                      {enhancing ? "Enhancing with Claude..." : "Enhance with Claude"}
                    </button>
                  )}
                  {enhanceError && (
                    <p className="text-[10px] text-red-500">{enhanceError}</p>
                  )}
                </div>
              )}

              {/* File tree */}
              {treeLoading && <p className="text-[10px] text-grey-30">Loading file tree...</p>}

              {treeNodes.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowTree(!showTree)}
                    className="cta-text text-grey-40 hover:text-green transition-colors flex items-center gap-1.5"
                  >
                    <span>{showTree ? "▾" : "▸"}</span>
                    Attach Files ({selectedFiles.size} selected)
                  </button>

                  {/* Detected file references */}
                  {detectedFiles.length > 0 && !showTree && (
                    <div className="mt-2 border border-gold/30 bg-gold/5 p-2">
                      <p className="text-[10px] text-gold mb-1">
                        {detectedFiles.length} files referenced in your content:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {detectedFiles.slice(0, 5).map((f) => (
                          <button key={f}
                            onClick={() => { if (!selectedFiles.has(f)) handleToggleFile(f); }}
                            className={cn(
                              "text-[9px] px-2 py-0.5 border transition-colors",
                              selectedFiles.has(f)
                                ? "border-green bg-green-light text-green"
                                : "border-gold/30 text-gold hover:border-gold"
                            )}
                          >
                            {f.split("/").pop()}
                          </button>
                        ))}
                        {detectedFiles.length > 5 && (
                          <button onClick={() => setShowTree(true)}
                            className="text-[9px] text-gold hover:underline">
                            +{detectedFiles.length - 5} more
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {showTree && (
                    <div className="mt-2 space-y-2">
                      {treeTruncated && (
                        <div className="text-[9px] text-gold bg-gold/5 px-2 py-1">
                          Large repo — browsing by folder. Some files may require expanding directories.
                        </div>
                      )}

                      {/* Search filter */}
                      <input
                        type="text"
                        value={treeFilter}
                        onChange={(e) => setTreeFilter(e.target.value)}
                        placeholder="Filter files..."
                        className="w-full bg-grey-5 border border-border px-3 py-1.5 text-[10px] text-ink placeholder:text-grey-30 focus:outline-none focus:border-green"
                      />

                      {/* Secret warnings */}
                      {secretWarnings.size > 0 && (
                        <div className="text-[10px] text-red-600 bg-red-50 border border-red-200 p-2 space-y-1">
                          <p className="font-medium">Potential secrets detected:</p>
                          {[...secretWarnings.entries()].map(([path, types]) => (
                            <p key={path}>{path}: {types.join(", ")}</p>
                          ))}
                        </div>
                      )}

                      {/* File count + tokens */}
                      <div className="flex justify-between text-[9px] text-grey-30">
                        <span>{selectedFiles.size} files selected</span>
                        <span>
                          {loadingFiles.size > 0 ? "Loading..." : ""}
                        </span>
                      </div>

                      {/* Tree */}
                      <div className="max-h-[300px] overflow-y-auto border border-border bg-white">
                        {filteredTree.slice(0, 500).map((node) => (
                          <FileTreeNode
                            key={node.path}
                            node={node}
                            depth={0}
                            selectedFiles={selectedFiles}
                            onToggleFile={handleToggleFile}
                            onExpandDir={handleExpandDir}
                            suggestedFiles={new Set([...detectedFiles, ...templateSuggestedFiles])}
                            blockedTooltip={(path) => {
                              if (isBlockedFile(path)) return "Potentially sensitive file — blocked";
                              if (!isAllowedExtension(path)) return "Unsupported file type";
                              return null;
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Pack name + save */}
              {brief && (
                <div className="space-y-2 pt-2 border-t border-border">
                  <input
                    type="text"
                    value={packName}
                    onChange={(e) => setPackName(e.target.value)}
                    placeholder="Pack name (e.g., LuxApts Core)"
                    className="w-full bg-grey-5 border border-border px-3 py-2 text-xs text-ink placeholder:text-grey-30 focus:outline-none focus:border-green"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSavePack}
                      disabled={!packName.trim() || !selectedRepo}
                      className="flex-1 py-2 bg-green text-cream cta-text tracking-[0.15em] hover:bg-green-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-300"
                    >
                      {mode === "edit" ? "Update Pack" : "Save Pack"}
                    </button>
                    {mode === "edit" && (
                      <button
                        onClick={() => setMode("view")}
                        className="px-4 py-2 border border-border text-grey-50 cta-text hover:border-green hover:text-green transition-colors duration-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Import + local files */}
              <div className="flex gap-2 flex-wrap items-center">
                <button
                  onClick={() => localFilesRef.current?.click()}
                  className="cta-text text-grey-30 hover:text-green transition-colors"
                >
                  Attach Local Files
                </button>
                <button
                  onClick={() => localFolderRef.current?.click()}
                  className="cta-text text-grey-30 hover:text-green transition-colors"
                >
                  Attach Local Folder
                </button>
                <button
                  onClick={() => importRef.current?.click()}
                  className="cta-text text-grey-30 hover:text-green transition-colors"
                >
                  Import Pack
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept=".json"
                  onChange={handleImport}
                  className="hidden"
                />
                <input ref={localFilesRef} type="file" multiple onChange={(e) => { handleLocalFiles(e.target.files); e.target.value = ""; }} className="hidden" />
                <input ref={localFolderRef} type="file" multiple onChange={(e) => { handleLocalFiles(e.target.files); e.target.value = ""; }} className="hidden" />
              </div>

              {/* Existing packs list */}
              {packs.length > 0 && mode === "create" && (
                <div className="space-y-1 pt-2 border-t border-border">
                  <span className="text-[10px] text-grey-30 uppercase tracking-wider">Saved Packs</span>
                  {packs.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-xs px-3 py-2 border border-border">
                      <button onClick={() => handleSwitchPack(p)} className="text-left flex-1 text-grey-60 hover:text-green transition-colors">
                        {p.name}
                        <span className="text-[9px] text-grey-20 ml-2">{p.repo.split("/").pop()}</span>
                      </button>
                      <button onClick={() => handleDeletePack(p.id)} className="text-[9px] text-grey-20 hover:text-red-500 ml-2">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty create state */}
          {mode === "create" && !activePack && repos.length === 0 && !reposLoading && (
            <button
              onClick={loadRepos}
              className="w-full py-3 border border-dashed border-border text-grey-30 text-xs hover:border-green hover:text-green transition-colors"
            >
              Select a repository to create a context pack
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- Utility: filter tree by search ---
function filterTreeNode(node: TreeNode, query: string): TreeNode | null {
  if (node.type === "file") {
    return node.name.toLowerCase().includes(query) ? node : null;
  }

  const filteredChildren = node.children
    .map((c) => filterTreeNode(c, query))
    .filter(Boolean) as TreeNode[];

  if (filteredChildren.length > 0 || node.name.toLowerCase().includes(query)) {
    return { ...node, children: filteredChildren, expanded: true };
  }
  return null;
}
