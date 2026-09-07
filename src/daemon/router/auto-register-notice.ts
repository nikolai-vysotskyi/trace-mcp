/**
 * One-time notice for a project root the daemon registered by itself (#936).
 *
 * The daemon indexes whatever root an MCP client connects from. That is
 * convenient and it is also a change to the user's machine nobody asked for:
 * someone who ran `trace-mcp init --scope project` for one repo gets every
 * other repo they later open a session in registered and indexed, with
 * nothing on screen saying so and no hint that there is anything to clean up.
 *
 * So say it once, in the one place the user is actually looking — the
 * `initialize` instructions of the session that caused it. "Once" needs no
 * persisted flag: the root is absent from registry.json before the
 * auto-registration and present after, so the session that saw it absent at
 * start and present-but-not-`explicit` at handshake is by construction the
 * first one. Later sessions see it already registered and stay quiet.
 *
 * Roots that never reach registry.json — ephemeral agent-run workdirs
 * (TRA-396) and read-mostly subprojects — have no entry at handshake either,
 * and get no notice: nothing persistent was added, so there is nothing to
 * remove.
 */
import { getProject, type RegistryEntry } from '../../registry.js';

function lookup(root: string): RegistryEntry | null {
  try {
    return getProject(root);
  } catch {
    return null;
  }
}

export class AutoRegisterNotice {
  private readonly wasRegistered: boolean;
  private spent = false;

  constructor(private readonly projectRoot: string) {
    this.wasRegistered = lookup(projectRoot) !== null;
  }

  /** The notice this session owes, or `''`. Answers non-empty at most once. */
  take(): string {
    if (this.spent || this.wasRegistered) return '';
    this.spent = true;
    const entry = lookup(this.projectRoot);
    if (!entry || entry.explicit) return '';
    return (
      `Notice: trace-mcp registered and indexed ${this.projectRoot} automatically, because an ` +
      'MCP client connected from it — no one ran `trace-mcp add` or `trace-mcp init` here. It ' +
      'stays in the project registry and is re-indexed as files change. Mention this to the ' +
      `user; if it was not intended, the way out is \`trace-mcp remove ${this.projectRoot}\`.`
    );
  }

  /**
   * Append the notice to an outbound `initialize` result. Any other frame —
   * and every frame once the notice is spent — passes through untouched.
   */
  applyTo(msg: unknown): unknown {
    const frame = msg as { result?: Record<string, unknown> } | null;
    const result = frame?.result;
    // protocolVersion, not instructions: instructions are absent when
    // instruction verbosity is `none`, and that session still owes the notice.
    if (!result || typeof result.protocolVersion !== 'string') return msg;
    const notice = this.take();
    if (!notice) return msg;
    const prev = typeof result.instructions === 'string' ? result.instructions : '';
    return {
      ...(frame as object),
      result: { ...result, instructions: prev ? `${prev}\n\n${notice}` : notice },
    };
  }
}
