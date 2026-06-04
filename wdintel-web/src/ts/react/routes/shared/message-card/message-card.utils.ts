import type { InboxMessage, Network, NoHeadersBody } from '../../../../../Bindings';
import { NO_DATA_LABEL, isPresent } from '../../../utils/misc';
import { buildRerNetworkDetailsHref } from '../../rer-network-details-neo/network-details-preference';

export type EtalonBindingDisplayValue = {
  displayValue: string;
  copyValue: string | null;
};

export type MessageCardRenderedNetwork = {
  networkId: number;
  label: string;
  badge: boolean;
};

export type MessageCardNavigationMenuItem = {
  kind: 'network' | 'map' | 'analysis';
  href: string;
  label?: string;
  networkLabel?: string;
  badge?: boolean;
};

export type MessageCardEtalonDisplayModel = {
  primaryKind: 'network' | 'location' | 'unit' | 'empty';
  displayValue: string;
  copyEtalonValue: string | null;
  copyLocationValue: string | null;
  renderedNetworks: MessageCardRenderedNetwork[];
  showInlineLocationTooltip: boolean;
  locationDisplayValue: string | null;
};

type ResolveEtalonBindingDisplayValueOptions = {
  featureStrictNetworks?: boolean;
  networkDisplayMap?: Record<number, string>;
  networkMap?: Record<number, Network>;
  networks?: Network[];
};

