/**
 * Minimal LSP protocol types — hand-written subset for call hierarchy enrichment.
 * Zero external dependencies. Only the types actually used by the LSP bridge.
 */

// ── JSON-RPC ──────────────────────────────────────────────────

export interface JsonRpcMessage {
  jsonrpc: '2.0';
}

export interface JsonRpcRequest extends JsonRpcMessage {
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse extends JsonRpcMessage {
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification extends JsonRpcMessage {
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── Basic LSP Types ───────────────────────────────────────────

export interface Position {
  line: number;      // 0-based
  character: number; // 0-based
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

// ── Initialize ────────────────────────────────────────────────

export interface ClientCapabilities {
  textDocument?: {
    callHierarchy?: { dynamicRegistration?: boolean };
    definition?: { dynamicRegistration?: boolean };
    references?: { dynamicRegistration?: boolean };
  };
  general?: {
    positionEncodings?: string[];
  };
}

export interface InitializeParams {
  processId: number | null;
  rootUri: string | null;
  capabilities: ClientCapabilities;
  initializationOptions?: Record<string, unknown>;
  workspaceFolders?: Array<{ uri: string; name: string }> | null;
}

export interface ServerCapabilities {
  callHierarchyProvider?: boolean | object;
  definitionProvider?: boolean | object;
  referencesProvider?: boolean | object;
  textDocumentSync?: number | { openClose?: boolean; change?: number };
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
}

// ── Call Hierarchy ────────────────────────────────────────────

export interface CallHierarchyPrepareParams extends TextDocumentPositionParams {}

export interface CallHierarchyItem {
  name: string;
  kind: number; // SymbolKind enum
  tags?: number[];
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

export interface CallHierarchyIncomingCallsParams {
  item: CallHierarchyItem;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CallHierarchyOutgoingCallsParams {
  item: CallHierarchyItem;
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

// ── Text Document Sync ────────────────────────────────────────

export interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

export interface DidCloseTextDocumentParams {
  textDocument: TextDocumentIdentifier;
}

// ── Symbol Kind (subset used for mapping) ─────────────────────

export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;
