import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const webRoot = new URL('..', import.meta.url).pathname;
const repoRoot = new URL('../..', import.meta.url).pathname;
const testFilePattern = /\.(?:spec|test)\.(?:tsx?|mts)$/;
const scopePattern = /@test-scope\s+(parser|safeguard|regression):\s*(.+)/;
const echoLinkPattern = /^https:\/\/github\.com\/echoua\/echo\/(?:issues|pull)\/\d+$/;
const baselinePath = join(webRoot, 'test-scope-baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
    return testFilePattern.test(entry.name) ? [path] : [];
  });
}

function testCallName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      ['describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll'].includes(
        expression.name.text,
      )
    ) {
      return null;
    }
    return testCallName(expression.expression);
  }
  if (ts.isCallExpression(expression)) return testCallName(expression.expression);
  return null;
}

function isTestDeclaration(node) {
  return (
    ts.isCallExpression(node) &&
    ['it', 'test'].includes(testCallName(node.expression) ?? '') &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function annotationBefore(sourceText, node) {
  const leading = sourceText.slice(node.getFullStart(), node.getStart());
  const match = leading.match(scopePattern);
  return match ? { category: match[1], detail: match[2].trim() } : null;
}

function fileAnnotation(sourceText) {
  let inBlockComment = false;
  for (const line of sourceText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    const match = trimmed.match(scopePattern);
    if (match) return { category: match[1], detail: match[2].trim() };
    if (trimmed.startsWith('//')) continue;
    return null;
  }
  return null;
}

function ancestorAnnotation(sourceText, node) {
  for (let current = node; current; current = current.parent) {
    const annotation = annotationBefore(sourceText, current);
    if (annotation) return annotation;
  }
  return null;
}

function validateAnnotation(annotation) {
  if (annotation.category === 'regression') return echoLinkPattern.test(annotation.detail);
  if (annotation.category === 'safeguard') return annotation.detail.length >= 20;
  return annotation.detail.length > 0;
}

function testDeclarations(sourceFile) {
  const declarations = [];
  const visit = (node) => {
    if (isTestDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function declarationIdentity(sourceFile, node, file) {
  const title = node.arguments[0].text;
  const ancestors = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      testCallName(parent.expression) === 'describe' &&
      ts.isStringLiteralLike(parent.arguments[0])
    ) {
      ancestors.unshift(parent.arguments[0].text);
    }
  }
  return `${relative(webRoot, file)}::${[...ancestors, title].join(' > ')}`;
}

function collectReferencedTestFiles() {
  const candidates = [
    join(repoRoot, '.github'),
    join(repoRoot, 'docs'),
    join(webRoot, 'package.json'),
    join(repoRoot, 'justfile'),
  ];
  const references = [];
  const visit = (path) => {
    if (!existsSync(path)) return;
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (
        /\.(?:md|ya?ml|json)$/.test(entry.name) &&
        entry.name !== 'react-test-removal-dispositions.json'
      )
        references.push(entryPath);
    }
  };
  for (const candidate of candidates) {
    if (candidate.endsWith('package.json') || candidate.endsWith('justfile'))
      references.push(candidate);
    else visit(candidate);
  }
  return references;
}

function referencedTestPathProblems() {
  const pattern = /(?:wdintel-web\/)?((?:src|tests)\/[^\s`'"()]+\.(?:spec|test)\.(?:tsx?|mts))/g;
  const problems = [];
  for (const file of collectReferencedTestFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      if (!match[1].startsWith('src/ts/react/') && !match[1].startsWith('tests/e2e/')) continue;
      const path = join(webRoot, match[1]);
      if (!existsSync(path))
        problems.push(`${relative(repoRoot, file)} references missing ${match[1]}`);
    }
  }
  return problems;
}

function modulePath(fromFile, moduleSpecifier) {
  if (!moduleSpecifier.startsWith('.')) return null;
  const basePath = join(fromFile, '..', moduleSpecifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
  ];
  return candidates.find(existsSync) ?? null;
}

function importedSymbols(file) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const imports = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const target = modulePath(file, statement.moduleSpecifier.text);
    if (!target || !statement.importClause) continue;
    const symbols = new Set();
    if (statement.importClause.name) symbols.add('default');
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements)
        symbols.add(element.propertyName?.text ?? element.name.text);
    }
    if (bindings && ts.isNamespaceImport(bindings)) symbols.add('*');
    imports.push({ target, symbols });
  }
  return imports;
}

function exportedSymbols(file) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const symbols = new Set();
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported && ts.isFunctionDeclaration(statement) && statement.name)
      symbols.add(statement.name.text);
    if (exported && ts.isClassDeclaration(statement) && statement.name)
      symbols.add(statement.name.text);
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) symbols.add(declaration.name.text);
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) symbols.add(element.name.text);
    }
  }
  return symbols;
}

function testOnlyProductionExports(testFiles) {
  const productionFiles = walk(join(webRoot, 'src', 'ts', 'react')).filter(
    (file) => !testFilePattern.test(file),
  );
  const testImports = new Map();
  const productionImports = new Map();
  for (const file of testFiles) {
    for (const { target, symbols } of importedSymbols(file)) {
      const imported = testImports.get(target) ?? new Set();
      symbols.forEach((symbol) => imported.add(symbol));
      testImports.set(target, imported);
    }
  }
  for (const file of productionFiles) {
    for (const { target, symbols } of importedSymbols(file)) {
      const imported = productionImports.get(target) ?? new Set();
      symbols.forEach((symbol) => imported.add(symbol));
      productionImports.set(target, imported);
    }
  }
  return productionFiles.flatMap((file) => {
    const usedByTests = testImports.get(file);
    if (!usedByTests) return [];
    const usedByProduction = productionImports.get(file) ?? new Set();
    return [...exportedSymbols(file)]
      .filter(
        (symbol) =>
          (usedByTests.has('*') || usedByTests.has(symbol)) &&
          !usedByProduction.has('*') &&
          !usedByProduction.has(symbol),
      )
      .map((symbol) => `${relative(webRoot, file)} exports ${symbol} for test-only use`);
  });
}

const invalidAnnotations = [];
const testRoots = [join(webRoot, 'src', 'ts', 'react'), join(webRoot, 'tests', 'e2e')];
const testFiles = testRoots.flatMap((root) => (existsSync(root) ? walk(root) : []));
const unclassified = [];
for (const file of testFiles) {
  if (file.includes('/characterization/')) continue;
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const fileScope = fileAnnotation(text);
  if (fileScope && fileScope.category !== 'parser') {
    invalidAnnotations.push(
      `${relative(webRoot, file)} has a file-level annotation that is not parser coverage.`,
    );
  }
  for (const node of testDeclarations(sourceFile)) {
    const annotation = ancestorAnnotation(text, node) ?? fileScope;
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const label = `${relative(webRoot, file)}:${location.line + 1}`;
    if (!annotation) {
      unclassified.push(declarationIdentity(sourceFile, node, file));
    } else if (!validateAnnotation(annotation)) {
      invalidAnnotations.push(
        `${label} has an invalid ${annotation.category} annotation: ${annotation.detail}`,
      );
    }
  }
}
invalidAnnotations.push(...referencedTestPathProblems());
const testOnlyExports = testOnlyProductionExports(testFiles);

const sortedUnclassified = [...new Set(unclassified)].sort();
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : { version: 1, unclassified: [] };
const baselineDebt = new Set(baseline.unclassified ?? []);
const currentDebt = new Set(sortedUnclassified);
let newDebt = sortedUnclassified.filter((identity) => !baselineDebt.has(identity));
let resolvedDebt = [...baselineDebt].filter((identity) => !currentDebt.has(identity)).sort();

if (updateBaseline) {
  if (existsSync(baselinePath) && newDebt.length > 0) {
    console.error('Refusing to expand the legacy test-scope baseline: classify new tests first.');
    console.error(newDebt.map((identity) => `- ${identity}`).join('\n'));
    process.exitCode = 1;
  } else {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ version: 1, unclassified: sortedUnclassified }, null, 2)}\n`,
    );
    console.log(`Updated legacy test-scope baseline with ${sortedUnclassified.length} entries.`);
    newDebt = [];
    resolvedDebt = [];
  }
}

if (invalidAnnotations.length > 0 || newDebt.length > 0) {
  console.error('React test-scope check failed:');
  if (newDebt.length > 0) {
    console.error('New unclassified test debt:');
    console.error(newDebt.map((identity) => `- ${identity}`).join('\n'));
  }
  if (invalidAnnotations.length > 0) {
    console.error('Invalid annotations or references:');
    console.error(invalidAnnotations.map((problem) => `- ${problem}`).join('\n'));
  }
  process.exitCode = 1;
} else {
  console.log('React test-scope check passed.');
}

console.log(`Remaining legacy test debt: ${sortedUnclassified.length}.`);
console.log(`Resolved legacy test debt: ${resolvedDebt.length}.`);

if (testOnlyExports.length > 0) {
  console.warn('React test-only production exports to review:');
  console.warn(testOnlyExports.map((entry) => `- ${entry}`).join('\n'));
}
