# Инвентарь опубликованных поверхностей trace-mcp.com

> Машиночитаемый источник: [`ops/content-inventory.json`](content-inventory.json).
> Сформирован: 2026-10-14 в рамках задачи **TRA-2417** (родительская задача: **TRA-2414**).
> Все URL проверены прямыми HTTP-запросами к `https://trace-mcp.com` (метод GET/HEAD с проверкой статуса 200 и отсутствия soft-404).

---

## 1. Сводка инвентаря

| Категория | Количество | Статус доступности на сайте |
|---|---:|---|
| **Всего файлов в `docs/`** | **148** | — |
| **Файлы с front matter (Jekyll)** | **73** | 73 из 73 отвечают **HTTP 200** |
| — Из них опубликовано HTML-страниц | **71** | 71 из 71 отвечают **HTTP 200** |
| — Из них в `docs/sitemap.xml` (индексируемые) | **43** | 43 из 43 отвечают **HTTP 200** |
| — Из них с `noindex: true` (служебные / лаборатория) | **28** | 28 из 28 отвечают **HTTP 200** |
| — Из них текстовые форматы с front matter (`llms.txt`, `llms-full.txt`) | **2** | 2 из 2 отвечают **HTTP 200** |
| **Файлы без front matter** | **75** | — |
| — Публичные служебные файлы (`robots.txt`, `sitemap.xml`, `site.webmanifest`) | 3 | 3 из 3 отвечают **HTTP 200** |
| — Конфигурация GitHub Pages (`CNAME`) | 1 | Служебный файл домена |
| — Внутренние файлы Jekyll (`_config.yml`, `_layouts/`, `_data/`) | 19 | Не публикуются напрямую (**HTTP 404** при прямом запросе — норма) |
| — Статические ассеты (картинки, шрифты, стили, бенчмарк-JSON) | 52 | Отдаются статически (**HTTP 200**) |

---

## 2. Анализ sitemap vs файлы с front matter

### Согласованность sitemap.xml
1. В `docs/sitemap.xml` включены ровно **43 URL**.
2. Все 43 URL соответствуют реальным файлам в репозитории:
   - 1 корневой лендинг (`docs/index.html` → `/`)
   - 22 документационных и продуктовых страницы верхнего уровня
   - 20 страниц детального сравнения с конкурентами в `/vs/`
   - 1 страница бенчмарка токенов (`docs/perf/response-tokens.md` → `/perf/response-tokens/`)
3. Все 43 страницы отдают **HTTP 200 OK**, имеют заполненные метатеги и OpenGraph.

### Файлы с front matter, отсутствующие в sitemap.xml
Всего **30 файлов**. Из них:
- **28 HTML-страниц**: все имеют явную директиву `noindex: true` в YAML front matter. Все 28 страниц реально скомпилированы Jekyll и доступны на живом сайте по прямым ссылкам (HTTP 200). В sitemap они **не должны** добавляться (соответствует политике закрытия внутренних отчетов от поискового индекса).
- **2 текстовых файла**: `docs/llms.txt` и `docs/llms-full.txt`. Имеют front matter (`layout: null`) исключительно для подстановки шаблонизатором Jekyll счетчиков из `docs/_data/counts.yml`. Отдаются как `text/plain`, статус 200.

#### Детальное распределение 28 noindex-страниц:
1. **Корневые служебные спецификации (3 страницы)**:
   - `docs/DESIGN-WEB.md` → `/DESIGN-WEB.html` (стандарт веб-дизайна Nothing)
   - `docs/ROADMAP.md` → `/ROADMAP.html` (продуктовый роадмап)
   - `docs/SKILL_STATE.md` → `/SKILL_STATE.html` (спецификация контекста агентов)
2. **Бенчмарк-лаборатория и пререгистрации `docs/perf/` (21 страница)**:
   - `docs/perf/README.md` → `/perf/` (индекс производительности десктопного приложения)
   - 14 отчетов об измерении памяти, пропускной способности, event loop и потребления ресурсов
   - 6 пререгистраций бенчмарков (`prereg-*`)
