import { Rating } from '@mui/material';
import type { DeviceRowView } from '../helpers';

export function DeviceRating({
  row,
  canRate,
  disabled,
  onRate,
}: {
  row: DeviceRowView;
  canRate: boolean;
  disabled: boolean;
  onRate: (deviceId: string, rating: number) => void;
}) {
  return (
    <Rating
      name={`device-rating-${row.id}`}
      value={row.rating}
      readOnly={!canRate || row.archived}
      disabled={disabled}
      getLabelText={(value) => `${value} із 5`}
      emptyLabelText="Без оцінки"
      onChange={(_event, value) => onRate(row.id, value ?? 0)}
    />
  );
}
