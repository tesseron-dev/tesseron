import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./check-docs-changeset.mjs', import.meta.url));
const docsMcpPackagePath = 'docs-mcp/package.json';
const docsPagePath = 'docs/src/content/docs/example.md';
const docsMcpChangesetPath = '.changeset/docs-mcp.md';

function runGit(repositoryRoot, gitArguments) {
  execFileSync('git', gitArguments, { cwd: repositoryRoot, stdio: 'pipe' });
}

function writeFiles(repositoryRoot, files) {
  for (const [filePath, content] of Object.entries(files)) {
    const destination = join(repositoryRoot, filePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}

function packageManifest(version) {
  return `${JSON.stringify({ name: '@tesseron/docs-mcp', version }, null, 2)}\n`;
}

function createFixture(testContext, baseFiles, candidateFiles, deletedFiles = []) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'check-docs-changeset-'));
  testContext.after(() => rmSync(repositoryRoot, { force: true, recursive: true }));
  runGit(repositoryRoot, ['init']);
  runGit(repositoryRoot, ['config', 'user.email', 'test@example.com']);
  runGit(repositoryRoot, ['config', 'user.name', 'Test User']);
  runGit(repositoryRoot, ['branch', '-M', 'main']);
  writeFiles(repositoryRoot, baseFiles);
  runGit(repositoryRoot, ['add', '.']);
  runGit(repositoryRoot, ['commit', '-m', 'base']);
  runGit(repositoryRoot, ['checkout', '-b', 'candidate']);
  for (const filePath of deletedFiles) {
    rmSync(join(repositoryRoot, filePath));
  }
  writeFiles(repositoryRoot, candidateFiles);
  runGit(repositoryRoot, ['add', '-A']);
  runGit(repositoryRoot, ['commit', '-m', 'candidate']);
  return repositoryRoot;
}

function runGuard(repositoryRoot, environment = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CHECK_DOCS_CHANGESET_REPOSITORY_ROOT: repositoryRoot,
      GITHUB_BASE_REF: 'main',
      ...environment,
    },
  });
}

function basePackage(version = '1.0.0') {
  return { [docsMcpPackagePath]: packageManifest(version) };
}

function baseChangeset() {
  return { [docsMcpChangesetPath]: "---\n'@tesseron/docs-mcp': patch\n---\n\nUpdate docs.\n" };
}

test('allows docs content with a pending docs-mcp changeset', (testContext) => {
  const repositoryRoot = createFixture(testContext, basePackage(), {
    [docsPagePath]: '# Updated docs\n',
    ...baseChangeset(),
  });
  assert.equal(runGuard(repositoryRoot).status, 0);
});

test('rejects docs content without a docs-mcp changeset', (testContext) => {
  const repositoryRoot = createFixture(testContext, basePackage(), {
    [docsPagePath]: '# Updated docs\n',
  });
  assert.equal(runGuard(repositoryRoot).status, 1);
});

test('allows a consumed docs-mcp changeset with an increased package version', (testContext) => {
  const repositoryRoot = createFixture(
    testContext,
    {
      ...basePackage(),
      ...baseChangeset(),
    },
    {
      [docsPagePath]: '# Updated docs\n',
      [docsMcpPackagePath]: packageManifest('1.0.1'),
    },
    [docsMcpChangesetPath],
  );
  assert.equal(runGuard(repositoryRoot).status, 0);
});

test('rejects a modified docs-mcp changeset even when the package version increases', (testContext) => {
  const repositoryRoot = createFixture(
    testContext,
    {
      ...basePackage(),
      ...baseChangeset(),
    },
    {
      [docsPagePath]: '# Updated docs\n',
      [docsMcpChangesetPath]: "---\n'@tesseron/mcp': patch\n---\n\nUpdate gateway.\n",
      [docsMcpPackagePath]: packageManifest('1.0.1'),
    },
  );
  assert.equal(runGuard(repositoryRoot).status, 1);
});

