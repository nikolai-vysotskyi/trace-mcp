# trace-mcp UI Localization Glossary

Canonical terms and localization conventions across languages for the trace-mcp desktop app and tools.

## Principles

1. **macOS Tahoe (macOS 26) Standard**: Use native Apple macOS terminology for OS concepts (e.g., Japanese: `ウインドウ`, `フォルダ`, `新規ウインドウ` without elongated vowel marks; German: standard Apple menu naming).
2. **Developer & AI Terminology**: Terms like MCP, CLI, JSON, OTLP, FQN, Git, OWASP, PR, SHA remain untranslated identifiers.
3. **Punctuation & Typography**:
   - **Japanese**: Full-width punctuation（、。）in prose; no extra space between numbers and Japanese units (e.g., `10分`, `1件`, `5本` instead of `10 分`, `1 件`, `5 本`).
   - **German**: Informal tone (*du/deine/dein*, never mix with formal *Sie/Ihre*). Spelling with *x* for *indexieren / indexiert* (never *indizieren*).
   - **Hindi**: Devanagari throughout. A Latin word left inside a Devanagari sentence ("कोई सिक्योरिटी findings नहीं") is the defect, not the shortcut — either transliterate it (सिक्योरिटी, डेड एक्सपोर्ट, इंडेक्स) or use the Hindi word (निष्कर्ष). Only bare identifiers stay Latin: MCP, OWASP, JSON, A–F grades.
   - **Korean**: a word never breaks across lines. See Principle 6.
4. **Button & Action Precision**: Action buttons should name the exact action concisely (e.g., "一時停止" for temporary pause vs "停止" for complete stop).
5. **Width Budgets**: Some labels sit in a fixed slot and truncate rather than wrap. Measured on the running renderer at 1280 pt, sidebar expanded:
   - Workspace KPI tile label (`kpi*` in `workspace.ts`, 11 px, `.truncate`): **96 px**. German "Braucht Aufmerksamkeit" needed 132 px and rendered as "Braucht Aufmer…"; shortened to "Zu prüfen" (52 px).
   - When a translation overruns a budget, shorten the string first. Change the CSS only if English overruns too.
6. **Line breaking is per script, not per app**: `word-break: break-word` is what lets a German compound break inside a fixed box, and it is exactly what splits a Hangul word — "항목" rendered as "항" over "목" on the workspace KPI strip. Wrapping labels use `.wrap-label`, which carries `:lang(ko) { word-break: keep-all }`. Numbers are `whitespace-nowrap` in every language ("+22.3" over "k" is a different number). Both rules are in `DESIGN.md` under localization.

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
| **Stale** (session) | Veraltet | 応答なし | Давно молчит | No heartbeat for 120 s — *not* "expired"; the client may come back |
| **Needs attention** | Zu prüfen | 要対応 | Требуют внимания | Workspace KPI tile — 96 px budget, see Principle 5 |
| **Coverage** | Abdeckung | カバレッジ | Покрытие | Dependency & plugin coverage |
| **Workspace** | Workspace | ワークスペース | Пространство | Top-level projects table |
| **MCP Clients** | MCP-Clients | MCP クライアント | Клиенты MCP | Connected editor clients |
| **Settings** | Einstellungen | 設定 | Настройки | App & daemon configuration |
| **Window** (macOS) | Fenster | ウインドウ | Окно | macOS standard (JA: ウインドウ, not ウィンドウ) |
| **Folder** (macOS) | Ordner | フォルダ | Папка | macOS standard (JA: フォルダ, not フォルダー) |

---

## Hindi (hi)

Settled 2026-09-04 (TRA-803), first pass over the language. The rest of the glossary
rows are still open for Hindi — fill them as each surface is reviewed.

| English (en) | Hindi (hi) | Notes / Context |
| :--- | :--- | :--- |
| **Workspace** | वर्कस्पेस | Sidebar row, tray, "remove from workspace". Was left as Latin "Workspace" while every other language translated it. |
| **Finding** / **Findings** | निष्कर्ष | Scanner result. Used for the filter group, both KPI criteria captions, the Security column tip, the row badge and the Ask slash-command hint — every one of them previously read "findings" in Latin. Uninflected in the plural, which is normal for a Hindi technical noun. |
| **Critical / High** (severity) | क्रिटिकल / हाई | Transliterated, matching सिक्योरिटी. |
| **Healthy** (KPI) | स्वस्थ | Was "ठीक-ठाक", which means *so-so* — the opposite of what a grade-A tile claims. Kept distinct from `statusOk` = ठीक. |
| **Connect** | कनेक्ट करें | Was "जोड़ें", the same word as the workspace toolbar's **+ Add** — two different actions under one label. |
| **Connected** | कनेक्टेड | Was "जुड़ा हुआ" in MCP Clients and "कनेक्टेड" in the setup wizard, for the same state. One word. |

## Korean (ko)

| English (en) | Korean (ko) | Notes / Context |
| :--- | :--- | :--- |
| **Healthy** (KPI) | 양호 | |
| **Needs attention** (KPI) | 주의 필요 | |
| **Workspace** | 작업 공간 | |

No string changes this pass — Korean read correctly on the workspace and MCP Clients
screens. Its one defect was line breaking, fixed in CSS (Principle 6).
