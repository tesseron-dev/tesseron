#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolvePath(
  process.env.CHECK_DOCS_CHANGESET_REPOSITORY_ROOT || defaultRepositoryRoot,
);
const configuredBase = process.env.GITHUB_BASE_REF?.trim() || 'origin/main';
const semanticVersionExpression =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function runGit(gitArguments) {
  try {
    return execFileSync('git', gitArguments, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[check-docs-changeset] failed to inspect git history: ${message}`);
    process.exit(1);
  }
}

function referenceExists(reference) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function readFileAtReference(reference, filePath) {
  try {
    return execFileSync('git', ['show', `${reference}:${filePath}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function fileExistsAtReference(reference, filePath) {
  try {
    execFileSync('git', ['cat-file', '-e', `${reference}:${filePath}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function versionMatch(version) {
  if (typeof version !== 'string') {
    return null;
  }
  return semanticVersionExpression.exec(version);
}

function versionParts(version) {
  const match = versionMatch(version);
  if (!match) {
    return null;
  }
  const prerelease = match[4] ? match[4].split('.') : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier) {
  const leftIsNumeric = /^\d+$/.test(leftIdentifier);
  const rightIsNumeric = /^\d+$/.test(rightIdentifier);
  if (leftIsNumeric && rightIsNumeric) {
    return Number(leftIdentifier) - Number(rightIdentifier);
  }
  if (leftIsNumeric) {
    return -1;
  }
  if (rightIsNumeric) {
    return 1;
  }
  return leftIdentifier.localeCompare(rightIdentifier);
}

function comparePrereleaseState(leftPrerelease, rightPrerelease) {
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0;
  }
  if (leftPrerelease.length === 0) {
    return 1;
  }
  if (rightPrerelease.length === 0) {
    return -1;
  }
  return null;
}

function comparePopulatedPrereleases(leftPrerelease, rightPrerelease) {
  const sharedLength = Math.min(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = comparePrereleaseIdentifiers(leftPrerelease[index], rightPrerelease[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return leftPrerelease.length - rightPrerelease.length;
}

function comparePrereleases(leftPrerelease, rightPrerelease) {
  const stateComparison = comparePrereleaseState(leftPrerelease, rightPrerelease);
  return stateComparison ?? comparePopulatedPrereleases(leftPrerelease, rightPrerelease);
}

function versionIncreases(baseVersion, headVersion) {
  const baseParts = versionParts(baseVersion);
  const headParts = versionParts(headVersion);
  if (!baseParts || !headParts) {
    return false;
  }
  for (const versionPart of ['major', 'minor', 'patch']) {
    if (baseParts[versionPart] !== headParts[versionPart]) {
      return headParts[versionPart] > baseParts[versionPart];
    }
  }
  return comparePrereleases(baseParts.prerelease, headParts.prerelease) < 0;
}

function docsMcpPackageVersion(reference) {
  const packageManifest = readFileAtReference(reference, 'docs-mcp/package.json');
  try {
    const packageMetadata = JSON.parse(packageManifest);
    if (
      packageMetadata.name !== '@tesseron/docs-mcp' ||
      typeof packageMetadata.version !== 'string'
    ) {
      return null;
    }
    return packageMetadata.version;
  } catch {
    return null;
  }
}

const baseCandidates = [configuredBase];
if (process.env.GITHUB_BASE_REF?.trim() && !configuredBase.startsWith('origin/')) {
  baseCandidates.push(`origin/${configuredBase}`);
}

const baseReference = baseCandidates.find(referenceExists);
if (!baseReference) {
  console.error(`[check-docs-changeset] could not resolve base ref ${configuredBase}`);
  process.exit(1);
}

const changedFiles = runGit(['diff', '--name-only', `${baseReference}...HEAD`])
  .split(/\r?\n/)
  .map((filePath) => filePath.trim())
  .filter(Boolean);
const documentationFiles = changedFiles.filter((filePath) =>
  /^docs\/src\/content\/docs(?:\/|$)/.test(filePath),
);

if (documentationFiles.length === 0) {
  process.exit(0);
}

const changesetFiles = changedFiles.filter(
  (filePath) => /^\.changeset\/[^/]+\.md$/.test(filePath) && filePath !== '.changeset/README.md',
);
const hasPendingDocsMcpChangeset = changesetFiles.some((filePath) =>
  readFileAtReference('HEAD', filePath).includes('@tesseron/docs-mcp'),
);
const consumedChangesetFiles = changesetFiles.filter(
  (filePath) => !fileExistsAtReference('HEAD', filePath),
);
const hasConsumedDocsMcpChangeset =
  consumedChangesetFiles.some((filePath) =>
    readFileAtReference(baseReference, filePath).includes('@tesseron/docs-mcp'),
  ) && versionIncreases(docsMcpPackageVersion(baseReference), docsMcpPackageVersion('HEAD'));

if (hasPendingDocsMcpChangeset || hasConsumedDocsMcpChangeset) {
  process.exit(0);
}

console.error(
  '[check-docs-changeset] Docs content changed without a @tesseron/docs-mcp changeset.',
);
console.error('Changed docs files:');
for (const documentationFile of documentationFiles) {
  console.error(`- ${documentationFile}`);
}
console.error('Add a changeset with this frontmatter:');
console.error('---');
console.error("'@tesseron/docs-mcp': patch");
console.error('---');
process.exit(1);