3. **QA-аудиты графа и топологии `docs/qa/` (4 страницы)**:
   - `docs/qa/TRA-1745-graph.md` → `/qa/TRA-1745-graph.html`
   - `docs/qa/TRA-1746-deleted-files.md` → `/qa/TRA-1746-deleted-files.html`
   - `docs/qa/TRA-1748-topology-edges.md` → `/qa/TRA-1748-topology-edges.html`
   - `docs/qa/TRA-1767-graph-gestures.md` → `/qa/TRA-1767-graph-gestures.html`

---

## 3. Рекомендованная структура редакторских пачек (координация с SEO Agent / TRA-2414)

Структура полностью согласована с планом родительской задачи TRA-2414:

| Пачка | Описание | Кол-во страниц | Приоритет | Назначенная задача / этап |
|---|---|---:|---|---|
| **Пачка 1: Core & Technical** | Главная (`index.html`), продуктовые гайды, справочники API/CLI, архитектура, качество, телеметрия | 23 | **P0 / P1** | TRA-2419 / TRA-2420 |
| **Пачка 2: Comparisons A** | Сравнения с конкурентами (часть 1: Repomix, Serena, codebase-memory-mcp, Codegraphcontext, SocratiCode, jCodeMunch, TokenSave, GitNexus, Graft, Narsil) | 10 | **P1 / P2** | TRA-2421 |
| **Пачка 3: Comparisons B** | Сравнения с конкурентами (часть 2: codegraph, Context Mode, code-review-graph, Repomix vs codegraph, ast-grep, Continue, Aider, Cody, ripwire, IDE context) | 10 | **P2** | TRA-2422 |
| **Пачка 4: Noindex & Internal** | Внутренние отчеты, perf-лаборатория (21 стр.), QA-отчеты (4 стр.), роадмап и спецификации (3 стр.) | 28 | **P3** | TRA-2423 |
| **Служебные форматы LLM** | `llms.txt`, `llms-full.txt` | 2 | **P2** | Согласование с SEO Agent |

---

## 4. Полный перечень индексируемых страниц (43 в sitemap.xml)

