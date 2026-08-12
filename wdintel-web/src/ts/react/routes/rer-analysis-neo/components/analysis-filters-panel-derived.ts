import type { AnalysisFilterOption } from '../types';
import { normalizeFilterLabel, sortFilterOptionsByLabel } from '../use-analysis-data.shared';
import {
  groupEquivalentAnalysisUnitOptions,
  normalizeUnknownUnitFilterLabel,
  normalizeUnknownUnitFilterValue,
} from '../../shared/analysis-unit-filter';
import { isPresent } from '../../../utils/misc';
import { normalizeCallsignFilterValues } from '../../../utils/callsign-normalization';
import type { AnalysisFiltersPanelPage } from './analysis-filters-panel-shared';

type Params = Pick<
  AnalysisFiltersPanelPage,
  'aorEntries' | 'counts' | 'groupInfos' | 'options' | 'queryState' | 'tagsMap' | 'tagsOrder'
> &
  Partial<Pick<AnalysisFiltersPanelPage, 'unitsMap'>>;

export type AnalysisFiltersPanelDerivedData = {
  groupOptions: AnalysisFilterOption[];
  callsignsOptions: AnalysisFilterOption[];
  aorOptions: AnalysisFilterOption[];
  networkOptions: AnalysisFilterOption[];
  tagOptions: AnalysisFilterOption[];
  metadataCcsOptions: AnalysisFilterOption[];
  metadataSendersOptions: AnalysisFilterOption[];
  metadataReceiversOptions: AnalysisFilterOption[];
  metadataHashesOptions: AnalysisFilterOption[];
  locationsOptions: AnalysisFilterOption[];
  postsOptions: AnalysisFilterOption[];
  unitsOptions: AnalysisFilterOption[];
  importantSelectedCount: number;
  tagsSelectedCount: number;
  aorsSelectedCount: number;
  groupsSelectedCount: number;
  sendersSelectedCount: number;
  freqsSelectedCount: number;
  callsignsSelectedCount: number;
  unitsSelectedCount: number;
  locationsSelectedCount: number;
  postsSelectedCount: number;
  networksSelectedCount: number;
  metadataSelectedCount: number;
  metadataOptionsCount: number;
};

function buildMergedGroupOptions(
  groupOptions: AnalysisFilterOption[],
  groupInfos: Record<string, { name: string }>,
): AnalysisFilterOption[] {
  const groupedByLabel = new Map<
    string,
    {
      value: string;
      label: string;
      count: number;
      values: string[];
    }
  >();

  groupOptions.forEach((option) => {
    const label = normalizeFilterLabel(
      groupInfos[option.value]?.name ?? option.label ?? option.value,
    );
    const values = option.values ?? [option.value];
    const existingOption = groupedByLabel.get(label);
    if (existingOption != null) {
      existingOption.count += option.count;
      existingOption.values = Array.from(new Set([...existingOption.values, ...values]));
      return;
    }

    groupedByLabel.set(label, {
      value: values[0] ?? option.value,
      label,
      count: option.count,
      values: Array.from(new Set(values)),
    });
  });

  return sortFilterOptionsByLabel(Array.from(groupedByLabel.values()));
}

function countMergedSelectedGroupOptions(
  groupOptions: AnalysisFilterOption[],
  selectedGroups: string[],
): number {
  const selectedGroupKeys = new Set(selectedGroups);
  const matchedSelectedKeys = new Set<string>();
  const visibleCount = groupOptions.reduce((count, option) => {
    const optionValues = option.values ?? [option.value];
    const matchedValues = optionValues.filter((value) => selectedGroupKeys.has(value));
    matchedValues.forEach((value) => matchedSelectedKeys.add(value));
    return matchedValues.length > 0 ? count + 1 : count;
  }, 0);
  return visibleCount + selectedGroups.filter((key) => !matchedSelectedKeys.has(key)).length;
}

