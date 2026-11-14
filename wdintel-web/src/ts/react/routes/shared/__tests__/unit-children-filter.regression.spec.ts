import { describe, expect, it } from 'vitest';
import type { Unit } from '../../../../../Bindings';
import { buildUnitFilterOptions } from '../../../utils/unit-search';
import {
  buildAnalysisReq,
  emptyQueryState,
  queryStateFromSavedFilter,
  queryStateMatchesSavedFilter,
} from '../../rer-analysis-neo/helpers';
import { buildInboxReq, emptyFilter } from '../../rer-duty-neo/utils';
import { aggregateUnitParentOptions, buildUnitHierarchyIndex } from '../unit-children-filter';

const template = buildUnitFilterOptions([])[0];
const unit = (id: number, name: string, fields: Partial<Unit>): Unit => ({
  ...template,
  id,
  name,
  armyRegion: 'Регіон',
  militaryDistrict: 'Округ',
  army: '6 А',
  ...fields,
});
const units = [
  unit(10, '6 А', {}),
  unit(20, '27 омсбр', { brigade: '27 омсбр' }),
  unit(21, '1 мср 27 омсбр', { brigade: '27 омсбр', company: '1 мср' }),
  unit(22, '2 мср 27 омсбр', { brigade: '27 омсбр', company: '2 мср' }),
  unit(23, '1 мср іншої армії', { army: '7 А', brigade: '27 омсбр', company: '1 мср' }),
];
const hierarchy = buildUnitHierarchyIndex(units);

