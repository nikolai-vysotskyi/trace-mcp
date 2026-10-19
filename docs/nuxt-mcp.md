---
title: "Nuxt MCP Server: Code Graph & Context for AI Agents"
description: "Code graph MCP server for Nuxt 3 and 4. Indexes file-based routes, Nitro API endpoints, auto-imports, and composables for AI coding agents."
updated: 2026-10-20
category: frameworks
---

# Nuxt MCP server: code graph for AI agents

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/nuxt-mcp.html",
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
        "@id": "https://trace-mcp.com/nuxt-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How does trace-mcp handle Nuxt auto-imports without import statements?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "trace-mcp indexes symbols in composables/, utils/, and server/utils/, automatically linking un-imported functions in Vue components and pages to their definitions."
          }
        },
        {
          "@type": "Question",
          "name": "Does trace-mcp connect useFetch calls to Nitro server API routes?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. The Nuxt plugin extracts URL path literals from useFetch and useAsyncData calls, connecting frontend data fetching directly to server/api/ endpoint handlers in the graph."
          }
        },
        {
          "@type": "Question",
          "name": "Does trace-mcp support Nuxt 4 app/ directory structures?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. trace-mcp recognizes Nuxt 4 compatibility mode, indexing pages, layouts, and components located under app/pages/ as well as classic root pages/."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Nuxt relies extensively on conventions and auto-imports: composables, utilities, and components are used without explicit `import` statements, leaving AI agents guessing where functions are defined. trace-mcp indexes Nuxt conventions, resolving auto-imports, file-based routes, and Nitro API calls into an explicit, queryable graph.

---

## What trace-mcp extracts in Nuxt

Nuxt projects combine Vue frontend architecture with Nitro server routes. The `nuxt` plugin extracts:

- **File-Based Routing:** Full route tree extraction from `pages/` (and Nuxt 4 `app/pages/`), handling dynamic parameters (`[id]`), catch-alls (`[...slug]`), and nested routes.
- **Nitro Server API Routes:** Endpoint mapping from `server/api/` (e.g., `server/api/users.get.ts` → `GET /api/users`), middleware, and server utilities.
- **Auto-Imports:** Resolution of implicit globals in `composables/`, `utils/`, and `server/utils/` without requiring explicit import statements in `.vue` files.
- **Data Fetching Connections:** Extraction of `useFetch` and `useAsyncData` call targets, linking frontend pages to their server API route handlers.
- **Layouts & Middleware:** Mapping between page front-matter / `definePageMeta` declarations and files in `layouts/` and `middleware/`.
- **Nuxt 3 & Nuxt 4 Compatibility:** Full detection of Nuxt 4 compatibility mode, `app/` folder hierarchies, and configuration settings.

---

## Installation & Quickstart

Install trace-mcp globally, run initialization, and connect your Nuxt repository:

```bash
npm i -g trace-mcp && trace init && trace add
```

### Example question to your agent

> "Which Nitro API routes in `server/api/` are called by `pages/checkout/[id].vue`, and what shared composables does that page rely on?"

The agent uses `trace-mcp` tools to trace the full request path from frontend Vue component to backend Nitro handler in a single step.

---

## Without graph vs with trace-mcp

Measurements below reflect corpus-level benchmarks from our [PR review context benchmark](pr-context-benchmark.md) across {{ site.data.pr_context_bench.pr_count }} pull requests.

| Capability | Without graph | With trace-mcp |
|---|---|---|
| **Median input tokens** | ~{{ site.data.pr_context_bench.baseline_median_tokens }} tokens | ~{{ site.data.pr_context_bench.trace_median_tokens }} tokens (-{{ site.data.pr_context_bench.median_savings_pct }}%) |
| **Auto-import resolution** | AI fails to locate un-imported symbols | Auto-imports mapped to definitions |
| **Data fetching paths** | Blind to `useFetch` targets | Direct edge from `useFetch` to `/api/*` |
| **File-based routing** | Manual path reconstruction | Complete URI route table extracted |
| **Nuxt 4 app/ layout** | Confused by multi-directory roots | Detects Nuxt 4 compatibility layout |
| **Tools exposed** | None (reads full files) | {{ site.data.counts.tools }} specialized MCP tools |

---

## Frequently asked questions

### How does trace-mcp handle Nuxt auto-imports without import statements?
trace-mcp indexes symbols in `composables/`, `utils/`, and `server/utils/`, automatically linking un-imported functions in Vue components and pages to their definitions.

### Does trace-mcp connect `useFetch` calls to Nitro server API routes?
Yes. The Nuxt plugin extracts URL path literals from `useFetch` and `useAsyncData` calls, connecting frontend data fetching directly to `server/api/` endpoint handlers in the graph.

### Does trace-mcp support Nuxt 4 `app/` directory structures?
Yes. trace-mcp recognizes Nuxt 4 compatibility mode, indexing pages, layouts, and components located under `app/pages/` as well as classic root `pages/`.

---

## Next steps

Explore the full [Tools reference](tools-reference.md) for available query tools, see the [Language capability matrix](language-matrix.md) for TypeScript and Vue parsing details, view [Comparisons](comparisons.md) against other tools, or browse all [Supported frameworks](supported-frameworks.md).
