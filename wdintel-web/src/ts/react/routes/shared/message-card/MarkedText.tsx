import InfoIcon from '@mui/icons-material/Info';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import PlaceIcon from '@mui/icons-material/Place';
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import { useId, useState } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';
import type { Theme } from '@mui/material/styles';
import { isNullOrUndefined, isPresent } from '../../../utils/misc';

import type {
  CallsignInfoRes,
  ContentNode,
  InboxMessage,
  Network,
  SignalGroupEntry,
  Unit,
} from '../../../../../Bindings';
import { normalizeCallsignLookupValue } from '../../../utils/callsign-normalization';
import {
  buildAnalysisMapHrefWithSearch,
  uniquePointEtalonsForMapSearch,
} from '../../rer-duty-neo/utils';
import {
  formatMessageCallsignHintTooltipData,
  getMessageCallsignHintResult,
} from '../../rer-analysis-neo/callsign-hints';
import { renderLinkifiedText } from './message-card-linkify';
import {
  pointBlacklistLabelKey,
  type PointBlacklistRequestSource,
} from './point-highlight-blacklist';
import { PowerMenu } from '../../../components/PowerMenu';

const ORANGE_TOKEN_BG = '#fd884f';
const ORANGE_TOKEN_FG = '#000';

export const CALLSIGN_TOOLTIP_ITEM_SX = {
  fontSize: '0.875rem',
  lineHeight: 1.35,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  minWidth: 0,
} as const;

const CALLSIGN_HINT_WRAPPER_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  verticalAlign: 'baseline',
};

function collectPointEtalons(nodes: ContentNode[]): string[] {
  const etalons: string[] = [];
  for (const n of nodes) {
    if (typeof n !== 'string' && 'CNPointC' in n && isPresent(n.CNPointC?.etalon)) {
      const e = String(n.CNPointC.etalon).trim();
      if (e !== '') etalons.push(e);
    }
  }
  return etalons;
}

function collectHighlightedTexts(nodes: ContentNode[]): Set<string> {
  const texts = new Set<string>();
  for (const n of nodes) {
    if (typeof n !== 'string' && 'CNHighlightC' in n) {
      const text = normalizeCallsignLookupValue(n.CNHighlightC.text);
      if (text !== '') texts.add(text);
    }
  }
  return texts;
}

function collectSearchTerms(searchText?: string | null): Set<string> {
  const terms = new Set<string>();
  if (isNullOrUndefined(searchText)) return terms;

  searchText
    .split(/[\s,;:]+/g)
    .map((value) => normalizeCallsignLookupValue(value))
    .filter((value) => value !== '')
    .forEach((value) => terms.add(value));

  return terms;
}

function normalizeSearchToken(value: string): string {
  return normalizeCallsignLookupValue(value).replace(/[^0-9a-zа-яёіїєґ-]+/giu, '');
}

function isSearchHighlightedCallsign(
  callsignText: string,
  searchTerms: Set<string>,
  highlightedTexts: Set<string>,
): boolean {
  const normalizedCallsignText = normalizeSearchToken(callsignText);
  if (normalizedCallsignText === '') return false;
  if (highlightedTexts.has(normalizedCallsignText)) return true;

  for (const term of searchTerms) {
    const normalizedTerm = normalizeSearchToken(term);
    if (normalizedTerm === '') continue;
    if (normalizedCallsignText === normalizedTerm) return true;
  }

  return false;
}

function tokenPillBaseStyle(isInteractive: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    backgroundColor: ORANGE_TOKEN_BG,
    color: ORANGE_TOKEN_FG,
    borderRadius: 4,
    padding: '0.15em 0.3em',
    fontSize: '90%',
    fontWeight: 600,
    lineHeight: 1.2,
    cursor: isInteractive ? 'pointer' : 'inherit',
  };
}

