import { ScSpecTypeDef, ScSpecUdtStructV0 } from "../xdr/index.js";
export declare function isNameReserved(name: string): boolean;
/**
 * Sanitize a name into a bare identifier for something the generated code
 * declares itself: a method, type, or enum member. Never use it for a key
 * the runtime looks up by spec name (function arguments, struct fields,
 * event params); those go through {@link propertyKey}.
 * @param identifier - The identifier to sanitize
 * @returns The sanitized identifier
 */
export declare function sanitizeIdentifier(identifier: string): string;
/**
 * Escape a string for safe interpolation inside a double-quoted JavaScript string literal.
 */
export declare function escapeStringLiteral(str: string): string;
/**
 * Render a spec name as a TypeScript property key. The runtime keys function
 * arguments and struct fields by their raw spec names, so the key is kept
 * verbatim: bare when it is a valid identifier (reserved words are legal
 * property names), quoted and escaped otherwise.
 */
export declare function propertyKey(rawName: string): string;
/**
 * Generate TypeScript type from XDR type definition
 */
export declare function parseTypeFromTypeDef(typeDef: ScSpecTypeDef, isFunctionInput?: boolean): string;
/**
 * Imports needed for generating bindings
 */
export interface BindingImports {
    /** Imports needed from type definitions */
    typeFileImports: Set<string>;
    /** Imports needed from the Stellar SDK in the contract namespace */
    stellarContractImports: Set<string>;
    /** Imports needed from Stellar SDK in the global namespace */
    stellarImports: Set<string>;
}
/**
 * Generate imports needed for a list of type definitions
 */
export declare function generateTypeImports(typeDefs: ScSpecTypeDef[]): BindingImports;
/**
 * Options for formatting imports
 */
export interface FormatImportsOptions {
    /** Whether to include imports from types.ts */
    includeTypeFileImports?: boolean;
    /** Additional imports needed from stellar/stellar-sdk/contract */
    additionalStellarContractImports?: string[];
    /** Additional imports needed from stellar/stellar-sdk */
    additionalStellarImports?: string[];
}
/**
 * Format imports into import statement strings
 */
export declare function formatImports(imports: BindingImports, options?: FormatImportsOptions): string;
/**
 * Format a comment string as JSDoc with proper escaping
 */
export declare function formatJSDocComment(comment: string, indentLevel?: number): string;
/**
 * Convert a sanitized identifier (snake_case, kebab-case, etc.) to PascalCase.
 * Intended to be applied after {@link sanitizeIdentifier}.
 */
export declare function toPascalCase(identifier: string): string;
/**
 * Convert a sanitized identifier (snake_case, kebab-case, etc.) to camelCase.
 * Intended to be applied after {@link sanitizeIdentifier}.
 */
export declare function toCamelCase(identifier: string): string;
export declare function isTupleStruct(udtStruct: ScSpecUdtStructV0): boolean;
