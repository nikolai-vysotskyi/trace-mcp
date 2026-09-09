// @ts-nocheck
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer, stepCounter } from './telemetry';

export async function executeStep(stepId: string) {
  return tracer.startActiveSpan('agent.step', async (parentSpan) => {
    parentSpan.setAttribute('agent.step_id', stepId);
    try {
      await tracer.startActiveSpan('agent.tool_call', async (childSpan) => {
        childSpan.setAttribute('tool.name', 'search_code');
        childSpan.addEvent('tool.invoked', { query: 'test' });
        childSpan.end();
      });
      stepCounter.add(1, { 'step.status': 'success' });
      parentSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err: any) {
      parentSpan.recordException(err);
      parentSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      parentSpan.end();
    }
  });
}
