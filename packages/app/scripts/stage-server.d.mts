/* Types for the build script, so `src/main/__tests__/stage-server.test.ts` can
   import it under `tsc --noEmit` without the script itself becoming TypeScript
   — electron-builder's `beforePack` loads it directly, uncompiled. */

export declare const PAYLOAD_ROOTS: string[];

export declare const PAYLOAD_GRAMMARS: string[];

export declare function collectClosure(
  roots: string[],
  from: string,
  opts?: {
    resolve?: (name: string, base: string) => string | null;
    targetOs?: string;
    targetCpu?: string;
  },
): { found: Map<string, string>; missing: string[] };

export declare function assertStagedArch(
  payloadDir: string,
  targetCpu: string,
  inspect?: (file: string) => string | null,
): void;

export declare function stageServer(opts?: { targetArch?: string; targetOs?: string }): {
  version: string;
  packages: number;
};

declare function beforePack(context?: { arch?: number; electronPlatformName?: string }): void;
export default beforePack;