function pointTokenSx(theme: Theme): CSSProperties {
  return {
    display: 'inline',
    backgroundColor:
      theme.palette.mode === 'dark' ? 'rgba(253, 136, 79, 0.22)' : 'rgba(253, 136, 79, 0.18)',
    boxShadow:
      theme.palette.mode === 'dark'
        ? 'inset 0 0 0 1px rgba(253, 136, 79, 0.58)'
        : 'inset 0 0 0 1px rgba(221, 91, 34, 0.48)',
    color: 'inherit',
    borderRadius: '2px',
    padding: '1px 3px',
    fontSize: 'inherit',
    fontWeight: 500,
    lineHeight: 'inherit',
    cursor: 'pointer',
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone',
  };
}

function tokenInteractiveResetStyle(cursor: CSSProperties['cursor']): CSSProperties {
  return {
    color: 'inherit',
    textDecoration: 'none',
    cursor,
  };
}

function searchHighlightedCallsignBaseSx(theme: Theme): CSSProperties {
  return {
    display: 'inline',
    backgroundColor:
      theme.palette.mode === 'dark' ? 'rgba(255, 213, 79, 0.38)' : 'rgba(255, 179, 0, 0.40)',
    boxShadow: theme.palette.mode === 'dark' ? 'inset 0 -1px 0 rgba(0, 0, 0, 0.5)' : 'none',
    borderRadius: 0,
    padding: '0 1px',
    fontSize: 'inherit',
    fontWeight: 600,
    lineHeight: 1.15,
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone',
  };
}

function searchHighlightedCallsignPlainSx(theme: Theme): CSSProperties {
  return {
    ...searchHighlightedCallsignBaseSx(theme),
    color: 'inherit',
    textDecoration: 'none',
  };
}

function callsignPlainStyle(): CSSProperties {
  return {
    color: 'inherit',
    textDecoration: 'none',
    borderBottom: 'none',
    fontWeight: 600,
  };
}

function renderPlainCallsign(
  displayText: string,
  options?: { muted?: boolean; title?: string; testId?: string; tinted?: boolean },
) {
  return (
    <Box
      component="span"
      data-testid={options?.testId}
      title={options?.title}
      sx={{
        color: options?.muted ? 'text.secondary' : 'inherit',
        ...(options?.tinted
          ? {
              color: 'var(--message-callsign-color)',
              textDecoration: 'underline',
              textDecorationColor: 'var(--message-callsign-color)',
              textDecorationThickness: '2px',
              textUnderlineOffset: '2px',
            }
          : {}),
        borderBottom: 'none',
        textDecoration: 'none',
        fontWeight: 600,
      }}
    >
      {displayText}
    </Box>
  );
}

