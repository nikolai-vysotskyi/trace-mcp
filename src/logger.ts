import pino from 'pino';

const level = process.env.TRACE_MCP_LOG_LEVEL ?? 'info';

export const logger = pino({
  name: 'trace-mcp',
  level,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 2 } } // stderr
      : undefined,
});
