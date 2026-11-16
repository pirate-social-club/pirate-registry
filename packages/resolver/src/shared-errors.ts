export class SharedNamesError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SharedNamesError';
    this.code = code;
  }
}

export function requireShared(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new SharedNamesError(code, message);
}
