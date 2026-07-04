/**
 * UTF-8 BOM handling for Windows PowerShell artifacts.
 *
 * Windows PowerShell 5.1 reads BOM-less scripts using the system codepage
 * (e.g. cp1251), not UTF-8. Any non-ASCII byte in a BOM-less .ps1 then decodes
 * to garbage and can break parsing before the script emits any diagnostics.
 * Prepending a UTF-8 BOM forces PowerShell to decode the file as UTF-8
 * regardless of the machine's locale.
 *
 * This is belt-and-suspenders: the .ps1 templates are also kept ASCII-only, so
 * even a BOM-less read stays correct. The BOM protects any future non-ASCII
 * content and matches what PowerShell tooling expects.
 */

/** UTF-8 byte-order-mark bytes (EF BB BF). */
export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** True when the buffer already starts with the UTF-8 BOM. */
export function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

/**
 * Return `content` with a UTF-8 BOM prepended when `destPath` targets a `.ps1`
 * file and the content doesn't already begin with a BOM. Non-.ps1 destinations
 * and already-BOMed buffers are returned unchanged.
 */
export function withPs1Bom(destPath: string, content: Buffer): Buffer {
  if (!destPath.toLowerCase().endsWith('.ps1')) return content;
  if (hasUtf8Bom(content)) return content;
  return Buffer.concat([UTF8_BOM, content]);
}
