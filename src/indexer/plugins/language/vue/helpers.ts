/**
 * Helper utilities for the Vue SFC language plugin.
 * Extracts props, emits, exposed keys, composables, and template components.
 */

/** HTML elements to exclude when detecting custom components in templates. */
const HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base',
  'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select',
  'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

/** SVG elements to exclude. */
const SVG_ELEMENTS = new Set([
  'svg', 'circle', 'clipPath', 'defs', 'desc', 'ellipse', 'feBlend',
  'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge',
  'feMergeNode', 'feMorphology', 'feOffset', 'feSpecularLighting',
  'feTile', 'feTurbulence', 'filter', 'foreignObject', 'g', 'image',
  'line', 'linearGradient', 'marker', 'mask', 'path', 'pattern', 'polygon',
  'polyline', 'radialGradient', 'rect', 'stop', 'switch', 'symbol', 'text',
  'textPath', 'tspan', 'use', 'view',
]);

/** Vue built-in components / directives. */
const VUE_BUILTINS = new Set([
  'component', 'transition', 'transition-group', 'keep-alive', 'teleport',
  'suspense', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport',
  'Suspense', 'Component', 'RouterView', 'RouterLink', 'router-view',
  'router-link',
]);

/**
 * Check if a tag name is a custom component (not HTML built-in).
 * Custom components are PascalCase or kebab-case with a hyphen.
 */
function isCustomComponent(tag: string): boolean {
  if (VUE_BUILTINS.has(tag)) return false;
  if (HTML_ELEMENTS.has(tag.toLowerCase())) return false;
  if (SVG_ELEMENTS.has(tag)) return false;

  // PascalCase: starts with uppercase
  if (/^[A-Z]/.test(tag)) return true;
  // kebab-case with hyphen (custom elements must contain a hyphen)
  if (tag.includes('-')) return true;

  return false;
}

/**
 * Extract component tags from template content using regex.
 * Finds both self-closing and opening tags.
 */
export function extractTemplateComponents(templateContent: string): string[] {
  const tags = new Set<string>();
  // Match opening tags: <TagName or <tag-name
  const tagRegex = /<([A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(templateContent)) !== null) {
    const tag = match[1];
    if (isCustomComponent(tag)) {
      tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Extract prop names from defineProps calls in script setup content.
 * Handles:
 *   - defineProps<{ name: type, ... }>()
 *   - defineProps({ name: { type: ... } })
 *   - defineProps(['name1', 'name2'])
 */
export function extractProps(scriptContent: string): string[] {
  const props: string[] = [];

  // Type-based: defineProps<{ prop: type; ... }>()
  const typeMatch = scriptContent.match(/defineProps\s*<\s*\{([^}]+)\}\s*>/);
  if (typeMatch) {
    const body = typeMatch[1];
    // Match property names: `name:` or `name?:`
    const propNames = body.match(/(\w+)\s*[?]?\s*:/g);
    if (propNames) {
      for (const p of propNames) {
        props.push(p.replace(/\s*[?]?\s*:/, ''));
      }
    }
    return props;
  }

  // Array-based: defineProps(['name1', 'name2'])
  const arrayMatch = scriptContent.match(/defineProps\s*\(\s*\[([^\]]+)\]/);
  if (arrayMatch) {
    const items = arrayMatch[1].match(/['"](\w+)['"]/g);
    if (items) {
      for (const item of items) {
        props.push(item.replace(/['"]/g, ''));
      }
    }
    return props;
  }

  // Object-based: defineProps({ name: { type: String }, name2: String })
  const objectMatch = scriptContent.match(/defineProps\s*\(\s*\{([^)]+)\}/);
  if (objectMatch) {
    const body = objectMatch[1];
    const propNames = body.match(/(\w+)\s*:/g);
    if (propNames) {
      for (const p of propNames) {
        const name = p.replace(/\s*:/, '');
        // Skip type/default/required/validator which are prop option keys
        if (!['type', 'default', 'required', 'validator'].includes(name)) {
          props.push(name);
        }
      }
    }
    return props;
  }

  return props;
}

/**
 * Extract emit names from defineEmits calls.
 * Handles:
 *   - defineEmits<{ (e: 'name', ...): void }>()
 *   - defineEmits(['name1', 'name2'])
 */
export function extractEmits(scriptContent: string): string[] {
  const emits: string[] = [];

  // Type-based: defineEmits<{ (e: 'name', ...): void }>()
  const typeMatch = scriptContent.match(/defineEmits\s*<\s*\{([^}]+)\}\s*>/);
  if (typeMatch) {
    const body = typeMatch[1];
    const eventNames = body.match(/['"](\w+)['"]/g);
    if (eventNames) {
      for (const name of eventNames) {
        emits.push(name.replace(/['"]/g, ''));
      }
    }
    return emits;
  }

  // Array-based: defineEmits(['name1', 'name2'])
  const arrayMatch = scriptContent.match(/defineEmits\s*\(\s*\[([^\]]+)\]/);
  if (arrayMatch) {
    const items = arrayMatch[1].match(/['"](\w+)['"]/g);
    if (items) {
      for (const item of items) {
        emits.push(item.replace(/['"]/g, ''));
      }
    }
    return emits;
  }

  return emits;
}

/**
 * Extract exposed keys from defineExpose({ key1, key2 }).
 */
export function extractExposed(scriptContent: string): string[] {
  const match = scriptContent.match(/defineExpose\s*\(\s*\{([^}]+)\}/);
  if (!match) return [];

  const body = match[1];
  const keys: string[] = [];
  // Match shorthand properties and key: value pairs
  const propPattern = /(\w+)\s*(?:,|$|\s*:)/g;
  let m: RegExpExecArray | null;
  while ((m = propPattern.exec(body)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/**
 * Detect composable usage: function calls matching use[A-Z]\w+.
 */
export function extractComposables(scriptContent: string): string[] {
  const composables = new Set<string>();
  const pattern = /\buse[A-Z]\w+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(scriptContent)) !== null) {
    composables.add(match[0]);
  }
  return [...composables];
}

/**
 * Derive component name from file path.
 * e.g., 'src/components/UserCard.vue' → 'UserCard'
 */
export function componentNameFromPath(filePath: string): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  return fileName.replace(/\.vue$/, '');
}
