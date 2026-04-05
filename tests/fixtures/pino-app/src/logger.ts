// @ts-nocheck
import pino from 'pino';

export const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
  },
});

export function createServiceLogger(service: string) {
  return logger.child({ service });
}
