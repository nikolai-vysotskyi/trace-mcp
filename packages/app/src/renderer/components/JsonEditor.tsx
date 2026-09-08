/* JsonEditor.tsx — macOS Tahoe styled JSON editor.
   Provides:
   1. Auto-growth up to available height (minHeight: 96px, maxHeight: 520px) + vertical resize.
   2. Monospace font with real-time JSON syntax highlighting via jsonc-parser tokens.
   3. Real-time JSON validation with clear parse error messages (line/col/cause).
   4. Format (prettify) action for valid JSON.
*/

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createScanner, SyntaxKind } from "jsonc-parser";
import { Icon } from "../lattice/icons";
import { t } from "../i18n";

export interface JsonEditorProps {
  value: unknown;
  onChange: (value: unknown) => void;
  label?: string;
  "aria-label"?: string;
  minHeight?: number;
  maxHeight?: number;
  disabled?: boolean;
  className?: string;
}

export type JsonTokenType =
  | "punctuation"
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "comment"
  | "error"
  | "whitespace";

export interface JsonToken {
  type: JsonTokenType;
  text: string;
}

const TOKEN_COLORS: Record<JsonTokenType, string> = {
  key: "var(--status-blue)",
  string: "var(--status-green)",
  number: "var(--status-orange)",
  boolean: "var(--status-purple)",
  null: "var(--status-purple)",
  comment: "var(--label-tertiary)",
  punctuation: "var(--label-secondary)",
  whitespace: "inherit",
  error: "var(--status-red)",
};

/** Tokenize JSON text for syntax highlighting without dropping whitespace or trivia. */
export function tokenizeJson(text: string): JsonToken[] {
  if (!text) return [];
  const scanner = createScanner(text, false);
  const raw: Array<{ kind: SyntaxKind; text: string }> = [];
  let kind: SyntaxKind;
  while ((kind = scanner.scan()) !== SyntaxKind.EOF) {
    const offset = scanner.getTokenOffset();
    const len = scanner.getTokenLength();
    raw.push({ kind, text: text.slice(offset, offset + len) });
  }

  const result: JsonToken[] = [];
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    let type: JsonTokenType = "punctuation";

    if (tok.kind === SyntaxKind.Trivia || tok.kind === SyntaxKind.LineBreakTrivia) {
      type = "whitespace";
    } else if (
      tok.kind === SyntaxKind.LineCommentTrivia ||
      tok.kind === SyntaxKind.BlockCommentTrivia
    ) {
      type = "comment";
    } else if (tok.kind === SyntaxKind.NumericLiteral) {
      type = "number";
    } else if (tok.kind === SyntaxKind.TrueKeyword || tok.kind === SyntaxKind.FalseKeyword) {
      type = "boolean";
    } else if (tok.kind === SyntaxKind.NullKeyword) {
      type = "null";
    } else if (tok.kind === SyntaxKind.StringLiteral) {
      let isKey = false;
      for (let j = i + 1; j < raw.length; j++) {
        const next = raw[j];
        if (next.kind !== SyntaxKind.Trivia && next.kind !== SyntaxKind.LineBreakTrivia) {
          if (next.kind === SyntaxKind.ColonToken) isKey = true;
          break;
        }
      }
      type = isKey ? "key" : "string";
    } else if (tok.kind === SyntaxKind.Unknown) {
      type = "error";
    }
    result.push({ type, text: tok.text });
  }
  return result;
}

export interface JsonValidationResult {
  valid: boolean;
  error: string | null;
  parsed?: unknown;
}

/** Validate JSON string and extract detailed parser error message. */
export function validateJsonString(text: string): JsonValidationResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { valid: true, error: null, parsed: undefined };
  }
  try {
    const parsed = JSON.parse(text);
    return { valid: true, error: null, parsed };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const posMatch = rawMsg.match(/at position (\d+)/i);
    if (posMatch && !rawMsg.includes("line ")) {
      const offset = parseInt(posMatch[1], 10);
      const upToOffset = text.slice(0, offset);
      const line = upToOffset.split("\n").length;
      const col = offset - upToOffset.lastIndexOf("\n");
      return { valid: false, error: `${rawMsg} (line ${line}, col ${col})` };
    }
    return { valid: false, error: rawMsg };
  }
}

