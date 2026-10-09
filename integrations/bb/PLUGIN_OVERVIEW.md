Search an indexed repository and recall project decisions directly from a bb thread. The plugin exposes compact code search, symbol definitions, file outlines, and decision recall as native bb agent tools. A searchable tool catalog gives access to the rest of trace-mcp without adding every tool to the agent's standing context.

trace-mcp runs on the machine hosting the thread's bb environment, so a thread needs an environment with a repository path. The first query uses npm to fetch the pinned trace-mcp package on that machine and may build an index. Node.js with npm registry access is required on each host. No hosted service or account is required.

The plugin does not change bb's provider token meter or quota limits. It helps agents use less context by returning targeted repository information and retained decisions.
