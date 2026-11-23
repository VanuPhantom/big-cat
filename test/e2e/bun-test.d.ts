// The subset of `bun:test` used by these tests. Installing `@types/bun`
// would replace this file, but Bun itself is not a dependency of Big Cat:
// the tests run on the Bun runtime that ships inside OpenCode.
declare module "bun:test" {
  interface Matchers {
    readonly not: Matchers;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toMatch(expected: string | RegExp): void;
    toBeLessThan(expected: number): void;
    toBeGreaterThan(expected: number): void;
    toBeUndefined(): void;
    toHaveLength(expected: number): void;
  }
  export function expect(actual: unknown): Matchers;
  export function test(
    name: string,
    body: () => void | Promise<void>,
    timeout?: number,
  ): void;
  export function describe(name: string, body: () => void): void;
}
