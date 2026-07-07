import { Box, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import InfoIcon from '@mui/icons-material/Info';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useId, useState } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';
import type { Theme } from '@mui/material/styles';
import { isNullOrUndefined, isPresent } from '../../../utils/misc';

import type {
  CallsignInfoRes,
  ContentNode,
  InboxMessage,
  Network,
  Unit,
} from '../../../../../Bindings';
import { normalizeCallsignLookupValue } from '../../../utils/callsign-normalization';
import {
  buildAnalysisMapHrefWithSearch,
  uniquePointEtalonsForMapSearch,
} from '../../rer-duty-neo/utils';
import {
  formatCallsignHintTooltipData,
  getCallsignHintResult,
  isCallsignRelatedToNetworks,
} from '../../rer-analysis-neo/callsign-hints';
import { renderLinkifiedText } from './message-card-linkify';

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
}: {
  text: string;
  hrefAll: string;
  hrefSingle: string;
  title: string;
  hasMultiplePoints: boolean;
}) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const menuId = useId();

  function openMenu(event: SyntheticEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setMenuAnchorEl(event.currentTarget);
  }

  return (
    <>
      <span
        className="content-token--point"
        style={tokenPillBaseStyle(true)}
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
        <span className="content-token--point-link" style={tokenInteractiveResetStyle('pointer')}>
          {text}
        </span>
        <IconButton
          size="small"
          aria-label="Показати на мапі"
          aria-controls={menuAnchorEl ? menuId : undefined}
          aria-haspopup="menu"
          aria-expanded={menuAnchorEl ? 'true' : undefined}
          title={title}
          onClick={openMenu}
          sx={{
            color: ORANGE_TOKEN_FG,
            fontWeight: 600,
            padding: 0,
            ml: 0,
            cursor: 'pointer',
            '&:hover': { backgroundColor: 'transparent' },
          }}
        >
          <span
            aria-hidden
            style={{ lineHeight: 1, fontSize: '1em', fontWeight: 'inherit', margin: '0 2px' }}
          >
            ⋮
          </span>
        </IconButton>
      </span>
      <Menu
        id={menuId}
        anchorEl={menuAnchorEl}
        open={isPresent(menuAnchorEl)}
        onClose={() => setMenuAnchorEl(null)}
        MenuListProps={{ 'aria-label': 'Дії з точкою' }}
      >
        {hasMultiplePoints ? (
          <>
            <MenuItem
              component="a"
              href={hrefAll}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuAnchorEl(null)}
            >
              Показати на мапі всі точки
            </MenuItem>
            <MenuItem
              component="a"
              href={hrefSingle}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuAnchorEl(null)}
            >
              Показати на мапі цю точку
            </MenuItem>
          </>
        ) : (
          <MenuItem
            component="a"
            href={hrefSingle}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenuAnchorEl(null)}
          >
            Показати на мапі
          </MenuItem>
        )}
      </Menu>
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
  linkCallsigns = true,
  searchHighlighted = false,
}: {
  text: string;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  freq?: string | null;
  networkIds?: number[] | null;
  linkCallsigns?: boolean;
  searchHighlighted?: boolean;
}) {
  const displayText = text.toUpperCase();
  const href = `/rer-callsigns-neo?callsign=${encodeURIComponent(displayText)}`;
  const callsignInfo = callsignInfoMap?.[normalizeCallsignLookupValue(displayText)]?.res ?? null;
  const hasCatalogMatch = (callsignInfo?.length ?? 0) > 0;
  const isNetworkRelated =
    hasCatalogMatch &&
    !!networks &&
    !!unitsMap &&
    isCallsignRelatedToNetworks(callsignInfo, networks, unitsMap);
  const hasMessageNetworks = (networkIds?.length ?? 0) > 0;
  const wrapSearchHighlighted = (node: ReactNode) =>
    searchHighlighted ? <SearchHighlightedCallsign>{node}</SearchHighlightedCallsign> : node;

  // Behavior change: callsign highlighting is intentionally split into 4 UX states.
  // States 1-3 stay clickable; state 4 is intentionally plain text.
  // Exact network matches keep the badge/tooltip, catalog-only callsigns keep the badge/tooltip,
  // and network-related non-exact callsigns remain clickable plain links.

  // If we don't have networks or unitsMap, just render as plain link
  if (!networks || !unitsMap) {
    return wrapSearchHighlighted(
      linkCallsigns ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="content-token--ADP hover:cursor-pointer"
        >
          {displayText}
        </a>
      ) : (
        <Box component="span" sx={callsignPlainStyle()}>
          {displayText}
        </Box>
      ),
    );
  }

  const hintResult = getCallsignHintResult({
    hintContext: 'message',
    freq: freq ?? null,
    networkIds,
    networks,
    unitsMap,
    callsignInfoMap,
    callsign: displayText,
  });

  const tooltipText = formatCallsignHintTooltipData(hintResult);
  const isNetworkHint = hintResult.strategy === 'network';
  const shouldLinkCallsign = linkCallsigns && (isPresent(tooltipText) || hasCatalogMatch);
  const callsignDisplay = shouldLinkCallsign ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="content-token--ADP hover:cursor-pointer"
    >
      {displayText}
    </a>
  ) : (
    <Box component="span" sx={callsignPlainStyle()}>
      {displayText}
    </Box>
  );

  if (isNullOrUndefined(tooltipText)) {
    if (hasMessageNetworks) {
      if (!hasCatalogMatch) {
        return wrapSearchHighlighted(
          renderPlainCallsign(displayText, { testId: 'callsign-hint-plain-missing' }),
        );
      }
      return wrapSearchHighlighted(callsignDisplay);
    }
    return wrapSearchHighlighted(
      shouldLinkCallsign ? callsignDisplay : renderPlainCallsign(displayText),
    );
  }

  return (
    <Box
      component="span"
      sx={{ position: 'relative', display: 'inline-block', verticalAlign: 'baseline', pr: '8px' }}
    >
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
            <Typography
              component="div"
              sx={{ fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.3 }}
            >
              {tooltipText.header}
            </Typography>
            <Box
              component="ul"
              sx={{
                m: 0,
                pl: 0,
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
                minWidth: 0,
              }}
            >
              {tooltipText.items.map((item, index) => (
                <Typography
                  key={`${displayText}-${index}`}
                  component="li"
                  sx={CALLSIGN_TOOLTIP_ITEM_SX}
                >
                  {item}
                </Typography>
              ))}
            </Box>
          </Box>
        }
      >
        <IconButton
          type="button"
          aria-label={isNetworkHint ? 'Підказка по мережі' : 'Підказка з каталогу'}
          data-testid={isNetworkHint ? 'callsign-hint-badge-network' : 'callsign-hint-badge-system'}
          size="small"
          disableRipple
          sx={{
            position: 'absolute',
            right: 0,
            top: 0,
            transform: 'translate(45%, -35%)',
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
    </Box>
  );
}

export function renderMarkedText(
  nodes: ContentNode[],
  _bodyText: string,
  messagePointEtalons?: string[],
  options?: {
    showPointLinks?: boolean;
    linkCallsigns?: boolean;
    message?: InboxMessage;
    callsignInfoMap?: Record<string, CallsignInfoRes>;
    networks?: Network[];
    unitsMap?: Record<number, Unit>;
    freq?: string | null;
    networkIds?: number[] | null;
    searchText?: string | null;
  },
): ReactNode[] {
  const showPointLinks = options?.showPointLinks !== false;
  const linkCallsigns = options?.linkCallsigns !== false;
  const messageForMap = options?.message;
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
      renderedNodes.push(<span key={i}>{renderLinkifiedText(node.CNTextC.text)}</span>);
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
          linkCallsigns={linkCallsigns}
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
        />,
      );
    }
  }

  return renderedNodes;
}
