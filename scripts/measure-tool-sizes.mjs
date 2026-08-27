#!/usr/bin/env node
/**
 * Statically extracts every `server.tool(name, description, schema, ...)` call
 * across src/tools/register/**\/*.ts using the TypeScript compiler API, and
 * reports description length + rough schema-source length per tool, sorted
 * descending. Does not execute the server — pure AST walk.
 *
 * Usage: node scripts/measure-tool-sizes.mjs [--json]
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const REGISTER_DIR = path.join(ROOT, 'src/tools/register');

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...walkFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stringLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    // Best-effort: concat literal parts, mark substitutions with a placeholder
    let s = node.head.text;
    for (const span of node.templateSpans) {
      s += '${...}' + span.literal.text;
    }
    return s;
  }
  // Binary '+' concatenation of string literals
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = stringLiteralValue(node.left);
    const r = stringLiteralValue(node.right);
    if (l !== null && r !== null) return l + r;
  }
  return null;
}

const results = [];
const files = walkFiles(REGISTER_DIR);

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'tool' &&
      (ts.isIdentifier(node.expression.expression) ? node.expression.expression.text === 'server' : true)
    ) {
      const args = node.args ?? node.arguments;
      if (args && args.length >= 2 && (ts.isStringLiteral(args[0]) || ts.isNoSubstitutionTemplateLiteral(args[0]))) {
        const name = args[0].text;
        let descNode = null;
        let schemaNode = null;
        // signatures: (name, desc, schema, cb) | (name, desc, schema, annotations, cb) | (name, schema, cb)
        if (args.length >= 3) {
          const maybeDesc = args[1];
          const isDescStr =
            ts.isStringLiteral(maybeDesc) ||
            ts.isNoSubstitutionTemplateLiteral(maybeDesc) ||
            ts.isTemplateExpression(maybeDesc) ||
            (ts.isBinaryExpression(maybeDesc) && maybeDesc.operatorToken.kind === ts.SyntaxKind.PlusToken);
          if (isDescStr) {
            descNode = maybeDesc;
            schemaNode = args[2];
          } else {
            // (name, schema, cb) form — no description string
            schemaNode = args[1];
          }
        }
        const description = descNode ? stringLiteralValue(descNode) : null;
        const schemaText = schemaNode ? schemaNode.getText(sf) : '';
        results.push({
          name,
          file: path.relative(ROOT, file),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          descLen: description ? description.length : 0,
          schemaLen: schemaText.length,
          totalLen: (description ? description.length : 0) + schemaText.length,
          hasDesc: description !== null,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

results.sort((a, b) => b.totalLen - a.totalLen);

const totalDesc = results.reduce((s, r) => s + r.descLen, 0);
const totalSchema = results.reduce((s, r) => s + r.schemaLen, 0);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ tools: results, totalDesc, totalSchema, count: results.length }, null, 2));
} else {
  console.log(`Found ${results.length} server.tool(...) registrations across ${files.length} files`);
  console.log(`Total description chars: ${totalDesc}`);
  console.log(`Total schema-source chars (rough): ${totalSchema}`);
  console.log('');
  console.log('Top 25 heaviest (description + schema-source chars):');
  for (const r of results.slice(0, 25)) {
    console.log(
      `  ${String(r.totalLen).padStart(6)}  desc=${String(r.descLen).padStart(5)}  schema=${String(r.schemaLen).padStart(5)}  ${r.name}  (${r.file}:${r.line})`,
    );
  }
}
