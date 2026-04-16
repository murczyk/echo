import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import { Tooltip } from '@mui/material';

import { PowerIconButton } from '../../../../../../../PowerIconButton';
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
      <PowerIconButton disabled={props.disabled} size="small">
        <FilterAltOffIcon />
      </PowerIconButton>
    );
  }

  return (
    <Tooltip title="Очистити фільтри та сортування по стовпцях">
      <span className="relative">
        <div className="bg-red-500 absolute top-1 right-1 h-2 w-2 rounded-full z-10" />
        <PowerIconButton disabled={props.disabled} onClick={onClickClearFilters} size="small">
          <FilterAltOffIcon />
        </PowerIconButton>
      </span>
    </Tooltip>
  );
}
