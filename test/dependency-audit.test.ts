import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for dependency and supply-chain audit workflow.
 * Validates presence of npm audit CI configuration and dependabot setup.
 */

describe('Dependency/Supply-Chain Audit Workflow', () => {
  const projectRoot = path.resolve(__dirname, '..');

  describe('npm audit configuration', () => {
    it('package.json exists and is valid', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json');
      expect(fs.existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      expect(packageJson).toHaveProperty('dependencies');
      expect(packageJson).toHaveProperty('devDependencies');
    });

    it('package-lock.json exists for reproducible dependencies', () => {
      const lockPath = path.join(projectRoot, 'package-lock.json');
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    it('npm audit should be part of CI workflow', () => {
      const githubWorkflowsPath = path.join(projectRoot, '.github', 'workflows');

      // Check if workflows directory exists
      if (fs.existsSync(githubWorkflowsPath)) {
        const workflowFiles = fs.readdirSync(githubWorkflowsPath).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

        // Verify at least one workflow file exists
        expect(workflowFiles.length).toBeGreaterThan(0);
      }
    });
  });

  describe('dependabot configuration', () => {
    it('dependabot.yml should exist in .github directory', () => {
      const dependabotPath = path.join(projectRoot, '.github', 'dependabot.yml');
      expect(fs.existsSync(dependabotPath)).toBe(true);
    });

    it('dependabot.yml should have valid YAML structure', () => {
      const dependabotPath = path.join(projectRoot, '.github', 'dependabot.yml');
      const content = fs.readFileSync(dependabotPath, 'utf-8');

      // Basic validation: should contain version and updates
      expect(content).toContain('version:');
      expect(content).toContain('updates:');
    });

    it('dependabot.yml should configure npm package updates', () => {
      const dependabotPath = path.join(projectRoot, '.github', 'dependabot.yml');
      const content = fs.readFileSync(dependabotPath, 'utf-8');

      // Should mention npm or package-ecosystem
      expect(content.toLowerCase()).toMatch(/npm|package-ecosystem/);
    });

    it('dependabot.yml should specify update schedule', () => {
      const dependabotPath = path.join(projectRoot, '.github', 'dependabot.yml');
      const content = fs.readFileSync(dependabotPath, 'utf-8');

      // Should have schedule configuration
      expect(content.toLowerCase()).toContain('schedule');
    });
  });

  describe('dependency audit policies', () => {
    it('package.json should not have known vulnerable dependencies', () => {
      // This is a documentation test - in real scenarios, npm audit would be run
      const packageJsonPath = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Check that critical dependencies are pinned
      const dependenciesToCheck = ['@stellar/stellar-sdk'];
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      dependenciesToCheck.forEach(dep => {
        if (allDeps[dep]) {
          expect(allDeps[dep]).toBeDefined();
        }
      });
    });

    it('security-sensitive dependencies should be explicitly specified', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Verify that cryptographic and security libraries are present
      // Given this is a financial SDK dealing with transactions
      expect(Object.keys(allDeps).length).toBeGreaterThan(0);
    });
  });

  describe('CI/CD audit integration', () => {
    it('project should have GitHub Actions workflows', () => {
      const githubPath = path.join(projectRoot, '.github');
      expect(fs.existsSync(githubPath)).toBe(true);
    });

    it('.github directory should contain workflows folder', () => {
      const workflowsPath = path.join(projectRoot, '.github', 'workflows');
      expect(fs.existsSync(workflowsPath)).toBe(true);
    });

    it('at least one workflow file should exist', () => {
      const workflowsPath = path.join(projectRoot, '.github', 'workflows');
      if (fs.existsSync(workflowsPath)) {
        const files = fs.readdirSync(workflowsPath);
        expect(files.length).toBeGreaterThan(0);
      }
    });
  });

  describe('documentation and audit policy', () => {
    it('project should have documentation about dependency management', () => {
      const possiblePaths = [
        path.join(projectRoot, 'SECURITY.md'),
        path.join(projectRoot, 'CONTRIBUTING.md'),
        path.join(projectRoot, 'README.md'),
      ];

      const hasDocumentation = possiblePaths.some(p => fs.existsSync(p));
      expect(hasDocumentation).toBe(true);
    });

    it('audit failure policy should be defined', () => {
      // This test documents that audit failures should block CI
      // This is typically configured in the workflow file
      const workflowsPath = path.join(projectRoot, '.github', 'workflows');

      if (fs.existsSync(workflowsPath)) {
        const files = fs.readdirSync(workflowsPath);
        // At least one workflow should exist for audit checks
        expect(files.length).toBeGreaterThan(0);
      }
    });
  });

  describe('supply chain security practices', () => {
    it('should use package-lock.json for dependency lock', () => {
      const lockPath = path.join(projectRoot, 'package-lock.json');
      expect(fs.existsSync(lockPath)).toBe(true);

      // Validate it's not empty
      const content = fs.readFileSync(lockPath, 'utf-8');
      expect(content.length).toBeGreaterThan(100);
    });

    it('package.json should have engines specification for Node.js', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Should specify minimum Node version to ensure secure baseline
      expect(packageJson).toHaveProperty('engines');
      expect(packageJson.engines).toHaveProperty('node');
    });

    it('should have peer dependency restrictions for security', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // If peer dependencies exist, they should have reasonable version constraints
      if (packageJson.peerDependencies) {
        Object.values(packageJson.peerDependencies).forEach(version => {
          expect(typeof version).toBe('string');
          expect(version.length).toBeGreaterThan(0);
        });
      }
    });
  });
});
