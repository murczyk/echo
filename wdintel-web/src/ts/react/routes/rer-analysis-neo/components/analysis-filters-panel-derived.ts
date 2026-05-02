import type { AnalysisFilterOption } from '../types';
import { normalizeFilterLabel, sortFilterOptionsByLabel } from '../use-analysis-data.shared';

import type { AnalysisFiltersPanelPage } from './analysis-filters-panel-shared';

type Params = Pick<AnalysisFiltersPanelPage, 'aorEntries' | 'counts' | 'groupInfos' | 'options' | 'queryState' | 'tagsMap'>;

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

export function buildAnalysisFiltersPanelDerivedData({ aorEntries, groupInfos, options, queryState, tagsMap }: Params): AnalysisFiltersPanelDerivedData {
  const groupOptions = sortFilterOptionsByLabel(
    options.groups.map((option) => ({
      ...option,
      label: normalizeFilterLabel(groupInfos[option.value]?.name ?? option.label ?? option.value),
    })),
  );

  const callsignsOptions = options.callsigns.reduce<AnalysisFilterOption[]>((acc, option) => {
    const label = (option.label ?? option.value).toUpperCase();
    const values = Array.from(new Set(option.values ?? [option.value]));
    const existingOption = acc.find((item) => item.label === label);
    if (existingOption != null) {
      existingOption.values = Array.from(new Set([...(existingOption.values ?? []), ...values]));
      existingOption.count += option.count;
      return acc;
    }
    acc.push({ value: label, label, count: option.count, values });
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

  const tagOptions = sortFilterOptionsByLabel(
    options.tags.map((option) => ({
      ...option,
      label: normalizeFilterLabel(tagsMap[Number(option.value)]?.label ?? option.label ?? option.value),
    })),
  );

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
    options.units.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );

  const importantSelectedCount =
    Number(queryState.orWithExtendedForm) +
    Number(queryState.orBookmarked) +
    Number(queryState.orImportant) +
    (queryState.orWithCoords && queryState.orWithoutCoords ? 0 : Number(queryState.orWithCoords) + Number(queryState.orWithoutCoords));

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
    groupsSelectedCount: queryState.groupsSelected.length,
    sendersSelectedCount: queryState.sendersSelected.length,
    freqsSelectedCount: queryState.freqsSelected.length,
    callsignsSelectedCount: queryState.callsignsSelected.length,
    unitsSelectedCount: queryState.unitsSelected.length,
    locationsSelectedCount: queryState.locationsSelected.length,
    postsSelectedCount: queryState.postsSelected.length,
    networksSelectedCount: queryState.networksSelected.length,
    metadataSelectedCount:
      queryState.metadataCc.length + queryState.metadataSender.length + queryState.metadataReceiver.length + queryState.metadataHash.length,
    metadataOptionsCount:
      options.metadataCcs.length + options.metadataSenders.length + options.metadataReceivers.length + options.metadataHashes.length,
  };
}
