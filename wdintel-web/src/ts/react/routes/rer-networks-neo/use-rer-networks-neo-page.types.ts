import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type { NetworksFilterState } from './helpers';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';

export type UiMessage = { kind: 'info' | 'success' | 'error'; text: string } | null;

export type ActivityByNetworkId = Map<number, Record<string, Record<string, number>>>;
export type NetworkActivityLoadState = 'loading' | 'loaded' | 'error';
export type ActivityLoadStateByNetworkId = Map<number, NetworkActivityLoadState>;

export type NetworksQuerySnapshot = {
  globalFilter: string;
  columnFilters: MRT_ColumnFiltersState;
  sorting: MRT_SortingState;
  filters: NetworksFilterState;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  fullQueryKey: string;
};
