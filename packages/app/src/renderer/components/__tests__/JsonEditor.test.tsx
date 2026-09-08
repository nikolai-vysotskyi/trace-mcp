// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  JsonEditor,
  tokenizeJson,
  validateJsonString,
} from "../JsonEditor";

describe("JsonEditor helper functions", () => {
  it("tokenizes JSON into keys, values, and punctuation", () => {
    const json = `{\n  "bug": {\n    "churn": 0.2,\n    "active": true\n  }\n}`;
    const tokens = tokenizeJson(json);
    const nonWs = tokens.filter((t) => t.type !== "whitespace");

    expect(nonWs[0]).toEqual({ type: "punctuation", text: "{" });
    expect(nonWs[1]).toEqual({ type: "key", text: "\"bug\"" });
    expect(nonWs[2]).toEqual({ type: "punctuation", text: ":" });
    expect(nonWs[3]).toEqual({ type: "punctuation", text: "{" });
    expect(nonWs[4]).toEqual({ type: "key", text: "\"churn\"" });
    expect(nonWs[5]).toEqual({ type: "punctuation", text: ":" });
    expect(nonWs[6]).toEqual({ type: "number", text: "0.2" });
    expect(nonWs[7]).toEqual({ type: "punctuation", text: "," });
    expect(nonWs[8]).toEqual({ type: "key", text: "\"active\"" });
    expect(nonWs[9]).toEqual({ type: "punctuation", text: ":" });
    expect(nonWs[10]).toEqual({ type: "boolean", text: "true" });
  });

  it("validates JSON string correctly and pinpoints parse error", () => {
    expect(validateJsonString("").valid).toBe(true);
    expect(validateJsonString(`{"a": 1}`).valid).toBe(true);

    const bad = validateJsonString(`{\n  "a":\n}`);
    expect(bad.valid).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});

describe("JsonEditor component", () => {
  it("renders value and line count", () => {
    const val = { bug: { churn: 0.2 } };
    render(<JsonEditor value={val} onChange={() => {}} label="Weights" />);

    const textarea = screen.getByLabelText("Weights") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toContain(`"bug"`);
    expect(screen.getByText(/lines/)).toBeTruthy();
  });

  it("reports parsed object on valid input change", () => {
    const onChange = vi.fn();
    render(<JsonEditor value={{ a: 1 }} onChange={onChange} label="Config" />);

    const textarea = screen.getByLabelText("Config");
    fireEvent.change(textarea, { target: { value: `{"a": 2}` } });

    expect(onChange).toHaveBeenCalledWith({ a: 2 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports error alert with details on invalid JSON input", () => {
    const onChange = vi.fn();
    render(<JsonEditor value={{ a: 1 }} onChange={onChange} label="Config" />);

    const textarea = screen.getByLabelText("Config");
    fireEvent.change(textarea, { target: { value: `{"a": }` } });

    expect(onChange).toHaveBeenCalledWith(`{"a": }`);
    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.textContent).toMatch(/Invalid JSON|Некорректный JSON/);
  });

  it("formats JSON on Format button click", () => {
    const onChange = vi.fn();
    const compact = `{"foo":"bar","baz":123}`;
    render(<JsonEditor value={compact} onChange={onChange} label="FormatTest" />);

    const formatBtn = screen.getByTitle("Format");
    fireEvent.click(formatBtn);

    const textarea = screen.getByLabelText("FormatTest") as HTMLTextAreaElement;
    expect(textarea.value).toContain("\n");
    expect(onChange).toHaveBeenCalledWith({ foo: "bar", baz: 123 });
  });

  it("syncs when value prop resets externally", () => {
    const { rerender } = render(
      <JsonEditor value={{ original: true }} onChange={() => {}} label="ResetTest" />,
    );
    const textarea = screen.getByLabelText("ResetTest") as HTMLTextAreaElement;
    expect(textarea.value).toContain("original");

    rerender(<JsonEditor value={{ reset: true }} onChange={() => {}} label="ResetTest" />);
    expect(textarea.value).toContain("reset");
    expect(textarea.value).not.toContain("original");
  });
});
