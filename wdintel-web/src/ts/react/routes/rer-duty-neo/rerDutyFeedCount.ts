import type { MessageFeedState } from './utils';

export function buildFeedCountSignature(feed: MessageFeedState, freqs: string[]): string {
  return JSON.stringify({
    historySinceMs: feed.historySinceMs ?? null,
    unitsIncludeChildren: feed.unitsIncludeChildren ?? false,
    groupScopeMasterKey: feed.groupScopeMasterKey ?? null,
    filter: {
      search: feed.filter.search ?? null,
      searchMode: feed.filter.searchMode ?? null,
      groupsSelected: feed.filter.groupsSelected ?? null,
      deniedGroups: feed.filter.groupsDenied ?? null,
      sendersSelected: feed.filter.sendersSelected ?? null,
      deniedSenders: feed.filter.deniedSenders ?? null,
      freqsSelected: feed.filter.freqsSelected ?? null,
      freqsDenied: feed.filter.freqsDenied ?? null,
      postsSelected: feed.filter.postsSelected ?? null,
      postsDenied: feed.filter.postsDenied ?? null,
      unitsSelected: feed.filter.unitsSelected ?? null,
      unitsDenied: feed.filter.unitsDenied ?? null,
      unitsExactMatchOnly: feed.filter.unitsExactMatchOnly ?? null,
      locationsSelected: feed.filter.locationsSelected ?? null,
      locationsDenied: feed.filter.locationsDenied ?? null,
      includePelengLocations: feed.filter.includePelengLocations ?? null,
    },
    freqUniverse: feed.adjacentFreqsRange > 0 ? freqs : null,
    adjacentFreqsRange: feed.adjacentFreqsRange ?? 0,
    highlightSignalsEnabled: feed.highlightSignalsEnabled ?? false,
  });
}
