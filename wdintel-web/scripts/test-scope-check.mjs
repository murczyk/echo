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
const testFilePattern = /\.(?:spec|test)\.(?:tsx?|mts|[cm]?js|jsx)$/;
const sourceModulePattern = /\.(?:tsx?|mts|[cm]?js|jsx)$/;
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

function walk(
  directory,
  pattern = testFilePattern,
  ignoredDirectories = new Set(['node_modules']),
) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ignoredDirectories.has(entry.name) ? [] : walk(path, pattern, ignoredDirectories);
    return pattern.test(entry.name) ? [path] : [];
  });
}

function testApiBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !['vitest', '@playwright/test'].includes(statement.moduleSpecifier.text) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    )
      continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (['it', 'test'].includes(imported) && !element.isTypeOnly)
          named.set(element.name.text, element);
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, bindings);
  }
  return { named, namespaces };
}

function declarationNames(node) {
  if (ts.isVariableDeclaration(node)) return bindingIdentifiers(node.name);
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node))
    return node.name ? [node.name.text] : [];
  return [];
}

function variableDeclarationListNames(declarationList) {
  return declarationList.declarations.flatMap(declarationNames);
}

function directScopeDeclarations(statements, includeFunctionScopedVariables) {
  return statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      const blockScoped = (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      return includeFunctionScopedVariables || blockScoped
        ? variableDeclarationListNames(statement.declarationList)
        : [];
    }
    return declarationNames(statement);
  });
}

function functionScopedVariableDeclarations(scope) {
  const names = [];
  const root = ts.isSourceFile(scope) ? scope : scope.body;
  if (!root) return names;
  const visit = (node) => {
    if (
      node !== root &&
      (ts.isFunctionLike(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isModuleDeclaration(node))
    )
      return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0)
      names.push(...variableDeclarationListNames(node));
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

function scopeDeclarations(scope) {
  if (ts.isSourceFile(scope))
    return [
      ...directScopeDeclarations(scope.statements, true),
      ...functionScopedVariableDeclarations(scope),
    ];
  if (ts.isBlock(scope) || ts.isCaseBlock(scope))
    return directScopeDeclarations(scope.statements, false);
  if (ts.isFunctionLike(scope))
    return [
      ...scope.parameters.flatMap((parameter) => bindingIdentifiers(parameter.name)),
      ...(scope.name && ts.isIdentifier(scope.name) ? [scope.name.text] : []),
      ...functionScopedVariableDeclarations(scope),
    ];
  if (ts.isCatchClause(scope))
    return scope.variableDeclaration ? bindingIdentifiers(scope.variableDeclaration.name) : [];
  if (ts.isForStatement(scope)) {
    const initializer = scope.initializer;
    return initializer &&
      ts.isVariableDeclarationList(initializer) &&
      (initializer.flags & ts.NodeFlags.BlockScoped) !== 0
      ? variableDeclarationListNames(initializer)
      : [];
  }
  if (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const initializer = scope.initializer;
    return ts.isVariableDeclarationList(initializer) &&
      (initializer.flags & ts.NodeFlags.BlockScoped) !== 0
      ? variableDeclarationListNames(initializer)
      : [];
  }
  return [];
}

function sourceImportBinding(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    if (statement.importClause.name?.text === name) return statement.importClause.name;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return bindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const element = bindings.elements.find((candidate) => candidate.name.text === name);
      if (element) return element;
    }
  }
  return null;
}

function isShadowedAt(identifier, sourceFile, importBinding) {
  for (let current = identifier.parent; current; current = current.parent) {
    if (ts.isSourceFile(current)) {
      const imported = sourceImportBinding(sourceFile, identifier.text);
      if (imported && imported !== importBinding) return true;
    }
    if (
      (ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isCaseBlock(current) ||
        ts.isFunctionLike(current) ||
        ts.isCatchClause(current) ||
        ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current)) &&
      scopeDeclarations(current).includes(identifier.text)
    )
      return true;
    if (current === sourceFile) break;
  }
  return false;
}

function isTestApiIdentifier(identifier, sourceFile, bindings) {
  const importBinding = bindings.named.get(identifier.text);
  if (importBinding) return !isShadowedAt(identifier, sourceFile, importBinding);
  return ['it', 'test'].includes(identifier.text) && !isShadowedAt(identifier, sourceFile);
}

function isTestApiNamespace(identifier, sourceFile, bindings) {
  const importBinding = bindings.namespaces.get(identifier.text);
  return importBinding && !isShadowedAt(identifier, sourceFile, importBinding);
}

function testCallName(expression, sourceFile, bindings) {
  if (ts.isIdentifier(expression))
    return isTestApiIdentifier(expression, sourceFile, bindings) ? expression.text : null;
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      ts.isIdentifier(expression.expression) &&
      isTestApiNamespace(expression.expression, sourceFile, bindings) &&
      ['it', 'test'].includes(expression.name.text)
    )
      return expression.name.text;
    if (
      !['each', 'only', 'skip', 'skipIf', 'runIf', 'todo', 'fails', 'concurrent'].includes(
        expression.name.text,
      )
    )
      return null;
    return testCallName(expression.expression, sourceFile, bindings);
  }
  if (ts.isCallExpression(expression))
    return testCallName(expression.expression, sourceFile, bindings);
  return null;
}

function isTestDeclaration(node, sourceFile, bindings) {
  return (
    ts.isCallExpression(node) &&
    testCallName(node.expression, sourceFile, bindings) !== null &&
    node.arguments[0] != null &&
    !isEachBuilderCall(node, sourceFile, bindings)
  );
}

function isEachBuilderCall(node, sourceFile, bindings) {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'each' &&
    testCallName(node.expression.expression, sourceFile, bindings) !== null
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
  const bindings = testApiBindings(sourceFile);
  const declarations = [];
  const visit = (node) => {
    if (isTestDeclaration(node, sourceFile, bindings)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function declarationIdentity(sourceFile, node, file) {
  const title = declarationTitle(sourceFile, node);
  const ancestors = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      isDescribeCall(parent, sourceFile, testApiBindings(sourceFile))
    )
      ancestors.unshift(declarationTitle(sourceFile, parent));
  }
  return `${relative(webRoot, file)}::${[...ancestors, title].join(' > ')}`;
}

function isDescribeCall(node, sourceFile, bindings) {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'describe' &&
    testCallName(node.expression.expression, sourceFile, bindings) !== null &&
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
  const bindings = testApiBindings(sourceFile);
  for (let current = node; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      (isTestDeclaration(current, sourceFile, bindings) ||
        isDescribeCall(current, sourceFile, bindings)) &&
      current.arguments[0]?.getText(sourceFile).includes('@regression')
    )
      return true;
  }
  return false;
}

function declarationScopeProblems(sourceText, file, playwright = false) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const bindings = testApiBindings(sourceFile);
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

