import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import RestoreIcon from '@mui/icons-material/Restore';

import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import type { DeviceRowView } from '../helpers';

type Props = {
  row: DeviceRowView;
  canEdit: boolean;
  disabled: boolean;
  onEdit: (deviceId: string) => void;
  onDelete: (deviceId: string, deviceName: string) => void;
  onRestore: (deviceId: string) => void;
};

export function DeviceRowActions({ row, canEdit, disabled, onEdit, onDelete, onRestore }: Props) {
  if (!canEdit) return null;

  return (
    <MrtRowActions forceMenu>
      {row.deleted ? (
        <MrtRowActionButton
          key="restore"
          label="Відновити"
          icon={<RestoreIcon fontSize="small" />}
          disabled={disabled}
          onClick={() => onRestore(row.id)}
        />
      ) : (
        [
          <MrtRowActionButton
            key="edit"
            label="Редагувати"
            icon={<EditIcon fontSize="small" />}
            disabled={disabled}
            onClick={() => onEdit(row.id)}
          />,
          <MrtRowActionButton
            key="delete"
            label="Видалити"
            icon={<DeleteOutlineIcon fontSize="small" />}
            disabled={disabled}
            tone="danger"
            onClick={() => onDelete(row.id, row.name)}
          />,
        ]
      )}
    </MrtRowActions>
  );
}
