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
            "text": "Yes. The Spring plugin inspects annotations, beans, controllers, and JPA repositories across both Java and Kotlin source files in your repository."
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

**TL;DR.** Spring Boot enterprise codebases are rich with annotations, interfaces, dependency injection wires, and JPA entity hierarchies. Dumping whole Java/Kotlin files quickly overflows AI token budgets. trace-mcp maps Spring beans, REST controllers, and entity relationships into a fast local graph that AI agents can query precisely.

---

## What trace-mcp extracts in Spring

The `spring` plugin indexes Spring MVC and Spring Boot applications across Java and Kotlin:

- **REST & MVC Routes:** `@RestController`, `@Controller`, `@RequestMapping`, `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping` (`spring_route`).
- **Dependency Injection:** `@Service`, `@Repository`, `@Component`, `@Configuration`, `@Autowired`, `@Inject`, and constructor injection (`spring_injects`).
- **JPA Entity Relationships:** `@Entity` declarations and relational mappings (`@OneToMany`, `@ManyToOne`, `@ManyToMany`, `@OneToOne`) (`spring_entity_relation`).
- **Configuration & Values:** `@Value` property injection keys (`spring_config_value`) and component scan directives (`spring_component_scan`).
- **Multi-Language Support:** First-class parsing for both Java and Kotlin codebases using Maven (`pom.xml`) or Gradle (`build.gradle`).

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
| **Dependency injection** | Cannot resolve `@Autowired` targets | Direct `spring_injects` edges |
| **Route mapping** | Must search annotations across files | Fast URI endpoint index |
| **JPA entity associations** | Parses complex Java class files | Relational entity graph |
| **Java & Kotlin mixing** | Inconsistent symbol tracking | Unified multi-language graph |
| **Tools exposed** | None (reads full files) | {{ site.data.counts.tools }} specialized MCP tools |

---

## Frequently asked questions

### Does trace-mcp support both Java and Kotlin Spring Boot applications?
Yes. The Spring plugin inspects annotations, beans, controllers, and JPA repositories across both Java and Kotlin source files in your repository.

### How does trace-mcp resolve Spring dependency injection?
It indexes `@Service`, `@Repository`, `@Component`, and `@Configuration` beans, building `spring_injects` edges between injection targets (`@Autowired`, constructor injection) and bean declarations.

### Does trace-mcp index JPA entity relationships in Spring?
Yes. It extracts `@Entity` definitions along with `@ManyToOne`, `@OneToMany`, `@ManyToMany`, and `@OneToOne` relations, generating `spring_entity_relation` graph edges.

---

## Next steps

Explore the full [Tools reference](tools-reference.md) for available query tools, see the [Language capability matrix](language-matrix.md) for Java and Kotlin parser details, view [Comparisons](comparisons.md) against other tools, or browse all [Supported frameworks](supported-frameworks.md).
