# trace-mcp UI Localization Glossary

Canonical terms and localization conventions across languages for the trace-mcp desktop app and tools.

## Principles

1. **macOS Tahoe (macOS 26) Standard**: Use native Apple macOS terminology for OS concepts (e.g., Japanese: `ウインドウ`, `フォルダ`, `新規ウインドウ` without elongated vowel marks; German: standard Apple menu naming).
2. **Developer & AI Terminology**: Terms like MCP, CLI, JSON, OTLP, FQN, Git, OWASP, PR, SHA remain untranslated identifiers.
3. **Punctuation & Typography**:
   - **Japanese**: Full-width punctuation（、。）in prose; no extra space between numbers and Japanese units (e.g., `10分`, `1件`, `5本` instead of `10 分`, `1 件`, `5 本`).
   - **German**: Informal tone (*du/deine/dein*, never mix with formal *Sie/Ihre*). Spelling with *x* for *indexieren / indexiert* (never *indizieren*).
4. **Button & Action Precision**: Action buttons should name the exact action concisely (e.g., "一時停止" for temporary pause vs "停止" for complete stop).
5. **Width Budgets**: Some labels sit in a fixed slot and truncate rather than wrap. Measured on the running renderer at 1280 pt, sidebar expanded:
   - Workspace KPI tile label (`kpi*` in `workspace.ts`, 11 px, `.truncate`): **96 px**. German "Braucht Aufmerksamkeit" needed 132 px and rendered as "Braucht Aufmer…"; shortened to "Zu prüfen" (52 px).
   - When a translation overruns a budget, shorten the string first. Change the CSS only if English overruns too.

---

## Core Glossary

| English (en) | German (de) | Japanese (ja) | Russian (ru) | Notes / Context |
| :--- | :--- | :--- | :--- | :--- |
| **Index** | Index | インデックス | Индекс | Core index data structure |
| **Indexing** | Wird indexiert | インデックス中 | Индексация | Active background indexing state |
| **Reindex** | Neu indexieren | 再インデックス | Переиндексировать | Action to reindex project |
| **Symbol** / **Symbols** | Symbol / Symbole | シンボル | Символ / Символы | Code entity (function, class, method) |
| **Edge** / **Edges** | Kante / Kanten | エッジ | Связь / Связи | Graph dependency connection |
| **Guard** | Guard | ガード | Guard | Hook interceptor protection layer |
| **Enforcement** | Durchsetzung | 適用 / ガード適用 | Применение | Guard rule application (not "強制") |
| **Strict** | Strikt | ストリクト | Строгий | Full blocking mode |
| **Coach** | Coach | コーチ | Обучающий | Advisory / suggestions-only mode |
| **Off** | Aus | オフ | Отключен | Disabled mode |
| **Pause** / **Bypass** | Pausieren | 一時停止 | Приостановить | Temporary bypass (not "停止") |
| **Dead exports** | Tote Exporte | 未使用エクスポート | Неиспользуемые экспорты | Exported symbols never imported |
| **Dead code** | Toter Code | デッドコード | Мёртвый код | Unreachable or unused code |
| **Untested** | Ungetestet | 未テスト | Без тестов | Code with no test coverage |
| **Decision** | Entscheidung | 決定事項 | Решение | Architecture decision / record |
| **Memory** | Wissen (surface) / Speicher (RAM) | メモリ | Память | Assistant memory & project knowledge |
| **Corpus** / **Corpora** | Korpus / Korpora | コーパス | Корпус / Корпусы | Saved code slice for assistant |
| **Mined sessions** | Ausgewertete Sitzungen | 抽出済みセッション | Извлечённые сессии | Past assistant transcripts analyzed |
| **Review queue** | Prüfliste | レビュー待ち | Очередь на проверку | Unreviewed mined decisions |
| **Ask** | Fragen | 質問 | Вопрос | AI conversational assistant surface |
| **Insights** | Insights | インサイト | Аналитика | Code intelligence & drift reports |
| **Notebook** | Notebook | ノートブック | Блокнот | Tool scratchpad / query runner |
| **Activity** | Aktivität | アクティビティ | Активность | Live tool & AI request feed |
| **Graph** | Graph | グラフ | Граф | Visual code dependency graph |
| **Tech-debt grade** | Tech-Debt-Note | 技術的負債の評価 | Оценка техдолга | A–F code quality grade |
| **Findings** | Funde | 検出 | Находки | Code smell / issue scanner results |
| **Needs attention** | Zu prüfen | 要対応 | Требуют внимания | Workspace KPI tile — 96 px budget, see Principle 5 |
| **Coverage** | Abdeckung | カバレッジ | Покрытие | Dependency & plugin coverage |
| **Workspace** | Workspace | ワークスペース | Пространство | Top-level projects table |
| **MCP Clients** | MCP-Clients | MCP クライアント | Клиенты MCP | Connected editor clients |
| **Settings** | Einstellungen | 設定 | Настройки | App & daemon configuration |
| **Window** (macOS) | Fenster | ウインドウ | Окно | macOS standard (JA: ウインドウ, not ウィンドウ) |
| **Folder** (macOS) | Ordner | フォルダ | Папка | macOS standard (JA: フォルダ, not フォルダー) |
