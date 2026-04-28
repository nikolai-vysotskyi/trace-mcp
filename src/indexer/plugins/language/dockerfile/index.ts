/**
 * Dockerfile Language Plugin — regex-based symbol extraction.
 *
 * Extracts: FROM stages, ARG/ENV declarations, EXPOSE ports, LABEL entries, COPY/ADD sources.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'dockerfile',
  language: 'dockerfile',
  extensions: ['Dockerfile', '.dockerfile'],
  symbolPatterns: [
    // FROM image[:tag] [AS name]
    { kind: 'module', pattern: /^\s*FROM\s+(\S+)(?:\s+AS\s+(\w+))?/gim, meta: { stage: true } },
    // ARG name[=default]
    { kind: 'variable', pattern: /^\s*ARG\s+(\w+)/gim, meta: { arg: true } },
    // ENV name=value or ENV name value
    { kind: 'variable', pattern: /^\s*ENV\s+(\w+)/gim, meta: { env: true } },
    // EXPOSE port
    { kind: 'constant', pattern: /^\s*EXPOSE\s+(\d+(?:\/\w+)?)/gim, meta: { port: true } },
    // LABEL key=value
    { kind: 'constant', pattern: /^\s*LABEL\s+(\S+)\s*=/gim },
    // ENTRYPOINT / CMD
    { kind: 'function', pattern: /^\s*(ENTRYPOINT|CMD)\s+/gim },
    // VOLUME
    { kind: 'variable', pattern: /^\s*VOLUME\s+(\S+)/gim },
  ],
  importPatterns: [
    // COPY --from=stage
    { pattern: /^\s*COPY\s+--from=(\w+)/gim },
  ],
});

export const DockerfileLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
