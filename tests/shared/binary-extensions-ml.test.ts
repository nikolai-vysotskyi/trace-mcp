import { describe, expect, it } from 'vitest';
import { isBinaryFile } from '../../src/shared/binary-extensions.js';

describe('ML binary artifacts (TRA-2479)', () => {
  it.each(['pt', 'pth', 'safetensors', 'onnx', 'bin'])('recognizes .%s as binary', (extension) => {
    expect(isBinaryFile(`weights/model.${extension}`)).toBe(true);
    expect(isBinaryFile(`weights/MODEL.${extension.toUpperCase()}`)).toBe(true);
  });
});
