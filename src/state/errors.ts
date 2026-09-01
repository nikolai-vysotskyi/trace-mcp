export class StateEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateEngineError';
  }
}

export class StateNotFoundError extends StateEngineError {
  constructor(public readonly taskId: string) {
    super(`State not found for task_id: '${taskId}'`);
    this.name = 'StateNotFoundError';
  }
}

export class TaskAlreadyExistsError extends StateEngineError {
  constructor(public readonly taskId: string) {
    super(`State already exists for task_id: '${taskId}'`);
    this.name = 'TaskAlreadyExistsError';
  }
}

export class StateValidationError extends StateEngineError {
  constructor(
    public readonly taskId: string,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(`Validation failed for task_id '${taskId}': ${message}`);
    this.name = 'StateValidationError';
  }
}

export class CheckpointNotFoundError extends StateEngineError {
  constructor(
    public readonly taskId: string,
    public readonly label: string,
  ) {
    super(`Checkpoint '${label}' not found for task_id: '${taskId}'`);
    this.name = 'CheckpointNotFoundError';
  }
}

export class RevisionNotFoundError extends StateEngineError {
  constructor(
    public readonly taskId: string,
    public readonly version: number,
  ) {
    super(`Revision ${version} not found for task_id: '${taskId}'`);
    this.name = 'RevisionNotFoundError';
  }
}
