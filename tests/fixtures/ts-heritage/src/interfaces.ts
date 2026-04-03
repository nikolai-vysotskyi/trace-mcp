/** Core interfaces for heritage testing */

export interface Serializable {
  serialize(): string;
}

export interface Persistable extends Serializable {
  save(): Promise<void>;
}

export interface Logger {
  log(msg: string): void;
}
