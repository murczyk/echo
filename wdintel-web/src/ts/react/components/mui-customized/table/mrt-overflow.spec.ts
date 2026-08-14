/**
 * @vitest-environment happy-dom
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { calculateVisibleItemCount } from './mrt-overflow';
import {
  assertMrtColumnPolicies,
  toMrtScalarText,
  validateMrtColumnPolicies,
} from './get-default-table-options';

type ColumnPolicy = {
  mode: 'text' | 'items' | 'wrap' | 'none';
  factory?: 'mrtTextCell' | 'mrtItemsCell';
};

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
  const columns: Array<{ id: string; mode?: string; factory?: string; position: string }> = [];
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
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        columns.push({
          id: rawId,
          mode,
          factory,
          position: `${path}:${location.line + 1}:${location.character + 1}`,
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
    expectColumnPolicies('src/ts/react/routes/admin-organisms-neo/index.tsx', {
      aors: { mode: 'items', factory: 'mrtItemsCell' },
      groups: { mode: 'items', factory: 'mrtItemsCell' },
      roles: { mode: 'items', factory: 'mrtItemsCell' },
      limitGroups: { mode: 'items', factory: 'mrtItemsCell' },
      parent: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-users-neo/index.tsx', {
      login: { mode: 'text', factory: 'mrtTextCell' },
      id: { mode: 'text', factory: 'mrtTextCell' },
      roles: { mode: 'items', factory: 'mrtItemsCell' },
      organism: { mode: 'text', factory: 'mrtTextCell' },
      zone: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      description: { mode: 'text', factory: 'mrtTextCell' },
    });
    expectColumnPolicies(
      'src/ts/react/routes/rer-networks-neo/components/NetworksTableColumns.tsx',
      {
        network: { mode: 'text', factory: 'mrtTextCell' },
        aors: { mode: 'items', factory: 'mrtItemsCell' },
        freqs: { mode: 'items', factory: 'mrtItemsCell' },
        location: { mode: 'text', factory: 'mrtTextCell' },
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
      name: { mode: 'wrap' },
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
      group: { mode: 'text', factory: 'mrtTextCell' },
      datasource: { mode: 'text', factory: 'mrtTextCell' },
      activityDay: { mode: 'text', factory: 'mrtTextCell' },
      activityWeek: { mode: 'text', factory: 'mrtTextCell' },
      createdAt: { mode: 'text', factory: 'mrtTextCell' },
      GROUP_ACTIVITY_TIMELINE_COLUMN_ID: { mode: 'none' },
      notes: { mode: 'wrap' },
    });
    expectColumnPolicies('src/ts/react/routes/admin-messenger-neo/index.tsx', {
      messenger: { mode: 'none' },
      description: { mode: 'wrap' },
      debugInfo: { mode: 'wrap' },
      status: { mode: 'none' },
    });
  });

  it('keeps every production custom cell classified and branded', () => {
    const violations = collectProductionFiles(resolve('src/ts/react/routes')).flatMap((path) =>
      columnPolicies(path).flatMap((column) => {
        if (!column.mode) return [`${column.position} ${column.id}: missing meta.overflowMode`];
        if (column.mode === 'text' && column.factory !== 'mrtTextCell')
          return [`${column.position} ${column.id}: text bypasses mrtTextCell`];
        if (column.mode === 'items' && column.factory !== 'mrtItemsCell')
          return [`${column.position} ${column.id}: items bypasses mrtItemsCell`];
        return [];
      }),
    );
    expect(violations).toEqual([]);
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
