import { Spec } from "../contract/index.js";
/**
 * Generates TypeScript client class for contract methods
 */
export declare class ClientGenerator {
    private spec;
    private eventFilterMethodNames;
    constructor(spec: Spec);
    /**
     * Generate client class
     */
    generate(): string;
    private generateImports;
    /**
     * Generate the parseEvent method, which delegates to the underlying Spec
     * to decode a raw event's topics/data into a typed ContractEvent.
     */
    private generateParseEventMethod;
    private parseEventMethodName;
    /**
     * The `<camelCase>EventFilter` method name derived from an event name is
     * not injective (e.g. "FooBar" and "foo_bar" both produce
     * "fooBarEventFilter"), a contract may declare several events with the
     * very same name (composed modules each emitting their own "transfer"),
     * and it can just as easily collide with a generated contract function
     * name (e.g. an event "transfer" plus a function "transferEventFilter").
     * Since function member names are load-bearing (called directly by
     * users) and event filter names are already synthetic, function names
     * always win: they are reserved first, in spec-entry order. Events are
     * then resolved in spec-entry order, appending the smallest integer 2 or
     * greater needed to make the name unique (and reserving whatever name
     * results, so later events see it too). This is deterministic for a
     * given spec.
     */
    private resolveEventFilterMethodNames;
    /**
     * Compute the resolved (possibly disambiguated) filter method name for an
     * event; see {@link resolveEventFilterMethodNames}.
     */
    private eventFilterMethodName;
    /**
     * The resolved (possibly disambiguated) filter method name of every event
     * in the spec, in declaration order. Exposed so callers (e.g. the bindings
     * generator's diagnostics) can report renames and duplicates.
     */
    eventFilterMethodNamesInOrder(): string[];
    /**
     * Generate a per-event helper that builds a topics-filter row for
     * `Api.EventFilter.topics`, suitable for passing to server.getEvents.
     */
    private generateEventFilterMethod;
    /**
     * Generate interface method signature
     */
    private generateInterfaceMethod;
    private generateFromJsonMethod;
    /**
     * Generate deploy method
     */
    private generateDeployMethod;
    /**
     * Describe one function input for the generated signature. `key` is the
     * raw spec name as a property key, since the runtime reads arguments by
     * that name.
     */
    private static methodInput;
    private static inputsType;
    private static readonly DEPLOY_OPTIONS_PARAM;
    /**
     * Format the parameter list for a generated method or `deploy`. The inputs
     * are always a single `args` object, never destructured: a reserved word,
     * a strict-mode restricted name or a quoted key can't be a binding, and an
     * alias in a bodiless interface method is an error (TS2842), so one shape
     * for every method keeps the output uniform.
     */
    private static formatParameters;
}
