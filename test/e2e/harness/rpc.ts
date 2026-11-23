/**
 * An in-process stand-in for OpenCode's plugin RPC transport.
 *
 * The server half of a plugin registers handlers with `context.rpc.register`,
 * and the TUI half calls them with `context.client.rpc(definition)`. In
 * OpenCode these live in different processes; here the bridge connects them
 * directly, while still enforcing the contract the real transport enforces:
 * inputs, outputs, and event payloads are validated against the definition's
 * JSON schemas, and calls made before the server registers fail with
 * `rpc.unavailable`.
 */

type JsonSchema = {
  type?: "object" | "array" | "string" | "boolean" | "number" | "integer";
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
};

type Definition = {
  id: string;
  methods: Record<string, { input: unknown; output: unknown }>;
  events: Record<string, { schema: unknown }>;
};

type Handler = (
  input: unknown,
  context: { signal: AbortSignal; error: unknown },
) => Promise<unknown>;

type Listener = (event: {
  type: string;
  data: Record<string, unknown>;
  location: { directory: string };
}) => void;

export class RpcFailure extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/** Returns the first schema violation in `value`, if any. */
export function violation(
  schema: JsonSchema,
  value: unknown,
  path = "$",
): string | undefined {
  switch (schema.type) {
    case "string":
    case "boolean":
    case "number":
      return typeof value === schema.type
        ? undefined
        : `${path}: expected ${schema.type}, got ${JSON.stringify(value)}`;
    case "integer":
      return Number.isInteger(value)
        ? undefined
        : `${path}: expected integer, got ${JSON.stringify(value)}`;
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected array`;
      for (const [index, item] of value.entries()) {
        const problem =
          schema.items && violation(schema.items, item, `${path}[${index}]`);
        if (problem) return problem;
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${path}: expected object`;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) return `${path}.${key}: required`;
      }
      for (const [key, item] of Object.entries(record)) {
        const property = schema.properties?.[key];
        if (!property) {
          if (schema.additionalProperties === false) {
            return `${path}.${key}: not allowed`;
          }
          continue;
        }
        const problem = violation(property, item, `${path}.${key}`);
        if (problem) return problem;
      }
      return;
    }
    default:
      return;
  }
}

export class RpcBridge {
  private registrations = new Map<
    string,
    { definition: Definition; handlers: Record<string, Handler> }
  >();
  private listeners = new Map<string, Set<Listener>>();
  /** Every call the TUI made, for assertions about traffic. */
  readonly calls: Array<{ method: string; input: unknown }> = [];
  /** Contract violations, which fail the test when the host is disposed. */
  readonly violations: string[] = [];

  constructor(private readonly directory: string) {}

  /** The server-side `context.rpc` domain. */
  readonly server = {
    register: async (
      definition: Definition,
      handlers: Record<string, Handler>,
    ) => {
      this.registrations.set(definition.id, { definition, handlers });
      return {
        events: {
          emit: async (name: string, data: Record<string, unknown>) => {
            const event = definition.events[name];
            if (!event)
              throw new Error(`Unknown event ${definition.id}.${name}`);
            this.check(`event ${definition.id}.${name}`, event.schema, data);
            const listeners = this.listeners.get(`${definition.id}.${name}`);
            for (const listener of listeners ?? []) {
              listener({
                type: `rpc.${definition.id}.${name}`,
                data,
                location: { directory: this.directory },
              });
            }
          },
        },
        dispose: async () => {
          this.registrations.delete(definition.id);
        },
      };
    },
  };

  /** The TUI-side `context.client.rpc` accessor. */
  client(definition: Definition) {
    const methods = Object.fromEntries(
      Object.keys(definition.methods).map((method) => [
        method,
        (input: unknown) => this.call(definition, method, input),
      ]),
    );
    return {
      ...methods,
      events: {
        on: (name: string, listener: Listener) => {
          const key = `${definition.id}.${name}`;
          const listeners = this.listeners.get(key) ?? new Set();
          listeners.add(listener);
          this.listeners.set(key, listeners);
          return () => listeners.delete(listener);
        },
      },
    };
  }

  private async call(definition: Definition, method: string, input: unknown) {
    this.calls.push({ method, input });
    const methodDefinition = definition.methods[method]!;
    this.check(
      `${definition.id}.${method} input`,
      methodDefinition.input,
      input,
    );
    const registration = this.registrations.get(definition.id);
    if (!registration) {
      throw new RpcFailure(
        "rpc.unavailable",
        `${definition.id} is not registered`,
      );
    }
    const handler = registration.handlers[method];
    if (!handler) {
      throw new RpcFailure(
        "rpc.method_not_found",
        `${definition.id}.${method}`,
      );
    }
    let output: unknown;
    try {
      output = await handler(input, {
        signal: AbortSignal.timeout(10_000),
        error: (type: string, message: string) => ({ type, message }),
      });
    } catch (cause) {
      throw new RpcFailure("rpc.internal", String(cause));
    }
    this.check(
      `${definition.id}.${method} output`,
      methodDefinition.output,
      output,
      "rpc.invalid_output",
    );
    return output;
  }

  private check(
    label: string,
    schema: unknown,
    value: unknown,
    type = "rpc.invalid_input",
  ) {
    const problem = violation(schema as JsonSchema, value);
    if (!problem) return;
    const message = `${label} violates its schema: ${problem}`;
    this.violations.push(message);
    throw new RpcFailure(type, message);
  }
}
