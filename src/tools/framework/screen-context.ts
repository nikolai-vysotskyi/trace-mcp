/**
 * get_screen_context tool — full context for a React Native screen.
 * Returns component info, navigator, navigation edges, deep link, platform variants.
 */
import type { Store, RnScreenRow } from '../../db/store.js';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { notFound } from '../../errors.js';

interface ScreenContextResult {
  screen: string;
  component: string | undefined;
  filePath: string | undefined;
  navigatorType: string | undefined;
  navigatedFrom: string[];
  navigatesTo: string[];
  deepLink: string | undefined;
  platformSpecific: Record<string, string>;
  nativeModulesUsed: string[];
  params: Record<string, unknown> | undefined;
}

export function getScreenContext(
  store: Store,
  screenName: string,
): TraceMcpResult<ScreenContextResult> {
  let screen = store.getRnScreenByName(screenName);

  if (!screen) {
    // Try case-insensitive partial match
    const all = store.getAllRnScreens();
    screen = all.find((s) => s.name.toLowerCase().includes(screenName.toLowerCase()));
  }

  if (!screen) {
    return err(notFound(`screen:${screenName}`));
  }

  return ok(buildContext(store, screen));
}

function buildContext(store: Store, screen: RnScreenRow): ScreenContextResult {
  const metadata = screen.metadata ? JSON.parse(screen.metadata) : {};

  // Find screens that navigate TO this screen (incoming rn_navigates_to edges)
  const allScreens = store.getAllRnScreens();
  const navigatedFrom: string[] = [];
  const navigatesTo: string[] = [];

  for (const other of allScreens) {
    if (other.id === screen.id) continue;
    const otherMeta = other.metadata ? JSON.parse(other.metadata) : {};
    const calls: string[] = otherMeta.navigationCalls ?? [];
    if (calls.includes(screen.name)) {
      navigatedFrom.push(other.name);
    }
  }

  // Find screens this screen navigates to (from its metadata.navigationCalls)
  const myCalls: string[] = metadata.navigationCalls ?? [];
  for (const target of myCalls) {
    const found = allScreens.find((s) => s.name === target || s.component_path?.includes(target));
    if (found) navigatesTo.push(found.name);
    else navigatesTo.push(target);
  }

  // Platform-specific variants from metadata
  const platformSpecific: Record<string, string> = metadata.platformSpecific ?? {};

  // Native modules from metadata
  const nativeModulesUsed: string[] = metadata.nativeModules ?? [];

  // File path from file_id
  let filePath: string | undefined;
  const file = store.getFileById(screen.file_id);
  if (file) filePath = file.path;

  // Params from options JSON
  let params: Record<string, unknown> | undefined;
  if (screen.options) {
    try {
      const opts = JSON.parse(screen.options);
      if (opts.params) params = opts.params;
    } catch {
      // ignore
    }
  }

  return {
    screen: screen.name,
    component: screen.component_path ?? undefined,
    filePath,
    navigatorType: screen.navigator_type ?? undefined,
    navigatedFrom,
    navigatesTo,
    deepLink: screen.deep_link ?? undefined,
    platformSpecific,
    nativeModulesUsed,
    params,
  };
}
