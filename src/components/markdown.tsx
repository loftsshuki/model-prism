import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Raw HTML and remote images are deliberately disabled for untrusted model output. */
export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{children}</a>,
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
    table: ({ children }) => <div className="overflow-x-auto my-4"><table className="w-full border-collapse text-left">{children}</table></div>,
    th: ({ children }) => <th className="border border-border bg-grey-5 px-3 py-2 font-medium">{children}</th>,
    td: ({ children }) => <td className="border border-border px-3 py-2 align-top">{children}</td>,
    pre: ({ children }) => <pre className="overflow-x-auto whitespace-pre p-4 bg-grey-5 rounded">{children}</pre>,
  }}>{children}</ReactMarkdown>;
}
