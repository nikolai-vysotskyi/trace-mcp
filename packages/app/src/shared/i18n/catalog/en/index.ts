/* One file per (language, surface): a slice that extracts Settings adds
   en/settings.ts and ru/settings.ts and one line here, so two extraction
   slices running at once do not both rewrite the same catalogue file. */

import { activity } from './activity.js';
import { common } from './common.js';
import { insights } from './insights.js';
import { menu } from './menu.js';
import { overview } from './overview.js';
import { tray } from './tray.js';
import { update } from './update.js';

export const en = { activity, common, insights, menu, overview, tray, update };

/** The source language's shape. Other catalogues are checked against it by
    catalog-parity.test.ts, not by the type system: plural forms differ per
    language (ru has `_few`/`_many`, en does not), so a structural type would
    forbid the very thing translations need to do. */
export type Catalog = typeof en;
