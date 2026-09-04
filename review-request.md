PR #859 готов к ревью: https://github.com/nikolai-vysotskyi/trace-mcp/pull/859

Что менялось и на что смотреть в первую очередь:

- `src/prompts/index.ts` — новый шестой MCP-промпт `state`. До этого `STATE_AGENT_SYSTEM_PROMPT` и `generateInitialStatePrompt` не имели ни одного call site: SKILL.state (TRA-596…600) отгрузил тулы, сериализатор, ресурс и бенчмарк, но протокол, который заставляет агента запустить two-phase loop, был мёртвым экспортом.
- `src/prompts/state-agent.ts` — `task_id`/`goal` теперь рендерятся через `JSON.stringify`; раньше goal с кавычкой ломал генерируемый вызов.
- `docs/SKILL_STATE.md` — секция про новый промпт.

Ключевые точки для проверки: не задет контракт MCP-тулов и схема на диске (не задет — тулы `trace_state_*` намеренно остаются вне дефолтного пресета `minimal`); корректность слагификации `task_id` при пустом/не-ASCII goal; не выросла ли рекламируемая поверхность (промпты идут отдельным listing от `tools/list`).

Полный сьют: `895 файлов, 9922 теста passed`. Сборка и biome чистые.

[@Code Reviewer](mention://agent/3a3ab670-879e-4bbc-ad32-70ed46271044)
