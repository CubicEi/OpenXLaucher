"use client";

import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type ChangelogMarkdownProps = {
  content: string;
  className?: string;
};

/**
 * 轻量 Markdown 渲染（零依赖），覆盖更新日志常见语法：
 * 标题、列表、引用、代码块、分割线、粗斜体、行内代码、链接。
 */
export function ChangelogMarkdown({ content, className }: ChangelogMarkdownProps) {
  const text = content.trim();
  if (!text) return null;

  return (
    <div
      className={cn(
        "changelog-md max-h-64 overflow-auto break-words rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground/80",
        "[&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground",
        "[&_h2]:mb-1.5 [&_h2]:mt-2.5 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:text-foreground",
        "[&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-foreground",
        "[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0",
        "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:space-y-0.5 [&_ul]:pl-4",
        "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:space-y-0.5 [&_ol]:pl-4",
        "[&_li]:leading-relaxed",
        "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_hr]:my-2.5 [&_hr]:border-border",
        "[&_a]:text-sky-600 [&_a]:underline-offset-2 hover:[&_a]:underline dark:[&_a]:text-sky-400",
        "[&_code]:rounded [&_code]:bg-background/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-background/70 [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-[0.85em]",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_strong]:font-semibold [&_strong]:text-foreground",
        "[&_em]:italic",
        className,
      )}
    >
      {renderBlocks(text)}
    </div>
  );
}

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      nodes.push(
        <pre key={key++}>
          <code data-lang={lang || undefined}>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line) || /^___+\s*$/.test(line)) {
      nodes.push(<hr key={key++} />);
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      nodes.push(
        <Tag key={key++}>{renderInline(heading[2].trim())}</Tag>,
      );
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      nodes.push(
        <blockquote key={key++}>
          {quoteLines.map((q, qi) => (
            <p key={qi}>{renderInline(q)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      nodes.push(
        <ListTag key={key++}>
          {items.map((item, ii) => (
            <li key={ii}>{renderInline(item)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^\*\*\*+\s*$/.test(lines[i]) &&
      !/^___+\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    nodes.push(
      <p key={key++}>
        {para.map((p, pi) => (
          <Fragment key={pi}>
            {pi > 0 ? <br /> : null}
            {renderInline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return nodes;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // links, images-as-links, bold, italic, strike, inline code
  const re =
    /(!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(`([^`]+)`)|(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)|(~~([^~]+)~~)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(<Fragment key={key++}>{text.slice(last, match.index)}</Fragment>);
    }

    if (match[1] !== undefined) {
      const label = match[2];
      const href = sanitizeHref(match[3]);
      if (href) {
        nodes.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
            {label || href}
          </a>,
        );
      } else {
        nodes.push(<Fragment key={key++}>{match[0]}</Fragment>);
      }
    } else if (match[4] !== undefined) {
      nodes.push(<code key={key++}>{match[5]}</code>);
    } else if (match[6] !== undefined) {
      nodes.push(
        <strong key={key++}>
          <em>{match[7]}</em>
        </strong>,
      );
    } else if (match[8] !== undefined || match[10] !== undefined) {
      nodes.push(<strong key={key++}>{match[9] ?? match[11]}</strong>);
    } else if (match[12] !== undefined || match[14] !== undefined) {
      nodes.push(<em key={key++}>{match[13] ?? match[15]}</em>);
    } else if (match[16] !== undefined) {
      nodes.push(
        <span key={key++} className="line-through opacity-80">
          {match[17]}
        </span>,
      );
    }

    last = match.index + match[0].length;
  }

  if (last < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  }

  return nodes;
}

function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}