function importsPlaywrightTest(file) {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const isPlaywrightSpecifier = (node) =>
    ts.isStringLiteralLike(node) && node.text === '@playwright/test';
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isPlaywrightSpecifier(node.moduleSpecifier)
    )
      found = true;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isPlaywrightSpecifier(node.arguments[0])
    )
      found = true;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      isPlaywrightSpecifier(node.arguments[0])
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function playwrightTestPathProblems(root = webRoot) {
  const ignoredDirectories = new Set([
    'node_modules',
    'dist',
    'coverage',
    'playwright-report',
    'test-results',
    '.elm-land',
  ]);
  return walk(root, sourceModulePattern, ignoredDirectories)
    .filter(importsPlaywrightTest)
    .filter((file) => {
      const path = relative(root, file);
      return path !== 'playwright.config.ts' && !path.startsWith('tests/e2e/');
    })
    .map((file) => `${relative(root, file)} must be under tests/e2e.`);
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
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
    join(basePath, 'index.mts'),
    join(basePath, 'index.js'),
    join(basePath, 'index.jsx'),
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
  ];
  return (
    candidates.find(
      (candidate) =>
        sourceModulePattern.test(candidate) &&
        existsSync(candidate) &&
        statSync(candidate).isFile(),
    ) ?? null
  );
}

