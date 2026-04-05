// @ts-nocheck
import { createServiceLogger } from './logger';

const log = createServiceLogger('handler');

export function handleRequest(req: any) {
  log.info({ path: req.path }, 'incoming request');
  try {
    // handle
    log.debug('processing');
  } catch (err) {
    log.error({ err }, 'request failed');
  }
}
