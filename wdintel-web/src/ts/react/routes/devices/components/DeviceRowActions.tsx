import EditIcon from '@mui/icons-material/Edit';

import { MrtRowActionButton } from '../../../components/MrtRowActionButton';
import type { DeviceRowView } from '../helpers';

type Props = {
  row: DeviceRowView;
  canEdit: boolean;
  disabled: boolean;
  onEdit: (deviceId: string) => void;
};

export function DeviceRowActions({ row, canEdit, disabled, onEdit }: Props) {
  if (!canEdit) return null;
  return (
    <MrtRowActionButton
      label="Редагувати"
      icon={<EditIcon fontSize="small" />}
      disabled={disabled}
      opensModal
      onClick={() => onEdit(row.id)}
    />
  );
}