function isTestSupportModule(file) {
  return (
    file.includes('/__tests__/') ||
    /(?:\.(?:test-utils|test-helpers|fixtures?|mocks?)|-+(?:test-utils|test-helpers|fixtures?|mocks?))\.(?:tsx?|mts|[cm]?js|jsx)$/.test(
      file,
    )
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

function importHasValueBinding(importClause) {
  if (!importClause || importClause.isTypeOnly) return false;
  if (importClause.name) return true;
  const bindings = importClause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function mixedOwnerImportProblems(file, pathSegments, testDirectoryIndex, root = webRoot) {
  const owner = join(root, ...pathSegments.slice(0, testDirectoryIndex));
  const ownerModuleName = basename(file).replace(/\.(?:spec|test)\.(?:tsx?|mts|[cm]?js|jsx)$/, '');
  const ownsMatchingModule = readdirSync(owner, { withFileTypes: true }).some(
    (entry) =>
      entry.isFile() &&
      sourceModulePattern.test(entry.name) &&
      basename(entry.name).replace(/\.(?:tsx?|mts|[cm]?js|jsx)$/, '') === ownerModuleName,
  );
  if (!ownsMatchingModule) return [];

  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const problems = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !importHasValueBinding(statement.importClause)
    )
      continue;
    const target = modulePath(file, statement.moduleSpecifier.text);
    if (!target || target.includes('/__tests__/')) continue;
    const targetDirectory = relative(owner, join(target, '..'));
    if (targetDirectory !== '' && !targetDirectory.startsWith('..'))
      problems.push(
        `${relative(root, file)} must not value-import descendant production module ${relative(root, target)}.`,
      );
  }
  return problems;
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
  return mixedOwnerImportProblems(file, pathSegments, testDirectoryIndexes[0], root);
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

    const adjacentSupportRoot = join(web, 'src/ts/react/adjacent-support-self-check');
    const adjacentOwner = join(adjacentSupportRoot, 'owner.ts');
    const adjacentSpec = join(adjacentSupportRoot, '__tests__/owner.spec.ts');
    const adjacentUtils = join(adjacentSupportRoot, 'owner.test-utils.ts');
    const adjacentMocks = join(adjacentSupportRoot, 'owner-mocks.ts');
    const adjacentFixtures = join(adjacentSupportRoot, 'owner.fixtures.ts');
    const adjacentConsumer = join(adjacentSupportRoot, 'consumer.ts');
    const adjacentCycleA = join(adjacentSupportRoot, 'owner.mock.ts');
    const adjacentCycleB = join(adjacentSupportRoot, 'owner.fixture.ts');
    write(adjacentOwner, 'export const helper = 1;');
    write(adjacentUtils, "import { helper } from './owner'; export { helper };");
    write(adjacentMocks, "export { helper } from './owner.test-utils';");
    write(adjacentFixtures, "export { helper } from './owner';");
    write(adjacentCycleA, "export { value } from './owner.fixture';");
    write(
      adjacentCycleB,
      "export { helper as value } from './owner'; export * from './owner.mock';",
    );
    const adjacentSources = [
      adjacentOwner,
      adjacentUtils,
      adjacentMocks,
      adjacentFixtures,
      adjacentCycleA,
      adjacentCycleB,
    ];
    const adjacentSupportFiles = new Set(adjacentSources.filter(isTestSupportModule));
    const classifyAdjacentSupport = () =>
      testOnlyProductionExportsFor({
        testFiles: [adjacentSpec],
        productionFiles: adjacentSources.filter((file) => !adjacentSupportFiles.has(file)),
        sourceFiles: adjacentSources,
        readSource: (candidate) => (existsSync(candidate) ? readFileSync(candidate, 'utf8') : null),
        resolveModule: modulePath,
        testSupportFiles: adjacentSupportFiles,
      });
    write(adjacentSpec, "import { helper } from '../owner.test-utils'; void helper;");
    expect(
      classifyAdjacentSupport().some(
        ({ file, symbol }) => file === adjacentOwner && symbol === 'helper',
      ),
      'adjacent test utility blessed a production export',
    );
    write(adjacentSpec, "import { helper } from '../owner-mocks'; void helper;");
    expect(
      classifyAdjacentSupport().some(
        ({ file, symbol }) => file === adjacentOwner && symbol === 'helper',
      ),
      'transitive adjacent mock did not preserve test demand',
    );
    write(adjacentSpec, "import { helper } from '../owner.fixtures'; void helper;");
    expect(
      classifyAdjacentSupport().some(
        ({ file, symbol }) => file === adjacentOwner && symbol === 'helper',
      ),
      'adjacent fixture blessed a production export',
    );
    write(adjacentConsumer, "import { helper } from './owner'; void helper;");
    adjacentSources.push(adjacentConsumer);
    expect(
      !testOnlyProductionExportsFor({
        testFiles: [adjacentSpec],
        productionFiles: adjacentSources.filter((file) => !isTestSupportModule(file)),
        sourceFiles: adjacentSources,
        readSource: (candidate) => (existsSync(candidate) ? readFileSync(candidate, 'utf8') : null),
        resolveModule: modulePath,
        testSupportFiles: new Set(adjacentSources.filter(isTestSupportModule)),
      }).some(({ file, symbol }) => file === adjacentOwner && symbol === 'helper'),
      'genuine production consumer did not clear adjacent support finding',
    );
    expect(
      productionToTestSupportProblems(
        [adjacentOwner, adjacentConsumer, adjacentUtils],
        new Set([adjacentUtils]),
      ).length === 0,
      'clean production-to-support dependencies failed',
    );
    write(adjacentConsumer, "import { helper } from './owner.test-utils'; void helper;");
    expect(
      productionToTestSupportProblems(
        [adjacentOwner, adjacentConsumer, adjacentUtils],
        new Set([adjacentUtils]),
      ).length === 1,
      'production-to-test-support dependency passed',
    );
    const supportDependencyProblems = (text) => {
      write(adjacentConsumer, text);
      return productionToTestSupportProblems(
        [
          adjacentOwner,
          adjacentConsumer,
          adjacentUtils,
          adjacentMocks,
          adjacentFixtures,
          adjacentCycleA,
          adjacentCycleB,
        ],
        new Set([adjacentUtils, adjacentMocks, adjacentFixtures, adjacentCycleA, adjacentCycleB]),
      );
    };
    for (const [text, message] of [
      ["import { helper } from './owner-mocks'; void helper;", 'named support import passed'],
      ["import './owner-mocks';", 'side-effect support import passed'],
      ["import type { helper } from './owner.test-utils';", 'type-only support import passed'],
      ["void import('./owner.fixture');", 'dynamic support import passed'],
      ["export { helper } from './owner-mocks';", 'named support re-export passed'],
      ["export * from './owner.fixtures';", 'wildcard support re-export passed'],
      ["export * as fixtures from './owner.fixtures';", 'namespace support re-export passed'],
    ])
      expect(supportDependencyProblems(text).length === 1, message);
    write(adjacentConsumer, "import { helper } from './owner'; void helper;");
    expect(
      productionToTestSupportProblems(
        [adjacentOwner, adjacentConsumer, adjacentUtils],
        new Set([adjacentUtils]),
      ).length === 0,
      'clean production dependency failed',
    );
    write(
      adjacentUtils,
      "import { helper } from './owner'; import './owner-mocks'; export { helper };",
    );
    expect(
      productionToTestSupportProblems(
        [adjacentOwner, adjacentConsumer, adjacentUtils, adjacentMocks],
        new Set([adjacentUtils, adjacentMocks]),
      ).length === 0,
      'test-support dependency failed',
    );
    write(adjacentConsumer, "import './owner-mocks'; export { helper } from './owner-mocks';");
    expect(
      supportDependencyProblems(readFileSync(adjacentConsumer, 'utf8')).length === 1,
      'duplicate support dependency was not deduplicated',
    );
    write(adjacentSpec, "import { value } from '../owner.mock'; void value;");
    expect(
      testDependencyDemands(
        [adjacentSpec],
        (candidate) => (existsSync(candidate) ? readFileSync(candidate, 'utf8') : null),
        modulePath,
      ).has(adjacentOwner),
      'adjacent support cycle did not terminate deterministically',
    );

    const declarationFile = join(
      web,
      'src/ts/react/declaration-self-check/__tests__/declarations.spec.ts',
    );
    const declarationProblems = (text, playwright = false) =>
      declarationScopeProblems(text, declarationFile, playwright);
    expect(
      declarationProblems("import { test as check } from 'vitest'; check('missing', () => {});")
        .length === 1,
      'unannotated aliased Vitest test passed',
    );
    expect(
      declarationProblems(
        "import { test as check } from 'vitest'; // @test-scope parser: fixture\ncheck('ok', () => {});",
      ).length === 0,
      'annotated aliased Vitest test failed',
    );
    expect(
      declarationProblems(
        "import { it as verify, test as check } from 'vitest'; // @test-scope parser: fixture\nverify.only('one', () => {}); check.skip('two', () => {}); check.each([1])('three', () => {});",
      ).length === 0,
      'aliased test modifiers were not discovered',
    );
    const aliasedEachSource = ts.createSourceFile(
      declarationFile,
      "import { test as check } from 'vitest'; check.each([1])('one', () => {});",
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      testDeclarations(aliasedEachSource).length === 1,
      'aliased .each was counted more than once',
    );
    expect(
      declarationProblems(
        "import * as vitest from 'vitest'; // @test-scope parser: fixture\nvitest.test('one', () => {}); vitest.it('two', () => {});",
      ).length === 0,
      'namespace Vitest tests were not discovered',
    );
    expect(
      declarationProblems(
        "import { test as scenario } from '@playwright/test'; // @test-scope regression: https://github.com/echoua/echo/issues/1\nscenario.describe('@regression suite', () => scenario('one', () => {}));",
        true,
      ).length === 0,
      'aliased Playwright describe ancestry was not discovered',
    );
    expect(
      declarationProblems(
        "import * as playwright from '@playwright/test'; // @test-scope regression: https://github.com/echoua/echo/issues/1\nplaywright.test('@regression one', () => {});",
        true,
      ).length === 0,
      'namespace Playwright test was not discovered',
    );
    expect(
      declarationProblems(
        "import { test as check } from 'vitest'; // @test-scope parser: fixture\ncheck('outside', () => {}); (() => { const check = () => {}; check('inside'); })();",
      ).length === 0,
      'block-local alias shadow was classified as a test',
    );
    expect(
      testDeclarations(
        ts.createSourceFile(
          declarationFile,
          "import { test as check } from 'vitest'; check('outside', () => {}); function run(check) { check('inside'); }",
          ts.ScriptTarget.Latest,
          true,
        ),
      ).length === 1,
      'parameter-shadowed alias was classified as a test',
    );
    expect(
      testDeclarations(
        ts.createSourceFile(
          declarationFile,
          "import * as vitest from 'vitest'; vitest.test('outside', () => {}); { const vitest = {}; vitest.test('inside', () => {}); }",
          ts.ScriptTarget.Latest,
          true,
        ),
      ).length === 1,
      'shadowed namespace was classified as a test',
    );
    expect(
      testDeclarations(
        ts.createSourceFile(
          declarationFile,
          "import { test as check } from 'vitest'; for (const check of [() => {}]) { check('inside'); } check('outside', () => {});",
          ts.ScriptTarget.Latest,
          true,
        ),
      ).length === 1,
      'loop-shadowed alias was classified as a test',
    );
    expect(
      testDeclarations(
        ts.createSourceFile(
          declarationFile,
          "import { test as check } from 'vitest'; check('outside', () => {}); function run() { if (true) { var check = () => {}; } check('inside'); }",
          ts.ScriptTarget.Latest,
          true,
        ),
      ).length === 1,
      'function-scoped var alias was classified as a test',
    );
    expect(
      testDeclarations(
        ts.createSourceFile(
          declarationFile,
          "if (true) { var test = () => {}; } test('not a test');",
          ts.ScriptTarget.Latest,
          true,
        ),
      ).length === 0,
      'source-scoped var was classified as a global test API',
    );
    expect(
      testDeclarations(
        ts.createSourceFile(
          declarationFile,
          "import { test } from 'other-package'; import type { it } from 'vitest'; test('no'); it('no');",
          ts.ScriptTarget.Latest,
          true,
        ),
      ).length === 0,
      'unrelated or type-only test import was classified as a test',
    );
    expect(
      declarationProblems("const check = () => {}; check('not a test');").length === 0,
      'unrelated local alias was classified as a test',
    );

    const mixedOwnerSpec = join(web, 'src/ts/react/mixed-owner/__tests__/helpers.spec.ts');
    const mixedOwnerComponent = join(
      web,
      'src/ts/react/mixed-owner/components/UnitStatsSidebar.tsx',
    );
    const mixedOwnerSupport = join(web, 'src/ts/react/mixed-owner/__tests__/fixture.ts');
    write(join(web, 'src/ts/react/mixed-owner/helpers.ts'), 'export {};');
    write(mixedOwnerComponent, 'export const UnitStatsSidebar = null;');
    write(mixedOwnerSupport, 'export const fixture = null;');
    write(mixedOwnerSpec, "import { UnitStatsSidebar } from '../components/UnitStatsSidebar';");
    expect(
      placementProblemsFor(mixedOwnerSpec, web).length === 1,
      'owner-level spec importing a descendant production component passed',
    );
    write(
      mixedOwnerSpec,
      "import type { UnitStatsSidebar } from '../components/UnitStatsSidebar';",
    );
    expect(
      placementProblemsFor(mixedOwnerSpec, web).length === 0,
      'type-only descendant import failed placement',
    );
    write(mixedOwnerSpec, "import { fixture } from './fixture'; void fixture;");
    expect(
      placementProblemsFor(mixedOwnerSpec, web).length === 0,
      'test-support import failed placement',
    );
    const componentSpec = join(
      web,
      'src/ts/react/mixed-owner/components/__tests__/UnitStatsSidebar.spec.tsx',
    );
    write(
      componentSpec,
      "import { UnitStatsSidebar } from '../UnitStatsSidebar'; void UnitStatsSidebar;",
    );
    expect(
      placementProblemsFor(componentSpec, web).length === 0,
      'descendant component-owned spec failed placement',
    );

    const playwrightOutsideFixture = join(web, 'src/ts/react/playwright.fixture.ts');
    const playwrightOutsideHelper = join(web, 'src/ts/react/playwright-helper.mjs');
    const playwrightE2eFixture = join(web, 'tests/e2e/support/fixture.ts');
    const playwrightConfig = join(web, 'playwright.config.ts');
    const playwrightMention = join(web, 'src/ts/react/playwright-mention.js');
    write(playwrightOutsideFixture, "import { test } from '@playwright/test'; void test;");
    write(playwrightOutsideHelper, "const test = require('@playwright/test'); void test;");
    write(playwrightE2eFixture, "export { test } from '@playwright/test';");
    write(playwrightConfig, "void import('@playwright/test');");
    write(
      playwrightMention,
      "// @playwright/test\nconst packageName = '@playwright/test'; void packageName;",
    );
    const playwrightProblems = playwrightTestPathProblems(web);
    expect(
      playwrightProblems.some((problem) => problem.includes('playwright.fixture.ts')),
      'outside-E2E fixture Playwright import passed',
    );
    expect(
      playwrightProblems.some((problem) => problem.includes('playwright-helper.mjs')),
      'outside-E2E helper Playwright require passed',
    );
    expect(
      !playwrightProblems.some((problem) => problem.includes('tests/e2e/support/fixture.ts')),
      'E2E fixture Playwright import failed',
    );
    expect(
      !playwrightProblems.some((problem) => problem.includes('playwright.config.ts')),
      'Playwright config import failed',
    );
    expect(
      !playwrightProblems.some((problem) => problem.includes('playwright-mention.js')),
      'Playwright comment or string literal failed',
    );

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

    const expectSymbols = (source, expected, message) => {
      const actual = [...exportedSymbolsFromText(dynamicFile, source)].sort();
      expect(JSON.stringify(actual) === JSON.stringify(expected), message);
    };
    expectSymbols(
      'export default function Named() {}',
      ['default'],
      'named default function leaked',
    );
    expectSymbols(
      'export default function () {}',
      ['default'],
      'anonymous default function failed',
    );
    expectSymbols('export default class Named {}', ['default'], 'named default class leaked');
    expectSymbols('export default class {}', ['default'], 'anonymous default class failed');
    expectSymbols(
      'const value = 1; export default value;',
      ['default'],
      'default identifier failed',
    );
    expectSymbols('export default 1 + 2;', ['default'], 'default expression failed');
    expectSymbols(
      'const value = 1; export { value as default };',
      ['default'],
      'default re-export failed',
    );
    expectSymbols(
      'export function named() {} export class Named {} export const value = 1;',
      ['Named', 'named', 'value'],
      'ordinary named exports changed',
    );
    expectSymbols(
      'const value = 1; export = value;',
      [],
      'export assignment became a default export',
    );
    expectSymbols('export enum Status { Active }', ['Status'], 'exported enum was not collected');
    expectSymbols(
      'export interface Contract { id: string }',
      ['Contract'],
      'interface was not collected',
    );
    expectSymbols(
      'export type Identifier = string;',
      ['Identifier'],
      'type alias was not collected',
    );
    expectSymbols(
      'export namespace Api { export const version = 1; }',
      ['Api'],
      'namespace was not collected',
    );
    expectSymbols(
      'export declare enum DeclaredEnum { Value } export declare interface DeclaredInterface {} export declare type DeclaredType = string;',
      ['DeclaredEnum', 'DeclaredInterface', 'DeclaredType'],
      'declared exports were not collected',
    );
    expectSymbols(
      'export default enum DefaultStatus { Active }',
      ['default'],
      'default enum leaked',
    );
    expectSymbols(
      'const value = { first: 1, nested: { second: 2 } }; export const { first, nested: { second } } = value; export const [third, fourth] = [3, 4];',
      ['first', 'fourth', 'second', 'third'],
      'destructured exported variables were not collected',
    );
    const defaultOwner = join(web, 'src/ts/react/default-owner/DefaultOwner.ts');
    const defaultSpec = join(web, 'src/ts/react/default-owner/__tests__/DefaultOwner.spec.ts');
    write(defaultOwner, 'export default function DefaultOwner() {}');
    write(defaultSpec, "import DefaultOwner from '../DefaultOwner.ts';\nvoid DefaultOwner;");
    const importedDefault = consumedSymbols(defaultSpec)[0]?.symbols;
    const exportedDefault = exportedSymbols(defaultOwner);
    expect(
      importedDefault?.has('default') && exportedDefault.has('default'),
      'default imports and exports did not intersect',
    );

    const barrelRoot = join(web, 'src/ts/react/barrel-self-check');
    const leaf = join(barrelRoot, 'leaf.ts');
    const barrel = join(barrelRoot, 'barrel.ts');
    const top = join(barrelRoot, 'top.ts');
    const named = join(barrelRoot, 'named.ts');
    const namespace = join(barrelRoot, 'namespace.ts');
    const cycleA = join(barrelRoot, 'cycle-a.ts');
    const cycleB = join(barrelRoot, 'cycle-b.ts');
    const missing = join(barrelRoot, 'missing.ts');
    const barrelSpec = join(barrelRoot, '__tests__/barrel.spec.ts');
    const barrelConsumer = join(barrelRoot, 'barrel-consumer.ts');
    const topConsumer = join(barrelRoot, 'top-consumer.ts');
    write(leaf, 'export const inherited = 1; export const branchOnly = 2; export default 3;');
    write(barrel, "export * from './leaf';");
    write(top, "export * from './barrel';");
    write(named, 'const value = 1; export { value as renamed };');
    write(namespace, "export * as api from './leaf';");
    write(cycleA, "export * from './cycle-b'; export const a = 1;");
    write(cycleB, "export * from './cycle-a'; export const b = 1;");
    write(missing, "export * from './absent';");
    const readCurrent = (candidate) =>
      existsSync(candidate) && statSync(candidate).isFile()
        ? readFileSync(candidate, 'utf8')
        : null;
    const resolveBarrel = (file) => effectiveExportedSymbols(file, readCurrent);
    expect(
      JSON.stringify([...resolveBarrel(barrel)].sort()) ===
        JSON.stringify(['branchOnly', 'inherited']),
      'one-level wildcard export failed',
    );
    expect(
      JSON.stringify([...resolveBarrel(top)].sort()) ===
        JSON.stringify(['branchOnly', 'inherited']),
      'transitive wildcard export failed',
    );
    expect(!resolveBarrel(top).has('default'), 'wildcard export propagated default');
    expect(resolveBarrel(named).has('renamed'), 'named re-export failed');
    expect(resolveBarrel(namespace).has('api'), 'namespace re-export failed');
    expect(
      JSON.stringify([...resolveBarrel(cycleA)].sort()) === JSON.stringify(['a', 'b']),
      'circular barrels did not terminate deterministically',
    );
    expect(
      (() => {
        try {
          resolveBarrel(missing);
          return false;
        } catch {
          return true;
        }
      })(),
      'missing wildcard target passed',
    );
    const productionFiles = [leaf, barrel, top, named, namespace, cycleA, cycleB, missing];
    const sourceFiles = () =>
      productionFiles.concat([barrelConsumer, topConsumer].filter((file) => existsSync(file)));
    const classify = () =>
      testOnlyProductionExportsFor({
        testFiles: [barrelSpec],
        productionFiles,
        sourceFiles: sourceFiles(),
        readSource: readCurrent,
        resolveModule: modulePath,
      });
    const baseSources = new Map([
      [leaf, 'export const inherited = 1; export default 3;'],
      [barrel, "export * from './leaf';"],
      [top, "export * from './barrel';"],
    ]);
    const baseExports = (file) =>
      effectiveExportedSymbols(file, (candidate) => baseSources.get(candidate) ?? null);
    const introducedExports = (file) =>
      classify().filter(
        ({ file: exportFile, symbol }) => exportFile === file && !baseExports(file).has(symbol),
      );
    write(
      barrelSpec,
      "import { inherited, branchOnly } from '../barrel';\nvoid inherited; void branchOnly;",
    );
    expect(baseExports(barrel).has('inherited'), 'base barrel export was not inherited');
    expect(
      introducedExports(barrel).length === 0,
      `production top-barrel re-export did not clear barrel exports: ${JSON.stringify(
        introducedExports(barrel).map(({ file, symbol }) => `${basename(file, '.ts')}::${symbol}`),
      )}`,
    );
    write(barrelConsumer, "import { branchOnly } from './barrel';\nvoid branchOnly;");
    expect(
      !classify().some(({ file, symbol }) => file === barrel && symbol === 'branchOnly'),
      'production barrel consumer did not clear test-only export',
    );
    rmSync(barrelConsumer);
    write(
      barrelSpec,
      "import { inherited, branchOnly } from '../top';\nvoid inherited; void branchOnly;",
    );
    expect(baseExports(top).has('inherited'), 'base top-barrel export was not inherited');
    expect(
      JSON.stringify(
        introducedExports(top).map(({ file, symbol }) => `${basename(file, '.ts')}::${symbol}`),
      ) === JSON.stringify(['top::branchOnly']),
      'test-only top-barrel export was not classified as introduced',
    );
    write(topConsumer, "import { branchOnly } from './top';\nvoid branchOnly;");
    expect(
      !classify().some(({ file, symbol }) => file === top && symbol === 'branchOnly'),
      'production top-barrel consumer did not clear test-only export',
    );

    const indirectRoot = join(web, 'src/ts/react/indirect-self-check');
    const indirectOwner = join(indirectRoot, 'owner.ts');
    const fixture = join(indirectRoot, '__tests__/fixture.ts');
    const nestedFixture = join(indirectRoot, '__tests__/nested-fixture.ts');
    const indirectCycleA = join(indirectRoot, '__tests__/cycle-a.ts');
    const indirectCycleB = join(indirectRoot, '__tests__/cycle-b.ts');
    const indirectSpec = join(indirectRoot, '__tests__/owner.spec.ts');
    const indirectConsumer = join(indirectRoot, 'consumer.ts');
    write(
      indirectOwner,
      'export function internallyUsed() { return 1; } internallyUsed(); export function recursive() { return recursive(); }',
    );
    write(
      fixture,
      "import { internallyUsed, recursive } from '../owner'; export const fixtureValue = [internallyUsed, recursive];",
    );
    write(nestedFixture, "import { fixtureValue } from './fixture'; export { fixtureValue };");
    write(
      indirectCycleA,
      "import { cycleBValue } from './cycle-b'; export const cycleAValue = cycleBValue;",
    );
    write(
      indirectCycleB,
      "import { internallyUsed } from '../owner'; import { cycleAValue } from './cycle-a'; export const cycleBValue = [internallyUsed, cycleAValue];",
    );
    const indirectSupportFiles = new Set([fixture, nestedFixture, indirectCycleA, indirectCycleB]);
    const classifyIndirect = () =>
      testOnlyProductionExportsFor({
        testFiles: [indirectSpec],
        productionFiles: [indirectOwner],
        sourceFiles: [indirectOwner, ...indirectSupportFiles, indirectConsumer].filter((file) =>
          existsSync(file),
        ),
        readSource: readCurrent,
        resolveModule: modulePath,
        testSupportFiles: indirectSupportFiles,
      });
    const expectIndirectSymbols = (expected, message) =>
      expect(
        JSON.stringify(
          classifyIndirect()
            .map(({ symbol }) => symbol)
            .sort(),
        ) === JSON.stringify(expected),
        message,
      );
    write(indirectSpec, "import { fixtureValue } from './fixture';\nvoid fixtureValue;");
    expectIndirectSymbols(
      ['internallyUsed', 'recursive'],
      'spec through fixture did not detect production exports',
    );
    write(indirectSpec, "import { fixtureValue } from './nested-fixture';\nvoid fixtureValue;");
    expectIndirectSymbols(
      ['internallyUsed', 'recursive'],
      'spec through nested fixture did not detect production exports',
    );
    write(indirectSpec, "import { cycleAValue } from './cycle-a';\nvoid cycleAValue;");
    expect(
      testDependencyDemands([indirectSpec], readCurrent, modulePath).size === 4,
      'cyclic fixture imports did not terminate deterministically',
    );
    expectIndirectSymbols(
      ['internallyUsed'],
      'cyclic fixture import did not detect production export',
    );
    write(indirectSpec, "import { fixtureValue } from './fixture';\nvoid fixtureValue;");
    write(indirectConsumer, "import { internallyUsed } from './owner';\nvoid internallyUsed;");
    expectIndirectSymbols(
      ['recursive'],
      'production consumer did not clear only its consumed export',
    );

    const reExportRoot = join(web, 'src/ts/react/re-export-self-check');
    const reExportOwner = join(reExportRoot, 'owner.ts');
    const reExportFixture = join(reExportRoot, '__tests__/fixture.ts');
    const aliasFixture = join(reExportRoot, '__tests__/alias-fixture.ts');
    const wildcardFixture = join(reExportRoot, '__tests__/wildcard-fixture.ts');
    const namespaceFixture = join(reExportRoot, '__tests__/namespace-fixture.ts');
    const nestedFixtureA = join(reExportRoot, '__tests__/nested-a.ts');
    const nestedFixtureB = join(reExportRoot, '__tests__/nested-b.ts');
    const reExportCycleA = join(reExportRoot, '__tests__/cycle-a.ts');
    const reExportCycleB = join(reExportRoot, '__tests__/cycle-b.ts');
    const assetFixture = join(reExportRoot, '__tests__/asset-fixture.ts');
    const asset = join(reExportRoot, '__tests__/fixture.css');
    const reExportSpec = join(reExportRoot, '__tests__/owner.spec.ts');
    const reExportConsumer = join(reExportRoot, 'consumer.ts');
    write(reExportOwner, 'export const helper = 1; export const unusedHelper = 2;');
    write(reExportFixture, "export { helper } from '../owner';");
    write(aliasFixture, "export { helper as fixtureHelper } from '../owner';");
    write(wildcardFixture, "export * from '../owner';");
    write(namespaceFixture, "export * as helpers from '../owner';");
    write(nestedFixtureA, "export { helper } from './nested-b';");
    write(nestedFixtureB, "export { helper } from '../owner';");
    write(reExportCycleA, "export { helper } from './cycle-b';");
    write(reExportCycleB, "export { helper } from '../owner'; export * from './cycle-a';");
    write(asset, 'fixture asset');
    write(assetFixture, "import './fixture.css'; export { helper } from '../owner';");
    const reExportSupportFiles = new Set([
      reExportFixture,
      aliasFixture,
      wildcardFixture,
      namespaceFixture,
      nestedFixtureA,
      nestedFixtureB,
      reExportCycleA,
      reExportCycleB,
      assetFixture,
    ]);
    const classifyReExport = () =>
      testOnlyProductionExportsFor({
        testFiles: [reExportSpec],
        productionFiles: [reExportOwner],
        sourceFiles: [reExportOwner, ...reExportSupportFiles, reExportConsumer].filter((file) =>
          existsSync(file),
        ),
        readSource: readCurrent,
        resolveModule: modulePath,
        testSupportFiles: reExportSupportFiles,
      });
    const expectReExportSymbols = (expected, message) =>
      expect(
        JSON.stringify(
          classifyReExport()
            .map(({ symbol }) => symbol)
            .sort(),
        ) === JSON.stringify(expected),
        message,
      );
    write(reExportSpec, "import { helper } from './fixture';\nvoid helper;");
    expectReExportSymbols(['helper'], 'direct fixture re-export did not detect production helper');
    write(reExportSpec, "import { fixtureHelper } from './alias-fixture';\nvoid fixtureHelper;");
    expectReExportSymbols(['helper'], 'aliased fixture re-export did not preserve helper identity');
    write(reExportSpec, "import { helper } from './wildcard-fixture';\nvoid helper;");
    expectReExportSymbols(['helper'], 'wildcard fixture re-export included unrelated exports');
    write(reExportSpec, "import * as helpers from './namespace-fixture';\nvoid helpers;");
    expectReExportSymbols(
      ['helper', 'unusedHelper'],
      'namespace fixture re-export did not propagate wildcard demand',
    );
    write(reExportSpec, "import { helper } from './nested-a';\nvoid helper;");
    expectReExportSymbols(['helper'], 'nested fixture re-exports did not detect production helper');
    write(reExportSpec, "import { helper } from './cycle-a';\nvoid helper;");
    expectReExportSymbols(['helper'], 'cyclic fixture re-exports did not propagate helper');
    write(reExportSpec, "import { helper } from './asset-fixture';\nvoid helper;");
    expect(
      !testDependencyDemands([reExportSpec], readCurrent, modulePath).has(asset),
      'relative asset import was traversed as source',
    );
    expectReExportSymbols(['helper'], 'asset fixture re-export did not detect production helper');
    write(reExportConsumer, "import { helper } from './owner';\nvoid helper;");
    expectReExportSymbols([], 'production consumer did not clear re-exported helper');

    const productionReExportRoot = join(web, 'src/ts/react/production-re-export-self-check');
    const productionOwner = join(productionReExportRoot, 'owner.ts');
    const productionSpec = join(productionReExportRoot, '__tests__/owner.spec.ts');
    const namedBarrel = join(productionReExportRoot, 'named-barrel.ts');
    const aliasBarrel = join(productionReExportRoot, 'alias-barrel.ts');
    const defaultBarrel = join(productionReExportRoot, 'default-barrel.ts');
    const defaultAliasBarrel = join(productionReExportRoot, 'default-alias-barrel.ts');
    const wildcardBarrel = join(productionReExportRoot, 'wildcard-barrel.ts');
    const namespaceBarrel = join(productionReExportRoot, 'namespace-barrel.ts');
    const nestedInnerBarrel = join(productionReExportRoot, 'nested-inner-barrel.ts');
    const nestedOuterBarrel = join(productionReExportRoot, 'nested-outer-barrel.ts');
    const localExport = join(productionReExportRoot, 'local-export.ts');
    const supportBarrel = join(productionReExportRoot, '__tests__/support-barrel.ts');
    write(
      productionOwner,
      'export const helper = 1; export const unusedHelper = 2; export default function owner() {}',
    );
    write(namedBarrel, "export { helper } from './owner';");
    write(aliasBarrel, "export { helper as publicHelper } from './owner';");
    write(defaultBarrel, "export { default } from './owner';");
    write(defaultAliasBarrel, "export { default as PublicOwner } from './owner';");
    write(wildcardBarrel, "export * from './owner';");
    write(namespaceBarrel, "export * as ownerApi from './owner';");
    write(nestedInnerBarrel, "export { helper } from './owner';");
    write(nestedOuterBarrel, "export { helper } from './nested-inner-barrel';");
    write(localExport, 'const helper = 1; export { helper };');
    write(supportBarrel, "export { helper } from '../owner';");
    const classifyProductionReExport = (specText, sourceFiles, testSupportFiles = new Set()) => {
      write(productionSpec, specText);
      return testOnlyProductionExportsFor({
        testFiles: [productionSpec],
        productionFiles: [productionOwner],
        sourceFiles,
        readSource: readCurrent,
        resolveModule: modulePath,
        testSupportFiles,
      });
    };
    const reportsProductionSymbol = (specText, sourceFiles, symbol, testSupportFiles) =>
      classifyProductionReExport(specText, sourceFiles, testSupportFiles).some(
        ({ file, symbol: exported }) => file === productionOwner && exported === symbol,
      );
    const helperSpec = "import { helper } from '../owner';\nvoid helper;";
    const defaultSpecText = "import Owner from '../owner';\nvoid Owner;";
    expect(
      !reportsProductionSymbol(helperSpec, [productionOwner, namedBarrel], 'helper'),
      'production named re-export did not clear helper',
    );
    expect(
      !reportsProductionSymbol(helperSpec, [productionOwner, aliasBarrel], 'helper'),
      'production alias re-export did not clear original helper',
    );
    expect(
      !reportsProductionSymbol(defaultSpecText, [productionOwner, defaultBarrel], 'default'),
      'production default re-export did not clear default',
    );
    expect(
      !reportsProductionSymbol(defaultSpecText, [productionOwner, defaultAliasBarrel], 'default'),
      'production default alias re-export did not clear default',
    );
    expect(
      !reportsProductionSymbol(helperSpec, [productionOwner, wildcardBarrel], 'helper') &&
        reportsProductionSymbol(defaultSpecText, [productionOwner, wildcardBarrel], 'default'),
      'production wildcard re-export did not preserve default exclusion',
    );
    expect(
      !reportsProductionSymbol(defaultSpecText, [productionOwner, namespaceBarrel], 'default'),
      'production namespace re-export did not clear target API',
    );
    expect(
      !reportsProductionSymbol(
        helperSpec,
        [productionOwner, nestedInnerBarrel, nestedOuterBarrel],
        'helper',
      ),
      'nested production re-exports did not clear helper',
    );
    expect(
      reportsProductionSymbol(helperSpec, [productionOwner, localExport], 'helper'),
      'local export without module specifier cleared production helper',
    );
    expect(
      reportsProductionSymbol(
        helperSpec,
        [productionOwner, supportBarrel],
        'helper',
        new Set([supportBarrel]),
      ),
      'test-support re-export cleared production helper',
    );
    expect(
      reportsProductionSymbol(helperSpec, [productionOwner], 'helper'),
      'removing production re-export did not restore helper finding',
    );

    const typeRoot = join(web, 'src/ts/react/type-self-check');
    const typeOwner = join(typeRoot, 'owner.ts');
    const typeSpec = join(typeRoot, '__tests__/owner.spec.ts');
    const typeConsumer = join(typeRoot, 'consumer.ts');
    const typeNamedBarrel = join(typeRoot, 'named-barrel.ts');
    const typeWildcardBarrel = join(typeRoot, 'wildcard-barrel.ts');
    write(
      typeOwner,
      'export interface Contract { id: string } export type Alias = string; export enum Kind { One } export namespace Api { export const version = 1; }',
    );
    write(
      typeSpec,
      "import type { Contract } from '../owner';\nconst value: Contract = { id: '1' }; void value;",
    );
    const classifyTypeExports = (sourceFiles) =>
      testOnlyProductionExportsFor({
        testFiles: [typeSpec],
        productionFiles: [typeOwner],
        sourceFiles,
        readSource: readCurrent,
        resolveModule: modulePath,
      });
    expect(
      classifyTypeExports([typeOwner]).some(({ symbol }) => symbol === 'Contract'),
      'type-only test import did not detect interface export',
    );
    write(
      typeConsumer,
      "import type { Contract } from './owner';\nconst value: Contract = { id: '1' }; void value;",
    );
    expect(
      !classifyTypeExports([typeOwner, typeConsumer]).some(({ symbol }) => symbol === 'Contract'),
      'production type-only import did not clear interface export',
    );
    rmSync(typeConsumer);
    write(typeNamedBarrel, "export type { Contract } from './owner';");
    expect(
      !classifyTypeExports([typeOwner, typeNamedBarrel]).some(
        ({ symbol }) => symbol === 'Contract',
      ),
      'named production type re-export did not clear interface export',
    );
    write(typeWildcardBarrel, "export * from './owner';");
    expect(
      !classifyTypeExports([typeOwner, typeWildcardBarrel]).some(
        ({ symbol }) => symbol === 'Contract',
      ),
      'wildcard production type re-export did not clear interface export',
    );
    const baseTypeSources = new Map([[typeOwner, 'export interface Contract { id: string }']]);
    expect(
      effectiveExportedSymbols(
        typeOwner,
        (candidate) => baseTypeSources.get(candidate) ?? null,
      ).has('Contract'),
      'base type export was not preserved as inherited debt',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function consumedSymbolsFromText(file, sourceText, resolveModule) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const imports = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveModule(file, statement.moduleSpecifier.text);
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
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const target = resolveModule(file, node.arguments[0].text);
      if (target) imports.push({ target, symbols: new Set(['*']) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return imports;
}

function localModuleDependenciesFromText(file, sourceText, resolveModule) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const targets = new Set();
  const add = (specifier) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const target = resolveModule(file, specifier.text);
    if (target) targets.add(target);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
}

function reExportDependenciesFromText(file, sourceText, resolveModule) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const dependencies = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const target = resolveModule(file, statement.moduleSpecifier.text);
    if (!target) continue;
    if (!statement.exportClause) {
      dependencies.push({ target, type: 'wildcard' });
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      dependencies.push({ target, type: 'namespace', exposed: statement.exportClause.name.text });
      continue;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      const symbols = new Map();
      for (const element of statement.exportClause.elements)
        symbols.set(element.name.text, element.propertyName?.text ?? element.name.text);
      dependencies.push({ target, type: 'named', symbols });
    }
  }
  return dependencies;
}

function consumedSymbols(file) {
  return consumedSymbolsFromText(file, readFileSync(file, 'utf8'), modulePath);
}

function directExportsFromText(file, sourceText) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const symbols = new Set();
  const wildcardSpecifiers = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) symbols.add('default');
      continue;
    }
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      symbols.add('default');
      continue;
    }
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (
      exported &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name
    )
      symbols.add(statement.name.text);
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        bindingIdentifiers(declaration.name).forEach((name) => symbols.add(name));
    }
    if (ts.isExportDeclaration(statement) && !statement.exportClause && statement.moduleSpecifier) {
      wildcardSpecifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) symbols.add(element.name.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamespaceExport(statement.exportClause)
    )
      symbols.add(statement.exportClause.name.text);
  }
  return { symbols, wildcardSpecifiers };
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name))
    return name.elements.flatMap((element) => bindingIdentifiers(element.name));
  if (ts.isArrayBindingPattern(name))
    return name.elements.flatMap((element) =>
      ts.isBindingElement(element) ? bindingIdentifiers(element.name) : [],
    );
  return [];
}