describe('unit descendants regression #3527', () => {
  it.each([0, 2])(
    'normalizes computed parents without crossing branches (own count: %s)',
    (count) => {
      const hierarchy = buildUnitHierarchyIndex([
        unit(30, ' 22 А ', { army: '22 А' }),
        unit(31, '22 А', { army: '22 А' }),
        unit(32, '72 мсд 22 А', { army: '22 А', division: '72 мсд' }),
        unit(33, 'Army headquarters', { army: '22 А' }),
        unit(34, '22 А', { armyRegion: 'Інший регіон', army: '22 А' }),
      ]);
      const options = aggregateUnitParentOptions(
        [
          { value: 'unit-id:30', label: ' 22 А ', count },
          { value: 'unit-id:31', label: '22 А', count: 3 },
          { value: 'unit-id:32', label: '72 мсд 22 А', count: 5 },
          { value: 'unit-id:33', label: 'Army headquarters', count: 7 },
          { value: 'unit-id:34', label: '22 А', count: 11 },
        ],
        hierarchy,
      );
      const armies = options.filter((option) => option.label.trim() === '22 А');
      expect(armies.map((option) => option.value).sort()).toEqual(['unit-id:30', 'unit-id:34']);
      expect(options.find((option) => option.value === 'unit-id:30')?.count).toBe(15 + count);
      expect(options.find((option) => option.value === 'unit-id:34')?.count).toBe(11);
      expect(options.find((option) => option.value === 'unit-id:33')?.count).toBe(7);
      for (const value of [
        'unit-id:30',
        'unit-id:31',
        'unit-parent:group:0:Регіон|1:Округ|2:22 А',
      ]) {
        const duty = buildInboxReq({
          filter: { ...emptyFilter(), unitsSelected: [value], unitsDenied: [value] },
          unitHierarchy: hierarchy,
        });
        expect(duty.selectedUnitIds?.sort()).toEqual([30, 31, 32, 33]);
        expect(duty.deniedUnitIds?.sort()).toEqual([30, 31, 32, 33]);
        expect(
          buildAnalysisReq({
            ...emptyQueryState(),
            fromDateTimeStr: '2026-10-30T00:00',
            toDateTimeStr: '2026-10-31T00:00',
            unitsSelected: [value],
            unitHierarchy: hierarchy,
          })?.selectedUnitIds?.sort(),
        ).toEqual([30, 31, 32, 33]);
      }
    },
  );

  it('does not join unrelated armies whose names contain hierarchy path delimiters', () => {
    const unitHierarchy = buildUnitHierarchyIndex([
      unit(40, 'Independent army', { army: '6 А|3:1 АК' }),
      unit(41, 'Other army child', { army: '6 А', corps: '1 АК', brigade: '27 омсбр' }),
    ]);
    const req = buildInboxReq({
      filter: { ...emptyFilter(), unitsSelected: ['unit-id:40'] },
      unitsIncludeChildren: false,
      unitHierarchy,
    });
    expect(req.selectedUnitIds).toEqual([40]);
  });
  it('keeps restored descendant requests closed until their hierarchy is available', () => {
    const query = {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-10-30T00:00',
      toDateTimeStr: '2026-10-31T00:00',
      unitsSelected: ['unit-id:20'],
      unitsIncludeChildren: false,
    };
    expect(buildAnalysisReq(query)).toBeNull();
    expect(
      buildAnalysisReq({ ...query, unitHierarchy: hierarchy })?.selectedUnitIds?.sort(),
    ).toEqual([20, 21, 22]);
  });

  it('restores saved parent intent and always includes descendants for older filters', () => {
    const query = {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-10-30T00:00',
      toDateTimeStr: '2026-10-31T00:00',
      unitsSelected: ['unit-id:20'],
      unitsIncludeChildren: true,
      unitHierarchy: hierarchy,
    };
    const saved = {
      id: 1,
      name: '#3527',
      req: buildAnalysisReq(query)!,
      unitFilter: { values: query.unitsSelected, includeChildren: true },
    };
    const restored = queryStateFromSavedFilter(saved, {
      ...emptyQueryState(),
      fromDateTimeStr: query.fromDateTimeStr,
      toDateTimeStr: query.toDateTimeStr,
    });
    expect(restored.unitsSelected).toEqual(['unit-id:20']);
    expect(restored.unitsIncludeChildren).toBe(true);
    const refreshedHierarchy = buildUnitHierarchyIndex([
      ...units,
      unit(24, '3 мср 27 омсбр', { brigade: '27 омсбр', company: '3 мср' }),
    ]);
    expect(
      buildAnalysisReq({ ...restored, unitHierarchy: refreshedHierarchy })?.selectedUnitIds?.sort(),
    ).toEqual([20, 21, 22, 24]);
    expect(queryStateMatchesSavedFilter(query, saved)).toBe(true);
    expect(queryStateMatchesSavedFilter({ ...query, unitsIncludeChildren: false }, saved)).toBe(
      true,
    );
    expect(
      queryStateFromSavedFilter(
        { ...saved, unitFilter: { values: query.unitsSelected, includeChildren: false } },
        query,
      ).unitsIncludeChildren,
    ).toBe(true);
    expect(
      queryStateMatchesSavedFilter(query, {
        ...saved,
        unitFilter: { values: query.unitsSelected, includeChildren: false },
      }),
    ).toBe(true);
    expect(
      queryStateFromSavedFilter({ ...saved, unitFilter: null }, query).unitsIncludeChildren,
    ).toBe(true);
    expect(
      queryStateMatchesSavedFilter(
        { ...query, unitsSelected: [] },
        {
          ...saved,
          req: buildAnalysisReq({ ...query, unitsSelected: [] })!,
          unitFilter: null,
        },
      ),
    ).toBe(true);
  });
  it('adds both children and a parent’s own counts without crossing another army or adding higher echelons', () => {
    const options = aggregateUnitParentOptions(
      [
        { value: 'unit-id:20', label: '27 омсбр', count: 2 },
        { value: 'unit-id:21', label: units[2].name, count: 5 },
        { value: 'unit-id:22', label: units[3].name, count: 6 },
        { value: 'unit-id:23', label: units[4].name, count: 100 },
        { value: 'Не визначено', label: 'Не визначено', count: 3 },
      ],
      hierarchy,
    );
    expect(options.find((option) => option.value === 'unit-id:20')?.count).toBe(13);
    expect(options.find((option) => option.value === 'unit-id:10')?.count).toBe(13);
    expect(options.some((option) => ['Регіон', 'Округ'].includes(option.label))).toBe(false);
    expect(options.find((option) => option.value === 'Не визначено')?.count).toBe(3);
  });

  it('expands overlapping Duty include/exclude and Analysis selections only in requests', () => {
    const selected = ['unit-id:20', 'unit-id:21'];
    const filter = { ...emptyFilter(), unitsSelected: selected, unitsDenied: ['unit-id:10'] };
    const duty = buildInboxReq({ filter, unitsIncludeChildren: true, unitHierarchy: hierarchy });
    expect(duty.selectedUnitIds?.sort()).toEqual([20, 21, 22]);
    expect(duty.deniedUnitIds?.sort()).toEqual([10, 20, 21, 22]);
    expect(duty.selectedUnits).toBeNull();
    const query = {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-10-30T00:00',
      toDateTimeStr: '2026-10-31T00:00',
      unitsSelected: selected,
      unitsIncludeChildren: true,
      unitHierarchy: hierarchy,
    };
    expect(buildAnalysisReq(query)?.selectedUnitIds?.sort()).toEqual([20, 21, 22]);
    expect(
      buildAnalysisReq({ ...query, unitsIncludeChildren: false })?.selectedUnitIds?.sort(),
    ).toEqual([20, 21, 22]);
    const restoredDuty = buildInboxReq({
      filter,
      unitsIncludeChildren: false,
      unitHierarchy: hierarchy,
    });
    expect(restoredDuty.selectedUnitIds?.sort()).toEqual([20, 21, 22]);
    expect(restoredDuty.deniedUnitIds?.sort()).toEqual([10, 20, 21, 22]);
    expect(filter.unitsSelected).toEqual(selected);
    expect(query.unitsSelected).toEqual(selected);
  });

  it('always expands a parent without its own catalog row, including older disabled filters', () => {
    const withoutParent = buildUnitHierarchyIndex(
      units
        .filter((row) => row.id !== 20)
        .map((row) =>
          [21, 22].includes(row.id)
            ? { ...row, corps: '1 АК', division: '2 мсд', battalion: '1 мсб' }
            : row,
        ),
    );
    const options = aggregateUnitParentOptions(
      [
        { value: 'unit-id:21', label: units[2].name, count: 5 },
        { value: 'unit-id:22', label: units[3].name, count: 6 },
      ],
      withoutParent,
    );
    expect(options.filter((option) => option.value.startsWith('unit-parent:'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '1 мсб 27 омсбр 2 мсд 1 АК 6 А', count: 11 }),
        expect.objectContaining({ label: '27 омсбр 2 мсд 1 АК 6 А', count: 11 }),
        expect.objectContaining({ label: '2 мсд 1 АК 6 А', count: 11 }),
        expect.objectContaining({ label: '1 АК 6 А', count: 11 }),
      ]),
    );
    expect(options.some((option) => /Регіон|Округ/.test(option.label))).toBe(false);
    const parent = options.find((option) => option.label === '27 омсбр 2 мсд 1 АК 6 А')!;
    expect(parent.count).toBe(11);
    const filter = { ...emptyFilter(), unitsSelected: [parent.value] };
    expect(
      buildInboxReq({
        filter,
        unitsIncludeChildren: true,
        unitHierarchy: withoutParent,
      }).selectedUnitIds?.sort(),
    ).toEqual([21, 22]);
    expect(
      buildInboxReq({
        filter,
        unitsIncludeChildren: false,
        unitHierarchy: withoutParent,
      }).selectedUnitIds?.sort(),
    ).toEqual([21, 22]);
  });
});
