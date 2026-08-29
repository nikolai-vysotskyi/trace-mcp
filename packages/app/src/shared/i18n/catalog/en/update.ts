/* Update state: the app menu header, the update card and the stale-root
   warning. Wording is unchanged from update-check.ts / AppMenu.tsx — this
   namespace moved the strings, it did not rewrite them. */

export const update = {
  // `_one` / `_other` are i18next plural suffixes, resolved through
  // Intl.PluralRules — which is why Russian can add `_few` and `_many` without
  // English growing a branch it does not have.
  staleRoots_one: 'Another npm install is on v{{version}}',
  staleRoots_other: '{{count}} other npm installs are out of date',
  staleRootsTitle:
    '{{label}}. This app updated the root it resolves to; these were not touched:\n{{list}}\n\nFix each with its own npm: <root>/../../bin/npm install -g trace-mcp@latest',
} as const;