function exportedSymbolsFromText(file, sourceText) {
  return directExportsFromText(file, sourceText).symbols;
}

function moduleCandidates(fromFile, moduleSpecifier) {
  if (!moduleSpecifier.startsWith('.')) return [];
  const basePath = join(fromFile, '..', moduleSpecifier);
  return [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
    join(basePath, 'index.mts'),
    join(basePath, 'index.js'),
    join(basePath, 'index.jsx'),
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
  ];
}

function effectiveExportedSymbols(file, readSource) {
  const cache = new Map();
  const resolving = new Set();
  const resolve = (current) => {
    if (cache.has(current)) return cache.get(current);
    if (resolving.has(current)) return new Set();
    const sourceText = readSource(current);
    if (sourceText === null)
      throw new Error(`Cannot resolve export source ${relative(repoRoot, current)}`);
    resolving.add(current);
    const { symbols, wildcardSpecifiers } = directExportsFromText(current, sourceText);
    for (const specifier of wildcardSpecifiers) {
      const target = moduleCandidates(current, specifier).find(
        (candidate) => sourceModulePattern.test(candidate) && readSource(candidate) !== null,
      );
      if (!target)
        throw new Error(
          `${relative(repoRoot, current)} has unresolved relative wildcard export ${specifier}`,
        );
      const inherited = new Set(resolve(target));
      inherited.delete('default');
      inherited.forEach((symbol) => symbols.add(symbol));
    }
    resolving.delete(current);
    cache.set(current, symbols);
    return symbols;
  };
  return resolve(file);
}

