---
title: "Laravel MCP Server: Code Graph & Context for AI Agents"
description: "Code graph MCP server for Laravel. Indexes routes, Eloquent relationships, controllers, migrations, and events for precise AI agent code context."
updated: 2026-10-20
category: frameworks
---

# Laravel MCP server: code graph for AI agents

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/laravel-mcp.html",
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
        "@id": "https://trace-mcp.com/laravel-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does trace-mcp support Laravel 11 and 12/13 with bootstrap/app.php?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. trace-mcp extracts routing, middleware, and exception configurations from modern bootstrap/app.php definitions (withRouting, withMiddleware) as well as classic app/Http/Kernel.php and RouteServiceProvider setups."
          }
        },
        {
          "@type": "Question",
          "name": "How does trace-mcp resolve Eloquent relationships?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The indexer inspects Eloquent model method calls like hasMany, belongsTo, belongsToMany, and hasOne, linking related models across files and cross-referencing migration schemas."
          }
        },
        {
          "@type": "Question",
          "name": "Does trace-mcp understand Livewire and Filament in Laravel?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Dedicated sub-plugins index Livewire component classes, properties, actions, and Blade views, as well as Filament resources, relation managers, panels, and widgets."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** LLMs writing Laravel code often hallucinate Eloquent method names, miss FormRequest validation bindings, and overlook route-to-controller mapping. trace-mcp indexes the entire Laravel topology into a local SQLite graph so Claude Code, Cursor, and other AI agents query exact architecture edges instead of dumping thousands of lines into the prompt.

---

## What trace-mcp extracts in Laravel

Laravel relies on convention, facades, and dynamic magic that raw text search cannot connect. The `laravel` plugin extracts:

- **Routes & Controllers:** Route definitions (`Route::get`, `post`, `resource`, `apiResource`), controller action targets, invokable controllers, and group prefixes.
- **Modern & Classic Bootstrap:** Route bindings from `bootstrap/app.php` (`withRouting`) and classic `RouteServiceProvider` / `Kernel.php`.
- **Eloquent Models & Associations:** `belongsTo`, `hasMany`, `hasOne`, `belongsToMany`, scopes, and migration schema definitions.
- **FormRequests:** Validation bindings linking request validation classes to controller action parameters.
- **Events & Listeners:** `Event::listen` definitions, subscriber classes, event dispatching, and queueable listener bindings.
- **Broadcasting & Middleware:** Channel authorizations (`routes/channels.php`), broadcast events, and global/route middleware stacks.
- **Ecosystem Packages:** First-class indexing for Laravel Livewire, Filament, Nova, Spatie Laravel Data, and Laravel Pennant.

---

## Installation & Quickstart

Install trace-mcp globally, run initialization, and connect your Laravel repository:

```bash
npm i -g trace-mcp && trace init && trace add
```

### Example question to your agent

> "Which Eloquent models, migrations, and FormRequests are affected if I modify the payment transaction status transitions, and what controllers route to it?"

The agent calls `trace-mcp` tools like `get_symbol`, `get_callers`, or `find_impact` to inspect the exact subgraph without reading irrelevant controllers or models.

---

## Without graph vs with trace-mcp

Measurements below reflect corpus-level benchmarks from our [PR review context benchmark](pr-context-benchmark.md) across {{ site.data.pr_context_bench.pr_count }} pull requests.

| Capability | Without graph | With trace-mcp |
|---|---|---|
| **Median input tokens** | ~{{ site.data.pr_context_bench.baseline_median_tokens }} tokens | ~{{ site.data.pr_context_bench.trace_median_tokens }} tokens (-{{ site.data.pr_context_bench.median_savings_pct }}%) |
| **Eloquent relations** | Guesses via grep | Exact relational graph edges |
| **Route to Controller mapping** | Relies on exact text search | Resolves closures, namespaces, groups |
| **FormRequest validation** | Must load request file manually | Automatic caller-to-request edge |
| **Livewire & Filament context** | Misses view-to-component linkage | Explicit component and action edges |
| **Tools exposed** | None (reads full files) | {{ site.data.counts.tools }} specialized MCP tools |

---

## Frequently asked questions

### Does trace-mcp support Laravel 11 and 12/13 with `bootstrap/app.php`?
Yes. trace-mcp extracts routing, middleware, and exception configurations from modern `bootstrap/app.php` definitions (`withRouting`, `withMiddleware`) as well as classic `app/Http/Kernel.php` and `RouteServiceProvider` setups.

### How does trace-mcp resolve Eloquent relationships?
The indexer inspects Eloquent model method calls like `hasMany`, `belongsTo`, `belongsToMany`, and `hasOne`, linking related models across files and cross-referencing migration schemas.

### Does trace-mcp understand Livewire and Filament in Laravel?
Yes. Dedicated sub-plugins index Livewire component classes, properties, actions, and Blade views, as well as Filament resources, relation managers, panels, and widgets.

---

## Next steps

Explore the full [Tools reference](tools-reference.md) for available query tools, see the [Language capability matrix](language-matrix.md) for PHP AST details, view [Comparisons](comparisons.md) against other tools, or browse all [Supported frameworks](supported-frameworks.md).
