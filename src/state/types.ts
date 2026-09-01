import type { AgentExecutionState, AgentStatus } from './schema.js';

export interface StateRecord {
  taskId: string;
  goal: string;
  status: AgentStatus;
  state: AgentExecutionState;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StateRevisionRecord {
  id: number;
  taskId: string;
  version: number;
  patch: unknown;
  createdAt: string;
}

export interface StateCheckpointRecord {
  id: number;
  taskId: string;
  label: string;
  state: AgentExecutionState;
  createdAt: string;
}

export interface ListStatesFilter {
  status?: AgentStatus;
  limit?: number;
  offset?: number;
}
