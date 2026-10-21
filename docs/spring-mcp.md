---
title: "Spring MCP Server: Code Graph & Context for AI Agents"
description: "Code graph MCP server for Spring Boot. Indexes controllers, routes, dependency injection beans, and JPA entity relations across Java and Kotlin."
updated: 2026-10-20
category: frameworks
---

# Spring MCP server: code graph for AI agents

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/spring-mcp.html",
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
        "@id": "https://trace-mcp.com/spring-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does trace-mcp support both Java and Kotlin Spring Boot applications?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Dependency injection extraction targets simple Java-style @Autowired fields and constructor signatures. Kotlin dependency injection is not reliably extracted."
          }
        },
        {
          "@type": "Question",
          "name": "How does trace-mcp resolve Spring dependency injection?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "It indexes @Service, @Repository, @Component, and @Configuration beans, building spring_injects edges between injection targets (@Autowired, constructor injection) and bean declarations."
          }
        },
        {
          "@type": "Question",
          "name": "Does trace-mcp index JPA entity relationships in Spring?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. It extracts @Entity definitions along with @ManyToOne, @OneToMany, @ManyToMany, and @OneToOne relations, generating spring_entity_relation graph edges."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Which `@Service` beans and JPA repositories are touched by a Spring Boot REST endpoint change? trace-mcp indexes your existing Spring Boot repository into a local static code graph. AI coding agents query `@RequestMapping` endpoints, `@Autowired` bean dependencies, and JPA entity relationships through MCP instead of searching through verbose class files.

---

## What trace-mcp extracts in Spring

The `spring` plugin indexes Spring MVC and Spring Boot applications across Java and Kotlin:

- **REST & MVC Routes:** `@RestController`, `@Controller`, `@RequestMapping`, `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping` (`spring_route`).
- **Dependency Injection:** `@Service`, `@Repository`, `@Component`, `@Configuration`, `@Autowired`, and constructor injection (`spring_injects`).
- **JPA Entity Relationships:** `@Entity` declarations and relational mappings (`@OneToMany`, `@ManyToOne`, `@ManyToMany`, `@OneToOne`) (`spring_entity_relation`).
- **Configuration & Values:** `@Value` property injection keys (`spring_config_value`).
- **Multi-Language Support:** Route and entity parsing across Java and Kotlin codebases using Maven (`pom.xml`) or Gradle (`build.gradle`), with Java-focused constructor DI analysis.

---

## Installation & Quickstart

Install trace-mcp globally, run initialization, and connect your Spring repository:

```bash
npm i -g trace-mcp && trace init && trace add
```

### Example question to your agent

> "Trace which `@Service` components and JPA repositories are invoked by the `AccountController` transfer endpoint."

The AI agent calls `trace-mcp` tools to trace DI bean resolution and route mapping without needing full-text grep over verbose Java classes.

---

## Without graph vs with trace-mcp

Measurements below reflect corpus-level benchmarks from our [PR review context benchmark](pr-context-benchmark.md) across {{ site.data.pr_context_bench.pr_count }} pull requests.

| Capability | Without graph | With trace-mcp |
|---|---|---|
| **Median input tokens** | ~{{ site.data.pr_context_bench.baseline_median_tokens }} tokens | ~{{ site.data.pr_context_bench.trace_median_tokens }} tokens (-{{ site.data.pr_context_bench.median_savings_pct }}%) |
| **Dependency injection** | Inspect injection sites and bean declarations | Direct `spring_injects` edges |
| **Route mapping** | Must search annotations across files | Fast URI endpoint index |
| **JPA entity associations** | Parses complex Java class files | Relational entity graph |
| **Java & Kotlin mixing** | Inspect symbols across separate Java and Kotlin trees | Unified multi-language graph |
| **Tools exposed** | None (reads full files) | {{ site.data.counts.tools }} specialized MCP tools |

---

## Frequently asked questions

### Does trace-mcp support both Java and Kotlin Spring Boot applications?
Dependency injection extraction targets simple Java-style `@Autowired` fields and constructor signatures. Kotlin dependency injection is not reliably extracted.

### How does trace-mcp resolve Spring dependency injection?
It indexes `@Service`, `@Repository`, `@Component`, and `@Configuration` beans, building `spring_injects` edges between injection targets (`@Autowired`, constructor injection) and bean declarations.

### Does trace-mcp index JPA entity relationships in Spring?
Yes. It extracts `@Entity` definitions along with `@ManyToOne`, `@OneToMany`, `@ManyToMany`, and `@OneToOne` relations, generating `spring_entity_relation` graph edges.

---

## Next steps

Explore the full [Tools reference](tools-reference.md) for available query tools, see the [Language capability matrix](language-matrix.md) for Java and Kotlin parser details, view [Comparisons](comparisons.md) against other tools, or browse all [Supported frameworks](supported-frameworks.md).
