import { summarizeAnalysisDebugFilters } from './analysis-debug';
import type { AnalysisQueryState } from './types';

type AnalysisActiveFilterCountOptions = {
  hideGroupSelection: boolean;
  radioFeaturesAllowed: boolean;
};

export function getAnalysisActiveFilterCount(
  queryState: AnalysisQueryState,
  options: AnalysisActiveFilterCountOptions,
): number {
  const summary = summarizeAnalysisDebugFilters(queryState);
  const hiddenFilterCount =
    Number(summary.hasSearch) +
    Number(options.hideGroupSelection && queryState.groupsSelected.length > 0) +
    Number(!options.radioFeaturesAllowed && queryState.includePelengLocations === false);

  return Math.max(0, summary.activeFilterCount - hiddenFilterCount);
}
