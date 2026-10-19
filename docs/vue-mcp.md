---
title: "Vue MCP Server: Code Graph & Component Context for AI"
description: "Code graph MCP server for Vue.js. Indexes Single File Components, script setup symbols, props, emits, and composables for AI coding assistants."
updated: 2026-10-20
category: frameworks
---

# Vue MCP server: code graph for AI agents

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vue-mcp.html",
      "datePublished": "2026-10-20",
      "dateModified": {{ page.updated | jsonify }},
      "author": {
        "@type": "Person",
        "name": "Nikolai Vysotskyi",
        "url": "https://github.com/nikolai-vysotskyi"
      },
      "publisher": {
        "@type": "Person",
        "name": "Nikolai Vysotskyi",
        "url": "https://github.com/nikolai-vysotskyi"
      },
      "mainEntityOfPage": {
        "@type": "WebPage",
        "@id": "https://trace-mcp.com/vue-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does trace-mcp support script setup and TypeScript in Vue SFCs?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. trace-mcp uses full AST parsing for Vue Single File Components, extracting defineProps, defineEmits, composables, and TypeScript types directly from script setup blocks."
          }
        },
        {
          "@type": "Question",
          "name": "How does trace-mcp resolve PascalCase vs kebab-case component tags?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The Vue resolver handles component naming bidirectional resolution, mapping template tags like <user-avatar /> to UserAvatar.vue and building parent-child component render tree edges."
          }
        },
        {
          "@type": "Question",
          "name": "Can trace-mcp track shared composables across components?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. trace-mcp traces composables (such as useAuth or useCart) from definition to usage, connecting state management and utility imports across components."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** AI coding agents working on Vue projects frequently lose track of component hierarchies, prop types across parent-child templates, and custom emit events. trace-mcp indexes Vue SFCs into a structural dependency graph, allowing AI agents to navigate render trees, script setup bindings, and composables with minimal token consumption.

---

## What trace-mcp extracts in Vue

Vue Single File Components (SFCs) bundle template, script, and styling together. The `vue` plugin extracts:

- **Single File Components (SFC):** Full AST parsing for `.vue` files, extracting template references, scripts, and component declarations.
- **Composition & Options API:** Complete support for `<script setup>`, `defineProps`, `defineEmits`, `defineExpose`, and Options API options (`methods`, `computed`, `props`).
- **Template Tag Resolution:** Automatic bidirectional mapping between kebab-case `<custom-card>` and PascalCase `CustomCard.vue` component files.
- **Component Render Trees:** Parent-child edges connecting components to subcomponents instantiated in their templates.
- **Composable Usage:** Edges tracking imports and invocations of reusable composables (`use*`) across views and components.
- **TypeScript Integration:** Type-aware analysis linking exported interfaces and types to component props.

---

## Installation & Quickstart

Install trace-mcp globally, run initialization, and connect your Vue repository:

```bash
npm i -g trace-mcp && trace init && trace add
```

### Example question to your agent

> "Which components render `UserProfile.vue`, what props do they pass, and what events are emitted back to parent views?"

The agent queries `trace-mcp` tools to trace the component hierarchy and props interface without dumping entire Vue SFC files into context.

---

## Without graph vs with trace-mcp

Measurements below reflect corpus-level benchmarks from our [PR review context benchmark](pr-context-benchmark.md) across {{ site.data.pr_context_bench.pr_count }} pull requests.

| Capability | Without graph | With trace-mcp |
|---|---|---|
| **Median input tokens** | ~{{ site.data.pr_context_bench.baseline_median_tokens }} tokens | ~{{ site.data.pr_context_bench.trace_median_tokens }} tokens (-{{ site.data.pr_context_bench.median_savings_pct }}%) |
| **Component hierarchy** | Must read every parent SFC | Direct parent-child render tree edges |
| **Props & Emits validation** | Hallucinates prop types | Typed symbol signatures from AST |
| **Tag casing resolution** | Misses kebab-case matches | Automatic kebab ↔ PascalCase resolution |
| **Composable dependency** | Greps for function names | Graph edges from composable to consumer |
| **Tools exposed** | None (reads full files) | {{ site.data.counts.tools }} specialized MCP tools |

---

## Frequently asked questions

### Does trace-mcp support `script setup` and TypeScript in Vue SFCs?
Yes. trace-mcp uses full AST parsing for Vue Single File Components, extracting `defineProps`, `defineEmits`, composables, and TypeScript types directly from `<script setup>` blocks.

### How does trace-mcp resolve PascalCase vs kebab-case component tags?
The Vue resolver handles component naming bidirectional resolution, mapping template tags like `<user-avatar />` to `UserAvatar.vue` and building parent-child component render tree edges.

### Can trace-mcp track shared composables across components?
Yes. trace-mcp traces composables (such as `useAuth` or `useCart`) from definition to usage, connecting state management and utility imports across components.

---

## Next steps

Explore the full [Tools reference](tools-reference.md) for available query tools, see the [Language capability matrix](language-matrix.md) for Vue SFC parser details, view [Comparisons](comparisons.md) against other tools, or browse all [Supported frameworks](supported-frameworks.md).