| Исходный файл | Опубликованный URL | Тип страницы | Sitemap Pri | Приоритет редактуры | Редакторская пачка |
|---|---|---|---:|---|---|
| `docs/analytics.md` | [`/analytics.html`](https://trace-mcp.com/analytics.html) | `feature_architecture` | 0.6 | **P2** (Medium) | Пачка 1 |
| `docs/architecture.md` | [`/architecture.html`](https://trace-mcp.com/architecture.html) | `technical_reference` | 0.7 | **P2** (Medium) | Пачка 1 |
| `docs/code-graph-mcp.md` | [`/code-graph-mcp.html`](https://trace-mcp.com/code-graph-mcp.html) | `category_explainer` | 0.9 | **P1** (High) | Пачка 1 |
| `docs/comparisons.md` | [`/comparisons.html`](https://trace-mcp.com/comparisons.html) | `comparison_hub` | 0.8 | **P1** (High) | Пачка 1 |
| `docs/config-index.md` | [`/config-index.html`](https://trace-mcp.com/config-index.html) | `technical_reference` | 0.6 | **P2** (Medium) | Пачка 1 |
| `docs/configuration.md` | [`/configuration.html`](https://trace-mcp.com/configuration.html) | `technical_reference` | 0.7 | **P2** (Medium) | Пачка 1 |
| `docs/daemon-memory.md` | [`/daemon-memory.html`](https://trace-mcp.com/daemon-memory.html) | `benchmark_performance` | 0.5 | **P2** (Medium) | Пачка 1 |
| `docs/decision-memory.md` | [`/decision-memory.html`](https://trace-mcp.com/decision-memory.html) | `feature_architecture` | 0.6 | **P2** (Medium) | Пачка 1 |
| `docs/development.md` | [`/development.html`](https://trace-mcp.com/development.html) | `feature_architecture` | 0.5 | **P2** (Medium) | Пачка 1 |
| `docs/index.html` | [`/`](https://trace-mcp.com/) | `landing_primary` | 1.0 | **P0** (Critical) | Пачка 1 |
| `docs/language-matrix.md` | [`/language-matrix.html`](https://trace-mcp.com/language-matrix.html) | `technical_reference` | 0.6 | **P2** (Medium) | Пачка 1 |
| `docs/perf/response-tokens.md` | [`/perf/response-tokens/`](https://trace-mcp.com/perf/response-tokens/) | `benchmark_performance` | 0.5 | **P2** (Medium) | Пачка 1 |
| `docs/pr-context-benchmark.md` | [`/pr-context-benchmark.html`](https://trace-mcp.com/pr-context-benchmark.html) | `benchmark_performance` | 0.7 | **P2** (Medium) | Пачка 1 |
| `docs/privacy.md` | [`/privacy.html`](https://trace-mcp.com/privacy.html) | `legal_privacy` | 0.6 | **P3** (Low) | Пачка 1 |
| `docs/quality-gates.md` | [`/quality-gates.html`](https://trace-mcp.com/quality-gates.html) | `feature_architecture` | 0.5 | **P2** (Medium) | Пачка 1 |
| `docs/reduce-claude-code-token-usage.md` | [`/reduce-claude-code-token-usage.html`](https://trace-mcp.com/reduce-claude-code-token-usage.html) | `product_guide` | 0.8 | **P1** (High) | Пачка 1 |
| `docs/supported-frameworks.md` | [`/supported-frameworks.html`](https://trace-mcp.com/supported-frameworks.html) | `technical_reference` | 0.7 | **P2** (Medium) | Пачка 1 |
| `docs/telemetry.md` | [`/telemetry.html`](https://trace-mcp.com/telemetry.html) | `feature_architecture` | 0.5 | **P2** (Medium) | Пачка 1 |
| `docs/tools-index.md` | [`/tools-index.html`](https://trace-mcp.com/tools-index.html) | `technical_reference` | 0.7 | **P2** (Medium) | Пачка 1 |
| `docs/tools-reference.md` | [`/tools-reference.html`](https://trace-mcp.com/tools-reference.html) | `technical_reference` | 0.8 | **P2** (Medium) | Пачка 1 |
| `docs/toon-savings.md` | [`/toon-savings.html`](https://trace-mcp.com/toon-savings.html) | `benchmark_performance` | 0.6 | **P2** (Medium) | Пачка 1 |
| `docs/tweakcc.md` | [`/tweakcc.html`](https://trace-mcp.com/tweakcc.html) | `feature_architecture` | 0.5 | **P2** (Medium) | Пачка 1 |
| `docs/what-trace-init-installs.md` | [`/what-trace-init-installs.html`](https://trace-mcp.com/what-trace-init-installs.html) | `product_guide` | 0.8 | **P1** (High) | Пачка 1 |
| `docs/vs/codebase-memory-mcp.md` | [`/vs/codebase-memory-mcp.html`](https://trace-mcp.com/vs/codebase-memory-mcp.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 2 |
| `docs/vs/codegraphcontext.md` | [`/vs/codegraphcontext.html`](https://trace-mcp.com/vs/codegraphcontext.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 2 |
| `docs/vs/gitnexus.md` | [`/vs/gitnexus.html`](https://trace-mcp.com/vs/gitnexus.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 2 |
| `docs/vs/graft.md` | [`/vs/graft.html`](https://trace-mcp.com/vs/graft.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 2 |
| `docs/vs/jcodemunch.md` | [`/vs/jcodemunch.html`](https://trace-mcp.com/vs/jcodemunch.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 2 |
| `docs/vs/narsil-mcp.md` | [`/vs/narsil-mcp.html`](https://trace-mcp.com/vs/narsil-mcp.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 2 |
| `docs/vs/repomix.md` | [`/vs/repomix.html`](https://trace-mcp.com/vs/repomix.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 2 |
| `docs/vs/serena.md` | [`/vs/serena.html`](https://trace-mcp.com/vs/serena.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 2 |
| `docs/vs/socraticode.md` | [`/vs/socraticode.html`](https://trace-mcp.com/vs/socraticode.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 2 |
| `docs/vs/tokensave.md` | [`/vs/tokensave.html`](https://trace-mcp.com/vs/tokensave.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 2 |
| `docs/vs/aider.md` | [`/vs/aider.html`](https://trace-mcp.com/vs/aider.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 3 |
| `docs/vs/ast-grep.md` | [`/vs/ast-grep.html`](https://trace-mcp.com/vs/ast-grep.html) | `competitor_comparison` | 0.8 | **P1** (High) | Пачка 3 |
| `docs/vs/code-review-graph.md` | [`/vs/code-review-graph.html`](https://trace-mcp.com/vs/code-review-graph.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |
| `docs/vs/codegraph.md` | [`/vs/codegraph.html`](https://trace-mcp.com/vs/codegraph.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |
| `docs/vs/cody.md` | [`/vs/cody.html`](https://trace-mcp.com/vs/cody.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |
| `docs/vs/context-mode.md` | [`/vs/context-mode.html`](https://trace-mcp.com/vs/context-mode.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |
| `docs/vs/continue.md` | [`/vs/continue.html`](https://trace-mcp.com/vs/continue.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |
| `docs/vs/ide-context.md` | [`/vs/ide-context.html`](https://trace-mcp.com/vs/ide-context.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |
| `docs/vs/repomix-vs-codegraph.md` | [`/vs/repomix-vs-codegraph.html`](https://trace-mcp.com/vs/repomix-vs-codegraph.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |
| `docs/vs/ripwire.md` | [`/vs/ripwire.html`](https://trace-mcp.com/vs/ripwire.html) | `competitor_comparison` | 0.8 | **P2** (Medium) | Пачка 3 |

---

## 5. Полный перечень неиндексируемых страниц с front matter (30 страниц, HTTP 200)

| Исходный файл | Опубликованный URL | Тип страницы | Директива noindex | Статус живого URL | Редакторская пачка |
|---|---|---|---|---|---|
| `docs/DESIGN-WEB.md` | [`/DESIGN-WEB.html`](https://trace-mcp.com/DESIGN-WEB.html) | `internal_spec_roadmap` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/daemon-idle-memory.md` | [`/perf/daemon-idle-memory/`](https://trace-mcp.com/perf/daemon-idle-memory/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/daemon-serving-memory.md` | [`/perf/daemon-serving-memory/`](https://trace-mcp.com/perf/daemon-serving-memory/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/embedding-eval.md` | [`/perf/embedding-eval.html`](https://trace-mcp.com/perf/embedding-eval.html) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/embedding-models.md` | [`/perf/embedding-models/`](https://trace-mcp.com/perf/embedding-models/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/health-starvation.md` | [`/perf/health-starvation/`](https://trace-mcp.com/perf/health-starvation/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/idle-cost.md` | [`/perf/idle-cost/`](https://trace-mcp.com/perf/idle-cost/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/index-throughput.md` | [`/perf/index-throughput/`](https://trace-mcp.com/perf/index-throughput/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/pr-context-loss-classes.md` | [`/perf/pr-context-loss-classes/`](https://trace-mcp.com/perf/pr-context-loss-classes/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/prereg-benchmark-lab.md` | [`/perf/prereg-benchmark-lab/`](https://trace-mcp.com/perf/prereg-benchmark-lab/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/prereg-index-throughput.md` | [`/perf/prereg-index-throughput/`](https://trace-mcp.com/perf/prereg-index-throughput/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/prereg-pr-context.md` | [`/perf/prereg-pr-context/`](https://trace-mcp.com/perf/prereg-pr-context/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/prereg-pr-quality.md` | [`/perf/prereg-pr-quality/`](https://trace-mcp.com/perf/prereg-pr-quality/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/prereg-response-tokens.md` | [`/perf/prereg-response-tokens/`](https://trace-mcp.com/perf/prereg-response-tokens/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/prereg-session-scaling.md` | [`/perf/prereg-session-scaling/`](https://trace-mcp.com/perf/prereg-session-scaling/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/README.md` | [`/perf/`](https://trace-mcp.com/perf/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/session-baseline.md` | [`/perf/session-baseline/`](https://trace-mcp.com/perf/session-baseline/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/session-scaling.md` | [`/perf/session-scaling/`](https://trace-mcp.com/perf/session-scaling/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/tra-2305-event-loop.md` | [`/perf/tra-2305-event-loop/`](https://trace-mcp.com/perf/tra-2305-event-loop/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/tra1608-ort-arena-watcher.md` | [`/perf/tra1608-ort-arena-watcher/`](https://trace-mcp.com/perf/tra1608-ort-arena-watcher/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/tra1780-electron-removal.md` | [`/perf/tra1780-electron-removal/`](https://trace-mcp.com/perf/tra1780-electron-removal/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/perf/weak-profile.md` | [`/perf/weak-profile/`](https://trace-mcp.com/perf/weak-profile/) | `benchmark_performance` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/qa/TRA-1745-graph.md` | [`/qa/TRA-1745-graph.html`](https://trace-mcp.com/qa/TRA-1745-graph.html) | `internal_qa_audit` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/qa/TRA-1746-deleted-files.md` | [`/qa/TRA-1746-deleted-files.html`](https://trace-mcp.com/qa/TRA-1746-deleted-files.html) | `internal_qa_audit` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/qa/TRA-1748-topology-edges.md` | [`/qa/TRA-1748-topology-edges.html`](https://trace-mcp.com/qa/TRA-1748-topology-edges.html) | `internal_qa_audit` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/qa/TRA-1767-graph-gestures.md` | [`/qa/TRA-1767-graph-gestures.html`](https://trace-mcp.com/qa/TRA-1767-graph-gestures.html) | `internal_qa_audit` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/ROADMAP.md` | [`/ROADMAP.html`](https://trace-mcp.com/ROADMAP.html) | `internal_spec_roadmap` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/SKILL_STATE.md` | [`/SKILL_STATE.html`](https://trace-mcp.com/SKILL_STATE.html) | `internal_spec_roadmap` | `true` | **HTTP 200 OK** | Пачка 4 |
| `docs/llms-full.txt` | [`/llms-full.txt`](https://trace-mcp.com/llms-full.txt) | `machine_discovery` | `false` | **HTTP 200 OK** | Машинные форматы LLM (llms.txt, llms-full.txt) |
| `docs/llms.txt` | [`/llms.txt`](https://trace-mcp.com/llms.txt) | `machine_discovery` | `false` | **HTTP 200 OK** | Машинные форматы LLM (llms.txt, llms-full.txt) |

---

## 6. Важные технические нюансы Jekyll и хостинга

1. **Маршрутизация README.md в подкаталогах**:
   - Файл `docs/perf/README.md` содержит явный `permalink: /perf/`. Благодаря этому он публикуется по каноническому адресу `https://trace-mcp.com/perf/`.
   - Запрос к `https://trace-mcp.com/perf/README.html` возвращает **404**. Это ожидаемое и правильное поведение.
2. **Кастомные permalinks в `docs/perf/`**:
   - Большинство файлов в `docs/perf/` имеют `permalink: /perf/<name>/` (со слешем на конце). Они отдаются сервером по URL со слешем на конце. Запрос с `.html` возвращает **404**.
   - Исключение: `docs/perf/embedding-eval.md` не имеет кастомного permalink и публикуется по стандартному Jekyll-правилу как `/perf/embedding-eval.html`.
3. **Расширения `.md` на живом сайте**:
   - Прямой запрос к `.md` файлам (например, `https://trace-mcp.com/code-graph-mcp.md`) возвращает **HTTP 404**. Файлы отдаются только в виде скомпилированного HTML (`.html` или с завершающим слешем).
   - В `docs/robots.txt` установлена директива `Disallow: /*.md$`, исключающая индексацию сырых markdown-файлов.
4. **Служебные файлы каталогов `_`**:
   - Каталоги `_layouts/`, `_data/` и файл `_config.yml` игнорируются Jekyll при генерации публичных страниц и возвращают **404** при прямом запросе.