function normalizeLabel(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function buildNetworkMap(
  options: ResolveEtalonBindingDisplayValueOptions,
): Record<number, Network> {
  if (options.networkMap) return options.networkMap;
  if (!options.networks) return {};
  return Object.fromEntries(options.networks.map((network) => [network.id, network]));
}

function uniqueNetworkIds(values: number[] | null | undefined): number[] {
  return Array.from(new Set(values ?? []));
}

function networkNeedsInvestigationBadge(network: Network | undefined): boolean {
  if (network == null) return false;
  const ids = network.unitIds;
  if (ids == null) return true;
  return ids.length === 0;
}

function hasLowercaseLetters(value: string): boolean {
  return value !== value.toUpperCase();
}

function titleCaseWord(value: string): string {
  const [first = '', ...rest] = value;
  return first.toLocaleUpperCase('uk-UA') + rest.join('').toLocaleLowerCase('uk-UA');
}

export function normalizeLocationDisplayValue(value: string | null | undefined): string | null {
  const normalizedLocation = String(value ?? '').trim();
  if (normalizedLocation === '' || normalizedLocation === 'Не встановлена') return null;
  if (hasLowercaseLetters(normalizedLocation)) return normalizedLocation;
  return normalizedLocation
    .toLocaleLowerCase('uk-UA')
    .split(/(\s+|-)/)
    .map((part) => (part.trim() === '' || part === '-' ? part : titleCaseWord(part)))
    .join('');
}

export function resolveMessageCardRenderedNetworks(
  networkIds: number[] | null | undefined,
  options: Pick<ResolveEtalonBindingDisplayValueOptions, 'networkDisplayMap' | 'networkMap' | 'networks'> = {},
): MessageCardRenderedNetwork[] {
  const networkMap = buildNetworkMap(options);
  const renderedNetworks = uniqueNetworkIds(networkIds)
    .map((networkId) => {
      const network = networkMap[networkId];
      const label = normalizeLabel(options.networkDisplayMap?.[networkId] ?? network?.name ?? null);
      if (label === '') return null;
      return {
        networkId,
        label: options.networkDisplayMap?.[networkId] ?? (network ? `р/м ${network.name}` : ''),
        badge: networkNeedsInvestigationBadge(network),
      };
    })
    .filter((network): network is MessageCardRenderedNetwork => network != null && normalizeLabel(network.label) !== '');

  return renderedNetworks.filter((item, index, all) => index === all.findIndex((other) => other.networkId === item.networkId));
}

export function buildMessageCardNavigationMenuItems(
  renderedNetworks: MessageCardRenderedNetwork[],
  mapHref: string | null | undefined,
  analysisHref: string | null | undefined,
): MessageCardNavigationMenuItem[] {
  const items: MessageCardNavigationMenuItem[] = renderedNetworks.map((network) => ({
    kind: 'network',
    href: buildRerNetworkDetailsHref(network.networkId),
    networkLabel: network.label,
    badge: network.badge,
  }));
  if (isPresent(mapHref) && mapHref.trim() !== '') {
    items.push({ kind: 'map', href: mapHref, label: 'На мапу' });
  }
  if (isPresent(analysisHref) && analysisHref.trim() !== '') {
    items.push({ kind: 'analysis', href: analysisHref, label: 'В аналіз' });
  }
  return items;
}

export function resolveEtalonBindingDisplayValue(
  msg: InboxMessage,
  options: ResolveEtalonBindingDisplayValueOptions = {},
): EtalonBindingDisplayValue {
  const networkIds = uniqueNetworkIds(msg.networkIds);
  const networkMap = buildNetworkMap(options);
  const labels = networkIds
    .map((networkId) => {
      const label = normalizeLabel(options.networkDisplayMap?.[networkId] ?? networkMap[networkId]?.name ?? null);
      if (label === '') return null;
      return options.networkDisplayMap?.[networkId] ?? (networkMap[networkId] ? `р/м ${networkMap[networkId].name}` : null);
    })
    .filter((label): label is string => normalizeLabel(label) !== '');

  if (labels.length > 0) {
    const displayValue = labels.join('\n');
    return {
      displayValue,
      copyValue: displayValue,
    };
  }

  if (networkIds.length > 0) {
    return {
      displayValue: NO_DATA_LABEL,
      copyValue: null,
    };
  }

  const unit = options.featureStrictNetworks ? '' : normalizeLabel(msg.unit);
  if (unit !== '') {
    return {
      displayValue: unit,
      copyValue: unit,
    };
  }

  return {
    displayValue: NO_DATA_LABEL,
    copyValue: null,
  };
}

const MESSAGE_DATETIME_COMMA_REGEXP = /^\d{2}\.\d{2}\.\d{4},\s*\d{2}:\d{2}:\d{2}/;
const MESSAGE_DATETIME_UNDERSCORE_REGEXP = /^\d{2}\.\d{2}\.\d{4}_\d{1,2}:\d{2}(?::\d{2})?/;
const MESSAGE_DATETIME_ISO_T_REGEXP = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?/;
const MESSAGE_DATETIME_ISO_UNDERSCORE_REGEXP = /^\d{4}-\d{2}-\d{2}_\d{1,2}:\d{2}(?::\d{2})?/;
const LEGACY_HEADER_FREQUENCY_REGEXP = /\s*F=\d{1,4}[.,]?\d*\(МГц\)/i;
const STANDALONE_FREQUENCY_LINE_REGEXP = /^\d{1,4}[.,]\d+$/;
const COORDS_METADATA_LINE_REGEXP = /^\d{2}\.\d{5,7}\s*,\s*\d{2}\.\d{5,7}$/;
const EMBEDDED_FREQUENCY_REGEXP = /\s*(?:F=)?\d{1,4}[.,]?\d*(?:\s*\(МГц\)|\s*МГц|\s*MHz|\s*\(MHz\))\s*/gi;

function isMessageDateTimeLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    MESSAGE_DATETIME_COMMA_REGEXP.test(trimmed) ||
    MESSAGE_DATETIME_UNDERSCORE_REGEXP.test(trimmed) ||
    MESSAGE_DATETIME_ISO_T_REGEXP.test(trimmed) ||
    MESSAGE_DATETIME_ISO_UNDERSCORE_REGEXP.test(trimmed)
  );
}

function findMessageDateTimeLineIndex(lines: string[]): number {
  return lines.findIndex((line) => isMessageDateTimeLine(line));
}

function isStandaloneFrequencyLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && STANDALONE_FREQUENCY_LINE_REGEXP.test(trimmed);
}

