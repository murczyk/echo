import { createRankedFilterOptions } from '../../../utils/search-filter';

export type NetworkEditLookupOption = {
  id: number;
  label: string;
};

export const networkEditLookupFilterOptions = createRankedFilterOptions<NetworkEditLookupOption>(
  (option) => option.label,
  20,
);
