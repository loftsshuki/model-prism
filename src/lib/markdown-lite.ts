// Minimal, escape-first markdown → HTML for model output.
//
// The synthesis view used to run a regex chain directly over the model's text and
// hand the result to dangerouslySetInnerHTML. Model output quotes untrusted input
// (PR diffs, repo files, pasted content), so an `<img onerror>` echoed by any
// council model executed in the reviewer's browser — with the API keys in
// localStorage in reach. Everything is HTML-escaped BEFORE any markup is added,
// so the only tags that can appear are the ones this file emits.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
}

/**
 * Supports: # / ## / ### headings, fenced code blocks, unordered (- *) and ordered
 * (1.) lists, blockquotes, **bold**, *italic*, `code`, and paragraphs.
 * Output contains only the tags emitted here; all source text is escaped.
 */
export function renderMarkdownLite(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inCode = false;
  let code: string[] = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const openList = (kind: "ul" | "ol") => {
    if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
  };

  for (const raw of lines) {
    const line = escapeHtml(raw);

    if (line.trim().startsWith("```")) {
      if (inCode) { out.push(`<pre><code>${code.join("\n")}</code></pre>`); code = []; inCode = false; }
      else { flushPara(); closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); closeList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) { flushPara(); openList("ul"); out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) { flushPara(); openList("ol"); out.push(`<li>${inline(ol[1])}</li>`); continue; }
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) { flushPara(); closeList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if (list) closeList();
    para.push(line.trim());
  }
  if (inCode) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushPara();
  closeList();
  return out.join("\n");
}
