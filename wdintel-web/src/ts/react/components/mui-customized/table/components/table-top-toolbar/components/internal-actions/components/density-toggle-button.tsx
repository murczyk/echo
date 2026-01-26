import DensityLargeIcon from '@mui/icons-material/DensityLarge';
import DensityMediumIcon from '@mui/icons-material/DensityMedium';
import DensitySmallIcon from '@mui/icons-material/DensitySmall';
import { Tooltip } from '@mui/material';

import { IconButton } from '../../../../../../icon-button';
import { useTableStateContext } from '../../../../../table-state-provider';

type DensityToggleButtonProps = {
  disabled?: boolean;
};

export function DensityToggleButton(props: DensityToggleButtonProps) {
  const tableStateContext = useTableStateContext();

  function onClickChangeDensity() {
    if (tableStateContext.density === 'compact') {
      tableStateContext.setDensity('comfortable');
    }
    if (tableStateContext.density === 'comfortable') {
      tableStateContext.setDensity('spacious');
    }
    if (tableStateContext.density === 'spacious') {
      tableStateContext.setDensity('compact');
    }
  }

  return (
    <Tooltip title="Перемкнути щільність">
      <span>
        <IconButton disabled={props.disabled} onClick={onClickChangeDensity}>
          {tableStateContext.density === 'compact' && <DensitySmallIcon />}
          {tableStateContext.density === 'comfortable' && <DensityMediumIcon />}
          {tableStateContext.density === 'spacious' && <DensityLargeIcon />}
        </IconButton>
      </span>
    </Tooltip>
  );
}
