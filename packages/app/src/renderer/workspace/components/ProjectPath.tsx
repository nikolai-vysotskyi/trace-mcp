/**
 * ProjectPath — an absolute path truncated at the HEAD.
 *
 * Twelve checkouts under the same parent directory all share the first 40
 * characters; tail truncation hides the only part that tells them apart. The
 * `rtl` direction puts the ellipsis on the left and keeps the tail visible;
 * the U+200E prefix stops the leading "/" — a bidi-neutral character at the
 * paragraph edge — from being reordered to the far end.
 */

/** U+200E LEFT-TO-RIGHT MARK. */
export const LRM = '\u200e';

export interface ProjectPathProps {
  root: string;
  className?: string;
}

export function ProjectPath({ root, className }: ProjectPathProps) {
  return (
    <div
      className={`truncate${className ? ` ${className}` : ''}`}
      style={{ direction: 'rtl', textAlign: 'left' }}
      title={root}
    >
      {LRM + root}
    </div>
  );
}
