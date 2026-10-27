import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { MaterialReactTable } from 'material-react-table';
import { useMemo } from 'react';

import type { SettlementAliasItem } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import {
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  renderDefaultMrtEmptyRowsFallback,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';

export function SettlementAliasesTable({
  aliases,
  loading,
  onEdit,
  onDelete,
}: {
  aliases: SettlementAliasItem[];
  loading: boolean;
  onEdit: (alias: SettlementAliasItem) => void;
  onDelete: (alias: SettlementAliasItem) => void;
}) {
  const columns = useMemo<AppMrtColumnDef<SettlementAliasItem>[]>(
    () => [
      { header: 'Синонім', accessorKey: 'text' },
      { header: 'Населений пункт', accessorKey: 'settlement.name' },
      { header: 'Район', accessorKey: 'settlement.district' },
      { header: 'Область', accessorKey: 'settlement.region' },
    ],
    [],
  );
  const table = useAppMaterialReactTable({
    columns,
    data: aliases,
    getRowId: (alias) => alias.id,
    state: { isLoading: loading },
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <MrtRowActions>
        <MrtRowActionButton
          label="Редагувати"
          disabled={loading}
          icon={<EditIcon fontSize="small" />}
          onClick={() => onEdit(row.original)}
          opensModal
        />
        <MrtRowActionButton
          label="Видалити"
          disabled={loading}
          icon={<DeleteIcon fontSize="small" />}
          onClick={() => onDelete(row.original)}
          tone="danger"
          opensModal
        />
      </MrtRowActions>
    ),
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table }),
    muiTableContainerProps: getDefaultMrtContainerProps({ hasRows: aliases.length > 0 }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({ table, noDataMessage: 'Синонімів ще немає.' }),
  });
  return <MaterialReactTable table={table} />;
}
