import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';
import { getDataflow } from '../../src/tools/analysis/dataflow.js';

describe('getDataflow', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
    tmpDir = createTmpDir('dataflow-');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  function setupFile(filePath: string, content: string) {
    const absPath = path.join(tmpDir, filePath);
    fs.writeFileSync(absPath, content);
    const lines = content.split('\n');
    return { absPath, lineCount: lines.length };
  }

  it('tracks parameter flow into function calls', () => {
    const content = [
      'export function processOrder(order, user) {',
      '  validateOrder(order);',
      '  checkPermission(user);',
      '  const total = calculateTotal(order.items);',
      '  return createInvoice(total, user);',
      '}',
    ].join('\n');
    setupFile('src/order.ts', content);

    const fileId = store.insertFile('src/order.ts', 'typescript', 'h1', 200);
    store.insertSymbol(fileId, {
      symbolId: 'src/order.ts::processOrder#function',
      name: 'processOrder',
      kind: 'function',
      fqn: 'processOrder',
      signature: 'function processOrder(order, user)',
      byteStart: 0,
      byteEnd: content.length,
      lineStart: 1,
      lineEnd: 6,
    });

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/order.ts::processOrder#function',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    expect(data.parameters).toHaveLength(2);

    // Check 'order' param
    const orderParam = data.parameters.find((p) => p.name === 'order')!;
    expect(orderParam).toBeDefined();
    expect(orderParam.flows_to.some((f) => f.target === 'validateOrder')).toBe(true);
    expect(orderParam.flows_to.some((f) => f.target === 'calculateTotal')).toBe(true);

    // Check 'user' param
    const userParam = data.parameters.find((p) => p.name === 'user')!;
    expect(userParam).toBeDefined();
    expect(userParam.flows_to.some((f) => f.target === 'checkPermission')).toBe(true);
    expect(userParam.flows_to.some((f) => f.target === 'createInvoice')).toBe(true);
  });

  it('detects mutations (property assignments)', () => {
    const content = [
      'export function processOrder(order) {',
      '  order.status = "processing";',
      '  order.total = calculateTotal(order);',
      '  return order;',
      '}',
    ].join('\n');
    setupFile('src/order.ts', content);

    const fileId = store.insertFile('src/order.ts', 'typescript', 'h1', 200);
    store.insertSymbol(fileId, {
      symbolId: 'src/order.ts::processOrder#function',
      name: 'processOrder',
      kind: 'function',
      signature: 'function processOrder(order)',
      byteStart: 0,
      byteEnd: content.length,
      lineStart: 1,
      lineEnd: 5,
    });

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/order.ts::processOrder#function',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const orderParam = data.parameters[0];

    expect(orderParam.mutations.length).toBe(2);
    expect(orderParam.mutations[0].property).toBe('status');
    expect(orderParam.mutations[1].property).toBe('total');
  });

  it('tracks return statements with param references', () => {
    const content = [
      'export function transform(input) {',
      '  const result = processData(input);',
      '  return result;',
      '}',
    ].join('\n');
    setupFile('src/transform.ts', content);

    const fileId = store.insertFile('src/transform.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fileId, {
      symbolId: 'src/transform.ts::transform#function',
      name: 'transform',
      kind: 'function',
      signature: 'function transform(input)',
      byteStart: 0,
      byteEnd: content.length,
      lineStart: 1,
      lineEnd: 4,
    });

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/transform.ts::transform#function',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.returns.length).toBe(1);
    expect(data.returns[0].expression).toBe('result');
  });

  it('tracks local assignments involving params', () => {
    const content = [
      'export function calculate(price, quantity) {',
      '  const subtotal = price * quantity;',
      '  const tax = calculateTax(subtotal);',
      '  const total = subtotal + tax;',
      '  return total;',
      '}',
    ].join('\n');
    setupFile('src/calc.ts', content);

    const fileId = store.insertFile('src/calc.ts', 'typescript', 'h1', 150);
    store.insertSymbol(fileId, {
      symbolId: 'src/calc.ts::calculate#function',
      name: 'calculate',
      kind: 'function',
      signature: 'function calculate(price, quantity)',
      byteStart: 0,
      byteEnd: content.length,
      lineStart: 1,
      lineEnd: 6,
    });

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/calc.ts::calculate#function',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.localAssignments.length).toBeGreaterThan(0);
    expect(data.localAssignments.some((a) => a.name === 'subtotal')).toBe(true);
  });

  it('parses TypeScript typed parameters', () => {
    const content = [
      'export function login(email: string, password: string): Promise<User> {',
      '  const user = findUser(email);',
      '  return verify(password, user.hash);',
      '}',
    ].join('\n');
    setupFile('src/auth.ts', content);

    const fileId = store.insertFile('src/auth.ts', 'typescript', 'h1', 150);
    store.insertSymbol(fileId, {
      symbolId: 'src/auth.ts::login#function',
      name: 'login',
      kind: 'function',
      signature: 'function login(email: string, password: string): Promise<User>',
      byteStart: 0,
      byteEnd: content.length,
      lineStart: 1,
      lineEnd: 4,
    });

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/auth.ts::login#function',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.parameters.length).toBe(2);
    expect(data.parameters[0].name).toBe('email');
    expect(data.parameters[0].type).toBe('string');
    expect(data.parameters[1].name).toBe('password');
    expect(data.parameters[1].type).toBe('string');
  });

  it('returns error for non-function symbols', () => {
    const content = 'export class User { name: string; }';
    setupFile('src/user.ts', content);

    const fileId = store.insertFile('src/user.ts', 'typescript', 'h1', 50);
    store.insertSymbol(fileId, {
      symbolId: 'src/user.ts::User#class',
      name: 'User',
      kind: 'class',
      byteStart: 0,
      byteEnd: 35,
      lineStart: 1,
      lineEnd: 1,
    });

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/user.ts::User#class',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('VALIDATION_ERROR');
  });

  it('returns error for unknown symbol', () => {
    const result = getDataflow(store, tmpDir, {
      symbolId: 'nonexistent::foo#function',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('resolves callees using graph edges', () => {
    const content = [
      'export function handler(req) {',
      '  const data = parseBody(req);',
      '  return respond(data);',
      '}',
    ].join('\n');
    setupFile('src/handler.ts', content);
    setupFile('src/parser.ts', 'export function parseBody(req) { return JSON.parse(req.body); }');

    // Index files and symbols
    const f1 = store.insertFile('src/handler.ts', 'typescript', 'h1', 100);
    const f2 = store.insertFile('src/parser.ts', 'typescript', 'h2', 80);

    const s1 = store.insertSymbol(f1, {
      symbolId: 'src/handler.ts::handler#function',
      name: 'handler',
      kind: 'function',
      signature: 'function handler(req)',
      byteStart: 0,
      byteEnd: content.length,
      lineStart: 1,
      lineEnd: 4,
    });

    const s2 = store.insertSymbol(f2, {
      symbolId: 'src/parser.ts::parseBody#function',
      name: 'parseBody',
      kind: 'function',
      byteStart: 0,
      byteEnd: 60,
      lineStart: 1,
      lineEnd: 1,
    });

    // Create edge: handler → calls → parseBody
    const n1 = store.getNodeId('symbol', s1)!;
    const n2 = store.getNodeId('symbol', s2)!;
    store.insertEdge(n1, n2, 'calls');

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/handler.ts::handler#function',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const reqParam = data.parameters[0];

    // parseBody should be resolved with its symbolId
    const parseBodyFlow = reqParam.flows_to.find((f) => f.target === 'parseBody');
    expect(parseBodyFlow).toBeDefined();
    expect(parseBodyFlow!.symbolId).toBe('src/parser.ts::parseBody#function');
    expect(parseBodyFlow!.file).toBe('src/parser.ts');
  });

  it('handles function with no params gracefully', () => {
    const content = ['export function getTime() {', '  return Date.now();', '}'].join('\n');
    setupFile('src/time.ts', content);

    const fileId = store.insertFile('src/time.ts', 'typescript', 'h1', 50);
    store.insertSymbol(fileId, {
      symbolId: 'src/time.ts::getTime#function',
      name: 'getTime',
      kind: 'function',
      signature: 'function getTime()',
      byteStart: 0,
      byteEnd: content.length,
      lineStart: 1,
      lineEnd: 3,
    });

    const result = getDataflow(store, tmpDir, {
      symbolId: 'src/time.ts::getTime#function',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.parameters).toHaveLength(0);
    expect(data.returns.length).toBe(1);
  });
});
