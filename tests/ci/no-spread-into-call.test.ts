/**
 * The gate for the defect class in #957: `Math.min(...xs)` / `Math.max(...xs)`
 * pass every element as a separate argument and throw `RangeError` once the
 * collection passes V8's argument limit (~65k-125k, stack-dependent).
 *
 * `scale-rangeerror.test.ts` catches this behaviourally, but only on the code
 * paths it happens to call. This catches it on every line of `src/`, including
 * the ones no test reaches — which is where both of #957's instances lived.
 *
 * The rule is total on purpose: `minMax()` is a drop-in for every spread form,
 * so there is no legitimate exception and therefore no allowlist to rot. A
 * bounded array reduced instead of spread costs nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SPREAD_INTO_MATH = /Math\.(?:min|max)\(\s*\.\.\./;

describe('no spread into Math.min/Math.max in src/', () => {
  it('every min/max over a collection reduces instead of spreading', () => {
    const files = (readdirSync('src', { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      .map((f) => `src/${f}`);
    expect(files.length).toBeGreaterThan(100); // the glob itself must not silently match nothing

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//')) return; // prose, incl. this rule's own docs
        if (SPREAD_INTO_MATH.test(code)) offenders.push(`${file}:${i + 1}  ${code}`);
      });
    }

    expect(
      offenders,
      `Spreading a collection into Math.min/Math.max throws RangeError past V8's\n` +
        `argument limit (#957). Use minMax() from src/util/minmax.ts:\n\n` +
        `  Math.max(...xs)        ->  minMax(xs).max\n` +
        `  Math.max(...xs, 0.001) ->  Math.max(minMax(xs).max, 0.001)\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