function exportedSymbols(file) {
  return effectiveExportedSymbols(file, (candidate) =>
    existsSync(candidate) && statSync(candidate).isFile() ? readFileSync(candidate, 'utf8') : null,
  );
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
  if (gitOutput(['show', `${base}:${relative(repoRoot, file)}`]) === null) return new Set();
  return effectiveExportedSymbols(file, (candidate) =>
    gitOutput(['show', `${base}:${relative(repoRoot, candidate)}`]),
  );
}

function testDependencyDemands(rootFiles, readSource, resolveModule) {
  const demandsByFile = new Map();
  const queued = new Set();
  const queue = [];
  const enqueue = (file, symbols = []) => {
    const demands = demandsByFile.get(file) ?? new Set();
    const isNewFile = !demandsByFile.has(file);
    const size = demands.size;
    symbols.forEach((symbol) => demands.add(symbol));
    demandsByFile.set(file, demands);
    if (!queued.has(file) && (isNewFile || demands.size !== size)) {
      queued.add(file);
      queue.push(file);
    }
  };
  rootFiles.forEach((file) => enqueue(file));
  while (queue.length > 0) {
    const file = queue.shift();
    queued.delete(file);
    const sourceText = readSource(file);
    if (sourceText === null) continue;
    for (const { target, symbols } of consumedSymbolsFromText(file, sourceText, resolveModule))
      enqueue(target, symbols);
    const demands = demandsByFile.get(file) ?? new Set();
    for (const dependency of reExportDependenciesFromText(file, sourceText, resolveModule)) {
      if (dependency.type === 'wildcard') {
        enqueue(
          dependency.target,
          [...demands].filter((symbol) => symbol !== 'default'),
        );
      }
      if (dependency.type === 'namespace' && (demands.has('*') || demands.has(dependency.exposed)))
        enqueue(dependency.target, ['*']);
      if (dependency.type === 'named') {
        enqueue(
          dependency.target,
          [...dependency.symbols]
            .filter(([exposed]) => demands.has('*') || demands.has(exposed))
            .map(([, original]) => original),
        );
      }
    }
  }
  return demandsByFile;
}

