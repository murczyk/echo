/**
 * @vitest-environment happy-dom
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calculateVisibleItemCount, MrtOverflowItems, MrtOverflowText } from './mrt-overflow';
import {
  assertMrtColumnPolicies,
  mrtCustomCell,
  toMrtScalarText,
  validateMrtColumnPolicies,
} from './get-default-table-options';

type ColumnPolicy = {
  mode: 'text' | 'items' | 'wrap' | 'custom' | 'none';
  factory?: 'mrtTextCell' | 'mrtItemsCell' | 'mrtCustomCell';
  owner?: 'shared-text' | 'domain-hover' | 'structured-layout';
};

const SHARED_TEXT_HELPERS = [
  {
    file: 'src/ts/react/routes/admin-directions-neo/index.tsx',
    id: 'datasource',
    helper: 'renderDatasourceCell',
  },
  {
    file: 'src/ts/react/routes/rer-palitra-neo/components/PalitraTable.cells.tsx',
    id: 'name',
    helper: 'renderNameCell',
  },
] as const;

function containsMrtOverflowTextRender(node: ts.Node): boolean {
  let containsRender = false;
  const inspect = (candidate: ts.Node, isRoot = false) => {
    if (!isRoot && ts.isFunctionLike(candidate)) return;
    if (
      (ts.isJsxSelfClosingElement(candidate) || ts.isJsxOpeningElement(candidate)) &&
      ts.isIdentifier(candidate.tagName) &&
      candidate.tagName.text === 'MrtOverflowText'
    ) {
      containsRender = true;
      return;
    }
    if (
      ts.isCallExpression(candidate) &&
      ((ts.isIdentifier(candidate.expression) && candidate.expression.text === 'MrtOverflowText') ||
        (ts.isIdentifier(candidate.expression) &&
          candidate.expression.text === 'createElement' &&
          ts.isIdentifier(candidate.arguments[0]) &&
          candidate.arguments[0].text === 'MrtOverflowText'))
    ) {
      containsRender = true;
      return;
    }
    ts.forEachChild(candidate, (child) => inspect(child));
  };
  inspect(node, true);
  return containsRender;
}

function helperBodyContainsMrtOverflowText(fileSource: string, helperName: string) {
  const source = ts.createSourceFile('helper.tsx', fileSource, ts.ScriptTarget.Latest, true);
  const helpers: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === helperName) helpers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (helpers.length !== 1 || !helpers[0].body) return false;

  return containsMrtOverflowTextRender(helpers[0].body);
}

function cellCallsHelper(cellSource: string, helperName: string) {
  const source = ts.createSourceFile(
    'cell.tsx',
    `const cell = ${cellSource};`,
    ts.ScriptTarget.Latest,
    true,
  );
  let callsHelper = false;
  const inspect = (node: ts.Node, enteredRenderer = false) => {
    if (ts.isFunctionLike(node)) {
      if (enteredRenderer) return;
      inspect(node.body, true);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === helperName
    ) {
      callsHelper = true;
      return;
    }
    ts.forEachChild(node, (child) => inspect(child, enteredRenderer));
  };
  const declaration = source.statements.find(ts.isVariableStatement);
  const initializer = declaration?.declarationList.declarations[0]?.initializer;
  if (!initializer) return false;
  inspect(initializer);
  return callsHelper;
}

function cellContainsMrtOverflowTextRender(cellSource: string) {
  const source = ts.createSourceFile(
    'cell.tsx',
    `const cell = ${cellSource};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(ts.isVariableStatement);
  const initializer = declaration?.declarationList.declarations[0]?.initializer;
  if (!initializer) return false;

  let containsRender = false;
  const inspect = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      containsRender ||= containsMrtOverflowTextRender(node.body);
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(initializer);
  return containsRender;
}

function customInventoryViolations(expected: readonly string[], actual: readonly string[]) {
  const expectedCounts = new Map<string, number>();
  const actualCounts = new Map<string, number>();
  for (const entry of expected) expectedCounts.set(entry, (expectedCounts.get(entry) ?? 0) + 1);
  for (const entry of actual) actualCounts.set(entry, (actualCounts.get(entry) ?? 0) + 1);

  return [...new Set([...expectedCounts.keys(), ...actualCounts.keys()])]
    .sort()
    .flatMap((entry) => {
      const missing = Math.max(
        0,
        (expectedCounts.get(entry) ?? 0) - (actualCounts.get(entry) ?? 0),
      );
      const unexpected = Math.max(
        0,
        (actualCounts.get(entry) ?? 0) - (expectedCounts.get(entry) ?? 0),
      );
      return [
        ...Array.from({ length: missing }, () => `missing ${entry}`),
        ...Array.from({ length: unexpected }, () => `unexpected ${entry}`),
      ];
    });
}

function hasSharedTextEvidence({
  path,
  column,
  fileSource = readFileSync(path, 'utf8'),
}: {
  path: string;
  column: { id: string; cellSource: string };
  fileSource?: string;
}) {
  if (cellContainsMrtOverflowTextRender(column.cellSource)) return true;
  const helper = SHARED_TEXT_HELPERS.find(
    (entry) => path.endsWith(entry.file) && entry.id === column.id,
  );
  return Boolean(
    helper &&
    cellCallsHelper(column.cellSource, helper.helper) &&
    helperBodyContainsMrtOverflowText(fileSource, helper.helper),
  );
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      candidate.name.getText().replaceAll("'", '').replaceAll('"', '') === name,
  );
}

function columnPolicies(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const columns: Array<{
    id: string;
    mode?: string;
    factory?: string;
    owner?: string;
    position: string;
    cellSource: string;
  }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const id = property(node, 'id') ?? property(node, 'accessorKey');
      const cell = property(node, 'Cell');
      if (id && cell) {
        const rawId = id.initializer.getText().replaceAll("'", '').replaceAll('"', '');
        const meta = property(node, 'meta');
        const mode =
          meta && ts.isObjectLiteralExpression(meta.initializer)
            ? property(meta.initializer, 'overflowMode')
                ?.initializer.getText()
                .replaceAll("'", '')
                .replaceAll('"', '')
            : undefined;
        const factory = ts.isCallExpression(cell.initializer)
          ? cell.initializer.expression.getText()
          : undefined;
        const owner =
          meta && ts.isObjectLiteralExpression(meta.initializer)
            ? property(meta.initializer, 'overflowOwner')
                ?.initializer.getText()
                .replaceAll("'", '')
                .replaceAll('"', '')
            : undefined;
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        columns.push({
          id: rawId,
          mode,
          factory,
          owner,
          position: `${path}:${location.line + 1}:${location.character + 1}`,
          cellSource: cell.initializer.getText(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return columns;
}

function expectColumnPolicies(path: string, expected: Record<string, ColumnPolicy>) {
  const columns = columnPolicies(path);
  const failures = Object.entries(expected).flatMap(([id, policy]) => {
    const matches = columns.filter((column) => column.id === id);
    if (matches.length === 0) return [`${path}: missing ${id}`];
    return matches.flatMap((column) => {
      const failures: string[] = [];
      if (column.mode !== policy.mode)
        failures.push(
          `${column.position} ${id}: expected ${policy.mode}, got ${column.mode ?? 'missing'}`,
        );
      if (policy.factory && column.factory !== policy.factory)
        failures.push(
          `${column.position} ${id}: expected ${policy.factory}, got ${column.factory ?? 'raw Cell'}`,
        );
      if (policy.owner && column.owner !== policy.owner)
        failures.push(
          `${column.position} ${id}: expected ${policy.owner}, got ${column.owner ?? 'missing'}`,
        );
      return failures;
    });
  });
  expect(failures).toEqual([]);
}

function collectProductionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return collectProductionFiles(path);
    return /\.(ts|tsx)$/.test(path) && !/\.spec\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

type Rendered = { container: HTMLDivElement; root: Root };

function render(node: ReactNode): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

function destroy(view: Rendered) {
  act(() => view.root.unmount());
  view.container.remove();
}

describe('MRT overflow policies', () => {
  it('fits only whole items including gaps and the dynamic trigger width', () => {
    expect(
      calculateVisibleItemCount({
        itemWidths: [20, 30, 40],
        contentWidth: 80,
        triggerWidths: [28, 38, 48],
        itemGap: 4,
        triggerGap: 6,
      }),
    ).toBe(1);

    expect(
      calculateVisibleItemCount({
        itemWidths: [20, 30, 40],
        contentWidth: 90,
        triggerWidths: [28, 38, 48],
        itemGap: 4,
        triggerGap: 6,
      }),
    ).toBe(2);
  });

  it('restores every item when the column widens', () => {
    const measurement = {
      itemWidths: [20, 30, 40],
      triggerWidths: [28, 38, 48],
      itemGap: 4,
      triggerGap: 6,
    };

    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 200 })).toBe(3);
    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 50 })).toBe(0);
  });

  it('never bisects a single item and accounts for the fade spacer', () => {
    const measurement = {
      itemWidths: [100],
      triggerWidths: [28],
      itemGap: 4,
      triggerGap: 6,
      spacerWidth: 32,
    };

    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 172 })).toBe(1);
    expect(calculateVisibleItemCount({ ...measurement, contentWidth: 99 })).toBe(0);
  });

  it('does not stringify arrays or objects as scalar cell values', () => {
    expect(toMrtScalarText('Привіт')).toBe('Привіт');
    expect(toMrtScalarText(42)).toBe('42');
    expect(toMrtScalarText(['a', 'b'])).toBeNull();
    expect(toMrtScalarText({ value: 'a' })).toBeNull();
    expect(toMrtScalarText('')).toBe('');
  });

  it('requires an explicit overflow policy for custom cells, including grouped columns', () => {
    expect(
      validateMrtColumnPolicies([
        {
          id: 'group',
          columns: [
            { id: 'missing', Cell: () => null },
            { id: 'classified', meta: { overflowMode: 'none' }, Cell: () => null },
          ],
        },
      ]),
    ).toEqual(['group.missing']);
  });

  it('rejects unclassified top-level and nested custom cells with their full paths', () => {
    expect(() =>
      assertMrtColumnPolicies([
        { id: 'topLevel', Cell: () => null },
        { id: 'group', columns: [{ id: 'nested', Cell: () => null }] },
      ]),
    ).toThrow('topLevel, group.nested');
  });

  it('rejects an unbranded items renderer', () => {
    expect(() =>
      assertMrtColumnPolicies([
        { id: 'items', meta: { overflowMode: 'items' }, Cell: (() => null) as any },
      ]),
    ).toThrow('items (items Cell must use mrtItemsCell)');
  });

  it('rejects unbranded top-level and grouped custom cells, but accepts mrtCustomCell', () => {
    expect(() =>
      assertMrtColumnPolicies([
        { id: 'custom', meta: { overflowMode: 'custom' }, Cell: (() => null) as any },
      ]),
    ).toThrow('custom (custom Cell must use mrtCustomCell)');
    expect(() =>
      assertMrtColumnPolicies([
        {
          id: 'group',
          columns: [{ id: 'nested', meta: { overflowMode: 'custom' }, Cell: (() => null) as any }],
        },
      ]),
    ).toThrow('group.nested (custom Cell must use mrtCustomCell)');
    expect(() =>
      assertMrtColumnPolicies([
        {
          id: 'owner',
          meta: { overflowMode: 'custom' } as any,
          Cell: mrtCustomCell(() => null),
        },
      ]),
    ).toThrow('owner (custom Cell must declare a valid overflowOwner)');
    expect(() =>
      assertMrtColumnPolicies([
        {
          id: 'branded',
          meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
          Cell: mrtCustomCell(() => null),
        },
      ]),
    ).not.toThrow();
  });

  it('keeps the direct MRT hook import inside the shared adapter', () => {
    const root = resolve('src/ts/react');
    const files: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) collect(path);
        else if (/\.(ts|tsx)$/.test(path)) files.push(path);
      }
    };
    collect(root);

    const violations = files
      .filter((path) => !path.endsWith('get-default-table-options.tsx'))
      .filter((path) => /import\s*\{[^}]*useMaterialReactTable/.test(readFileSync(path, 'utf8')));

    expect(violations).toEqual([]);
  });

  it('keeps named semantic policies on their branded factories', () => {
    expectColumnPolicies(
      'src/ts/react/routes/rer-analysis-neo/components/analysis-summary-table-columns.tsx',
      { unitSearchText: { mode: 'items', factory: 'mrtItemsCell' } },
    );
    expectColumnPolicies('src/ts/react/routes/admin-organisms-neo/index.tsx', {
      aors: { mode: 'items', factory: 'mrtItemsCell' },
      groups: { mode: 'items', factory: 'mrtItemsCell' },
      roles: { mode: 'items', factory: 'mrtItemsCell' },
      limitGroups: { mode: 'items', factory: 'mrtItemsCell' },
      parent: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-users-neo/index.tsx', {
      login: { mode: 'custom', factory: 'mrtCustomCell', owner: 'shared-text' },
      id: { mode: 'custom', factory: 'mrtCustomCell', owner: 'structured-layout' },
      roles: { mode: 'items', factory: 'mrtItemsCell' },
      organism: { mode: 'text', factory: 'mrtTextCell' },
      zone: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      description: { mode: 'text', factory: 'mrtTextCell' },
    });
    expectColumnPolicies(
      'src/ts/react/routes/rer-networks-neo/components/NetworksTableColumns.tsx',
      {
        network: { mode: 'custom', factory: 'mrtCustomCell', owner: 'structured-layout' },
        aors: { mode: 'items', factory: 'mrtItemsCell' },
        freqs: { mode: 'custom', factory: 'mrtCustomCell', owner: 'domain-hover' },
        location: { mode: 'custom', factory: 'mrtCustomCell', owner: 'domain-hover' },
        lastActivity: { mode: 'text', factory: 'mrtTextCell' },
        activity: { mode: 'none' },
      },
    );
    expectColumnPolicies('src/ts/react/routes/rer-unit-details/UnitAttachmentsTable.tsx', {
      aors: { mode: 'items', factory: 'mrtItemsCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      shortDescription: { mode: 'wrap' },
      fullDescription: { mode: 'wrap' },
      fileName: { mode: 'none' },
    });
    expectColumnPolicies('src/ts/react/routes/rer-palitra-neo/components/PalitraTable.cells.tsx', {
      name: { mode: 'custom', factory: 'mrtCustomCell', owner: 'shared-text' },
      sourceFileName: { mode: 'text', factory: 'mrtTextCell' },
      lastUploadedAtTs: { mode: 'text', factory: 'mrtTextCell' },
      author: { mode: 'text', factory: 'mrtTextCell' },
      accessSummary: { mode: 'text', factory: 'mrtTextCell' },
      colorHex: { mode: 'none' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-directions-neo/index.tsx', {
      aors: { mode: 'items', factory: 'mrtItemsCell' },
      access: { mode: 'items', factory: 'mrtItemsCell' },
      admins: { mode: 'items', factory: 'mrtItemsCell' },
      group: { mode: 'custom', factory: 'mrtCustomCell', owner: 'shared-text' },
      datasource: { mode: 'custom', factory: 'mrtCustomCell', owner: 'shared-text' },
      activityDay: { mode: 'text', factory: 'mrtTextCell' },
      activityWeek: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      GROUP_ACTIVITY_TIMELINE_COLUMN_ID: { mode: 'none' },
      notes: { mode: 'wrap' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-messenger-neo/index.tsx', {
      messenger: { mode: 'none' },
      description: { mode: 'wrap' },
      debugInfo: { mode: 'text', factory: 'mrtTextCell' },
      status: { mode: 'none' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-ai-agent/index.tsx', {
      prompt: { mode: 'text', factory: 'mrtTextCell' },
    });
  });

  it('keeps an exhaustive custom-owner inventory on approved primitives', () => {
    const expected = [
      ['admin-ai-agent/index.tsx', 'humanLogin', 'shared-text'],
      ['admin-ai-agent/index.tsx', 'status', 'structured-layout'],
      ['admin-ai-agent/index.tsx', 'reviewState', 'structured-layout'],
      ['admin-ai-agent/index.tsx', 'lastTestedAt', 'structured-layout'],
      ['admin-directions-neo/index.tsx', 'group', 'shared-text'],
      ['admin-directions-neo/index.tsx', 'group', 'shared-text'],
      ['admin-directions-neo/index.tsx', 'datasource', 'shared-text'],
      ['admin-directions-neo/index.tsx', 'datasource', 'shared-text'],
      ['admin-unit-duplicates/index.tsx', 'sigintUnitName', 'shared-text'],
      ['admin-unit-duplicates/index.tsx', 'orbitUnitFullName', 'shared-text'],
      ['admin-users-neo/index.tsx', 'login', 'shared-text'],
      ['admin-users-neo/index.tsx', 'id', 'structured-layout'],
      ['devices/components/DevicesTable.tsx', 'name', 'shared-text'],
      [
        'rer-network-details-neo/components/NetworkCallsignsCatalogTable.tsx',
        'sourceName',
        'structured-layout',
      ],
      [
        'rer-network-details-neo/components/NetworkCallsignsNetworkTable.tsx',
        'callsign',
        'structured-layout',
      ],
      [
        'rer-network-details-neo/components/NetworkCallsignsNetworkTable.tsx',
        'sourceName',
        'structured-layout',
      ],
      [
        'rer-network-details-neo/components/NetworkDetailsFrequenciesTable.tsx',
        'displayFreq',
        'structured-layout',
      ],
      [
        'rer-network-details-neo/components/NetworkDetailsFrequenciesTable.tsx',
        'callsignLabel',
        'structured-layout',
      ],
      ['rer-networks-neo/components/NetworksTableColumns.tsx', 'network', 'structured-layout'],
      ['rer-networks-neo/components/NetworksTableColumns.tsx', 'freqs', 'domain-hover'],
      ['rer-networks-neo/components/NetworksTableColumns.tsx', 'location', 'domain-hover'],
      ['rer-palitra-neo/components/PalitraTable.cells.tsx', 'name', 'shared-text'],
      ['rer-units-neo/components/UnitsTable.tsx', 'name', 'structured-layout'],
    ]
      .map(([suffix, id, owner]) => `${suffix}:${id}:${owner}`)
      .sort();
    const actual = collectProductionFiles(resolve('src/ts/react/routes'))
      .flatMap((path) =>
        columnPolicies(path)
          .filter((column) => column.mode === 'custom')
          .map((column) => ({ path, column })),
      )
      .map(
        ({ path, column }) =>
          `${path.replace(/^.*\/src\/ts\/react\/routes\//, '')}:${column.id}:${column.owner}`,
      )
      .sort();

    expect(customInventoryViolations(expected, actual)).toEqual([]);

    const customColumns = collectProductionFiles(resolve('src/ts/react/routes')).flatMap((path) =>
      columnPolicies(path)
        .filter((column) => column.mode === 'custom')
        .map((column) => ({ path, column })),
    );
    expect(customColumns.filter(({ column }) => column.factory !== 'mrtCustomCell')).toEqual([]);
    expect(
      customColumns
        .filter(({ column }) => column.owner === 'shared-text')
        .filter(({ path, column }) => !hasSharedTextEvidence({ path, column })),
    ).toEqual([]);
    expect(
      customColumns
        .filter(({ column }) => column.owner === 'domain-hover')
        .map(({ column }) => column.id)
        .sort(),
    ).toEqual(['freqs', 'location']);
  });

  it('requires column-specific shared-text evidence', () => {
    expect(
      hasSharedTextEvidence({
        path: 'unrelated.tsx',
        column: { id: 'name', cellSource: 'mrtCustomCell(() => <Link>name</Link>)' },
        fileSource: 'const unrelated = <MrtOverflowText displayValue="x" fullValue="x" />;',
      }),
    ).toBe(false);
    expect(
      hasSharedTextEvidence({
        path: 'src/ts/react/routes/admin-directions-neo/index.tsx',
        column: { id: 'datasource', cellSource: 'mrtCustomCell(() => renderWrongHelper())' },
        fileSource: 'function renderDatasourceCell() { return <MrtOverflowText />; }',
      }),
    ).toBe(false);
    expect(
      hasSharedTextEvidence({
        path: 'src/ts/react/routes/admin-directions-neo/index.tsx',
        column: {
          id: 'datasource',
          cellSource: 'mrtCustomCell(() => renderDatasourceCell())',
        },
        fileSource:
          'function renderDatasourceCell() { return <span />; } function later() { return <MrtOverflowText />; }',
      }),
    ).toBe(false);
    expect(
      helperBodyContainsMrtOverflowText(
        'function renderDatasourceCell() { return <MrtOverflowText />; }',
        'renderDatasourceCell',
      ),
    ).toBe(true);
    expect(
      helperBodyContainsMrtOverflowText(
        'function renderNameCell() { return <MrtOverflowText />; }',
        'renderNameCell',
      ),
    ).toBe(true);
    expect(
      helperBodyContainsMrtOverflowText(
        'const MrtOverflowText = null; function other() {}',
        'missing',
      ),
    ).toBe(false);
  });

  it('recognizes only semantic MrtOverflowText render references', () => {
    const hasRender = (sourceText: string) =>
      containsMrtOverflowTextRender(
        ts.createSourceFile('reference.tsx', sourceText, ts.ScriptTarget.Latest, true),
      );

    expect(hasRender('const value = <MrtOverflowText />;')).toBe(true);
    expect(hasRender('const value = <MrtOverflowText>text</MrtOverflowText>;')).toBe(true);
    expect(hasRender('const value = MrtOverflowText({ displayValue: "text" });')).toBe(true);
    expect(
      hasRender('const value = createElement(MrtOverflowText, { displayValue: "text" });'),
    ).toBe(true);
    expect(hasRender('const MrtOverflowText = false;')).toBe(false);
    expect(hasRender('void MrtOverflowText;')).toBe(false);
    expect(hasRender('const value = <CustomMrtOverflowText />;')).toBe(false);
    expect(hasRender('type MrtOverflowText = string;')).toBe(false);
    expect(hasRender('const value = { MrtOverflowText: true };')).toBe(false);
    expect(hasRender('// <MrtOverflowText />\nconst value = "MrtOverflowText";')).toBe(false);
  });

  it('keeps helper render evidence within the one allowlisted helper body', () => {
    expect(
      helperBodyContainsMrtOverflowText(
        'function renderDatasourceCell() { const MrtOverflowText = false; return <span />; }',
        'renderDatasourceCell',
      ),
    ).toBe(false);
    expect(
      helperBodyContainsMrtOverflowText(
        'function renderDatasourceCell() { void MrtOverflowText; return <span />; }',
        'renderDatasourceCell',
      ),
    ).toBe(false);
    expect(
      helperBodyContainsMrtOverflowText(
        'function renderDatasourceCell() { return <CustomMrtOverflowText />; }',
        'renderDatasourceCell',
      ),
    ).toBe(false);
    expect(
      helperBodyContainsMrtOverflowText(
        'function renderDatasourceCell() { return <span />; } function later() { return <MrtOverflowText />; }',
        'renderDatasourceCell',
      ),
    ).toBe(false);
    expect(
      helperBodyContainsMrtOverflowText(
        'function other() { return <MrtOverflowText />; }',
        'missing',
      ),
    ).toBe(false);
    expect(
      helperBodyContainsMrtOverflowText(
        'function renderDatasourceCell() { return <MrtOverflowText />; } function renderDatasourceCell() { return <MrtOverflowText />; }',
        'renderDatasourceCell',
      ),
    ).toBe(false);
  });

  it('reports real custom inventory mismatches, including duplicate ownership entries', () => {
    expect(customInventoryViolations(['a'], ['a', 'unexpected'])).toEqual([
      'unexpected unexpected',
    ]);
    expect(customInventoryViolations(['a', 'missing'], ['a'])).toEqual(['missing missing']);
    expect(
      customInventoryViolations(
        ['directions:datasource', 'directions:datasource'],
        ['directions:datasource', 'directions:datasource', 'directions:datasource'],
      ),
    ).toEqual(['unexpected directions:datasource']);
    expect(
      customInventoryViolations(
        ['directions:datasource', 'directions:datasource'],
        ['directions:datasource'],
      ),
    ).toEqual(['missing directions:datasource']);
    expect(
      customInventoryViolations(
        ['network:freqs:domain-hover'],
        ['network:freqs:structured-layout'],
      ),
    ).toEqual(['missing network:freqs:domain-hover', 'unexpected network:freqs:structured-layout']);
  });

  it('keeps runtime enforcement ahead of MRT initialization without a raw options compatibility union', () => {
    const source = readFileSync(
      'src/ts/react/components/mui-customized/table/get-default-table-options.tsx',
      'utf8',
    );
    expect(source.indexOf('assertMrtColumnPolicies(options.columns)')).toBeGreaterThanOrEqual(0);
    expect(source).not.toContain('AppMrtTableOptions<TData> | MRT_TableOptions<TData>');
  });
});

describe('MRT rendered overflow components', () => {
  let availableWidth = 100;
  let textWidth = 100;
  let itemWidths: Record<string, number> = {};
  let columnGap = '4px';
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let observers: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }> =
    [];
  let originalClientWidth: PropertyDescriptor | undefined;
  let originalScrollWidth: PropertyDescriptor | undefined;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalGetComputedStyle: typeof window.getComputedStyle;

  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  };
  const triggerResize = () => {
    act(() =>
      observers.forEach((observer) => observer.callback([], observer as unknown as ResizeObserver)),
    );
    flushFrames();
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    observers = [];
    availableWidth = 100;
    textWidth = 100;
    itemWidths = {};
    columnGap = '4px';
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    originalGetComputedStyle = window.getComputedStyle.bind(window);
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return availableWidth;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return /overflow text|alpha/.test(this.textContent ?? '') ? textWidth : availableWidth;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      const label = this.textContent?.trim() ?? '';
      const width = label === '' ? 32 : (itemWidths[label] ?? (label.startsWith('Ще') ? 32 : 20));
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 20,
        width,
        height: 20,
        toJSON() {},
      };
    } as typeof HTMLElement.prototype.getBoundingClientRect;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const styles = originalGetComputedStyle(element);
      return new Proxy(styles, {
        get(target, key, receiver) {
          return key === 'columnGap' ? columnGap : Reflect.get(target, key, target);
        },
      }) as CSSStyleDeclaration;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        callback: ResizeObserverCallback;
        disconnect = vi.fn();
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
          observers.push(this);
        }
        observe = vi.fn();
        unobserve = vi.fn();
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    if (originalScrollWidth)
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('renders the complete scalar tooltip only while text overflows', async () => {
    vi.useFakeTimers();
    textWidth = 220;
    const fullValue = 'complete untruncated value';
    const view = render(
      createElement(MrtOverflowText, { displayValue: 'overflow text', fullValue }),
    );
    const text = view.container.querySelector('span');
    expect(text?.getAttribute('tabindex')).toBe('0');
    expect(getComputedStyle(text!).overflow).toBe('hidden');
    expect(getComputedStyle(text!).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(text!).textOverflow).toBe('ellipsis');
    act(() => text?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(fullValue);
    act(() =>
      text?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      ),
    );
    await act(async () => vi.runAllTimers());
    destroy(view);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    const focusView = render(
      createElement(MrtOverflowText, { displayValue: 'overflow text', fullValue }),
    );
    const focusText = focusView.container.querySelector('span');
    act(() => focusText?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(fullValue);

    textWidth = 80;
    triggerResize();
    expect(focusText?.getAttribute('tabindex')).toBeNull();
    act(() => focusText?.blur());
    act(() => focusText?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    destroy(focusView);
    const settled = render(
      createElement(MrtOverflowText, { displayValue: 'overflow text', fullValue }),
    );
    const settledText = settled.container.querySelector('span');
    act(() => settledText?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => settledText?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    destroy(settled);
    vi.useRealTimers();
  });

  it('does not create meaningless text disclosure or conflicting interactive tab stops', () => {
    textWidth = 220;
    const empty = render(createElement(MrtOverflowText, { displayValue: '—', fullValue: '—' }));
    expect(empty.container.querySelector('[tabindex="0"]')).toBeNull();
    destroy(empty);

    const interactive = render(
      createElement(MrtOverflowText, {
        displayValue: createElement('button', null, 'overflow text'),
        fullValue: 'overflow text',
        interactive: true,
      }),
    );
    expect(interactive.container.querySelector('span')?.getAttribute('tabindex')).toBeNull();
    expect(interactive.container.querySelector('button')).not.toBeNull();
    destroy(interactive);
  });

  it('preserves interactive link behavior while disclosing overflowing text', async () => {
    vi.useFakeTimers();
    textWidth = 220;
    const onClick = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let view: Rendered | undefined;
    try {
      view = render(
        createElement(MrtOverflowText, {
          component: 'a',
          componentProps: { href: '/target', onClick },
          interactive: true,
          displayValue: 'overflow text',
          fullValue: 'overflow text',
        }),
      );
      const link = view.container.querySelector<HTMLAnchorElement>('a[href="/target"]');
      expect(link).not.toBeNull();
      expect(link?.querySelector('[tabindex="0"]')).toBeNull();
      expect(getComputedStyle(link!).textOverflow).toBe('ellipsis');
      const overflowSource = readFileSync(
        'src/ts/react/components/mui-customized/table/mrt-overflow.tsx',
        'utf8',
      );
      expect(overflowSource).toContain("outline: '2px solid'");
      expect(overflowSource).toContain("outlineColor: 'primary.main'");
      expect(overflowSource).toContain('outlineOffset: 2');
      act(() => link?.click());
      expect(onClick).toHaveBeenCalledTimes(1);
      act(() => link?.focus());
      expect(link).toBe(document.activeElement);
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('overflow text');
      act(() => link?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('overflow text');

      textWidth = 80;
      triggerResize();
      act(() =>
        link?.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
        ),
      );
      act(() => link?.blur());
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      expect(view.container.querySelector('a[href="/target"]')).toBe(link);
      expect(link?.getAttribute('href')).toBe('/target');
      act(() => link?.focus());
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      act(() => link?.click());
      expect(onClick).toHaveBeenCalledTimes(2);
    } finally {
      if (view) destroy(view);
      const errors = consoleError.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      consoleError.mockRestore();
      vi.useRealTimers();
      expect(errors).not.toMatch(/failed prop type|invalid prop .* supplied/i);
    }
  });

  it('does not pass invalid portal children to MUI components', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let view: Rendered | undefined;
    let errors = '';

    try {
      itemWidths = { alpha: 60, beta: 60, 'Ще 1': 32, 'Ще 2': 32 };
      availableWidth = 100;
      view = render(
        createElement(MrtOverflowItems<string>, {
          items: ['alpha', 'beta'],
          renderItem: (value) => createElement('span', null, value),
          renderMeasurementItem: (value) => createElement('span', null, value),
          getItemText: (value) => value,
        }),
      );
      triggerResize();
    } finally {
      try {
        if (view) destroy(view);
      } finally {
        errors = consoleError.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
        consoleError.mockRestore();
      }
    }

    expect(errors).not.toMatch(/failed prop type|invalid prop .* supplied/i);
  });

  it('measures whole items, adapts on resize, and discloses only hidden items', async () => {
    itemWidths = { alpha: 60, beta: 60, gamma: 60, 'Ще 1': 32, 'Ще 2': 32, 'Ще 3': 32 };
    availableWidth = 150;
    const onBeta = vi.fn();
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta', 'gamma'],
        renderItem: (value) =>
          createElement(
            'button',
            { 'data-item': value, onClick: value === 'beta' ? onBeta : undefined },
            value,
          ),
        renderMeasurementItem: (value) => createElement('span', null, value),
        getItemKey: (value) => value,
        getItemText: (value) => value,
      }),
    );
    expect(observers).toHaveLength(1);
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(1);
    expect(view.container.querySelector('[data-item="alpha"]')).not.toBeNull();
    expect(view.container.querySelector('[data-item="beta"]')).toBeNull();
    expect(view.container.querySelector('[data-item="gamma"]')).toBeNull();
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Показати ще"]',
    );
    expect(trigger?.textContent).toBe('Ще 2');
    expect(trigger?.getAttribute('aria-label')).toBe('Показати ще 2 значення');
    const fade = view.container.querySelector<HTMLElement>('[aria-hidden][inert]');
    expect(getComputedStyle(fade!).background).toContain('linear-gradient');

    act(() => trigger?.click());
    const surface = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(surface?.textContent).toContain('beta');
    expect(surface?.textContent).toContain('gamma');
    expect(surface?.textContent).not.toContain('alpha');
    act(() =>
      document.body.querySelector<HTMLButtonElement>('[role="dialog"] [data-item="beta"]')?.click(),
    );
    expect(onBeta).toHaveBeenCalledTimes(1);
    act(() => surface?.focus());
    expect(document.activeElement).toBe(surface);
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(trigger);

    act(() => trigger?.click());
    availableWidth = 300;
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]').length).toBe(3);
    expect(view.container.querySelector('button[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('[aria-hidden][inert]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    destroy(view);
  });

  it('treats a normal column gap as zero during rendered item measurement', () => {
    columnGap = 'normal';
    itemWidths = { alpha: 60, beta: 60, gamma: 60, 'Ще 1': 32, 'Ще 2': 32, 'Ще 3': 32 };
    availableWidth = 150;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta', 'gamma'],
        renderItem: (value) => createElement('button', { 'data-item': value }, value),
        renderMeasurementItem: (value) => createElement('span', null, value),
        getItemText: (value) => value,
      }),
    );
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(1);
    expect(view.container.querySelector('[data-item="alpha"]')).not.toBeNull();
    expect(view.container.querySelector('[data-item="beta"]')).toBeNull();
    expect(
      view.container.querySelector('button[aria-label="Показати ще 2 значення"]')?.textContent,
    ).toBe('Ще 2');
    destroy(view);
  });

  it('represents the first oversized item and discloses only later items with original indices', async () => {
    itemWidths = { alpha: 140, beta: 30, 'Ще 1': 32, 'Ще 2': 32 };
    availableWidth = 80;
    textWidth = 140;
    const onBeta = vi.fn();
    const getItemText = vi.fn((value: string, index: number) => `${value}-${index}`);
    const getItemKey = vi.fn((value: string, index: number) => `${value}-${index}`);
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha', 'beta'],
        renderItem: (value) =>
          createElement(
            'button',
            { 'data-item': value, onClick: value === 'beta' ? onBeta : undefined },
            value,
          ),
        getItemKey,
        getItemText,
        emptyValue: 'порожньо',
      }),
    );
    triggerResize();
    vi.useFakeTimers();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(0);
    expect(view.container.textContent).toContain('alpha');
    expect(getItemText).toHaveBeenCalledWith('beta', 1);
    expect(getItemKey).toHaveBeenCalledWith('beta', 1);
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати ще 1 значення"]',
    );
    expect(trigger?.textContent).toBe('Ще 1');
    const compactText = view.container.querySelector('span');
    expect(getComputedStyle(compactText!).textOverflow).toBe('ellipsis');
    act(() => compactText?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('alpha-0');
    act(() =>
      compactText?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      ),
    );
    await act(async () => vi.runAllTimers());
    act(() => compactText?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('alpha-0');
    act(() => compactText?.blur());
    await act(async () => vi.runAllTimers());
    vi.useRealTimers();
    act(() => trigger?.click());
    const beta = document.body.querySelector<HTMLButtonElement>(
      '[role="dialog"] [data-item="beta"]',
    );
    act(() => beta?.click());
    expect(onBeta).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    act(() => outside.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    availableWidth = 300;
    triggerResize();
    expect(view.container.querySelectorAll('[data-item]')).toHaveLength(2);
    expect(view.container.querySelector('[data-item="alpha"]')).not.toBeNull();
    expect(view.container.querySelector('[data-item="beta"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('span')?.textContent).not.toBe('alpha');
    destroy(view);
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);

    const empty = render(
      createElement(MrtOverflowItems<string>, {
        items: [],
        renderItem: (value) => value,
        emptyValue: 'немає',
      }),
    );
    expect(empty.container.textContent).toBe('немає');
    destroy(empty);
  });

  it('uses the compact first-item text without a bare disclosure for a zero-fit single item', () => {
    itemWidths = { alpha: 140, 'Ще 1': 32 };
    availableWidth = 80;
    const view = render(
      createElement(MrtOverflowItems<string>, {
        items: ['alpha'],
        renderItem: (value) => createElement('button', { 'data-item': value }, value),
        getItemText: (value) => value,
      }),
    );
    triggerResize();
    expect(view.container.querySelector('[data-item]')).toBeNull();
    expect(view.container.textContent).toContain('alpha');
    expect(view.container.querySelector('button[aria-label^="Показати ще"]')).toBeNull();
    expect(view.container.querySelector('[data-mrt-overflow-fade]')).toBeNull();
    destroy(view);
  });
});
