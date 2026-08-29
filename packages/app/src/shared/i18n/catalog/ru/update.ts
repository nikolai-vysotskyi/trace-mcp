/* Russian needs four plural forms where English needs two; that difference is
   exactly what Intl.PluralRules is for, and why these keys are not a mirror of
   en/update.ts. */

export const update = {
  staleRoots_one: 'Ещё одна установка npm использует v{{version}}',
  staleRoots_few: 'Ещё {{count}} установки npm устарели',
  staleRoots_many: 'Ещё {{count}} установок npm устарели',
  staleRoots_other: 'Ещё {{count}} установки npm устарели',
  staleRootsTitle:
    '{{label}}. Приложение обновило тот каталог, который использует само; эти остались нетронутыми:\n{{list}}\n\nОбновите каждый его собственным npm: <root>/../../bin/npm install -g trace-mcp@latest',
} as const;
