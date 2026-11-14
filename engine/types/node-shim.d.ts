// Minimal ambient declarations for the few Node built-ins used by src/lab.ts and the
// tests, so `tsc --noEmit` works with `typescript` as the only dev dependency
// (no @types/node). Only what is actually used is declared.

declare module 'node:fs' {
  export function mkdirSync(path: string | URL, options?: { recursive?: boolean }): string | undefined;
  export function writeFileSync(path: string | URL, data: string): void;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): URL;
}

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: object | ((error: unknown) => boolean), message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare const process: {
  stdout: { write(chunk: string): boolean };
  argv: string[];
};
