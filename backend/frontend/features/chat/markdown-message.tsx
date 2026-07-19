import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/ui/code-block";

export function MarkdownMessage({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="max-w-[680px] type-body text-foreground [&>*+*]:mt-3.5 [&_a]:text-foreground [&_a]:underline [&_a]:decoration-border-strong [&_a]:underline-offset-4 hover:[&_a]:text-primary [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:py-1 [&_blockquote]:pl-4 [&_blockquote]:text-text-secondary [&_h1]:mt-8 [&_h1]:type-section-title [&_h2]:mt-8 [&_h2]:type-panel-title [&_h3]:mt-7 [&_h3]:type-body-strong [&_li]:ml-5 [&_li]:mt-2 [&_ol]:list-decimal [&_p]:leading-7 [&_table]:block [&_table]:overflow-x-auto [&_ul]:list-disc"
      components={{
        pre({ children: preChildren }) { return <>{preChildren}</>; },
        code({ className, children: codeChildren, ...props }) {
          const match = /language-(\w+)/.exec(className ?? "");
          const source = String(codeChildren).replace(/\n$/, "");
          if (!match) return <code className="rounded bg-code px-1.5 py-0.5 type-mono text-code-foreground" {...props}>{codeChildren}</code>;
          return <CodeBlock source={source} language={match[1] ?? "text"} />;
        },
      }}
    >{children}</ReactMarkdown>
  );
}
