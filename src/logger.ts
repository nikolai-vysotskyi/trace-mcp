import pino from 'pino';

const level = process.env.TRACE_MCP_LOG_LEVEL ?? 'info';

export const logger = pino({
  name: 'trace-mcp',
  level,
}, process.stderr);
