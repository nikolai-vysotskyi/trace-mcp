/**
 * Versioned prompt templates for all AI tasks.
 * When a template changes, the prompt text changes → cache key changes → fresh generation.
 */

interface PromptTemplate {
  version: number;
  build: (vars: Record<string, string>) => string;
  maxTokens: number;
  temperature: number;
}

export const PROMPTS = {
  summarize_symbol: {
    version: 1,
    build: (v) => {
      const parts = [
        `Summarize this ${v.kind} in one concise sentence. Focus on WHAT it does, not HOW.`,
      ];
      parts.push(`Name: ${v.name}`);
      if (v.fqn) parts.push(`FQN: ${v.fqn}`);
      if (v.signature) parts.push(`Signature: ${v.signature}`);
      if (v.source) parts.push(`Source:\n${v.source}`);
      parts.push('Summary:');
      return parts.join('\n');
    },
    maxTokens: 100,
    temperature: 0.1,
  },

  explain_symbol: {
    version: 1,
    build: (v) => {
      const parts = [
        `Explain this ${v.kind} in detail. Cover: purpose, key behaviors, relationships with other code, and usage patterns.`,
        `Name: ${v.name}`,
      ];
      if (v.fqn) parts.push(`FQN: ${v.fqn}`);
      if (v.signature) parts.push(`Signature: ${v.signature}`);
      if (v.source) parts.push(`Source:\n${v.source}`);
      if (v.context) parts.push(`Related context:\n${v.context}`);
      parts.push('Explanation:');
      return parts.join('\n');
    },
    maxTokens: 500,
    temperature: 0.3,
  },

  suggest_tests: {
    version: 1,
    build: (v) => {
      const parts = [
        'Suggest test cases for this code. For each test, provide a description and what it should verify.',
        `Name: ${v.name}`,
        `Kind: ${v.kind}`,
      ];
      if (v.signature) parts.push(`Signature: ${v.signature}`);
      if (v.source) parts.push(`Source:\n${v.source}`);
      if (v.dependencies) parts.push(`Dependencies:\n${v.dependencies}`);
      parts.push('Respond in JSON: [{ "description": "...", "verifies": "..." }]');
      return parts.join('\n');
    },
    maxTokens: 800,
    temperature: 0.3,
  },

  review_change: {
    version: 1,
    build: (v) => {
      const parts = [
        'Review this code change. Identify potential issues, bugs, or improvements.',
        `File: ${v.filePath}`,
      ];
      if (v.diff) parts.push(`Diff:\n${v.diff}`);
      if (v.blastRadius) parts.push(`Affected dependents:\n${v.blastRadius}`);
      parts.push(
        'Respond in JSON: { "issues": [{ "severity": "high|medium|low", "description": "...", "suggestion": "..." }], "summary": "..." }',
      );
      return parts.join('\n');
    },
    maxTokens: 800,
    temperature: 0.2,
  },

  explain_architecture: {
    version: 1,
    build: (v) => {
      const parts = [
        'Analyze the architecture of this codebase scope. Describe layers, key patterns, and data flow.',
      ];
      if (v.scope) parts.push(`Scope: ${v.scope}`);
      if (v.context) parts.push(`Key symbols and structure:\n${v.context}`);
      parts.push(
        'Respond in JSON: { "overview": "...", "layers": ["..."], "key_patterns": ["..."], "data_flow": ["..."] }',
      );
      return parts.join('\n');
    },
    maxTokens: 1000,
    temperature: 0.3,
  },

  rerank: {
    version: 1,
    build: (v) => {
      return `Rate the relevance of each document to the query on a scale of 0-10.
Query: ${v.query}

Documents:
${v.documents}

Respond with one score per line, in order: just the number, nothing else.`;
    },
    maxTokens: 200,
    temperature: 0.0,
  },
} satisfies Record<string, PromptTemplate>;
