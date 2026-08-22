import type { MRT_RowData } from 'material-react-table';

import type { AppMrtColumnDef } from './get-default-table-options';
import { mrtItemsCell, mrtTextCell } from './get-default-table-options';

type Row = MRT_RowData & { name: string; values: string[] };

const textCell = mrtTextCell<Row>({ displayValue: ({ row }) => row.original.name });
const itemsCell = mrtItemsCell<Row, string>({
  items: ({ row }) => row.original.values,
  renderItem: (value) => value,
  measurementScope: 'mrt-column-contract:values',
});

const columns: AppMrtColumnDef<Row>[] = [
  { accessorKey: 'name' },
  { accessorKey: 'name', Cell: textCell, meta: { overflowMode: 'text' } },
  { accessorKey: 'values', Cell: itemsCell, meta: { overflowMode: 'items' } },
  // @ts-expect-error custom cells require a policy
  { accessorKey: 'name', Cell: () => null },
  {
    id: 'group',
    columns: [
      // @ts-expect-error nested custom cells require a policy
      { accessorKey: 'name', Cell: () => null },
    ],
  },
  // @ts-expect-error text cells must use mrtTextCell
  { accessorKey: 'name', Cell: () => null, meta: { overflowMode: 'text' } },
  // @ts-expect-error item cells must use mrtItemsCell
  { accessorKey: 'values', Cell: () => null, meta: { overflowMode: 'items' } },
];

void columns;
