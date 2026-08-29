/* Update state: the app menu header, the update card and the stale-root
   warning. */

export const update = {
  /* Singular, not a plural key: the main process sends at most one stale root —
     the one MCP clients actually launch from — so there is no count to inflect
     (TRA-377). The line names the consequence rather than the filesystem fact,
     and the title carries the install and the one command that ends it. */
  staleRoots: 'MCP clients still run v{{version}}',
  staleRootsTitle:
    'Your editors launch trace-mcp from {{pkgDir}}, which is on v{{version}}. That copy was installed by a different npm, so updating this app did not touch it — until it is updated, every MCP client keeps using the old server.\n\nUpdate it from a terminal:\n{{command}}',
  copyStaleRootCommand: 'Copy update command',
} as const;
