/**
 * Protocol Buffers Language Plugin -- regex-based symbol extraction.
 *
 * Extracts: message, enum, service, rpc, oneof definitions and import statements.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'protobuf',
  language: 'protobuf',
  extensions: ['.proto'],
  symbolPatterns: [
    // message Name {
    {
      kind: 'class',
      pattern: /^\s*message\s+([A-Za-z_]\w*)\s*\{/gm,
      meta: { protoKind: 'message' },
    },
    // enum Name {
    {
      kind: 'enum',
      pattern: /^\s*enum\s+([A-Za-z_]\w*)\s*\{/gm,
      meta: { protoKind: 'enum' },
    },
    // service Name {
    {
      kind: 'interface',
      pattern: /^\s*service\s+([A-Za-z_]\w*)\s*\{/gm,
      meta: { protoKind: 'service' },
    },
    // rpc MethodName(
    {
      kind: 'method',
      pattern: /^\s*rpc\s+([A-Za-z_]\w*)\s*\(/gm,
      meta: { protoKind: 'rpc' },
    },
    // oneof name {
    {
      kind: 'property',
      pattern: /^\s*oneof\s+([A-Za-z_]\w*)\s*\{/gm,
      meta: { protoKind: 'oneof' },
    },
  ],
  importPatterns: [
    // import "path.proto";
    {
      pattern: /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm,
    },
  ],
});

export const ProtobufLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
