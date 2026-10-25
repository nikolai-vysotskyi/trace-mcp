---
title: "Django MCP Server: Code Graph & Context for AI Agents"
description: "Code graph MCP server for Django. Indexes models, URL patterns, views, admin registrations, and signals for fast, token-efficient AI context."
updated: 2026-10-24
category: frameworks
---

# Django MCP server: code graph for AI agents

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/django-mcp.html",
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
        "@id": "https://trace-mcp.com/django-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How does trace-mcp index Django signals across apps?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "trace-mcp parses @receiver decorators and signal.connect() calls, creating explicit graph edges that connect signal senders to receiver functions even when defined in separate apps."
          }
        },
        {
          "@type": "Question",
          "name": "Does trace-mcp support Django REST Framework (DRF)?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. It indexes DRF DefaultRouter and SimpleRouter registrations, linking registered routes to ViewSet classes, and connects views to explicit model or queryset definitions."
          }
        },
        {
          "@type": "Question",
          "name": "Does trace-mcp connect Django admin registrations to models?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. It indexes @admin.register() decorators and admin.site.register() calls, building django_admin_registers edges between ModelAdmin classes and models."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Which views, admin registrations, and signal receivers depend on a modified Django model? trace-mcp indexes your existing Django repository into a local static code graph. AI coding agents query URL patterns, CBV/FBV definitions, model relationships, and `@receiver` signal bindings directly through MCP instead of running broad text searches across apps.

---

## What trace-mcp extracts in Django

The `django` plugin indexes Django 2.x through 5.x applications:

- **Models & Relationships:** Subclasses of `models.Model`, `ForeignKey`, `ManyToManyField`, and `OneToOneField` mapping model associations across apps.
- **URL Routing & Patterns:** Root `urlpatterns`, `path()`, `re_path()`, `include()` modules, and Django REST Framework routers.
- **Views (CBV & FBV):** Class-based views (`ListView`, `DetailView`, `CreateView`, `ViewSet`) and function-based views, extracting model and template bindings (`django_view_uses_model`, `django_view_template`).
- **Signal Graph:** `@receiver` decorators and `signal.connect()` calls, mapping sender models to receiver callbacks (`django_signal_receiver`).
- **Admin Registrations:** `@admin.register()` and `admin.site.register()` mappings (`django_admin_registers`).
- **Forms & ModelForms:** Form field extraction and `Meta.model` bindings (`django_form_meta_model`).

---

## Installation & Quickstart

Install trace-mcp globally, run initialization, and connect your Django repository:

```bash
npm i -g trace-mcp && trace init && trace add
```

### Example question to your agent

> "Which views, admin classes, and signal receivers depend on the `Invoice` model in this Django repository?"

The AI agent invokes `trace-mcp` tools to query relationships, signals, and view bindings directly without searching hundreds of Python files.

---

## Without graph vs with trace-mcp

Measurements below reflect corpus-level benchmarks from our [PR review context benchmark](pr-context-benchmark.md) across {{ site.data.pr_context_bench.pr_count }} pull requests.

| Capability | Without graph | With trace-mcp |
|---|---|---|
| **Median input tokens** | ~{{ site.data.pr_context_bench.baseline_median_tokens }} tokens | ~{{ site.data.pr_context_bench.trace_median_tokens }} tokens (-{{ site.data.pr_context_bench.median_savings_pct }}%) |
| **Signal listener discovery** | Hidden in disconnected files | Explicit `django_signal_receiver` edges |
| **Model relationships** | Search foreign keys with grep | Explicit model relation graph edges |
| **URL pattern nesting** | Traverses nested `include()` manually | Flattened URL route-to-view graph |
| **Admin & Form binding** | Must read admin.py and forms.py | Direct edges from model to admin/forms |
| **Tools exposed** | None (reads full files) | {{ site.data.counts.tools }} specialized MCP tools |

---

## Frequently asked questions

### How does trace-mcp index Django signals across apps?
trace-mcp parses `@receiver` decorators and `signal.connect()` calls, creating explicit graph edges that connect signal senders to receiver functions even when defined in separate apps.

### Does trace-mcp support Django REST Framework (DRF)?
Yes. It indexes DRF DefaultRouter and SimpleRouter registrations, linking registered routes to ViewSet classes, and connects views to explicit model or queryset definitions.

### Does trace-mcp connect Django admin registrations to models?
Yes. It indexes `@admin.register()` decorators and `admin.site.register()` calls, building `django_admin_registers` edges between ModelAdmin classes and models.

---

## Next steps

Explore the full [Tools reference](tools-reference.md) for available query tools, see the [Language capability matrix](language-matrix.md) for Python AST details, view [Comparisons](comparisons.md) against other tools, or browse all [Supported frameworks](supported-frameworks.md).