function addConsumedImports(importsByFile, importsByTarget) {
  for (const imports of importsByFile.values()) {
    for (const { target, symbols } of imports) {
      const imported = importsByTarget.get(target) ?? new Set();
      symbols.forEach((symbol) => imported.add(symbol));
      importsByTarget.set(target, imported);
    }
  }
}

function productionReExportSymbols(file, sourceText, resolveModule, readSource) {
  const imports = [];
  for (const dependency of reExportDependenciesFromText(file, sourceText, resolveModule)) {
    if (dependency.type === 'named') {
      imports.push({ target: dependency.target, symbols: new Set(dependency.symbols.values()) });
      continue;
    }
    const symbols = effectiveExportedSymbols(dependency.target, readSource);
    if (dependency.type === 'wildcard') symbols.delete('default');
    imports.push({ target: dependency.target, symbols });
  }
  return imports;
}

function testOnlyProductionExportsFor({
  testFiles,
  productionFiles,
  sourceFiles,
  readSource,
  resolveModule,
  testSupportFiles = new Set(),
}) {
  const testImports = new Map();
  const productionImports = new Map();
  testDependencyDemands(testFiles, readSource, resolveModule).forEach((symbols, file) => {
    if (symbols.size > 0) testImports.set(file, symbols);
  });
  for (const file of sourceFiles) {
    if (testSupportFiles.has(file)) continue;
    const sourceText = readSource(file);
    addConsumedImports(
      new Map([
        [
          file,
          [
            ...consumedSymbolsFromText(file, sourceText, resolveModule),
            ...productionReExportSymbols(file, sourceText, resolveModule, readSource),
          ],
        ],
      ]),
      productionImports,
    );
  }
  return productionFiles.flatMap((file) => {
    const usedByTests = testImports.get(file);
    if (!usedByTests) return [];
    const usedByProduction = productionImports.get(file) ?? new Set();
    return [...effectiveExportedSymbols(file, readSource)]
      .filter(
        (symbol) =>
          (usedByTests.has('*') || usedByTests.has(symbol)) &&
          !usedByProduction.has('*') &&
          !usedByProduction.has(symbol),
      )
      .map((symbol) => ({ file, symbol }));
  });
}

