import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const webRoot = new URL('..', import.meta.url).pathname;
const repoRoot = new URL('../..', import.meta.url).pathname;
const testFilePattern = /\.(?:spec|test)\.(?:tsx?|mts)$/;
const scopePattern = /@test-scope\s+(parser|safeguard|regression):\s*(.+)/;
const echoLinkPattern = /^https:\/\/github\.com\/echoua\/echo\/(?:issues|pull)\/\d+$/;
const prohibitedTestDirectories = new Set([
  'characterization',
  'holding',
  'placement-exception',
  'placement-exceptions',
  'recovery',
  'temporary',
]);

function walk(directory, pattern = testFilePattern) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

function testCallName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      !['each', 'only', 'skip', 'skipIf', 'runIf', 'todo', 'fails', 'concurrent'].includes(
        expression.name.text,
      )
    )
      return null;
    return testCallName(expression.expression);
  }
  if (ts.isCallExpression(expression)) return testCallName(expression.expression);
  return null;
}

function isTestDeclaration(node) {
  return (
    ts.isCallExpression(node) &&
    ['it', 'test'].includes(testCallName(node.expression) ?? '') &&
    node.arguments[0] != null &&
    !isEachBuilderCall(node)
  );
}

function isEachBuilderCall(node) {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'each' &&
    ['it', 'test'].includes(testCallName(node.expression.expression) ?? '')
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
  const title = declarationTitle(sourceFile, node);
  const ancestors = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && isDescribeCall(parent))
      ancestors.unshift(declarationTitle(sourceFile, parent));
  }
  return `${relative(webRoot, file)}::${[...ancestors, title].join(' > ')}`;
}

function isDescribeCall(node) {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'describe' &&
    ['it', 'test'].includes(testCallName(node.expression.expression) ?? '') &&
    node.arguments[0] != null
  );
}

function declarationTitle(sourceFile, node) {
  const title = node.arguments[0];
  if (ts.isStringLiteralLike(title) || ts.isNoSubstitutionTemplateLiteral(title)) return title.text;
  const location = sourceFile.getLineAndCharacterOfPosition(title.getStart(sourceFile));
  return `dynamic title at line ${location.line + 1}: ${title.getText(sourceFile)}`;
}

function hasRegressionSelector(sourceFile, node) {
  for (let current = node; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      (isTestDeclaration(current) || isDescribeCall(current)) &&
      current.arguments[0]?.getText(sourceFile).includes('@regression')
    )
      return true;
  }
  return false;
}

function declarationScopeProblems(sourceText, file, playwright = false) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const fileScope = fileAnnotation(sourceText);
  const problems = [];
  for (const node of testDeclarations(sourceFile)) {
    const annotation = ancestorAnnotation(sourceText, node) ?? fileScope;
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const label = `${relative(webRoot, file)}:${location.line + 1} (${declarationTitle(sourceFile, node)})`;
    if (!annotation) problems.push(`${label} is unclassified`);
    else if (!validateAnnotation(annotation)) problems.push(`${label} has an invalid annotation`);
    if (!playwright) continue;
    const selected = hasRegressionSelector(sourceFile, node);
    if (annotation?.category === 'regression' && validateAnnotation(annotation) && !selected)
      problems.push(`${label} has a regression annotation without an @regression selector tag`);
    if (
      selected &&
      (!annotation || annotation.category !== 'regression' || !validateAnnotation(annotation))
    )
      problems.push(
        `${label} has an @regression selector tag without a valid regression annotation`,
      );
  }
  return problems;
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
      else if (/\.(?:md|ya?ml|json)$/.test(entry.name)) references.push(entryPath);
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

function behaviorContractTestReferenceProblems() {
  const contractsRoot = join(repoRoot, 'docs/frontend/react-behavior-contracts');
  return behaviorContractTestReferenceProblemsAt(contractsRoot, repoRoot);
}

const noDirectTestStatement =
  'No direct default-suite test; behavior is preserved by this contract.';
const coverageFieldPattern =
  /^\s*-\s+\*\*(?:Existing test(?:\(s\))?|Existing tests|Current retained test(?:\(s\))?|Recovered test inventory):\*\*\s*(.*)$/i;
