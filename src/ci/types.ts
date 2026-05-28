/**
 * Shared type declarations for the CI subsystem.
 *
 * Both `baseline.ts` and `report-generator.ts` need to reference
 * `BaselineComparison`, and `CIReport` (defined in report-generator.ts)
 * embeds it. Hosting the shared type here breaks the import cycle
 * between the two modules.
 */
export interface BaselineComparison {
  riskDelta: number;
  untestedDelta: number;
  violationsDelta: number;
  deadExportsDelta: number;
  regressionDetected: boolean;
  baselineCommit: string | null;
  baselineDate: string;
}