function PointToken({
  text,
  hrefAll,
  hrefSingle,
  title,
  hasMultiplePoints,
  onOpenPointsOnMap,
  message,
  etalonsAll,
  etalonSingle,
  palitraIds,
  messageId,
  onRequestPointBlacklist,
  pendingBlacklistKeys,
}: {
  text: string;
  hrefAll: string;
  hrefSingle: string;
  title: string;
  hasMultiplePoints: boolean;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  message?: InboxMessage;
  etalonsAll: string[];
  etalonSingle: string;
  palitraIds: number[];
  messageId: number;
  onRequestPointBlacklist?: (source: PointBlacklistRequestSource) => void;
  pendingBlacklistKeys: Set<string>;
}) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const sourcePalitraIds = Array.from(new Set(palitraIds));
  const blacklistLabel = etalonSingle.trim();
  const directBlacklistKey = `${messageId}:${pointBlacklistLabelKey(blacklistLabel)}:${sourcePalitraIds[0] ?? ''}`;

  function openMenu(event: SyntheticEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setMenuAnchorEl(event.currentTarget);
  }

  return (
    <>
      <Box
        component="span"
        className="content-token--point"
        sx={pointTokenSx}
        title={title}
        role="button"
        tabIndex={0}
        onClick={openMenu}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            openMenu(event);
          }
        }}
      >
        <span className="content-token--point-link">{text}</span>
      </Box>
      <PowerMenu
        id={menuId}
        anchorEl={menuAnchorEl}
        open={menuAnchorEl !== null}
        onClose={() => setMenuAnchorEl(null)}
        slotProps={{ list: { 'aria-label': 'Дії з точкою' } }}
      >
        {hasMultiplePoints ? (
          onOpenPointsOnMap && message ? (
            <>
              <MenuItem
                onClick={() => {
                  setMenuAnchorEl(null);
                  onOpenPointsOnMap([etalonSingle], message);
                }}
              >
                <ListItemIcon>
                  <PlaceIcon />
                </ListItemIcon>
                Показати на мапі цю точку
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenuAnchorEl(null);
                  onOpenPointsOnMap(etalonsAll, message);
                }}
              >
                <ListItemIcon>
                  <ScatterPlotIcon />
                </ListItemIcon>
                Показати на мапі всі точки
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                component="a"
                href={hrefSingle}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMenuAnchorEl(null)}
              >
                <ListItemIcon>
                  <PlaceIcon />
                </ListItemIcon>
                Показати на мапі цю точку
              </MenuItem>
              <MenuItem
                component="a"
                href={hrefAll}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMenuAnchorEl(null)}
              >
                <ListItemIcon>
                  <ScatterPlotIcon />
                </ListItemIcon>
                Показати на мапі всі точки
              </MenuItem>
            </>
          )
        ) : onOpenPointsOnMap && message ? (
          <MenuItem
            onClick={() => {
              setMenuAnchorEl(null);
              onOpenPointsOnMap([etalonSingle], message);
            }}
          >
            <ListItemIcon>
              <PlaceIcon />
            </ListItemIcon>
            Показати на мапі цю точку
          </MenuItem>
        ) : (
          <MenuItem
            component="a"
            href={hrefSingle}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenuAnchorEl(null)}
          >
            <ListItemIcon>
              <PlaceIcon />
            </ListItemIcon>
            Показати на мапі цю точку
          </MenuItem>
        )}
        {onRequestPointBlacklist ? (
          sourcePalitraIds.length === 0 ? (
            <MenuItem disabled>
              <ListItemIcon>
                <VisibilityOffIcon />
              </ListItemIcon>
              <ListItemText
                primary="Додати до чорного списку"
                secondary="Неможливо визначити палітру-джерело"
              />
            </MenuItem>
          ) : sourcePalitraIds.length === 1 ? (
            <MenuItem
              onClick={() => {
                setMenuAnchorEl(null);
                onRequestPointBlacklist({
                  messageId,
                  etalon: blacklistLabel,
                  palitraIds: sourcePalitraIds,
                });
              }}
              disabled={pendingBlacklistKeys.has(directBlacklistKey)}
            >
              <ListItemIcon>
                <VisibilityOffIcon />
              </ListItemIcon>
              {pendingBlacklistKeys.has(directBlacklistKey)
                ? 'Додавання…'
                : 'Додати до чорного списку'}
            </MenuItem>
          ) : (
            <MenuItem
              onClick={() => {
                setMenuAnchorEl(null);
                const activeElement = document.activeElement;
                if (activeElement instanceof HTMLElement) activeElement.blur();
                window.setTimeout(() => {
                  onRequestPointBlacklist({
                    messageId,
                    etalon: blacklistLabel,
                    palitraIds: sourcePalitraIds,
                  });
                }, 0);
              }}
            >
              <ListItemIcon>
                <VisibilityOffIcon />
              </ListItemIcon>
              Додати до чорного списку
            </MenuItem>
          )
        ) : null}
      </PowerMenu>
    </>
  );
}

function KeywordToken({ text }: { text: string }) {
  return (
    <span
      className="badge-highlighed-token badge-highlighed-token--callsign"
      style={tokenPillBaseStyle(false)}
    >
      {text}
    </span>
  );
}

function SearchHighlightedCallsign({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      className="badge-highlighed-token badge-highlighed-token--callsign"
      sx={searchHighlightedCallsignPlainSx}
    >
      {children}
    </Box>
  );
}

