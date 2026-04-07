/**
 * Structured context assembly for AI tools.
 * Groups items by role (primary, dependencies, callers, type context)
 * and allocates token budget proportionally.
 */
import { assembleContext, type ContextItem, type AssembledItem } from './assembly.js';

interface StructuredContextRequest {
  primary: ContextItem[];
  dependencies: ContextItem[];
  callers: ContextItem[];
  typeContext: ContextItem[];
  totalBudget: number;
  budgetWeights?: { primary: number; dependencies: number; callers: number; typeContext: number };
}

interface StructuredContextResult {
  primary: AssembledItem[];
  dependencies: AssembledItem[];
  callers: AssembledItem[];
  typeContext: AssembledItem[];
  totalTokens: number;
  truncated: boolean;
}

const DEFAULT_WEIGHTS = { primary: 0.4, dependencies: 0.3, callers: 0.2, typeContext: 0.1 };

export function assembleStructuredContext(request: StructuredContextRequest): StructuredContextResult {
  const weights = request.budgetWeights ?? DEFAULT_WEIGHTS;
  const budget = request.totalBudget;

  // Redistribute budget from empty categories to non-empty ones proportionally
  type Category = 'primary' | 'dependencies' | 'callers' | 'typeContext';
  const categories: Category[] = ['primary', 'dependencies', 'callers', 'typeContext'];
  const itemCounts: Record<Category, number> = {
    primary: request.primary.length,
    dependencies: request.dependencies.length,
    callers: request.callers.length,
    typeContext: request.typeContext.length,
  };

  let surplusWeight = 0;
  let activeWeight = 0;
  for (const cat of categories) {
    if (itemCounts[cat] === 0) {
      surplusWeight += weights[cat];
    } else {
      activeWeight += weights[cat];
    }
  }

  const effectiveWeights: Record<Category, number> = { primary: 0, dependencies: 0, callers: 0, typeContext: 0 };
  for (const cat of categories) {
    if (itemCounts[cat] === 0) {
      effectiveWeights[cat] = 0;
    } else if (activeWeight > 0) {
      // Original weight + proportional share of surplus
      effectiveWeights[cat] = weights[cat] + surplusWeight * (weights[cat] / activeWeight);
    }
  }

  const primaryResult = assembleContext(request.primary, Math.floor(budget * effectiveWeights.primary));
  const depsResult = assembleContext(request.dependencies, Math.floor(budget * effectiveWeights.dependencies));
  const callersResult = assembleContext(request.callers, Math.floor(budget * effectiveWeights.callers));
  const typeResult = assembleContext(request.typeContext, Math.floor(budget * effectiveWeights.typeContext));

  return {
    primary: primaryResult.items,
    dependencies: depsResult.items,
    callers: callersResult.items,
    typeContext: typeResult.items,
    totalTokens: primaryResult.totalTokens + depsResult.totalTokens + callersResult.totalTokens + typeResult.totalTokens,
    truncated: primaryResult.truncated || depsResult.truncated || callersResult.truncated || typeResult.truncated,
  };
}

/**
 * Render structured context into a flat string for LLM prompts.
 */
export function renderStructuredContext(result: StructuredContextResult): string {
  const sections: string[] = [];

  if (result.primary.length > 0) {
    sections.push('=== Primary Symbol ===\n' + result.primary.map((i) => i.content).join('\n\n'));
  }
  if (result.dependencies.length > 0) {
    sections.push('=== Dependencies ===\n' + result.dependencies.map((i) => i.content).join('\n\n'));
  }
  if (result.callers.length > 0) {
    sections.push('=== Callers ===\n' + result.callers.map((i) => i.content).join('\n\n'));
  }
  if (result.typeContext.length > 0) {
    sections.push('=== Type Hierarchy ===\n' + result.typeContext.map((i) => i.content).join('\n\n'));
  }

  return sections.join('\n\n');
}
