import { TableStateProvider } from '../../../components/mui-customized/table/table-state-provider';
import { buildNetworkColumnOrder } from './NetworkCallsignsTableShared';
import { DEFAULT_NETWORK_FREQ_SORTING } from '../frequency-utils';
import {
  NetworkDetailsFrequenciesTable,
  type NetworkDetailsFrequenciesTableProps,
} from './NetworkDetailsFrequenciesTable';

const DEFAULT_COLUMNS_VISIBILITY = {
  'mrt-row-numbers': true,
  displayFreq: true,
  typeLabel: true,
  encryptionLabel: true,
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
        dataColumnIds: [
          'displayFreq',
          'typeLabel',
          'encryptionLabel',
          'messageCount',
          'callsignLabel',
          'lastDatetime',
        ],
      })}
      defaultSorting={DEFAULT_NETWORK_FREQ_SORTING}
    >
      <NetworkDetailsFrequenciesTable {...props} />
    </TableStateProvider>
  );
}