function stripEmbeddedFrequencyFromLine(line: string): string {
  return line.replace(EMBEDDED_FREQUENCY_REGEXP, ' ').replace(/\s{2,}/g, ' ').trimEnd();
}

function normalizeHeaderLineWithEmbeddedFrequency(line: string, datetimePart: string): string {
  const trimmed = line.trim();
  const rest = trimmed
    .slice(datetimePart.length)
    .replace(LEGACY_HEADER_FREQUENCY_REGEXP, '')
    .replace(EMBEDDED_FREQUENCY_REGEXP, ' ')
    .trim();
  const normalized = rest === '' ? datetimePart : `${datetimePart} ${rest}`;
  return line.startsWith(' ') || line.startsWith('\t') ? line.replace(trimmed, normalized) : normalized;
}

function normalizeMetadataLineForCopy(line: string): string {
  const trimmed = line.trim();
  if (trimmed === '') return line;

  const legacyDatetimeMatch = trimmed.match(/^(\d{2}\.\d{2}\.\d{4}_\d{1,2}:\d{2}(?::\d{2})?)/);
  if (legacyDatetimeMatch != null) {
    return normalizeHeaderLineWithEmbeddedFrequency(line, legacyDatetimeMatch[1]);
  }

  const isoDatetimeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}[T_]\d{1,2}:\d{2}(?::\d{2})?)/);
  if (isoDatetimeMatch != null) {
    return normalizeHeaderLineWithEmbeddedFrequency(line, isoDatetimeMatch[1]);
  }

  return stripEmbeddedFrequencyFromLine(line);
}

function isCoordsMetadataLine(line: string): boolean {
  return COORDS_METADATA_LINE_REGEXP.test(line.trim());
}

function isUnitMetadataLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:\[DMR\]\s+)?(?:УКХ|управління)\s/i.test(trimmed) || /р\/м/i.test(trimmed);
}

/**
 * Determines if a line is part of the message body (not metadata).
 * Returns true for:
 *   - Lines starting with em-dashes ("—") or dashes ("- ", "--").
 *     These are typical for transcript/dialogue formatting.
 * No real messages found with numeric lists, so do not match number-prefixed bullets.
 * Ignores blank lines and metadata/header-like lines.
 */
function isMessageBodyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('—')) return true;
  if (trimmed.startsWith('- ') || trimmed.startsWith('--')) return true;
  return false;
}

function findFirstMessageBodyLineIndex(lines: string[]): number {
  return lines.findIndex((line) => isMessageBodyLine(line));
}

export function extractMessageTextForCopy(rawText: string): string {
  const lines = rawText.split('\n');
  const startIndex = findMessageDateTimeLineIndex(lines);
  const relevantLines = startIndex >= 0 ? lines.slice(startIndex) : [...lines];
  const bodyStartIndex = findFirstMessageBodyLineIndex(relevantLines);
  const metadataEndIndex = bodyStartIndex >= 0 ? bodyStartIndex : relevantLines.length;
  const processed: string[] = [];

  for (let index = 0; index < relevantLines.length; index += 1) {
    const line = relevantLines[index] ?? '';
    if (index >= metadataEndIndex) {
      processed.push(line);
      continue;
    }
    if (line.trim() === '') {
      processed.push(line);
      continue;
    }
    if (isStandaloneFrequencyLine(line)) continue;
    processed.push(normalizeMetadataLineForCopy(line));
  }

  while (processed.length > 0 && processed[processed.length - 1]?.trim() === '') {
    processed.pop();
  }

  return processed.join('\n').trimEnd();
}

function findNetworkReplacementLineIndex(lines: string[], datetimeIndex: number): number {
  let replaceIndex = datetimeIndex + 1;
  while (replaceIndex < lines.length) {
    const line = lines[replaceIndex] ?? '';
    if (line.trim() === '' || isCoordsMetadataLine(line)) {
      replaceIndex += 1;
      continue;
    }
    return replaceIndex;
  }
  return replaceIndex;
}