function testOnlyProductionExports(testFiles) {
  const allProductionFiles = walk(
    join(webRoot, 'src', 'ts', 'react'),
    /\.(?:tsx?|mts|[cm]?js|jsx)$/,
  ).filter((file) => !testFilePattern.test(file));
  const testSupportFiles = new Set(allProductionFiles.filter(isTestSupportModule));
  const productionFiles = allProductionFiles.filter((file) => !testSupportFiles.has(file));
  const sourceFiles = walk(join(webRoot, 'src'), /\.(?:tsx?|mts|[cm]?js|jsx)$/).filter(
    (file) => !testFilePattern.test(file),
  );
  return testOnlyProductionExportsFor({
    testFiles,
    productionFiles,
    sourceFiles,
    readSource: (file) =>
      existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null,
    resolveModule: modulePath,
    testSupportFiles,
  });
}

function inheritedTestOnlyExportBaseline(testFiles, base) {
  const allReactFiles = walk(
    join(webRoot, 'src', 'ts', 'react'),
    /\.(?:tsx?|mts|[cm]?js|jsx)$/,
  ).filter((file) => !testFilePattern.test(file));
  const testSupportFiles = new Set(allReactFiles.filter((file) => file.includes('/__tests__/')));
  const productionFiles = allReactFiles.filter((file) => !testSupportFiles.has(file));
  return testOnlyProductionExportsFor({
    testFiles,
    productionFiles,
    sourceFiles: allReactFiles,
    readSource: (file) =>
      existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null,
    resolveModule: modulePath,
    testSupportFiles,
  }).filter(({ file, symbol }) => baseExportedSymbols(file, base).has(symbol)).length;
}

