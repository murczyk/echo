import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';

const webRoot = resolve(new URL('..', import.meta.url).pathname);
const repoRoot = resolve(webRoot, '..');
const reactRoot = join(webRoot, 'src/ts/react');
const e2eRoot = join(webRoot, 'tests/e2e');
const behaviorContractRoot = join(repoRoot, 'docs/frontend/react-behavior-contracts');
const playwrightConfig = join(webRoot, 'playwright.config.ts');
const testFilePattern = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const sourceFilePattern = /\.[cm]?[jt]sx?$/;
const testSupportPattern =
  /(?:\.|-)(?:test-utils|test-helpers|fixture|fixtures|mock|mocks)\.[cm]?[jt]sx?$/;
const ignoredDirectoryNames = new Set([
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const failures = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) return [path];
    return ignoredDirectoryNames.has(entry.name) ? [] : walk(path);
  });
}

function report(message) {
  failures.push(message);
}

function isInside(path, directory) {
  const pathRelative = relative(directory, path);
  return !pathRelative.startsWith('..') && !pathRelative.includes('/../');
}

function hasProductionOwner(owner) {
  return readdirSync(owner, { withFileTypes: true }).some(
    (entry) =>
      entry.isFile() &&
      sourceFilePattern.test(entry.name) &&
      !testFilePattern.test(entry.name) &&
      !testSupportPattern.test(entry.name),
  );
}

function checkReactTestPlacement() {
  for (const path of walk(reactRoot).filter((candidate) => testFilePattern.test(candidate))) {
    const segments = relative(reactRoot, path).split('/');
    const testDirectoryIndex = segments.indexOf('__tests__');
    if (
      testDirectoryIndex < 0 ||
      testDirectoryIndex !== segments.lastIndexOf('__tests__') ||
      testDirectoryIndex !== segments.length - 2
    ) {
      report(
        `${relative(repoRoot, path)} must be a direct child of exactly one __tests__/ directory.`,
      );
      continue;
    }
    const owner = dirname(dirname(path));
    if (!hasProductionOwner(owner))
      report(
        `${relative(repoRoot, path)} has no production source module in its __tests__/ owner.`,
      );
  }
}

function checkE2ePlacement() {
  const testsRoot = join(webRoot, 'tests');
  if (!existsSync(testsRoot)) return;
  for (const path of walk(testsRoot)) {
    if (sourceFilePattern.test(path) && !isInside(path, e2eRoot))
      report(`${relative(repoRoot, path)} must live under wdintel-web/tests/e2e.`);
  }
}

function resolveRelativeImport(path, specifier) {
  const base = resolve(dirname(path), specifier);
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map(
      (extension) => `${base}${extension}`,
    ),
    ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((name) => join(base, name)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function moduleSpecifiers(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function frontendModules() {
  return walk(webRoot).filter((path) => sourceFilePattern.test(path));
}

function checkPlaywrightPlacement() {
  for (const path of frontendModules()) {
    if (!moduleSpecifiers(path).includes('@playwright/test')) continue;
    if (!isInside(path, e2eRoot) && path !== playwrightConfig)
      report(`${relative(repoRoot, path)} imports @playwright/test outside wdintel-web/tests/e2e.`);
  }
}

function checkProductionImports() {
  for (const path of walk(reactRoot)) {
    if (
      !sourceFilePattern.test(path) ||
      testFilePattern.test(path) ||
      testSupportPattern.test(path)
    )
      continue;
    for (const specifier of moduleSpecifiers(path)) {
      if (!specifier.startsWith('.')) continue;
      const imported = resolveRelativeImport(path, specifier);
      if (imported && testSupportPattern.test(imported))
        report(
          `${relative(repoRoot, path)} imports test-only support ${relative(repoRoot, imported)}.`,
        );
    }
  }
}

function checkReferencedFiles() {
  const packageScripts = Object.values(
    JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')).scripts,
  );
  const ciFiles = existsSync(join(repoRoot, '.github'))
    ? walk(join(repoRoot, '.github')).filter((path) => /\.(?:ya?ml|json|js|mjs)$/.test(path))
    : [];
  const behaviorContractFiles = existsSync(behaviorContractRoot)
    ? walk(behaviorContractRoot).filter((path) => path.endsWith('.md'))
    : [];
  const sources = packageScripts.concat(
    ciFiles.concat(behaviorContractFiles).map((path) => readFileSync(path, 'utf8')),
  );
  const pathPattern =
    /(?:wdintel-web\/)?(?:src\/ts\/react|tests\/e2e)\/[^\s'"\\]+?\.(?:spec|test)\.[cm]?[jt]sx?/g;
  for (const source of sources) {
    for (const match of source.matchAll(pathPattern)) {
      const path = match[0].replace(/^wdintel-web\//, '');
      if (!existsSync(join(webRoot, normalize(path))))
        report(`Referenced test file does not exist: wdintel-web/${path}`);
    }
  }
}

checkReactTestPlacement();
checkE2ePlacement();
checkPlaywrightPlacement();
checkProductionImports();
checkReferencedFiles();

if (failures.length) {
  console.error(
    `Test structure check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
  );
  process.exit(1);
}
