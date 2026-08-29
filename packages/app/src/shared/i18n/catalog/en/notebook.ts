/* The Notebook scratchpad.

   Tool names (`search`, `get_outline`, …) and the example values in the field
   placeholders are the trace-mcp API's own vocabulary, so they read the same in
   every language — but they still come from here, because a placeholder that
   lives half in the catalogue and half in the code is the arrangement nobody
   can review.

   `missing` is spelled out once per field rather than assembled from
   "Enter a " + the field name: Russian inflects the noun in that slot, and a
   sentence built out of pieces is exactly what DESIGN.md forbids. */

export const notebook = {
  title: 'Notebook',
  cells_one: '{{count}} cell',
  cells_other: '{{count}} cells',
  addCell: 'Add cell',
  removeCell: 'Remove cell',
  removeCellNumbered: 'Remove cell {{index}}',
  tool: 'Tool',
  run: 'Run',
  running: 'Running…',
  runningStatus: 'Running',
  unknownError: 'Unknown error',
  truncated_one: '… (truncated, {{count}} more char)',
  truncated_other: '… (truncated, {{count}} more chars)',

  searchDescription: 'Search symbols by name across the project',
  outlineDescription: 'Get symbol signatures for a file',
  symbolDescription: 'Read a single symbol by FQN',
  usagesDescription: 'Find all references to a symbol',

  queryLabel: 'Query',
  queryPlaceholder: 'e.g. registerTool',
  queryMissing: 'Enter a query to run this cell.',
  kindLabel: 'Kind',
  // Optionality lives in the placeholder, not the label: "Kind (optional)"
  // wrapped to two lines in the form's label column and broke the row's
  // baseline. `required` is what the runtime actually reads.
  kindPlaceholder: 'function | class | method — optional',
  pathLabel: 'Path',
  pathPlaceholder: 'src/server/server.ts',
  pathMissing: 'Enter a path to run this cell.',
  fqnLabel: 'FQN',
  fqnPlaceholder: 'src/foo.ts::Bar#class',
  fqnMissing: 'Enter a fqn to run this cell.',
  symbolIdLabel: 'Symbol ID',
  symbolIdPlaceholder: 'src/foo.ts::Bar#class',
  symbolIdMissing: 'Enter a symbol id to run this cell.',
} as const;
