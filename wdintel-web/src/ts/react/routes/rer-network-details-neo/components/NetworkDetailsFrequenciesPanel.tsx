import { TableStateProvider } from '../../../components/mui-customized/table/table-state-provider';
import { buildNetworkColumnOrder } from './NetworkCallsignsTableShared';
import { NetworkDetailsFrequenciesTable, type NetworkDetailsFrequenciesTableProps } from './NetworkDetailsFrequenciesTable';

const DEFAULT_COLUMNS_VISIBILITY = {
  'mrt-row-numbers': true,
  displayFreq: true,
  typeLabel: true,
  messageCount: true,
  callsignLabel: true,
  lastDatetime: true,
};

export type Props = NetworkDetailsFrequenciesTableProps;

export function NetworkDetailsFrequenciesPanel(props: Props) {
  return (
    <TableStateProvider
      tableId="network-details-frequencies"
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultColumnOrder={buildNetworkColumnOrder({
        dataColumnIds: ['displayFreq', 'typeLabel', 'messageCount', 'callsignLabel', 'lastDatetime'],
      })}
    >
      <NetworkDetailsFrequenciesTable {...props} />
    </TableStateProvider>
  );
}