test('rejects a consumed docs-mcp changeset without a package version increase', (testContext) => {
  const repositoryRoot = createFixture(
    testContext,
    {
      ...basePackage(),
      ...baseChangeset(),
    },
    { [docsPagePath]: '# Updated docs\n' },
    [docsMcpChangesetPath],
  );
  assert.equal(runGuard(repositoryRoot).status, 1);
});

test('rejects an unrelated package increase after consuming a docs-mcp changeset', (testContext) => {
  const repositoryRoot = createFixture(
    testContext,
    {
      ...basePackage(),
      ...baseChangeset(),
      'gateway/package.json': '{"version":"1.0.0"}\n',
    },
    {
      [docsPagePath]: '# Updated docs\n',
      'gateway/package.json': '{"version":"1.0.1"}\n',
    },
    [docsMcpChangesetPath],
  );
  assert.equal(runGuard(repositoryRoot).status, 1);
});

test('rejects a lower docs-mcp package version after consuming its changeset', (testContext) => {
  const repositoryRoot = createFixture(
    testContext,
    {
      ...basePackage(),
      ...baseChangeset(),
    },
    {
      [docsPagePath]: '# Updated docs\n',
      [docsMcpPackagePath]: packageManifest('0.9.0'),
    },
    [docsMcpChangesetPath],
  );
  assert.equal(runGuard(repositoryRoot).status, 1);
});

test('rejects a missing docs-mcp package manifest after consuming its changeset', (testContext) => {
  const repositoryRoot = createFixture(
    testContext,
    {
      ...basePackage(),
      ...baseChangeset(),
    },
    { [docsPagePath]: '# Updated docs\n' },
    [docsMcpChangesetPath, docsMcpPackagePath],
  );
  assert.equal(runGuard(repositoryRoot).status, 1);
});

test('rejects an invalid docs-mcp package version after consuming its changeset', (testContext) => {
  const repositoryRoot = createFixture(
    testContext,
    {
      ...basePackage(),
      ...baseChangeset(),
    },
    {
      [docsPagePath]: '# Updated docs\n',
      [docsMcpPackagePath]: packageManifest('not-a-version'),
    },
    [docsMcpChangesetPath],
  );
  assert.equal(runGuard(repositoryRoot).status, 1);
});

test('supports valid semantic prerelease version increases', (testContext) => {
  const scenarios = [
    { baseVersion: '1.0.0-1', headVersion: '1.0.0-alpha', expectedStatus: 0 },
    { baseVersion: '1.0.0-alpha', headVersion: '1.0.0-1', expectedStatus: 1 },
    { baseVersion: '1.0.0-alpha', headVersion: '1.0.0-beta', expectedStatus: 0 },
    { baseVersion: '1.0.0-alpha.1', headVersion: '1.0.0-alpha.2', expectedStatus: 0 },
    { baseVersion: '1.0.0-alpha', headVersion: '1.0.0-alpha.1', expectedStatus: 0 },
    { baseVersion: '1.0.0-alpha.1', headVersion: '1.0.0-alpha', expectedStatus: 1 },
    { baseVersion: '1.0.0-alpha', headVersion: '1.0.0', expectedStatus: 0 },
    { baseVersion: '1.0.0', headVersion: '1.0.0-alpha', expectedStatus: 1 },
  ];
  for (const scenario of scenarios) {
    const repositoryRoot = createFixture(
      testContext,
      {
        ...basePackage(scenario.baseVersion),
        ...baseChangeset(),
      },
      {
        [docsPagePath]: '# Updated docs\n',
        [docsMcpPackagePath]: packageManifest(scenario.headVersion),
      },
      [docsMcpChangesetPath],
    );
    assert.equal(runGuard(repositoryRoot).status, scenario.expectedStatus);
  }
});

test('allows no documentation content changes', (testContext) => {
  const repositoryRoot = createFixture(testContext, basePackage(), { 'README.md': '# Updated\n' });
  assert.equal(runGuard(repositoryRoot).status, 0);
});

test('fails when the configured base cannot resolve', (testContext) => {
  const repositoryRoot = createFixture(testContext, basePackage(), {
    [docsPagePath]: '# Updated docs\n',
  });
  assert.equal(runGuard(repositoryRoot, { GITHUB_BASE_REF: 'missing-base' }).status, 1);
});
