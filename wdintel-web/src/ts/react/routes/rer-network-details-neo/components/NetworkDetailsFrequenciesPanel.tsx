import { TableStateProvider } from '../../../components/mui-customized/table/table-state-provider';
import { buildDefaultColumnOrder } from '../../../components/mui-customized/table/get-default-table-options';
import { NetworkDetailsFrequenciesTable, type NetworkDetailsFrequenciesTableProps } from './NetworkDetailsFrequenciesTable';

const DEFAULT_COLUMNS_VISIBILITY = {
  displayFreq: true,
  typeLabel: true,
  encryptionLabel: true,
  messageCount: true,
  callsignLabel: true,
  lastDatetime: true,
  status: true,
};

const DEFAULT_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['displayFreq', 'typeLabel', 'encryptionLabel', 'messageCount', 'callsignLabel', 'lastDatetime', 'status'],
  withRowNumbers: true,
  withRowActions: true,
});

export type Props = NetworkDetailsFrequenciesTableProps;

export function NetworkDetailsFrequenciesPanel(props: Props) {
  return (
    <TableStateProvider
      tableId="network-details-frequencies"
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
    >
      <NetworkDetailsFrequenciesTable {...props} />
    </TableStateProvider>
  );
}
