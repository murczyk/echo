import EditIcon from '@mui/icons-material/Edit';

import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import type { DeviceRowView } from '../helpers';

type Props = {
  row: DeviceRowView;
  canEdit: boolean;
  disabled: boolean;
  onEdit: (deviceId: string) => void;
};

export function DeviceRowActions({ row, canEdit, disabled, onEdit }: Props) {
  if (!canEdit || row.archived) return null;

  return (
    <MrtRowActions forceMenu>
      <MrtRowActionButton
        label="Редагувати"
        icon={<EditIcon fontSize="small" />}
        disabled={disabled}
        onClick={() => onEdit(row.id)}
      />
    </MrtRowActions>
  );
}