function CallsignWithHint({
  text,
  callsignInfoMap,
  networks,
  unitsMap,
  freq,
  networkIds,
  searchHighlighted = false,
}: {
  text: string;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  freq?: string | null;
  networkIds?: number[] | null;
  searchHighlighted?: boolean;
}) {
  const displayText = text.toUpperCase();
  const wrapSearchHighlighted = (node: ReactNode) =>
    searchHighlighted ? <SearchHighlightedCallsign>{node}</SearchHighlightedCallsign> : node;

  const hintResult = getMessageCallsignHintResult({
    networkIds,
    networks: networks ?? [],
    unitsMap: unitsMap ?? {},
    callsignInfoMap,
    callsign: displayText,
  });

  const tooltipText = formatMessageCallsignHintTooltipData(hintResult);
  const isNetworkHint = hintResult.state === 'message-network';
  const hasOnlyOtherNetworkHints =
    hintResult.catalogRows.length === 0 && hintResult.otherNetworkHints.length > 0;
  const callsignDisplay = (
    <Box component="span" data-testid="callsign-token" sx={callsignPlainStyle()}>
      {displayText}
    </Box>
  );

  if (isNullOrUndefined(tooltipText)) {
    return wrapSearchHighlighted(callsignDisplay);
  }

  return (
    <span style={CALLSIGN_HINT_WRAPPER_STYLE}>
      {wrapSearchHighlighted(callsignDisplay)}
      <Tooltip
        placement="top"
        arrow
        describeChild
        slotProps={{
          tooltip: {
            sx: {
              maxWidth: 420,
              width: 'min(420px, calc(100vw - 32px))',
              px: 1.5,
              py: 1.25,
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            },
          },
        }}
        title={
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 0.75,
              maxHeight: 320,
              overflowY: 'auto',
              overflowX: 'hidden',
              minWidth: 0,
            }}
          >
            {tooltipText.sections.map((section) => (
              <Box key={section.header} component="section">
                <Typography component="div" sx={{ fontSize: '0.875rem', fontWeight: 600 }}>
                  {section.header}
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
                  {section.items.map((item, index) => (
                    <Typography
                      key={`${displayText}-${section.header}-${index}`}
                      component="li"
                      sx={CALLSIGN_TOOLTIP_ITEM_SX}
                    >
                      {item}
                    </Typography>
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        }
      >
        <IconButton
          type="button"
          aria-label={
            isNetworkHint
              ? 'Підказка по мережі'
              : hasOnlyOtherNetworkHints
                ? 'Інформація про позивний'
                : 'Підказка з каталогу'
          }
          data-testid={isNetworkHint ? 'callsign-hint-badge-network' : 'callsign-hint-badge-system'}
          size="small"
          disableRipple
          sx={{
            flex: '0 0 auto',
            ml: 0.25,
            width: 18,
            height: 18,
            minWidth: 18,
            p: 0,
            borderRadius: '50%',
            bgcolor: 'var(--color-card)',
            color: 'var(--message-callsign-color)',
            lineHeight: 0,
            zIndex: 1,
            '&:hover': { bgcolor: 'var(--color-card)' },
          }}
        >
          {isNetworkHint ? (
            <InfoIcon sx={{ fontSize: 16 }} />
          ) : (
            <InfoOutlinedIcon sx={{ fontSize: 16 }} />
          )}
        </IconButton>
      </Tooltip>
    </span>
  );
}

export function renderMarkedText(
  nodes: ContentNode[],
  _bodyText: string,
  messagePointEtalons?: string[],
  options?: {
    showPointLinks?: boolean;
    message?: InboxMessage;
    messageId?: number;
    onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
    onRequestPointBlacklist?: (source: PointBlacklistRequestSource) => void;
    pendingBlacklistKeys?: Set<string>;
    callsignInfoMap?: Record<string, CallsignInfoRes>;
    networks?: Network[];
    unitsMap?: Record<number, Unit>;
    messageLinkGroupInfos?: Record<string, SignalGroupEntry>;
    freq?: string | null;
    networkIds?: number[] | null;
    searchText?: string | null;
  },
): ReactNode[] {
  const showPointLinks = options?.showPointLinks !== false;
  const messageForMap = options?.message;
  const onOpenPointsOnMap = options?.onOpenPointsOnMap;
  const fromNodes = collectPointEtalons(nodes);
  const highlightedTexts = collectHighlightedTexts(nodes);
  const searchTerms = collectSearchTerms(options?.searchText);
  const allPointEtalons = uniquePointEtalonsForMapSearch(
    isPresent(messagePointEtalons) && messagePointEtalons.length > 0
      ? messagePointEtalons
      : fromNodes,
  );
  const renderedNodes: ReactNode[] = [];

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];

    if (typeof node === 'string') {
      if (node === 'CNNewlineC') renderedNodes.push(<br key={i} />);
      continue;
    }

    if ('CNTextC' in node) {
      renderedNodes.push(
        <span key={i}>
          {renderLinkifiedText(node.CNTextC.text, {
            groupInfos: options?.messageLinkGroupInfos,
          })}
        </span>,
      );
      continue;
    }

    if ('CNCallsignC' in node) {
      const { text } = node.CNCallsignC;
      const callsignText = text.trim();
      if (callsignText === '') continue;
      const searchHighlighted = isSearchHighlightedCallsign(
        callsignText,
        searchTerms,
        highlightedTexts,
      );
      renderedNodes.push(
        <CallsignWithHint
          key={i}
          text={callsignText}
          callsignInfoMap={options?.callsignInfoMap}
          networks={options?.networks}
          unitsMap={options?.unitsMap}
          freq={options?.freq}
          networkIds={options?.networkIds}
          searchHighlighted={searchHighlighted}
        />,
      );
      continue;
    }

    if ('CNHighlightC' in node) {
      const { text } = node.CNHighlightC;
      if (text.trim() === '') continue;
      renderedNodes.push(<KeywordToken key={i} text={text} />);
      continue;
    }

    if ('CNSignalC' in node) {
      const { text } = node.CNSignalC;
      if (text.trim() === '') continue;
      renderedNodes.push(
        <span key={i} className="content-token--ADV">
          {text}
        </span>,
      );
      continue;
    }

    if ('CNPointC' in node) {
      const { etalon, text } = node.CNPointC;
      if (text.trim() === '') continue;
      const cleanEtalon = String(etalon ?? '').trim();
      if (!showPointLinks || cleanEtalon === '') {
        renderedNodes.push(<span key={i}>{text}</span>);
        continue;
      }
      const etalonsForUrl = allPointEtalons.length > 0 ? allPointEtalons : [etalon];
      const hrefAll = buildAnalysisMapHrefWithSearch(etalonsForUrl, messageForMap);
      const hrefSingle = buildAnalysisMapHrefWithSearch(etalon, messageForMap);
      const title =
        allPointEtalons.length > 1
          ? `Відкрити на мапі аналізу: ${allPointEtalons.join(', ')}`
          : `Відкрити на мапі аналізу: ${cleanEtalon}`;
      renderedNodes.push(
        <PointToken
          key={i}
          text={text}
          hrefAll={hrefAll}
          hrefSingle={hrefSingle}
          title={title}
          hasMultiplePoints={allPointEtalons.length > 1}
          onOpenPointsOnMap={onOpenPointsOnMap}
          message={messageForMap}
          etalonsAll={etalonsForUrl}
          etalonSingle={cleanEtalon}
          palitraIds={node.CNPointC.palitraIds}
          messageId={options?.messageId ?? 0}
          onRequestPointBlacklist={options?.onRequestPointBlacklist}
          pendingBlacklistKeys={options?.pendingBlacklistKeys ?? new Set()}
        />,
      );
    }
  }

  return renderedNodes;
}
