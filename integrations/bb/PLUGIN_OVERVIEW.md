Search an indexed repository and recall project decisions directly from a bb thread. Native agent tools cover compact code search, symbol definitions, file outlines, decision recall and recording, index health, and the project memo. A searchable tool catalog gives access to the rest of trace-mcp without adding every tool to the agent's standing context.

Open **Trace context** from a thread's side-panel Actions list to see index health, the provider-reported context window, and saved project decisions. Search decisions, record one manually, or reindex the repository there. The panel shows when a provider has not reported usage; it does not infer a number. The same operations are available in the `bb trace` CLI with a thread ID.

trace-mcp runs on the machine hosting the thread's bb environment, so a thread needs an environment with a repository path. The first query uses npm to fetch the pinned trace-mcp package on that machine and may build an index. Node.js with npm registry access is required on each host. No hosted service or account is required.

The plugin does not change bb's provider token meter or quota limits. It helps agents use less context by returning targeted repository information and retained decisions.