export function JsonEditor({
  value,
  onChange,
  label,
  "aria-label": ariaLabel,
  minHeight = 96,
  maxHeight = 520,
  disabled = false,
  className,
}: JsonEditorProps): ReactNode {
  const editorId = useId();
  const errorId = `${editorId}-error`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const initialText = useMemo(() => {
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }, [value]);

  const [text, setText] = useState<string>(initialText);
  const [parseError, setParseError] = useState<string | null>(() => {
    if (!initialText.trim()) return null;
    return validateJsonString(initialText).error;
  });

  // Keep internal text in sync if parent resets value externally (e.g. Reset button)
  useEffect(() => {
    if (value === undefined || value === null) {
      if (text.trim() !== "") {
        setText("");
        setParseError(null);
      }
      return;
    }

    try {
      const currentParsed = JSON.parse(text);
      if (JSON.stringify(currentParsed) === JSON.stringify(value)) {
        return; // Content is semantically identical, avoid cursor jump
      }
    } catch {
      // If current text was invalid but value is a new external object:
      if (typeof value === "object") {
        const nextText = JSON.stringify(value, null, 2);
        setText(nextText);
        setParseError(null);
        return;
      }
    }

    const nextText = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (nextText !== text) {
      setText(nextText);
      const valRes = validateJsonString(nextText);
      setParseError(valRes.error);
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow height calculation
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const targetH = Math.min(Math.max(el.scrollHeight + 2, minHeight), maxHeight);
    el.style.height = `${targetH}px`;
  }, [minHeight, maxHeight]);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  const tokens = useMemo(() => tokenizeJson(text), [text]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = e.target.value;
    setText(nextText);
    const valRes = validateJsonString(nextText);
    setParseError(valRes.error);
    if (valRes.valid) {
      onChange(valRes.parsed);
    } else {
      // Pass raw invalid string so schema validation also marks the section as dirty/error
      onChange(nextText);
    }
  };

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (preRef.current) {
      preRef.current.scrollTop = e.currentTarget.scrollTop;
      preRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, 2);
      setText(formatted);
      setParseError(null);
      onChange(parsed);
    } catch {}
  };

  const lineCount = text ? text.split("\n").length : 1;
  const canFormat = !parseError && text.trim().length > 0;
  const accessibleName = label ?? ariaLabel ?? "JSON";

  return (
    <div className={`json-editor-root w-full ${className ?? ""}`}>
      <div
        className="flex items-center justify-between pb-1 px-0.5 text-[11px] leading-[13px]"
        style={{ color: "var(--label-secondary)" }}
      >
        <span className="font-mono tabular-nums">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
        {canFormat && !disabled && (
          <button
            type="button"
            className="text-[11px] hover:underline cursor-default focus:outline-none"
            style={{ color: "var(--accent)" }}
            onClick={handleFormat}
            title={t("settings:json.format")}
          >
            {t("settings:json.format")}
          </button>
        )}
      </div>

      <div
        className="json-editor-frame relative w-full overflow-hidden"
        style={{
          borderRadius: "var(--radius-input)",
          border: `0.5px solid ${parseError ? "var(--status-red)" : "var(--separator)"}`,
          background: "var(--fill-quaternary)",
        }}
      >
        <pre
          ref={preRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            margin: 0,
            padding: "8px 10px",
            boxSizing: "border-box",
            overflow: "hidden",
            pointerEvents: "none",
            userSelect: "none",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: "18px",
            whiteSpace: "pre",
            tabSize: 2,
            color: "var(--label)",
          }}
        >
          {tokens.map((tok, i) =>
            tok.type === "whitespace" ? (
              tok.text
            ) : (
              <span
                key={i}
                style={{
                  color: TOKEN_COLORS[tok.type],
                  fontStyle: tok.type === "comment" ? "italic" : undefined,
                  textDecoration:
                    tok.type === "error" ? "underline wavy var(--status-red)" : undefined,
                }}
              >
                {tok.text}
              </span>
            ),
          )}
          {text.endsWith("\n") ? " " : ""}
        </pre>

        <textarea
          ref={textareaRef}
          value={text}
          aria-label={accessibleName}
          aria-invalid={parseError ? "true" : "false"}
          aria-errormessage={parseError ? errorId : undefined}
          disabled={disabled}
          spellCheck={false}
          onChange={handleChange}
          onScroll={handleScroll}
          style={{
            position: "relative",
            display: "block",
            width: "100%",
            minHeight,
            maxHeight,
            margin: 0,
            padding: "8px 10px",
            boxSizing: "border-box",
            background: "transparent",
            color: "transparent",
            caretColor: "var(--label)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: "18px",
            whiteSpace: "pre",
            tabSize: 2,
            overflow: "auto",
            resize: "vertical",
            border: "none",
            outline: "none",
          }}
        />
      </div>

      {parseError && (
        <div
          id={errorId}
          className="flex items-start gap-1.5 text-[11px] leading-[14px] mt-1.5 px-2.5 py-1.5 rounded-[6px]"
          style={{
            color: "var(--status-red)",
            background: "color-mix(in oklab, var(--status-red) 10%, transparent)",
            border: "0.5px solid color-mix(in oklab, var(--status-red) 25%, transparent)",
          }}
          role="alert"
        >
          <span className="shrink-0 mt-0.5">
            <Icon name="warning" size={12} />
          </span>
          <span className="font-mono break-all">
            {t("settings:invalidJson")}: {parseError}
          </span>
        </div>
      )}
    </div>
  );
}
