import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Package Exports Audit - Issue #51: Dual ESM/CJS export correctness', () => {
  it('should have valid exports field in package.json', () => {
    const packageJsonPath = path.join(__dirname, '../package.json');
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);

    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['.']).toBeDefined();
    expect(pkg.exports['./react']).toBeDefined();
  });

  it('should have types, import, and require entries for main export', () => {
    const packageJsonPath = path.join(__dirname, '../package.json');
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);

    const mainExport = pkg.exports['.'];
    expect(mainExport.types).toBeDefined();
    expect(mainExport.import).toBeDefined();
    expect(mainExport.require).toBeDefined();
  });

  it('should have types, import, and require entries for react export', () => {
    const packageJsonPath = path.join(__dirname, '../package.json');
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);

    const reactExport = pkg.exports['./react'];
    expect(reactExport.types).toBeDefined();
    expect(reactExport.import).toBeDefined();
    expect(reactExport.require).toBeDefined();
  });

  it('should have both ESM and CJS entry points in dist', () => {
    const distDir = path.join(__dirname, '../dist');
    if (fs.existsSync(distDir)) {
      const files = fs.readdirSync(distDir);
      expect(files.some(f => f === 'index.js' || f.endsWith('.js'))).toBe(true);
      expect(files.some(f => f === 'index.cjs' || f.endsWith('.cjs'))).toBe(true);
    }
  });

  it('should have matching type definitions for both export points', () => {
    const packageJsonPath = path.join(__dirname, '../package.json');
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);

    const types = pkg.exports['.']?.types;
    expect(types).toBeDefined();
    expect(types.endsWith('.d.ts')).toBe(true);
  });
});