export function buildAnalysisFiltersPanelDerivedData({
  aorEntries,
  groupInfos,
  options,
  queryState,
  tagsMap,
  tagsOrder = [],
  unitsMap = {},
}: Params): AnalysisFiltersPanelDerivedData {
  const groupOptions = buildMergedGroupOptions(options.groups, groupInfos);

  const callsignsOptions = options.callsigns.reduce<AnalysisFilterOption[]>((acc, option) => {
    const label = (option.label ?? option.value).toLocaleUpperCase('uk-UA');
    const values = normalizeCallsignFilterValues(option.values ?? [option.value]);
    if (values.length === 0) return acc;
    const existingOption = acc.find((item) => item.label === label);
    if (isPresent(existingOption)) {
      existingOption.values = normalizeCallsignFilterValues([
        ...(existingOption.values ?? []),
        ...values,
      ]);
      existingOption.count += option.count;
      return acc;
    }
    acc.push({ value: values[0], label, count: option.count, values });
    return acc;
  }, []);

  const aorNamesById = Object.fromEntries(aorEntries.map((aor) => [String(aor.id), aor.name]));
  const aorOptions = sortFilterOptionsByLabel(
    options.aors.map((option) => ({
      ...option,
      label: normalizeFilterLabel(aorNamesById[option.value] ?? option.label ?? option.value),
    })),
    ['Вся смуга'],
  );

  const networkOptions = sortFilterOptionsByLabel(
    options.networks.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );

  // The dropdown lists every known tag, not just the facet of tags present on the
  // currently-visible messages. `options.tags` supplies the per-tag counts (how many
  // visible messages carry the tag); tags absent from the facet show a count of 0 but
  // stay pickable. Ordering follows the backend `tagsOrder`, with the current
  // organism's user tags first and every other tag after them.
  const tagFacetCountByValue = new Map<string, number>(
    options.tags.map((option) => [option.value, option.count]),
  );
  const tagValuesInOrder: number[] = [];
  const seenTagValues = new Set<number>();
  const pushTagValue = (tagId: number) => {
    if (seenTagValues.has(tagId)) return;
    seenTagValues.add(tagId);
    tagValuesInOrder.push(tagId);
  };
  // `tagsOrder` already carries the full tag list in backend order; the facet and the
  // selected tags are unioned in afterwards so nothing selectable is ever dropped.
  tagsOrder.forEach(pushTagValue);
  options.tags.forEach((option) => pushTagValue(Number(option.value)));
  queryState.tags.forEach(pushTagValue);

  const buildTagOption = (tagId: number): AnalysisFilterOption => {
    const value = String(tagId);
    return {
      value,
      label: normalizeFilterLabel(tagsMap[tagId]?.label ?? value),
      count: tagFacetCountByValue.get(value) ?? 0,
    };
  };
  const userTagOptions = tagValuesInOrder
    .filter((tagId) => tagsMap[tagId]?.ownerOrganismId != null)
    .map(buildTagOption);
  const otherTagOptions = tagValuesInOrder
    .filter((tagId) => tagsMap[tagId]?.ownerOrganismId == null)
    .map(buildTagOption);
  const tagOptions = [...userTagOptions, ...otherTagOptions];

  const metadataCcsOptions = sortFilterOptionsByLabel(
    options.metadataCcs.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );

  const metadataSendersOptions = sortFilterOptionsByLabel(
    options.metadataSenders.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );

  const metadataReceiversOptions = sortFilterOptionsByLabel(
    options.metadataReceivers.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );

  const metadataHashesOptions = sortFilterOptionsByLabel(
    options.metadataHashes.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );

  const locationsOptions = sortFilterOptionsByLabel(
    options.locations.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
    ['<Не вказано>'],
  );

  const postsOptions = sortFilterOptionsByLabel(
    options.posts.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );

  const unitsOptions = sortFilterOptionsByLabel(
    groupEquivalentAnalysisUnitOptions(options.units, Object.values(unitsMap)).map((option) => ({
      ...option,
      value: normalizeUnknownUnitFilterValue(option.value),
      label: normalizeUnknownUnitFilterLabel(option.label ?? option.value),
    })),
  );

  const importantSelectedCount =
    Number(queryState.orWithExtendedForm) +
    Number(queryState.onlyWithMedia) +
    Number(queryState.orBookmarked) +
    Number(queryState.orImportant) +
    Number(queryState.orWithCoords);

  const tagsSelectedCount =
    queryState.tags.length +
    Number(queryState.filterTagsOption !== 'OneOfTags') +
    Number(queryState.withoutModelTags) +
    Number(queryState.reportTagsOnlyThisUnit);

  return {
    groupOptions,
    callsignsOptions,
    aorOptions,
    networkOptions,
    tagOptions,
    metadataCcsOptions,
    metadataSendersOptions,
    metadataReceiversOptions,
    metadataHashesOptions,
    locationsOptions,
    postsOptions,
    unitsOptions,
    importantSelectedCount,
    tagsSelectedCount,
    aorsSelectedCount: queryState.aorsSelected.length,
    groupsSelectedCount: countMergedSelectedGroupOptions(groupOptions, queryState.groupsSelected),
    sendersSelectedCount: queryState.sendersSelected.length,
    freqsSelectedCount: queryState.freqsSelected.length,
    callsignsSelectedCount: queryState.callsignsSelected.length,
    unitsSelectedCount: queryState.unitsSelected.length,
    locationsSelectedCount: queryState.locationsSelected.length,
    postsSelectedCount: queryState.postsSelected.length,
    networksSelectedCount: queryState.networksSelected.length,
    metadataSelectedCount:
      queryState.metadataCc.length +
      queryState.metadataSender.length +
      queryState.metadataReceiver.length +
      queryState.metadataHash.length,
    metadataOptionsCount:
      options.metadataCcs.length +
      options.metadataSenders.length +
      options.metadataReceivers.length +
      options.metadataHashes.length,
  };
}
