import type { Serializable, Persistable, Logger } from './interfaces.js';

export class JsonSerializer implements Serializable {
  serialize(): string {
    return JSON.stringify(this);
  }
}

export class DatabaseRecord extends JsonSerializer implements Persistable {
  async save(): Promise<void> {
    // stub
  }
}

export class ConsoleLogger implements Logger {
  log(msg: string): void {
    console.log(msg);
  }
}

/** Not exported — should NOT appear in api surface */
class InternalHelper {
  helper(): void {}
}

export class LoggingRecord extends DatabaseRecord implements Logger {
  log(msg: string): void {
    console.log(msg);
  }
}
