/**
 * Contract version deprecation warnings (#646)
 */

/**
 * Contract version compatibility status
 */
export enum VersionStatus {
  Current = 'current',
  Deprecated = 'deprecated',
  EndOfLife = 'eol',
}

/**
 * Version compatibility info
 */
export interface VersionInfo {
  version: string;
  status: VersionStatus;
  deprecatedSince?: string;
  eolDate?: string;
  replacement?: string;
  message?: string;
}

/**
 * Version compatibility matrix
 */
export const VERSION_COMPATIBILITY_MATRIX: Map<string, VersionInfo> = new Map([
  [
    '1.0.0',
    {
      version: '1.0.0',
      status: VersionStatus.EndOfLife,
      deprecatedSince: '2.0.0',
      eolDate: '2024-12-31',
      replacement: '2.1.0',
      message: 'Version 1.0.0 is no longer supported. Please upgrade to 2.1.0 or later.',
    },
  ],
  [
    '1.5.0',
    {
      version: '1.5.0',
      status: VersionStatus.Deprecated,
      deprecatedSince: '2.0.0',
      eolDate: '2025-06-30',
      replacement: '2.1.0',
      message: 'Version 1.5.0 is deprecated and will be unsupported after 2025-06-30.',
    },
  ],
  [
    '2.0.0',
    {
      version: '2.0.0',
      status: VersionStatus.Deprecated,
      deprecatedSince: '2.1.0',
      eolDate: '2025-12-31',
      replacement: '2.1.0',
      message: 'Version 2.0.0 is deprecated. Upgrade to 2.1.0 for latest features and bug fixes.',
    },
  ],
  [
    '2.1.0',
    {
      version: '2.1.0',
      status: VersionStatus.Current,
      message: 'Version 2.1.0 is the current recommended version.',
    },
  ],
]);

/**
 * Check contract version and warn if deprecated
 */
export function checkAndWarnVersion(version: string): void {
  const versionInfo = VERSION_COMPATIBILITY_MATRIX.get(version);

  if (!versionInfo) {
    console.warn(`⚠️  Unknown contract version: ${version}. Please ensure you are using a supported version.`);
    return;
  }

  switch (versionInfo.status) {
    case VersionStatus.EndOfLife:
      console.error(
        `❌ Contract version ${version} is no longer supported as of ${versionInfo.eolDate}. ${versionInfo.message}`,
      );
      break;

    case VersionStatus.Deprecated:
      console.warn(
        `⚠️  Contract version ${version} is deprecated as of ${versionInfo.deprecatedSince}. ${versionInfo.message}`,
      );
      break;

    case VersionStatus.Current:
      // No warning for current version
      break;
  }
}

/**
 * Get version compatibility info
 */
export function getVersionInfo(version: string): VersionInfo | null {
  return VERSION_COMPATIBILITY_MATRIX.get(version) || null;
}

/**
 * Check if version is supported
 */
export function isVersionSupported(version: string): boolean {
  const info = VERSION_COMPATIBILITY_MATRIX.get(version);
  return info?.status !== VersionStatus.EndOfLife;
}

/**
 * Get all current/supported versions
 */
export function getSupportedVersions(): string[] {
  return Array.from(VERSION_COMPATIBILITY_MATRIX.values())
    .filter((v) => v.status !== VersionStatus.EndOfLife)
    .map((v) => v.version);
}