const canonicalTestPathPattern =
  /^wdintel-web\/(?:src\/|tests\/)[^\s`*?]+\.(?:spec|test)\.(?:ts|tsx|mts)$/;

function markdownOutsideFencedCodeBlocks(text) {
  let fenced = false;
  return text
    .split('\n')
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join('\n');
}

function behaviorContractTestReferenceProblemsAt(contractsRoot, root) {
  const problems = [];
  for (const file of walk(contractsRoot, /\.md$/)) {
    for (const [index, line] of markdownOutsideFencedCodeBlocks(readFileSync(file, 'utf8'))
      .split('\n')
      .entries()) {
      const match = line.match(coverageFieldPattern);
      if (!match) continue;
      const value = match[1].trim();
      const label = `${relative(root, file)}:${index + 1}`;
      if (value === noDirectTestStatement) continue;
      const references = [...value.matchAll(/`([^`]+)`/g)].map((reference) => reference[1]);
      const remaining = value.replace(/`[^`]+`/g, '').trim();
      if (references.length === 0 || !/^(?:(?:,|;|and)\s*)*\.?$/.test(remaining)) {
        problems.push(`${label} must use canonical test paths or the exact no-direct statement`);
        continue;
      }
      for (const reference of references) {
        if (!canonicalTestPathPattern.test(reference))
          problems.push(`${label} uses incomplete test reference ${reference}`);
        else if (!existsSync(join(root, reference)))
          problems.push(`${label} references missing ${reference}`);
      }
    }
  }
  return problems;
}

function playwrightTestPathProblems() {
  return walk(webRoot)
    .filter((file) => readFileSync(file, 'utf8').includes('@playwright/test'))
    .filter((file) => !relative(webRoot, file).startsWith('tests/e2e/'))
    .map((file) => `${relative(webRoot, file)} must be under tests/e2e.`);
}

function modulePath(fromFile, moduleSpecifier) {
  if (!moduleSpecifier.startsWith('.')) return null;
  const basePath = join(fromFile, '..', moduleSpecifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.json`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
    join(basePath, 'index.mts'),
    join(basePath, 'index.js'),
    join(basePath, 'index.jsx'),
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
    join(basePath, 'index.json'),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

function relativeMockProblems(file) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const problems = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['vi', 'jest'].includes(node.expression.expression.getText(sourceFile)) &&
      ['mock', 'doMock'].includes(node.expression.name.text) &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith('.') &&
      !modulePath(file, node.arguments[0].text)
    ) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.arguments[0].getStart());
      problems.push(
        `${relative(webRoot, file)}:${location.line + 1} has unresolved relative mock ${node.arguments[0].text}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return problems;
}

function productionOwnedTestDirectory(pathSegments, testDirectoryIndex, root = webRoot) {
  const owner = join(root, ...pathSegments.slice(0, testDirectoryIndex));
  return readdirSync(owner, { withFileTypes: true }).some(
    (entry) =>
      entry.isFile() &&
      /\.(?:ts|tsx|js|jsx)$/.test(entry.name) &&
      !testFilePattern.test(entry.name),
  );
}

function uniquelyMatchesDescendantProductionModule(
  pathSegments,
  testDirectoryIndex,
  file,
  root = webRoot,
) {
  const owner = join(root, ...pathSegments.slice(0, testDirectoryIndex));
  const moduleName = basename(file).replace(/\.(?:spec|test)\.(?:ts|tsx|mts)$/, '');
  const matches = walk(owner, /\.(?:ts|tsx|js|jsx)$/).filter(
    (candidate) =>
      !candidate.includes('/__tests__/') &&
      basename(candidate).replace(/\.(?:ts|tsx|js|jsx)$/, '') === moduleName,
  );
  return matches.length === 1 && join(matches[0], '..') !== owner;
}

function placementProblemsFor(file, root = webRoot) {
  const path = relative(root, file);
  if (!path.startsWith('src/ts/react/')) return [];
  const pathSegments = path.split('/');
  const testDirectoryIndexes = pathSegments.flatMap((segment, index) =>
    segment === '__tests__' ? [index] : [],
  );
  const prohibitedDirectory = pathSegments.find((segment) =>
    prohibitedTestDirectories.has(segment),
  );
  if (prohibitedDirectory)
    return [`${path} uses prohibited ${prohibitedDirectory} test placement.`];
  if (testDirectoryIndexes.length !== 1)
    return [
      `${path} must be in the nearest production-owned __tests__ directory (found ${testDirectoryIndexes.length}).`,
    ];
  if (testDirectoryIndexes[0] !== pathSegments.length - 2)
    return [
      `${path} must be an immediate child of its nearest production-owned __tests__ directory.`,
    ];
  if (!productionOwnedTestDirectory(pathSegments, testDirectoryIndexes[0], root))
    return [`${path} has a test-created __tests__ owner directory.`];
  if (uniquelyMatchesDescendantProductionModule(pathSegments, testDirectoryIndexes[0], file, root))
    return [`${path} must be under the uniquely matching production module's __tests__ directory.`];
  return [];
}

