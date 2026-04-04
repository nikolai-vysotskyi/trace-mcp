/**
 * PHP version feature mapping.
 * Maps AST constructs to the minimum PHP version that introduced them.
 */

/** Minimum PHP version required for specific AST constructs. */
export const PHP_MIN_VERSION: Record<string, string> = {
  // PHP 5.3
  'namespace_definition': '5.3',
  // PHP 5.4
  'trait_declaration': '5.4',
  // PHP 5.5
  'yield_expression': '5.5',
  // PHP 5.6
  'variadic_parameter': '5.6',
  // PHP 7.0
  'return_type': '7.0',
  'anonymous_class': '7.0',
  'null_coalesce': '7.0',
  // PHP 7.1
  'nullable_type': '7.1',
  // PHP 7.4
  'typed_property': '7.4',
  'arrow_function': '7.4',
  // PHP 8.0
  'attribute_list': '8.0',
  'match_expression': '8.0',
  'named_argument': '8.0',
  'union_type': '8.0',
  'nullsafe_member_access_expression': '8.0',
  // PHP 8.1
  'enum_declaration': '8.1',
  'readonly_modifier': '8.1',
  'intersection_type': '8.1',
  // PHP 8.2
  'disjunctive_normal_form_type': '8.2',
  // PHP 8.4
  'property_hook_list': '8.4',
};

/**
 * Determine the minimum PHP version required for a symbol based on its AST features.
 * Returns undefined if the symbol uses only pre-8.0 features.
 */
export function detectMinPhpVersion(nodeTypes: string[]): string | undefined {
  let maxVersion: string | undefined;
  for (const nt of nodeTypes) {
    const ver = PHP_MIN_VERSION[nt];
    if (ver && (!maxVersion || ver > maxVersion)) {
      maxVersion = ver;
    }
  }
  return maxVersion;
}
