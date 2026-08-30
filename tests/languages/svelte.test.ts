import { describe, expect, it } from 'vitest';
import { SvelteLanguagePlugin } from '../../src/indexer/plugins/language/svelte/index.js';

const plugin = new SvelteLanguagePlugin();

async function parse(source: string, filePath = 'Component.svelte') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

const names = (r: Awaited<ReturnType<typeof parse>>) => r.symbols.map((s) => s.name);

describe('SvelteLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('svelte-language');
    expect(plugin.supportedExtensions).toContain('.svelte');
  });

  it('extracts Svelte 4 props, exports and reactive declarations', async () => {
    const r = await parse(`<script>
  export let title;
  export const VERSION = 2;
  export function focus() {}
  $: upper = title.toUpperCase();
</script>
<h1>{upper}</h1>`);
    expect(names(r)).toEqual(expect.arrayContaining(['title', 'VERSION', 'focus', 'upper']));
    expect(r.symbols.find((s) => s.name === 'title')?.metadata).toMatchObject({ prop: true });
  });

  it('extracts runes and snippets', async () => {
    const r = await parse(`<script>
  let count = $state(0);
  const doubled = $derived(count * 2);
</script>
{#snippet row(item)}<li>{item}</li>{/snippet}`);
    expect(names(r)).toEqual(expect.arrayContaining(['count', 'doubled', 'row']));
  });

  it('produces import edges', async () => {
    const r = await parse(`<script>
  import Button from './Button.svelte';
  import './styles.css';
</script>`);
    const modules = (r.edges ?? []).map((e) => e.metadata?.module);
    expect(modules).toEqual(expect.arrayContaining(['./Button.svelte', './styles.css']));
  });

  // Svelte 5's $props() destructuring IS the component's public API. Before
  // TRA-531 the plugin matched `$props()` with a pattern that had no capture
  // group, so every prop of every Svelte 5 component extracted as nothing.
  it('extracts every binding of a $props() destructure', async () => {
    const r = await parse(`<script>
  let { open = false, items = [1, 2, 3], onclick, ...rest } = $props();
</script>`);
    expect(names(r)).toEqual(expect.arrayContaining(['open', 'items', 'onclick', 'rest']));
    expect(r.symbols.find((s) => s.name === 'onclick')?.metadata).toMatchObject({ prop: true });
  });

  it('handles renamed bindings and arrow-function defaults', async () => {
    const r = await parse(`<script>
  let { class: className, onselect = (a, b) => a + b } = $props();
</script>`);
    expect(names(r)).toEqual(expect.arrayContaining(['className', 'onselect']));
    expect(names(r)).not.toContain('class');
  });

  // Verbatim from bits-ui (huntabyte/bits-ui, accordion-trigger.svelte) — a
  // real Svelte 5 library component, not a hand-shaped fixture.
  it('extracts the props of a real-world Svelte 5 component', async () => {
    const r = await parse(`<script lang="ts">
	import { boxWith, mergeProps } from "svelte-toolbelt";
	import type { AccordionTriggerProps } from "../types.js";
	import { AccordionTriggerState } from "../accordion.svelte.js";
	import { createId } from "$lib/internal/create-id.js";

	const uid = $props.id();

	let {
		disabled = false,
		ref = $bindable(null),
		id = createId(uid),
		tabindex = 0,
		children,
		child,
		...restProps
	}: AccordionTriggerProps = $props();

	const mergedProps = $derived(mergeProps(restProps, triggerState.props));
</script>

{#if child}
	{@render child({ props: mergedProps })}
{/if}`);
    expect(names(r)).toEqual(
      expect.arrayContaining([
        'disabled',
        'ref',
        'id',
        'tabindex',
        'children',
        'child',
        'restProps',
        'uid',
        'mergedProps',
      ]),
    );
    // Line numbers must point into the destructure, not at the match start.
    expect(r.symbols.find((s) => s.name === 'tabindex')?.lineStart).toBe(13);
  });
});
