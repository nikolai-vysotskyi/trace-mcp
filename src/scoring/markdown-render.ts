/**
 * Markdown rendering for context-tool responses.
 *
 * LLMs handle Markdown more naturally than nested JSON for source-code context:
 * code fences trigger syntax-aware reasoning, headings provide structure, and
 * the absence of quoted-string escaping reduces token overhead. We use this for
 * `get_feature_context`, `get_task_context`, and (already) `get_context_bundle`.
 *
 * The rendered string is exposed as a top-level `content` field — the original
 * structured fields (`items`, `symbols`, etc.) are dropped to save tokens, since
 * the Markdown form already encodes them.
 */

interface MarkdownItem {
  /** Symbol/file/etc. — used as section header */
  name?: string | null;
  symbol_id?: string | null;
  file?: string | null;
  /** Source code content. Rendered inside a fenced block. */
  source?: string | null;
  /** Optional language hint for the fence (typescript, python, etc.). */
  language?: string | null;
  /** Optional score / metadata to surface above the fence. */
  score?: number | null;
}

export interface MarkdownRenderOptions {
  /** Heading shown at the top of the document. */
  title?: string;
  /** Optional summary line under the title. */
  subtitle?: string;
  /** Section heading per group of items. Defaults to "Context" when omitted. */
  sectionTitle?: string;
}

/**
 * Render a flat list of code items to Markdown. Items without `source` are
 * rendered as bullet entries; items with `source` get a header + code fence.
 */
export function renderItemsMarkdown(
  items: MarkdownItem[],
  opts: MarkdownRenderOptions = {},
): string {
  const lines: string[] = [];
  if (opts.title) lines.push(`# ${opts.title}`);
  if (opts.subtitle) lines.push(opts.subtitle);
  if (lines.length > 0) lines.push('');

  if (items.length === 0) {
    lines.push('_No items._');
    return lines.join('\n');
  }

  const sectionTitle = opts.sectionTitle ?? 'Context';
  lines.push(`## ${sectionTitle}`);
  lines.push('');

  for (const item of items) {
    const headingParts: string[] = [];
    if (item.name) headingParts.push(`\`${item.name}\``);
    if (item.file) headingParts.push(`— ${item.file}`);
    const heading = headingParts.length > 0 ? `### ${headingParts.join(' ')}` : '###';
    lines.push(heading);

    if (item.source) {
      const lang = item.language ?? guessLanguageFromPath(item.file);
      lines.push('');
      lines.push(`\`\`\`${lang ?? ''}`);
      lines.push(item.source.trimEnd());
      lines.push('```');
    } else if (item.symbol_id) {
      lines.push(`_${item.symbol_id}_`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Render a multi-section context (primary symbols + tests + entry points etc.)
 * to Markdown. Each section is rendered iff it has items.
 */
export function renderSectionsMarkdown(sections: {
  title?: string;
  subtitle?: string;
  groups: Array<{ title: string; items: MarkdownItem[] }>;
}): string {
  const lines: string[] = [];
  if (sections.title) lines.push(`# ${sections.title}`);
  if (sections.subtitle) lines.push(sections.subtitle);
  if (lines.length > 0) lines.push('');

  for (const group of sections.groups) {
    if (group.items.length === 0) continue;
    const rendered = renderItemsMarkdown(group.items, { sectionTitle: group.title });
    // renderItemsMarkdown already includes "## title"; drop the leading title from this call's title
    lines.push(rendered);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function guessLanguageFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  )
    return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.rb')) return 'ruby';
  if (lower.endsWith('.php')) return 'php';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) return 'kotlin';
  if (lower.endsWith('.swift')) return 'swift';
  if (lower.endsWith('.cs')) return 'csharp';
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx')) return 'cpp';
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'bash';
  if (lower.endsWith('.sql')) return 'sql';
  return null;
}
