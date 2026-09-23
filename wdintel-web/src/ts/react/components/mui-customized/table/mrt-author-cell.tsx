import type { MRT_RowData } from 'material-react-table';
import { AuthorLabel } from '../../AuthorLabel';
import { mrtCustomCell } from './get-default-table-options';
import { MrtOverflowText } from './mrt-overflow';

export const AUTHOR_COLUMN_META = {
  overflowMode: 'custom',
  overflowOwner: 'shared-text',
  interactive: true,
} as const;

export function mrtAuthorCell<TData extends MRT_RowData>(
  getLogin: (row: TData) => string | null | undefined,
) {
  return mrtCustomCell<TData>(({ row }) => {
    const login = getLogin(row.original);
    return (
      <MrtOverflowText interactive displayValue={<AuthorLabel login={login} />} fullValue={login} />
    );
  });
}
