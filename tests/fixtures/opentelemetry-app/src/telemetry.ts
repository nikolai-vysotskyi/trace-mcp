// @ts-nocheck
import { trace, metrics } from '@opentelemetry/api';

export const tracer = trace.getTracer('agent-tracer', '1.0.0');
export const meter = metrics.getMeter('agent-meter', '1.0.0');

export const stepCounter = meter.createCounter('agent.steps.completed', {
  description: 'Number of steps completed by agent',
});
