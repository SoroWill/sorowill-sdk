import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

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
      const workflowFiles = fs
        .readdirSync(githubWorkflowsPath)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

      const runsNpmAudit = workflowFiles.some((file) => {
        const content = fs.readFileSync(path.join(githubWorkflowsPath, file), 'utf-8');
        return /npm audit/.test(content);
      });

      expect(runsNpmAudit).toBe(true);
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
    it(
      'production dependencies have no known high/critical vulnerabilities',
      () => {
        const result = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], {
          cwd: projectRoot,
          encoding: 'utf-8',
        });

        const report = JSON.parse(result.stdout || '{}');
        const highOrCriticalCount =
          (report.metadata?.vulnerabilities?.high ?? 0) + (report.metadata?.vulnerabilities?.critical ?? 0);

        expect(highOrCriticalCount).toBe(0);
      },
      30_000,
    );
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

    it('the npm audit CI step is not configured to ignore failures', () => {
      const githubWorkflowsPath = path.join(projectRoot, '.github', 'workflows');
      const workflowFiles = fs
        .readdirSync(githubWorkflowsPath)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

      const auditStepIgnoresFailure = workflowFiles.some((file) => {
        const lines = fs.readFileSync(path.join(githubWorkflowsPath, file), 'utf-8').split('\n');
        const isStepBoundary = (line: string): boolean => /^\s*-\s/.test(line);

        return lines.some((line, i) => {
          if (!/npm audit/.test(line)) {
            return false;
          }
          let end = i + 1;
          while (end < lines.length && !isStepBoundary(lines[end]!)) {
            end += 1;
          }
          return lines.slice(i, end).some((stepLine) => /continue-on-error:\s*true/.test(stepLine));
        });
      });

      expect(auditStepIgnoresFailure).toBe(false);
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
        Object.values(packageJson.peerDependencies).forEach((version) => {
          expect(typeof version).toBe('string');
          expect(String(version).length).toBeGreaterThan(0);
        });
      }
    });
  });
});