function runGateSelfValidation() {
  const root = mkdtempSync(join(tmpdir(), 'echo-test-scope-'));
  const write = (path, content = '') => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  const expect = (condition, message) => {
    if (!condition) throw new Error(`React test-scope self-validation failed: ${message}`);
  };
  const web = join(root, 'wdintel-web');
  try {
    const mockSpec = join(web, 'src/ts/react/mock-owner/__tests__/MockOwner.spec.ts');
    write(join(web, 'src/ts/react/mock-owner/MockOwner.ts'), 'export {};');
    write(mockSpec, "vi.mock('./missing');");
    expect(relativeMockProblems(mockSpec).length === 1, 'unresolved relative mock passed');

    const nestedSpec = join(web, 'src/ts/react/nested-owner/__tests__/nested/Nested.spec.ts');
    write(join(web, 'src/ts/react/nested-owner/Nested.ts'), 'export {};');
    write(nestedSpec);
    expect(placementProblemsFor(nestedSpec, web).length === 1, 'nested __tests__ content passed');

    const descendantSpec = join(web, 'src/ts/react/descendant-owner/__tests__/Owner.spec.ts');
    write(join(web, 'src/ts/react/descendant-owner/child/Owner.ts'), 'export {};');
    write(descendantSpec);
    expect(
      placementProblemsFor(descendantSpec, web).length === 1,
      'descendant-only production ownership passed',
    );

    const broadSpec = join(web, 'src/ts/react/broad-owner/__tests__/Child.spec.ts');
    write(join(web, 'src/ts/react/broad-owner/BroadOwner.ts'), 'export {};');
    write(join(web, 'src/ts/react/broad-owner/child/Child.tsx'), 'export {};');
    write(broadSpec);
    expect(placementProblemsFor(broadSpec, web).length === 1, 'broader parent placement passed');

    const validSpec = join(web, 'src/ts/react/valid-owner/__tests__/ValidOwner.spec.ts');
    write(join(web, 'src/ts/react/valid-owner/ValidOwner.tsx'), 'export {};');
    write(validSpec);
    expect(placementProblemsFor(validSpec, web).length === 0, 'valid owner placement failed');

    const contract = join(root, 'docs/frontend/react-behavior-contracts/self-check.md');
    const actualPath = 'wdintel-web/src/ts/react/valid-owner/__tests__/ValidOwner.spec.ts';
    write(contract, `- **Existing test(s):** \`wdintel-web/src/ts/react/missing.spec.ts\`\n`);
    expect(
      behaviorContractTestReferenceProblemsAt(join(root, 'docs'), root).length === 1,
      'stale path passed',
    );
    write(contract, '- **Existing test(s):** `ValidOwner.spec.ts`\n');
    expect(
      behaviorContractTestReferenceProblemsAt(join(root, 'docs'), root).length === 1,
      'bare path passed',
    );
    write(contract, '- **Existing test(s):** focused coverage\n');
    expect(
      behaviorContractTestReferenceProblemsAt(join(root, 'docs'), root).length === 1,
      'prose coverage passed',
    );
    write(contract, `- **Existing test(s):** ${noDirectTestStatement}\n`);
    expect(
      behaviorContractTestReferenceProblemsAt(join(root, 'docs'), root).length === 0,
      'no-direct statement failed',
    );
    write(contract, `- **Existing test(s):** \`${actualPath}\`\n`);
    expect(
      behaviorContractTestReferenceProblemsAt(join(root, 'docs'), root).length === 0,
      'canonical path failed',
    );

    const dynamicFile = join(web, 'tests/e2e/dynamic.spec.ts');
    const dynamicTitle = 'const host = "duty"; test(`${host} title`, () => {});';
    expect(
      declarationScopeProblems(dynamicTitle, dynamicFile, true).some((problem) =>
        problem.includes('is unclassified'),
      ),
      'unannotated template title passed',
    );
    const annotatedDynamic =
      '// @test-scope safeguard: prevents the dynamic title from hiding an admitted failure.\n' +
      'const host = "duty"; test(`${host} title`, () => {});';
    expect(
      declarationScopeProblems(annotatedDynamic, dynamicFile, true).length === 0,
      'annotated template title failed',
    );
    const identifierTitle = 'const title = "title"; test(title, () => {});';
    expect(
      declarationScopeProblems(identifierTitle, dynamicFile, true).some((problem) =>
        problem.includes('dynamic title'),
      ),
      'identifier title was skipped',
    );
    const eachSource =
      '// @test-scope safeguard: prevents each declarations from bypassing admission.\n' +
      'test.each(["a"])(`title`, () => {});';
    const eachFile = ts.createSourceFile(dynamicFile, eachSource, ts.ScriptTarget.Latest, true);
    expect(testDeclarations(eachFile).length === 1, 'test.each was not counted exactly once');
    expect(
      declarationScopeProblems(eachSource, dynamicFile, true).length === 0,
      'test.each failed admission',
    );
    const regressionWithoutTag =
      '// @test-scope regression: https://github.com/echoua/echo/issues/1\n' +
      'test("title", () => {});';
    expect(
      declarationScopeProblems(regressionWithoutTag, dynamicFile, true).some((problem) =>
        problem.includes('without an @regression selector tag'),
      ),
      'regression without selector tag passed',
    );
    const tagWithoutRegression =
      '// @test-scope safeguard: prevents selector misuse from hiding a safety failure.\n' +
      'test("title @regression", () => {});';
    expect(
      declarationScopeProblems(tagWithoutRegression, dynamicFile, true).some((problem) =>
        problem.includes('without a valid regression annotation'),
      ),
      'selector tag without regression passed',
    );
    const matchingRegression =
      '// @test-scope regression: https://github.com/echoua/echo/issues/1\n' +
      'test.describe("group @regression", () => { test("title", () => {}); });';
    expect(
      declarationScopeProblems(matchingRegression, dynamicFile, true).length === 0,
      'matching regression annotation and selector tag failed',
    );
    const safeguardUnderRegression =
      '// @test-scope regression: https://github.com/echoua/echo/issues/1\n' +
      'test.describe("group @regression", () => {\n' +
      '  // @test-scope safeguard: prevents the child safety failure.\n' +
      '  test("title", () => {});\n' +
      '});';
    expect(
      declarationScopeProblems(safeguardUnderRegression, dynamicFile, true).some((problem) =>
        problem.includes('without a valid regression annotation'),
      ),
      'safeguard under regression ancestor passed',
    );
    expect(
      declarationScopeProblems(regressionWithoutTag, dynamicFile).length === 0,
      'Vitest regression required a Playwright selector tag',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function importedSymbols(file) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const imports = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
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
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = modulePath(file, statement.moduleSpecifier.text);
      if (!target) continue;
      const symbols = new Set();
      if (!statement.exportClause) symbols.add('*');
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements)
          symbols.add(element.propertyName?.text ?? element.name.text);
      }
      imports.push({ target, symbols });
    }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const target = modulePath(file, node.arguments[0].text);
      if (target) imports.push({ target, symbols: new Set(['*']) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return imports;
}

function exportedSymbolsFromText(file, sourceText) {
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

function exportedSymbols(file) {
  return exportedSymbolsFromText(file, readFileSync(file, 'utf8'));
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function githubEventBaseRef() {
  if (!process.env.GITHUB_EVENT_PATH || !existsSync(process.env.GITHUB_EVENT_PATH)) return null;
  try {
    return (
      JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.base?.sha ??
      null
    );
  } catch {
    return null;
  }
}

function mergeBase(reference) {
  if (!gitOutput(['rev-parse', '--verify', `${reference}^{commit}`])) return null;
  return gitOutput(['merge-base', 'HEAD', reference]);
}

function exportComparisonBase() {
  const explicitReference = process.env.TEST_SCOPE_BASE_REF;
  if (explicitReference) {
    const base = mergeBase(explicitReference);
    if (base) return base;
    throw new Error(
      `Cannot resolve TEST_SCOPE_BASE_REF=${explicitReference}. Provide a reachable commit or ref.`,
    );
  }

  const eventReference = githubEventBaseRef();
  if (eventReference) {
    const base = mergeBase(eventReference);
    if (base) return base;
    throw new Error(
      `Cannot resolve the GitHub PR base ${eventReference}. Provide TEST_SCOPE_BASE_REF explicitly.`,
    );
  }

  if (process.env.GITHUB_BASE_REF) {
    const base = mergeBase(`origin/${process.env.GITHUB_BASE_REF}`);
    if (base) return base;
  }

  const base = mergeBase('origin/main');
  if (base) return base;
  throw new Error(
    'Cannot resolve a merge base for the test-only export check. Provide TEST_SCOPE_BASE_REF.',
  );
}

function baseExportedSymbols(file, base) {
  const sourceText = gitOutput(['show', `${base}:${relative(repoRoot, file)}`]);
  return sourceText === null ? new Set() : exportedSymbolsFromText(file, sourceText);
}

function isUsedWithinFile(file, symbol) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  let uses = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === symbol && !isDeclarationName(node)) uses += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return uses > 0;
}

function isDeclarationName(node) {
  const parent = node.parent;
  return (
    (ts.isDeclaration(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isExportSpecifier(parent) && parent.name === node)
  );
}

function testOnlyProductionExports(testFiles, base) {
  const productionFiles = walk(join(webRoot, 'src', 'ts', 'react'), /\.(?:tsx?|mts)$/).filter(
    (file) => !testFilePattern.test(file),
  );
  const sourceFiles = walk(join(webRoot, 'src'), /\.(?:tsx?|mts)$/).filter(
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
  for (const file of sourceFiles) {
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
          !usedByProduction.has(symbol) &&
          !isUsedWithinFile(file, symbol),
      )
      .map((symbol) => ({ file, symbol }));
  });
}

const invalidAnnotations = [];
let exportBase;
try {
  exportBase = exportComparisonBase();
} catch (error) {
  invalidAnnotations.push(error.message);
}
const testRoots = [join(webRoot, 'src', 'ts', 'react'), join(webRoot, 'tests', 'e2e')];
const testFiles = testRoots.flatMap((root) => (existsSync(root) ? walk(root) : []));
const unclassified = [];
const placementProblems = [];
for (const file of testFiles) {
  const path = relative(webRoot, file);
  if (path.startsWith('src/ts/react/')) {
    placementProblems.push(...placementProblemsFor(file));
  }
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
    if (path.startsWith('tests/e2e/')) {
      const selected = hasRegressionSelector(sourceFile, node);
      if (annotation?.category === 'regression' && validateAnnotation(annotation) && !selected)
        invalidAnnotations.push(
          `${label} (${declarationTitle(sourceFile, node)}) has a regression annotation without an @regression selector tag.`,
        );
      if (
        selected &&
        (!annotation || annotation.category !== 'regression' || !validateAnnotation(annotation))
      )
        invalidAnnotations.push(
          `${label} (${declarationTitle(sourceFile, node)}) has an @regression selector tag without a valid regression annotation.`,
        );
    }
  }
}
runGateSelfValidation();
invalidAnnotations.push(...referencedTestPathProblems());
invalidAnnotations.push(...behaviorContractTestReferenceProblems());
invalidAnnotations.push(...playwrightTestPathProblems());
invalidAnnotations.push(...testFiles.flatMap(relativeMockProblems));
invalidAnnotations.push(...placementProblems);
let inheritedTestOnlyExports = 0;
if (exportBase) {
  const testOnlyExports = testOnlyProductionExports(testFiles, exportBase);
  for (const { file, symbol } of testOnlyExports) {
    if (baseExportedSymbols(file, exportBase).has(symbol)) inheritedTestOnlyExports += 1;
    else invalidAnnotations.push(`${relative(webRoot, file)} exports ${symbol} for test-only use`);
  }
}

if (invalidAnnotations.length > 0 || unclassified.length > 0) {
  console.error('React test-scope check failed:');
  if (unclassified.length > 0) {
    console.error('Unclassified tests:');
    console.error(
      [...new Set(unclassified)]
        .sort()
        .map((identity) => `- ${identity}`)
        .join('\n'),
    );
  }
  if (invalidAnnotations.length > 0) {
    console.error('Invalid annotations or references:');
    console.error(invalidAnnotations.map((problem) => `- ${problem}`).join('\n'));
  }
  process.exitCode = 1;
} else {
  console.log('React test-scope check passed.');
}

if (inheritedTestOnlyExports > 0)
  console.log(`Ignored ${inheritedTestOnlyExports} inherited test-only exports.`);
