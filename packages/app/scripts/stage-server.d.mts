/* Types for the build script, so `src/main/__tests__/stage-server.test.ts` can
   import it under `tsc --noEmit` without the script itself becoming TypeScript
   — electron-builder's `beforePack` loads it directly, uncompiled. */

export declare const PAYLOAD_ROOTS: string[];

export declare function collectClosure(
  roots: string[],
  from: string,
  resolve?: (name: string, base: string) => string | null,
): { found: Map<string, string>; missing: string[] };

export declare function assertNativeArch(targetArch?: string, hostArch?: string): void;

export declare function stageServer(opts?: { targetArch?: string }): {
  version: string;
  packages: number;
};

declare function beforePack(context?: { arch?: number }): void;
export default beforePack;
