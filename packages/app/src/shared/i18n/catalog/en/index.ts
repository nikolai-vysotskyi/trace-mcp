/* One file per (language, surface): a slice that extracts Settings adds
   en/settings.ts and ru/settings.ts and one line here, so two extraction
   slices running at once do not both rewrite the same catalogue file. */

import { activity } from './activity.js';
import { ask } from './ask.js';
import { clients } from './clients.js';
import { common } from './common.js';
import { graph } from './graph.js';
import { insights } from './insights.js';
import { memory } from './memory.js';
import { menu } from './menu.js';
import { notebook } from './notebook.js';
import { overview } from './overview.js';
import { stats } from './stats.js';
import { tray } from './tray.js';
import { update } from './update.js';

export const en = {
  activity,
  ask,
  clients,
  common,
  graph,
  insights,
  memory,
  menu,
  notebook,
  overview,
  stats,
  tray,
  update,
};

/** The source language's shape. Other catalogues are checked against it by
    catalog-parity.test.ts, not by the type system: plural forms differ per
    language (ru has `_few`/`_many`, en does not), so a structural type would
    forbid the very thing translations need to do. */
export type Catalog = typeof en;
