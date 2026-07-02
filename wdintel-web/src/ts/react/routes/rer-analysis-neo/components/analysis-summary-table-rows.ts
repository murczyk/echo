import type { CallsignInfoRes, Network, SummaryTableFreqRow, Unit } from '../../../../../Bindings';

import { formatCallsignHintTooltip, getCallsignHintResult } from '../callsign-hints';

export type AnalysisSummaryTableCallsignChip = {
  callsign: string;
  tooltip: string | null;
  iconClass: string;
  isHighlighted: boolean;
};

export type AnalysisSummaryTableRowView = {
  freq: string;
  count: number;
  coordinateLabels: string[];
  callsignChips: AnalysisSummaryTableCallsignChip[];
  unitLabels: string[];
  editableUnits: string[];
  locationLabels: string[];
};

function freqNetworks(freq: string, networks: Network[]): Network[] {
  return networks.filter((network) => network.freqs.some((item) => item.freq === freq));
}

function sortCallsigns(params: {
  row: SummaryTableFreqRow;
  networks: Network[];
  unitsMap: Record<number, Unit>;
  callsignInfoMap: Record<string, CallsignInfoRes>;
}): AnalysisSummaryTableCallsignChip[] {
  return params.row.callsigns
    .map((callsign, index) => {
      const hint = getCallsignHintResult({
        hintContext: 'frequency',
        freq: params.row.freq,
        networks: params.networks,
        unitsMap: params.unitsMap,
        callsignInfoMap: params.callsignInfoMap,
        callsign,
      });
      const tooltip = formatCallsignHintTooltip(hint);

      return {
        callsign,
        tooltip,
        iconClass: hint.iconClass,
        isHighlighted: Boolean(tooltip),
        index,
      };
    })
    .sort((left, right) => {
      const leftPriority = left.isHighlighted ? 0 : 1;
      const rightPriority = right.isHighlighted ? 0 : 1;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .map(({ index: _index, ...entry }) => entry);
}

export function buildAnalysisSummaryTableRows(params: {
  rows: SummaryTableFreqRow[];
  networks: Network[];
  networkDisplayMap: Record<number, string>;
  unitsMap: Record<number, Unit>;
  callsignInfoMap: Record<string, CallsignInfoRes>;
}): AnalysisSummaryTableRowView[] {
  return params.rows.map((row) => {
    const linkedNetworks = freqNetworks(row.freq, params.networks);

    return {
      freq: row.freq,
      count: row.count,
      coordinateLabels: row.localityCoords.map((item) => item.locality.split(',')[0]),
      callsignChips: sortCallsigns({
        row,
        networks: params.networks,
        unitsMap: params.unitsMap,
        callsignInfoMap: params.callsignInfoMap,
      }),
      unitLabels: [
        ...linkedNetworks.map(
          (network) => params.networkDisplayMap[network.id] ?? `р/м ${network.name}`,
        ),
        ...row.units,
      ],
      editableUnits: row.units,
      locationLabels: row.locations,
    };
  });
}
