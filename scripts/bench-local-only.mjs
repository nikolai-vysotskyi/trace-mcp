/**
 * TRA-951: a stdio session attaches to a running daemon even with
 * TRACE_MCP_NO_DAEMON=1 (that flag only disables auto-*spawn*), and the
 * daemon's own preset then decides which tools answer. For a benchmark that
 * means half the table silently becomes `Tool X disabled` error strings.
 *
 * Loaded with `--import` into the benchmark's server child only: it makes the
 * daemon port unreachable for that process, so the session serves itself
 * locally at the preset the bench asked for. Nothing outside the child sees
 * this, and the daemon keeps running for everyone else on the machine.
 */
const port = process.env.TRACE_MCP_BENCH_BLOCK_PORT;
if (port) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(
      typeof input === 'object' && input !== null && 'url' in input ? input.url : input,
    );
    if (url.includes(`127.0.0.1:${port}`) || url.includes(`localhost:${port}`)) {
      return Promise.reject(new Error(`bench-local-only: daemon port ${port} blocked`));
    }
    return realFetch(input, init);
  };
}