function productionToTestSupportProblems(sourceFiles, testSupportFiles) {
  const problems = new Set();
  for (const file of sourceFiles) {
    if (testSupportFiles.has(file)) continue;
    const sourceText = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (sourceText === null) continue;
    for (const target of localModuleDependenciesFromText(file, sourceText, modulePath)) {
      if (testSupportFiles.has(target))
        problems.add(
          `${relative(webRoot, file)} must not import test-support module ${relative(webRoot, target)}.`,
        );
    }
  }
  return [...problems];
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
const allSourceFiles = walk(join(webRoot, 'src', 'ts', 'react'), /\.(?:tsx?|mts|[cm]?js|jsx)$/);
const testSupportFiles = new Set(allSourceFiles.filter(isTestSupportModule));
invalidAnnotations.push(...productionToTestSupportProblems(allSourceFiles, testSupportFiles));
let inheritedTestOnlyExports = 0;
if (exportBase) {
  try {
    const testOnlyExports = testOnlyProductionExports(testFiles, exportBase);
    inheritedTestOnlyExports = inheritedTestOnlyExportBaseline(testFiles, exportBase);
    for (const { file, symbol } of testOnlyExports) {
      if (!baseExportedSymbols(file, exportBase).has(symbol))
        invalidAnnotations.push(`${relative(webRoot, file)} exports ${symbol} for test-only use`);
    }
  } catch (error) {
    invalidAnnotations.push(error.message);
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
