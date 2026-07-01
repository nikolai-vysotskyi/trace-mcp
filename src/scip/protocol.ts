/**
 * Minimal, zero-dependency decoder for the SCIP protobuf wire format.
 *
 * Why hand-rolled: the official Sourcegraph SCIP TypeScript bindings are not
 * reliably published on npm, and pulling a full protobuf runtime + generated
 * stubs for the handful of fields we read would be heavy. This mirrors the
 * approach taken by `src/lsp/protocol.ts`, which hand-writes the LSP types it
 * needs. We decode only the subset of the SCIP schema required to upgrade edge
 * precision: Index → Documents → Occurrences (symbol, range, symbol_roles) and
 * each occurrence's enclosing definition.
 *
 * SCIP schema reference (field numbers are part of the stable wire contract):
 *   message Index {
 *     Metadata metadata = 1;
 *     repeated Document documents = 2;
 *     repeated SymbolInformation external_symbols = 3;
 *   }
 *   message Document {
 *     string language = 4;
 *     string relative_path = 1;
 *     repeated Occurrence occurrences = 2;
 *     repeated SymbolInformation symbols = 3;
 *   }
 *   message Occurrence {
 *     repeated int32 range = 1;          // [startLine, startCol, endLine, endCol] or
 *                                        // [startLine, startCol, endCol] (same-line)
 *     string symbol = 2;
 *     int32 symbol_roles = 3;            // bitset; Definition = 0x1
 *     ... (other fields ignored)
 *   }
 *
 * Protobuf wire types we handle: VARINT (0), LEN (2), packed repeated int32.
 */

/** SymbolRole bitset values (SCIP spec). */
export const SCIP_SYMBOL_ROLE_DEFINITION = 0x1;

export interface ScipRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ScipOccurrence {
  /** SCIP symbol descriptor string (globally unique within the index). */
  symbol: string;
  range: ScipRange;
  /** symbol_roles bitset — test against SCIP_SYMBOL_ROLE_DEFINITION. */
  symbolRoles: number;
  isDefinition: boolean;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
}

export interface ScipIndex {
  documents: ScipDocument[];
}

// ─── Low-level protobuf reader ───────────────────────────────────────────────

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Read a base-128 varint as an unsigned number (safe for our int32 fields). */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  /** Decode a zig-zag varint into a signed int32 (SCIP ranges are signed). */
  readSignedVarint(): number {
    const raw = this.readVarint();
    return (raw >>> 1) ^ -(raw & 1);
  }

  /** Read a length-delimited byte slice. */
  readBytes(): Uint8Array {
    const len = this.readVarint();
    const start = this.pos;
    this.pos += len;
    return this.buf.subarray(start, start + len);
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  /** Skip a field whose wire type we do not care about. */
  skipField(wireType: number): void {
    switch (wireType) {
      case 0: // VARINT
        this.readVarint();
        break;
      case 1: // I64
        this.pos += 8;
        break;
      case 2: {
        // LEN. NOTE: `this.pos += this.readVarint()` is WRONG — JS evaluates the
        // `this.pos` on the left to its pre-call value, then readVarint() also
        // advances this.pos past the length prefix, so the addition double-counts
        // from the stale base and lands 1+ bytes short. Capture the length first,
        // then advance. (This off-by-one only manifested on real .scip files that
        // contain skipped LEN fields — e.g. Document.symbols — followed by more
        // fields; the synthetic decoder tests never exercised that path.)
        const len = this.readVarint();
        this.pos += len;
        break;
      }
      case 5: // I32
        this.pos += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }
}

interface Tag {
  fieldNumber: number;
  wireType: number;
}

function readTag(r: Reader): Tag {
  const key = r.readVarint();
  return { fieldNumber: key >>> 3, wireType: key & 0x7 };
}

// ─── Message decoders ────────────────────────────────────────────────────────

/**
 * Range arrays in SCIP are packed signed int32s. The two valid shapes are
 *   [startLine, startCol, endLine, endCol]
 *   [startLine, startCol, endCol]            (start/end on the same line)
 */
function rangeFromInts(ints: number[]): ScipRange {
  if (ints.length === 4) {
    return {
      startLine: ints[0],
      startCharacter: ints[1],
      endLine: ints[2],
      endCharacter: ints[3],
    };
  }
  if (ints.length === 3) {
    return {
      startLine: ints[0],
      startCharacter: ints[1],
      endLine: ints[0],
      endCharacter: ints[2],
    };
  }
  // Malformed — surface a zero range rather than throwing the whole parse.
  return { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 };
}

function decodeOccurrence(bytes: Uint8Array): ScipOccurrence {
  const r = new Reader(bytes);
  const rangeInts: number[] = [];
  let symbol = '';
  let symbolRoles = 0;

  while (!r.eof) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1) {
      // range: `repeated int32`. In proto3, `int32` is encoded as a PLAIN
      // varint (two's complement) — NOT zig-zag. Only `sint32`/`sint64` use
      // zig-zag. SCIP ranges are always 0-based and non-negative, so plain
      // varint is both correct and never negative. (Reading them as zig-zag —
      // the previous bug — produced garbage negative lines/chars on real .scip
      // files, so no reference occurrence ever matched a symbol and NO
      // scip_resolved edges were produced. The synthetic decoder tests missed
      // this because their test writer also zig-zag-encoded the range, making
      // the round-trip self-consistent but wrong vs. real indexers.)
      // Packed (LEN) is the common case; tolerate the unpacked (one VARINT per
      // element) form too.
      if (wireType === 2) {
        const sub = new Reader(r.readBytes());
        while (!sub.eof) rangeInts.push(sub.readVarint());
      } else if (wireType === 0) {
        rangeInts.push(r.readVarint());
      } else {
        r.skipField(wireType);
      }
    } else if (fieldNumber === 2 && wireType === 2) {
      symbol = r.readString();
    } else if (fieldNumber === 3 && wireType === 0) {
      symbolRoles = r.readVarint();
    } else {
      r.skipField(wireType);
    }
  }

  return {
    symbol,
    range: rangeFromInts(rangeInts),
    symbolRoles,
    isDefinition: (symbolRoles & SCIP_SYMBOL_ROLE_DEFINITION) !== 0,
  };
}

function decodeDocument(bytes: Uint8Array): ScipDocument {
  const r = new Reader(bytes);
  let relativePath = '';
  let language = '';
  const occurrences: ScipOccurrence[] = [];

  while (!r.eof) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1 && wireType === 2) {
      relativePath = r.readString();
    } else if (fieldNumber === 2 && wireType === 2) {
      occurrences.push(decodeOccurrence(r.readBytes()));
    } else if (fieldNumber === 4 && wireType === 2) {
      language = r.readString();
    } else {
      r.skipField(wireType);
    }
  }

  return { relativePath, language, occurrences };
}

/**
 * Decode a SCIP `Index` protobuf message from a `.scip` file's bytes.
 * Only Documents → Occurrences are extracted; everything else is skipped.
 */
export function decodeScipIndex(bytes: Uint8Array): ScipIndex {
  const r = new Reader(bytes);
  const documents: ScipDocument[] = [];

  while (!r.eof) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 2 && wireType === 2) {
      documents.push(decodeDocument(r.readBytes()));
    } else {
      r.skipField(wireType);
    }
  }

  return { documents };
}
