/**
 * Contract specification exposure for consumers (#650)
 *
 * Exposes contract ABI and spec for custom adapter introspection
 */

import type { ContractSpecLike } from './types';

/**
 * Wrapper around contract spec providing introspection capabilities
 */
export class ContractSpecWrapper {
  private readonly spec: ContractSpecLike;
  private functionsCache: Map<string, unknown> | null = null;

  constructor(spec: ContractSpecLike) {
    this.spec = spec;
  }

  /**
   * Get the raw contract spec
   */
  getRawSpec(): ContractSpecLike {
    return this.spec;
  }

  /**
   * Get all available contract functions
   */
  getFunctions(): Record<string, unknown> {
    if (this.functionsCache) {
      return Object.fromEntries(this.functionsCache);
    }

    const specAny = this.spec as Record<string, unknown>;
    const functions: Record<string, unknown> = {};

    // Extract functions based on spec structure
    if (specAny.functions && Array.isArray(specAny.functions)) {
      (specAny.functions as Array<Record<string, unknown>>).forEach((fn) => {
        if (fn.name) {
          functions[fn.name] = {
            name: fn.name,
            inputs: fn.inputs || [],
            outputs: fn.outputs || [],
            doc: fn.doc || '',
          };
        }
      });
    }

    this.functionsCache = new Map(Object.entries(functions));
    return functions;
  }

  /**
   * Get a specific function's signature
   */
  getFunction(name: string): unknown | null {
    const functions = this.getFunctions();
    return functions[name] || null;
  }

  /**
   * Check if contract has a function
   */
  hasFunction(name: string): boolean {
    return this.getFunction(name) !== null;
  }

  /**
   * Get all data types defined in contract
   */
  getDataTypes(): Record<string, unknown> {
    const specAny = this.spec as Record<string, unknown>;
    const types: Record<string, unknown> = {};

    if (specAny.types && Array.isArray(specAny.types)) {
      (specAny.types as Array<Record<string, unknown>>).forEach((type) => {
        if (type.name) {
          types[type.name] = type;
        }
      });
    }

    return types;
  }

  /**
   * Export spec as JSON for documentation
   */
  exportAsJSON(): string {
    return JSON.stringify(this.spec, null, 2);
  }
}

/**
 * Helper to create spec wrapper from contract spec
 */
export function wrapContractSpec(spec: ContractSpecLike): ContractSpecWrapper {
  return new ContractSpecWrapper(spec);
}
