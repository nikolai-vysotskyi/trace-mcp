/**
 * Vue component name resolution.
 *
 * Converts between PascalCase and kebab-case, and resolves component tags
 * to actual file paths using import maps and auto-registration conventions.
 */

/** Convert PascalCase to kebab-case: "UserCard" -> "user-card" */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** Convert kebab-case to PascalCase: "user-card" -> "UserCard" */
export function toPascalCase(name: string): string {
  return name
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

/**
 * Resolve a template component tag to a file path.
 *
 * Resolution order:
 * 1. Check explicit imports (exact match or PascalCase/kebab-case variants)
 * 2. Check auto-registered component files by name convention
 *
 * @param tag - The component tag from the template (e.g. "UserCard" or "user-card")
 * @param imports - Map of imported name -> file path (from script imports)
 * @param componentFiles - Map of component name -> file path (auto-registered)
 * @returns The resolved file path, or undefined if not found
 */
export function resolveComponentTag(
  tag: string,
  imports: Map<string, string>,
  componentFiles: Map<string, string>,
): string | undefined {
  // 1. Direct import match
  if (imports.has(tag)) return imports.get(tag);

  // 2. Try PascalCase variant of the tag
  const pascal = toPascalCase(tag);
  if (imports.has(pascal)) return imports.get(pascal);

  // 3. Try kebab-case variant of the tag
  const kebab = toKebabCase(tag);
  if (imports.has(kebab)) return imports.get(kebab);

  // 4. Auto-registered by PascalCase name
  if (componentFiles.has(tag)) return componentFiles.get(tag);
  if (componentFiles.has(pascal)) return componentFiles.get(pascal);

  // 5. Auto-registered by kebab-case name
  if (componentFiles.has(kebab)) return componentFiles.get(kebab);

  return undefined;
}
