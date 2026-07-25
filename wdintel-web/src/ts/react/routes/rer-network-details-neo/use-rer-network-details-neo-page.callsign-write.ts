export type NetworkCallsignWritePayload = {
  id?: number;
  networkId: number;
  callsign: string;
  fullName: string | null;
  position: string | null;
  comment: string | null;
  sourceId: number | null;
  radioFreq: string | null;
  unitId: number | null;
  unitDeveloping: boolean;
  developing: boolean;
  mainRadioStation: boolean;
  commandControl: boolean;
};

type BuildNetworkCallsignWritePayloadInput = {
  networkId: number;
  callsign: string;
  fullName: string;
  position: string;
  comment: string;
  sourceId: number | null;
  radioFreq: string;
  unitId: number | null;
  unitDeveloping: boolean;
  developing: boolean;
  mainRadioStation: boolean;
  commandControl: boolean;
};

type NetworkCallsignMarkerOverrides = {
  mainRadioStation?: boolean;
  commandControl?: boolean;
};

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function buildNetworkCallsignWritePayload(
  input: BuildNetworkCallsignWritePayloadInput,
  overrides: NetworkCallsignMarkerOverrides = {},
): NetworkCallsignWritePayload {
  return {
    networkId: input.networkId,
    callsign: input.callsign,
    fullName: trimOrNull(input.fullName),
    position: trimOrNull(input.position),
    comment: trimOrNull(input.comment),
    sourceId: input.sourceId,
    radioFreq: trimOrNull(input.radioFreq),
    unitId: input.unitId,
    unitDeveloping: input.unitDeveloping,
    developing: input.developing,
    mainRadioStation: overrides.mainRadioStation ?? input.mainRadioStation,
    commandControl: overrides.commandControl ?? input.commandControl,
  };
}
