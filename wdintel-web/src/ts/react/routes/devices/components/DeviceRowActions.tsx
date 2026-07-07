import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import EditIcon from '@mui/icons-material/Edit';
import RestoreIcon from '@mui/icons-material/Restore';

import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import type { DeviceRowView } from '../helpers';

type Props = {
  row: DeviceRowView;
  canEdit: boolean;
  disabled: boolean;
  onEdit: (deviceId: string) => void;
  onArchive: (deviceId: string, deviceName: string) => void;
  onRestore: (deviceId: string) => void;
};

export function DeviceRowActions({ row, canEdit, disabled, onEdit, onArchive, onRestore }: Props) {
  if (!canEdit) return null;

  return (
    <MrtRowActions forceMenu>
      {row.archived ? (
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
            key="archive"
            label="Архівувати"
            icon={<ArchiveOutlinedIcon fontSize="small" />}
            disabled={disabled}
            tone="danger"
            onClick={() => onArchive(row.id, row.name)}
          />,
        ]
      )}
    </MrtRowActions>
  );
}