function buildCopyTextWithNetworkFromNoHeadersBody(networkName: string, noHeadersBody: NoHeadersBody): string {
  const body = normalizeLabel(noHeadersBody.body);
  if (body === '') return networkName;
  return `${networkName}\n\n${body}`;
}

function insertNetworkNameIntoExtractedMessage(
  extractedText: string,
  networkName: string,
  noHeadersBody?: NoHeadersBody | null,
): string {
  const lines = extractedText.split('\n');
  const datetimeIndex = findMessageDateTimeLineIndex(lines);
  if (datetimeIndex < 0) {
    if (noHeadersBody != null && normalizeLabel(noHeadersBody.body) !== '') {
      return buildCopyTextWithNetworkFromNoHeadersBody(networkName, noHeadersBody);
    }
    return `${networkName}\n${extractedText}`.trim();
  }

  const replaceIndex = findNetworkReplacementLineIndex(lines, datetimeIndex);

  if (replaceIndex >= lines.length) {
    return [...lines, networkName].join('\n');
  }

  if (isMessageBodyLine(lines[replaceIndex] ?? '')) {
    lines.splice(replaceIndex, 0, networkName);
    return lines.join('\n');
  }

  if (isUnitMetadataLine(lines[replaceIndex] ?? '')) {
    lines[replaceIndex] = networkName;
    return lines.join('\n');
  }

  lines.splice(replaceIndex, 0, networkName);
  return lines.join('\n');
}

export function buildCopyTextWithNetworkName(
  rawText: string,
  networkName: string | null | undefined,
  noHeadersBody?: NoHeadersBody | null,
): string {
  const extractedText = extractMessageTextForCopy(rawText);
  const network = normalizeLabel(networkName);
  if (network === '') return extractedText;
  return insertNetworkNameIntoExtractedMessage(extractedText, network, noHeadersBody);
}

export function buildCopyTextWithNetworkAndNote(
  rawText: string,
  networkName: string | null | undefined,
  note: string | null | undefined,
  noHeadersBody?: NoHeadersBody | null,
): string {
  const noteText = normalizeLabel(note);
  const messageWithNetwork = buildCopyTextWithNetworkName(rawText, networkName, noHeadersBody);
  if (noteText === '') return messageWithNetwork;
  return `${noteText}\n\n${messageWithNetwork}`;
}

export function resolveMessageCardEtalonDisplayModel(
  msg: InboxMessage,
  options: ResolveEtalonBindingDisplayValueOptions = {},
): MessageCardEtalonDisplayModel {
  const renderedNetworks = resolveMessageCardRenderedNetworks(msg.networkIds, options);
  const locationDisplayValue = normalizeLocationDisplayValue(msg.location);
  const etalonBindingValue = resolveEtalonBindingDisplayValue(msg, options);

  if (renderedNetworks.length > 0) {
    const displayValue = renderedNetworks.map((network) => network.label).join('\n');
    return {
      primaryKind: 'network',
      displayValue,
      copyEtalonValue: displayValue,
      copyLocationValue: null,
      renderedNetworks,
      showInlineLocationTooltip: locationDisplayValue != null,
      locationDisplayValue,
    };
  }

  if (locationDisplayValue != null) {
    return {
      primaryKind: 'location',
      displayValue: locationDisplayValue,
      copyEtalonValue: null,
      copyLocationValue: locationDisplayValue,
      renderedNetworks,
      showInlineLocationTooltip: false,
      locationDisplayValue,
    };
  }

  if (etalonBindingValue.copyValue != null) {
    return {
      primaryKind: 'unit',
      displayValue: etalonBindingValue.displayValue,
      copyEtalonValue: etalonBindingValue.copyValue,
      copyLocationValue: null,
      renderedNetworks,
      showInlineLocationTooltip: false,
      locationDisplayValue: null,
    };
  }

  return {
    primaryKind: 'empty',
    displayValue: NO_DATA_LABEL,
    copyEtalonValue: null,
    copyLocationValue: null,
    renderedNetworks,
    showInlineLocationTooltip: false,
    locationDisplayValue: null,
  };
}
