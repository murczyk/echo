import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import { Tooltip } from '@mui/material';

import { IconButton } from '../../../../../../icon-button';
import { useTableStateContext } from '../../../../../table-state-provider';

type ClearFiltersButtonProps = {
  disabled?: boolean;
};

export function ClearFiltersButton(props: ClearFiltersButtonProps) {
  const tableStateContext = useTableStateContext();

  function onClickClearFilters() {
    const updatedParams = tableStateContext.onColumnFiltersChange([]);
    tableStateContext.onSortingChange([], updatedParams);
  }

  if (tableStateContext.columnFilters.length === 0 && tableStateContext.sorting.length === 0) {
    return null;
  }

  if (props.disabled) {
    return (
      <IconButton disabled={props.disabled} size="small">
        <FilterAltOffIcon />
      </IconButton>
    );
  }

  return (
    <Tooltip title="Очистити фільтри та сортування по стовпцях">
      <span className="relative">
        <div className="bg-red-500 absolute top-1 right-1 h-2 w-2 rounded-full z-10" />
        <IconButton disabled={props.disabled} onClick={onClickClearFilters} size="small">
          <FilterAltOffIcon />
        </IconButton>
      </span>
    </Tooltip>
  );
}
