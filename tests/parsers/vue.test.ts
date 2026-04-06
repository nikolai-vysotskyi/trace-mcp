import { describe, it, expect } from 'vitest';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

async function parse(code: string, filePath = 'src/components/MyComponent.vue') {
  const plugin = new VueLanguagePlugin();
  const result = await plugin.extractSymbols(filePath, Buffer.from(code, 'utf-8'));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function findSymbol(symbols: RawSymbol[], name: string, kind?: string): RawSymbol {
  const found = symbols.find((s) => s.name === name && (!kind || s.kind === kind));
  if (!found) throw new Error(`Symbol "${name}" (kind=${kind}) not found`);
  return found;
}

// ---------- script setup with defineProps/defineEmits/defineExpose ----------

describe('Vue plugin — script setup with defineProps/defineEmits/defineExpose', () => {
  const code = `<script setup lang="ts">
import { ref } from 'vue'
import UserCard from './UserCard.vue'

defineProps<{ users: User[], title: string }>()
defineEmits<{ (e: 'select', id: number): void }>()
defineExpose({ refresh })

const count = ref(0)
</script>

<template>
  <div>
    <UserCard v-for="user in users" :key="user.id" :user="user" />
    <el-button @click="count++">{{ title }}</el-button>
  </div>
</template>`;

  it('extracts component-level symbol', async () => {
    const result = await parse(code, 'src/components/UserList.vue');
    const comp = findSymbol(result.symbols, 'UserList', 'class');
    expect(comp.symbolId).toBe('src/components/UserList.vue::UserList#class');
    expect(comp.metadata?.framework).toBe('vue');
    expect(comp.metadata?.sfc).toBe(true);
  });

  it('extracts props from defineProps type syntax', async () => {
    const result = await parse(code, 'src/components/UserList.vue');
    expect(result.components).toBeDefined();
    expect(result.components!.length).toBe(1);
    const comp = result.components![0];
    expect(comp.props).toBeDefined();
    expect(Object.keys(comp.props!)).toContain('users');
    expect(Object.keys(comp.props!)).toContain('title');
  });

  it('extracts emits from defineEmits type syntax', async () => {
    const result = await parse(code, 'src/components/UserList.vue');
    const comp = result.components![0];
    expect(comp.emits).toContain('select');
  });

  it('extracts exposed keys', async () => {
    const result = await parse(code, 'src/components/UserList.vue');
    const sym = findSymbol(result.symbols, 'UserList', 'class');
    expect(sym.metadata?.exposed).toContain('refresh');
  });

  it('extracts import edges from script setup', async () => {
    const result = await parse(code, 'src/components/UserList.vue');
    expect(result.edges).toBeDefined();
    const vueImport = result.edges!.find(
      (e) => (e.metadata as Record<string, unknown>).from === 'vue',
    );
    expect(vueImport).toBeDefined();
    expect(vueImport!.edgeType).toBe('imports');
  });

  it('sets language to vue', async () => {
    const result = await parse(code);
    expect(result.language).toBe('vue');
  });
});

// ---------- template component extraction ----------

describe('Vue plugin — template component extraction', () => {
  const code = `<script setup lang="ts">
import UserCard from './UserCard.vue'
</script>

<template>
  <div>
    <UserCard :user="user" />
    <el-button>Click</el-button>
    <span>Not a component</span>
  </div>
</template>`;

  it('extracts custom component tags from template', async () => {
    const result = await parse(code);
    const comp = findSymbol(result.symbols, 'MyComponent', 'class');
    const templateComponents = comp.metadata?.templateComponents as string[];
    expect(templateComponents).toBeDefined();
    expect(templateComponents).toContain('UserCard');
    expect(templateComponents).toContain('el-button');
  });

  it('excludes HTML built-in elements', async () => {
    const result = await parse(code);
    const comp = findSymbol(result.symbols, 'MyComponent', 'class');
    const templateComponents = comp.metadata?.templateComponents as string[];
    expect(templateComponents).not.toContain('div');
    expect(templateComponents).not.toContain('span');
  });
});

// ---------- Options API (non-setup script) ----------

describe('Vue plugin — Options API script', () => {
  const code = `<script lang="ts">
export default {
  name: 'MyComponent',
  props: {
    message: String
  },
  methods: {
    greet() { console.log(this.message) }
  }
}
</script>`;

  it('creates component-level symbol', async () => {
    const result = await parse(code);
    const comp = findSymbol(result.symbols, 'MyComponent', 'class');
    expect(comp).toBeDefined();
    expect(comp.kind).toBe('class');
  });

  it('returns status ok for valid SFC', async () => {
    const result = await parse(code);
    expect(result.status).toBe('ok');
  });

  it('returns a RawComponent with framework=vue', async () => {
    const result = await parse(code);
    expect(result.components).toBeDefined();
    expect(result.components![0].framework).toBe('vue');
    expect(result.components![0].kind).toBe('component');
  });
});

// ---------- composable detection ----------

describe('Vue plugin — composable detection', () => {
  const code = `<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuth } from '@/composables/auth'

const router = useRouter()
const { user } = useAuth()
</script>

<template>
  <div>{{ user?.name }}</div>
</template>`;

  it('detects composable usage in script setup', async () => {
    const result = await parse(code);
    const comp = result.components![0];
    expect(comp.composables).toContain('useRouter');
    expect(comp.composables).toContain('useAuth');
  });

  it('stores composables in component symbol metadata', async () => {
    const result = await parse(code);
    const sym = findSymbol(result.symbols, 'MyComponent', 'class');
    expect(sym.metadata?.composables).toContain('useRouter');
    expect(sym.metadata?.composables).toContain('useAuth');
  });
});

// ---------- broken/invalid SFC ----------

describe('Vue plugin — broken SFC', () => {
  it('handles completely broken content without crashing', async () => {
    const plugin = new VueLanguagePlugin();
    const result = await plugin.extractSymbols(
      'broken.vue',
      Buffer.from('<<<not valid at all>>>', 'utf-8'),
    );
    // Should still succeed (SFC parser is lenient), possibly with warnings
    expect(result.isOk()).toBe(true);
  });

  it('handles empty content', async () => {
    const plugin = new VueLanguagePlugin();
    const result = await plugin.extractSymbols(
      'empty.vue',
      Buffer.from('', 'utf-8'),
    );
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.language).toBe('vue');
    // Still creates the component symbol
    expect(parsed.symbols.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- empty SFC with only template ----------

describe('Vue plugin — template-only SFC', () => {
  const code = `<template>
  <div>
    <MyWidget />
    <p>Hello</p>
  </div>
</template>`;

  it('extracts component symbol and template components', async () => {
    const result = await parse(code, 'src/components/Simple.vue');
    const comp = findSymbol(result.symbols, 'Simple', 'class');
    expect(comp).toBeDefined();
    const templateComponents = comp.metadata?.templateComponents as string[];
    expect(templateComponents).toContain('MyWidget');
  });

  it('has no edges when there is no script', async () => {
    const result = await parse(code);
    expect(result.edges).toBeUndefined();
  });
});

// ---------- array-based defineProps/defineEmits ----------

describe('Vue plugin — array-based defineProps and defineEmits', () => {
  const code = `<script setup>
defineProps(['name', 'age', 'active'])
defineEmits(['click', 'submit'])
</script>

<template><div /></template>`;

  it('extracts props from array syntax', async () => {
    const result = await parse(code);
    const comp = result.components![0];
    expect(Object.keys(comp.props!)).toEqual(
      expect.arrayContaining(['name', 'age', 'active']),
    );
  });

  it('extracts emits from array syntax', async () => {
    const result = await parse(code);
    const comp = result.components![0];
    expect(comp.emits).toEqual(expect.arrayContaining(['click', 'submit']));
  });
});

// ---------- manifest ----------

describe('Vue plugin — manifest', () => {
  it('has correct manifest properties', () => {
    const plugin = new VueLanguagePlugin();
    expect(plugin.manifest.name).toBe('vue-language');
    expect(plugin.manifest.priority).toBe(10);
    expect(plugin.supportedExtensions).toEqual(['.vue']);
  });
});
