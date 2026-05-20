import { createFilterOptions } from '@mui/material/Autocomplete';

export type NetworkEditLookupOption = {
  id: number;
  label: string;
};

export const networkEditLookupFilterOptions = createFilterOptions<NetworkEditLookupOption>({
  stringify: (option) => option.label,
  limit: 10,
});
