import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Box, Button, Chip, CircularProgress, Collapse, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';

import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  MessageMediaInfo,
  Network,
  Tag,
  Unit,
  User,
} from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';
import { getPointEtalonsFromMessage, messageHasPalitraTag, type TagsLayoutVariant } from '../../rer-duty-neo/utils';
import { filterOtherMessageComments } from '../../rer-analysis-neo/use-analysis-data.comments';
import { renderMarkedText } from './MarkedText';

const PREVIEW_IMAGE_HEIGHT_PX = 100;

export type AnalysisCallsignActions = {
  onAddCallsign: (callsign: string) => Promise<boolean> | boolean;
  onRemoveCallsign: (callsign: string) => Promise<boolean> | boolean;
  onAddSuggestedCallsign: (callsign: string) => Promise<boolean> | boolean;
};

function isImageMediaAttachment(m: MessageMediaInfo): boolean {
  const ct = String(m.contentType ?? '').trim();
  if (ct.startsWith('image/')) return true;
  if (ct !== '') return false;
  const href = String(m.href ?? '').toLowerCase();
  return /\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.test(href);
}

function collectMessageImageHrefs(msg: InboxMessage): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (h: string) => {
    if (seen.has(h)) return;
    seen.add(h);
    out.push(h);
  };
  for (const u of msg.images ?? []) add(u);
  for (const m of msg.media ?? []) {
    if (isImageMediaAttachment(m)) add(m.href);
  }
  return out;
}

export function MessagePictureThumb({ href }: { href: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <Box component="span" sx={{ display: 'inline-block', mr: 0.5, mb: 0.5, lineHeight: 0 }}>
      <Box component="a" href={href} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-block' }}>
        <Box
          component="img"
          src={href}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          sx={{
            display: loaded ? 'block' : 'none',
            height: PREVIEW_IMAGE_HEIGHT_PX,
            minHeight: PREVIEW_IMAGE_HEIGHT_PX,
            width: 'auto',
            maxWidth: '100%',
            objectFit: 'contain',
            verticalAlign: 'middle',
          }}
        />
      </Box>
    </Box>
  );
}

function mediaAttachmentDisplayName(m: MessageMediaInfo): string {
  const raw = m as MessageMediaInfo & { file_name?: string | null };
  const s = (m.fileName ?? raw.file_name ?? '').trim();
  if (s !== '') return s;
  return '<файл без назви>';
}

function normalizeCallsign(value: string): string {
  return value.trim().toUpperCase();
}

function uniqueNormalizedCallsigns(values: string[]): string[] {
  return values.reduce<string[]>((acc, value) => {
    const normalized = normalizeCallsign(value);
    if (normalized === '' || acc.includes(normalized)) return acc;
    acc.push(normalized);
    return acc;
  }, []);
}

function buildSuggestedCallsigns(msg: InboxMessage): string[] {
  const current = new Set(uniqueNormalizedCallsigns(msg.callsigns ?? []));
  return uniqueNormalizedCallsigns(msg.callsignsAlg2 ?? []).filter((callsign) => callsign.length <= 12 && !current.has(callsign));
}

function AnalysisCallsignsSection({
  msg,
  actions,
  callsignInfoMap,
}: {
  msg: InboxMessage;
  actions: AnalysisCallsignActions;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
}) {
  const [callsignDraft, setCallsignDraft] = useState('');
  const [addingCallsign, setAddingCallsign] = useState(false);
  const currentCallsigns = useMemo(() => uniqueNormalizedCallsigns(msg.callsigns ?? []), [msg.callsigns]);
  const analysisVisibleCallsigns = useMemo(() => {
    if (!callsignInfoMap) return currentCallsigns;
    // Analysis-only UX: keep all user-managed callsigns visible so operators can remove/correct them inline.
    return currentCallsigns;
  }, [callsignInfoMap, currentCallsigns]);
  const proposedCallsigns = useMemo(() => buildSuggestedCallsigns(msg), [msg]);
  const messageResetKey = msg.messageUid ?? `${msg.timestamp ?? ''}-${msg.text ?? ''}`;

  useEffect(() => {
    setCallsignDraft('');
  }, [messageResetKey]);

  const addCallsign = async () => {
    if (addingCallsign) return;
    const callsign = normalizeCallsign(callsignDraft);
    if (callsign === '') return;
    if (currentCallsigns.includes(callsign)) {
      setCallsignDraft('');
      return;
    }
    setAddingCallsign(true);
    try {
      const saved = await actions.onAddCallsign(callsign);
      if (saved) setCallsignDraft('');
    } finally {
      setAddingCallsign(false);
    }
  };

  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: 0.4 }}>
        Позивні
      </Typography>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" alignItems="center" sx={{ minWidth: 0 }}>
        {analysisVisibleCallsigns.length > 0
          ? analysisVisibleCallsigns.map((callsign) => (
              <PowerChip
                key={callsign}
                label={callsign}
                onDelete={() => void actions.onRemoveCallsign(callsign)}
                color="primary"
                size="small"
                sx={{
                  height: 28,
                  '& .MuiChip-label': {
                    px: 1,
                    py: 0,
                  },
                  '& .MuiChip-deleteIcon': {
                    fontSize: 18,
                    ml: 0.25,
                    mr: 0.5,
                  },
                }}
              />
            ))
          : null}
        <TextField
          size="small"
          value={callsignDraft}
          placeholder="Новий"
          autoComplete="off"
          onChange={(event) => setCallsignDraft(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void addCallsign();
            }
          }}
          inputProps={{
            autoComplete: 'off',
            spellCheck: false,
            maxLength: 12,
          }}
          sx={{
            width: { xs: '100%', sm: 132 },
            minWidth: 108,
            flex: '0 1 132px',
            '& .MuiInputBase-root': {
              height: 30,
              borderRadius: 1,
              fontSize: 12,
            },
            '& .MuiInputBase-input': {
              py: 0,
              px: 1,
              lineHeight: '30px',
            },
            '& .MuiInputBase-input:-webkit-autofill, & .MuiInputBase-input:-webkit-autofill:hover, & .MuiInputBase-input:-webkit-autofill:focus, & .MuiInputBase-input:-webkit-autofill:active': {
              WebkitBoxShadow: '0 0 0 1000px var(--color-card) inset',
              WebkitTextFillColor: 'inherit',
              transition: 'background-color 9999s ease-out 0s',
              caretColor: 'inherit',
            },
          }}
        />
        <Tooltip title="Додати позивний" enterDelay={300}>
          <span>
            <IconButton
              aria-label="Додати позивний"
              onClick={() => void addCallsign()}
              disabled={normalizeCallsign(callsignDraft) === '' || addingCallsign}
              size="small"
              sx={{ width: 30, height: 30, flexShrink: 0, ml: 0.25 }}
            >
              {addingCallsign ? <CircularProgress size={16} thickness={5} color="inherit" /> : <AddIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {proposedCallsigns.length > 0 ? (
        <Stack spacing={0.75}>
          <Typography variant="caption" color="text.secondary">
            Запропоновані позивні
          </Typography>
          <Stack direction="row" gap={1} flexWrap="wrap">
            {proposedCallsigns.map((callsign) => (
              <Chip
                key={callsign}
                label={callsign}
                onClick={() => void actions.onAddSuggestedCallsign(callsign)}
                variant="filled"
              />
            ))}
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );
}

function MessageMediaDownloadLink({ attachment }: { attachment: MessageMediaInfo }) {
  const displayName = mediaAttachmentDisplayName(attachment);
  const downloadAttr = displayName === '<файл без назви>' ? 'attachment' : displayName.replace(/[/\\]/g, '_');
  return (
    <Tooltip title={displayName} enterDelay={400}>
      <Button
        component="a"
        size="small"
        variant="outlined"
        href={String(attachment.href ?? '')}
        download={downloadAttr}
        target="_blank"
        rel="noopener noreferrer"
        sx={{
          mb: 0.5,
          width: 'fit-content',
          minWidth: 0,
          maxWidth: '100%',
          minHeight: 26,
          py: 0.25,
          px: 0.75,
          fontSize: 11,
          lineHeight: 1.25,
          textTransform: 'none',
          fontWeight: 500,
          alignSelf: 'flex-start',
          overflow: 'hidden',
          justifyContent: 'flex-start',
          '& .MuiButton-startIcon': { mr: 0.35, ml: -0.25, '& svg': { fontSize: 14 } },
        }}
        startIcon={<DownloadOutlinedIcon aria-hidden />}
        >
          <Box
          component="span"
          sx={{
            display: 'block',
            minWidth: 0,
            width: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
        >
          {displayName}
        </Box>
      </Button>
    </Tooltip>
  );
}

export function MessageCardWatermark({ authUserName }: { authUserName: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: '10%',
          top: '20%',
          transform: 'rotate(-28deg)',
          fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
          fontWeight: 600,
          opacity: 0.08,
          color: 'currentColor',
          whiteSpace: 'nowrap',
        }}
      >
        {authUserName}
      </span>
      <span
        style={{
          position: 'absolute',
          right: '5%',
          bottom: '15%',
          transform: 'rotate(-28deg)',
          fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
          fontWeight: 600,
          opacity: 0.08,
          color: 'currentColor',
          whiteSpace: 'nowrap',
        }}
      >
        {authUserName}
      </span>
    </div>
  );
}

const TAG_CHIP_GAP_PX = 4;
/** Reserve for «розгорнути» + chevron (collapsed row). */
const COMPACT_EXPAND_BTN_RESERVE_PX = 92;
/**
 * Contribution badge is `absolute` to the right of the chip — only the **last** chip in the row
 * needs extra slack toward the expand control; adding this for every chip over-counts and wastes space.
 */
const COMPACT_LAST_CHIP_BADGE_OVERFLOW_PX = 44;
/** Compact: every chip outer wrapper; full layout: only when `showBadge`. Expand button uses the same in compact. */
const TAG_CHIP_BADGE_TOP_PADDING_THEME = 1.75;
const OTHER_COMMENTS_PREVIEW_COUNT = 3;

function estimateTagChipWidthPx(label: string): number {
  return Math.min(180, Math.max(28, Math.round(label.length * 6.5 + 26)));
}

function MessageCardTagChips({
  compact = false,
  msg,
  tagsMap,
  onToggleTag,
  tagsLayout,
}: {
  compact?: boolean;
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  onToggleTag: (tagId: number) => void;
  tagsLayout: TagsLayoutVariant;
}) {
  const [showCompactRest, setShowCompactRest] = useState(false);
  const compactMeasureRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(
    () =>
      Object.keys(tagsMap).map((tagId) => {
        const tag = tagsMap[tagId];
        const label = tag.label ?? `#${tagId}`;
        const inboxTagList = msg.inboxTags ?? [];
        const isSet =
          inboxTagList.length > 0
            ? inboxTagList.some((t) => t.tagId === Number(tagId))
            : (msg.tags ?? []).includes(Number(tagId));
        const contribs = inboxTagList.filter((t) => t.tagId === Number(tagId));
        const humanContribs = contribs.filter((t) => !t.model);
        const botContribs = contribs.filter((t) => t.model);
        const humanLogins = humanContribs.map((t) => t.login).filter(Boolean) as string[];
        const bots = botContribs.map((t) => `${t.model} (${Math.round((t.confidence ?? 0) * 100)}%)`);
        const tip =
          isSet &&
          (humanContribs.length > 0 || botContribs.length > 0) &&
          [
            ...(humanLogins.length > 0
              ? [`Користувачі: ${humanLogins.join(', ')}`]
              : humanContribs.length > 0
                ? ['Користувачі: (ваш вибір)']
                : []),
            ...(bots.length > 0 ? [`Боти: ${bots.join(', ')}`] : []),
          ].join('\n');
        const showBadge = isSet && (humanContribs.length > 0 || botContribs.length > 0);
        return {
          tagId,
          label,
          isSet,
          tip,
          showBadge,
          humanContribsLen: humanContribs.length,
          botContribsLen: botContribs.length,
        };
      }),
    [msg.inboxTags, msg.tags, tagsMap],
  );
  const selectedRows = useMemo(() => rows.filter((r) => r.isSet), [rows]);
  const unselectedRows = useMemo(() => rows.filter((r) => !r.isSet), [rows]);
  /** Selected first — packing fills the row by priority. */
  const compactOrderedRows = useMemo(() => [...selectedRows, ...unselectedRows], [selectedRows, unselectedRows]);

  const [firstRowCount, setFirstRowCount] = useState(() => compactOrderedRows.length);

  useLayoutEffect(() => {
    if (tagsLayout !== 'compact' || showCompactRest) return;
    const el = compactMeasureRef.current;
    if (!el) return;
    const packing = compactOrderedRows;
    const compute = () => {
      if (packing.length === 0) {
        setFirstRowCount(0);
        return;
      }
      const w = el.getBoundingClientRect().width;
      if (w <= 0) return;

      let totalNoBtn = 0;
      for (let i = 0; i < packing.length; i++) {
        const add = (i > 0 ? TAG_CHIP_GAP_PX : 0) + estimateTagChipWidthPx(packing[i].label);
        if (totalNoBtn + add > w) {
          totalNoBtn = Infinity;
          break;
        }
        totalNoBtn += add;
      }
      if (totalNoBtn <= w) {
        setFirstRowCount((c) => (c === packing.length ? c : packing.length));
        return;
      }

      const btn = COMPACT_EXPAND_BTN_RESERVE_PX;
      const widthFirstKChips = (k: number) => {
        if (k <= 0) return 0;
        let u = 0;
        for (let j = 0; j < k; j++) {
          u += (j > 0 ? TAG_CHIP_GAP_PX : 0) + estimateTagChipWidthPx(packing[j].label);
        }
        if (packing[k - 1].showBadge) {
          u += COMPACT_LAST_CHIP_BADGE_OVERFLOW_PX;
        }
        return u;
      };
      let count = 0;
      for (let i = 0; i < packing.length; i++) {
        if (widthFirstKChips(i + 1) + btn > w) break;
        count = i + 1;
      }
      const atLeastOne = count === 0 && packing.length > 0 ? 1 : count;
      const next = atLeastOne >= packing.length ? packing.length : atLeastOne;
      setFirstRowCount((c) => (c === next ? c : next));
    };
    compute();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(compute);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tagsLayout, compactOrderedRows, showCompactRest]);

  const row1Chips = useMemo(() => compactOrderedRows.slice(0, firstRowCount), [compactOrderedRows, firstRowCount]);
  const row1IdSet = useMemo(() => new Set(row1Chips.map((r) => Number(r.tagId))), [row1Chips]);
  const restRows = useMemo(
    () => compactOrderedRows.filter((r) => !row1IdSet.has(Number(r.tagId))),
    [compactOrderedRows, row1IdSet],
  );
  const hasRest = restRows.length > 0;

  useEffect(() => {
    if (!hasRest) setShowCompactRest(false);
  }, [hasRest]);

  const renderOneChip = (row: (typeof rows)[0]) => {
    const botContribsLen = row.botContribsLen;
    const humanContribsLen = row.humanContribsLen;
    return (
      <Tooltip key={row.tagId} title={row.tip} placement="top">
        <Box
          component="span"
          sx={{
            display: 'inline-flex',
            alignItems: 'flex-start',
            maxWidth: '100%',
            verticalAlign: 'top',
            ...(tagsLayout === 'compact' ? { pt: TAG_CHIP_BADGE_TOP_PADDING_THEME } : {}),
          }}
        >
          <Box component="span" className="relative inline-flex shrink-0 max-w-full">
            <PowerChip
              label={row.label}
              selected={row.isSet}
              onClick={() => onToggleTag(Number(row.tagId))}
              size="small"
              fontSize="0.875rem"
              unselectedBackgroundColor="var(--color-background)"
              unselectedBorderColor="var(--text-color)"
              unselectedTextColor="var(--text-color)"
              selectedBackgroundColor="var(--color-tag-selected)"
              selectedBorderColor="var(--color-border-selected)"
              selectedTextColor="var(--neutral-900)"
            />
            {row.showBadge && (
                <span
                  className="absolute -top-[12px] -right-1 flex items-center gap-1 text-[10px] bg-card border border-border rounded-full px-1.5 py-0.5 shadow-sm"
                  aria-hidden
                >
                  {botContribsLen > 0 && (
                    <span className="flex items-center gap-0.5" title="Боти">
                      <SmartToyOutlinedIcon sx={{ fontSize: 11 }} aria-hidden />
                      <span>{botContribsLen}</span>
                    </span>
                  )}
                  {humanContribsLen > 0 && (
                    <span className="flex items-center gap-0.5" title="Користувачі">
                      <PersonOutlineOutlinedIcon sx={{ fontSize: 11 }} aria-hidden />
                      <span>{humanContribsLen}</span>
                    </span>
                  )}
                </span>
            )}
          </Box>
        </Box>
      </Tooltip>
    );
  };

  if (tagsLayout !== 'compact') {
    return <Box className="flex flex-wrap items-start gap-1">{rows.map((row) => renderOneChip(row))}</Box>;
  }

  const expandToggleButton = hasRest ? (
    <Button
      size="small"
      color="primary"
      variant="text"
      onClick={() => setShowCompactRest((v) => !v)}
      aria-expanded={showCompactRest}
      aria-label={showCompactRest ? 'Згорнути додаткові теги' : 'Показати додаткові теги'}
      endIcon={showCompactRest ? <ExpandLessIcon fontSize="inherit" aria-hidden /> : <ExpandMoreIcon fontSize="inherit" aria-hidden />}
      sx={{
        flexShrink: 0,
        minHeight: 27,
        py: 0,
        px: 0.5,
        fontSize: '0.875rem',
        fontWeight: 400,
        textTransform: 'none',
        '& .MuiButton-endIcon': { ml: 1, mr: 0, '& i': { fontSize: '0.875rem' } },
      }}
    >
      {showCompactRest ? 'згорнути' : 'розгорнути'}
    </Button>
  ) : null;

  if (showCompactRest && hasRest) {
    return (
      <Box ref={compactMeasureRef} className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-1">
        <Box className="flex w-full min-w-0 flex-wrap items-start gap-1">
          {compactOrderedRows.map((row) => renderOneChip(row))}
        </Box>
        <Box sx={{ flexShrink: 0, justifySelf: 'end', pt: TAG_CHIP_BADGE_TOP_PADDING_THEME }}>{expandToggleButton}</Box>
      </Box>
    );
  }

  if (!hasRest) {
    return (
      <Box ref={compactMeasureRef} className="flex w-full min-w-0 flex-wrap items-start gap-1">
        {compactOrderedRows.map((row) => renderOneChip(row))}
      </Box>
    );
  }

  return (
    <Box ref={compactMeasureRef} className="w-full min-w-0">
      <Box className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-1">
        <Box className="flex min-h-[27px] min-w-0 flex-1 items-center gap-1 overflow-x-hidden">
          {row1Chips.map((row) => renderOneChip(row))}
        </Box>
        <Box
          sx={{
            flexShrink: 0,
            justifySelf: 'end',
            pt: TAG_CHIP_BADGE_TOP_PADDING_THEME,
          }}
        >
          {expandToggleButton}
        </Box>
      </Box>
    </Box>
  );
}

export function MessageCardMessageBody({
  compact = false,
  msg,
  tagsMap,
  tagsLoading = false,
  onToggleTag,
  tagsLayout = 'full',
  analysisCallsignActions,
  callsignInfoMap,
  networks,
  unitsMap,
  authUserName,
  currentUser,
  messageComments = [],
  users,
  searchText,
}: {
  compact?: boolean;
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  tagsLoading?: boolean;
  onToggleTag: (tagId: number) => void;
  tagsLayout?: TagsLayoutVariant;
  analysisCallsignActions?: AnalysisCallsignActions;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  authUserName: string | null;
  currentUser: User | null;
  messageComments?: MessageComment[];
  users: Record<string, User | null>;
  searchText?: string | null;
}) {
  const imageHrefs = useMemo(() => collectMessageImageHrefs(msg), [msg]);
  const imageHrefSet = useMemo(() => new Set(imageHrefs), [imageHrefs]);
  /** Do not show download for the same URL already shown as a picture (`images` or image `media`). */
  const attachmentMedia = useMemo(
    () =>
      (msg.media ?? []).filter((m) => {
        const href = String(m.href ?? '');
        if (imageHrefSet.has(href)) return false;
        return !isImageMediaAttachment(m);
      }),
    [msg.media, imageHrefSet],
  );

  const showPointLinks = messageHasPalitraTag(msg, tagsMap);
  const hasTags = tagsLayout !== 'hidden' && Object.keys(tagsMap).length > 0;
  const textPrimary = useMemo(
    () =>
      msg.textMarked && msg.textMarked.length > 0
        ? renderMarkedText(msg.textMarked, msg.text ?? '', getPointEtalonsFromMessage(msg, tagsMap), {
            showPointLinks,
            message: msg,
            callsignInfoMap,
            networks,
            unitsMap,
            freq: msg.freq ?? null,
            networkIds: msg.networkIds ?? null,
            searchText,
          })
        : (() => {
            const text = msg.text?.trim() ?? '';
            if (text === '' || text === '—' || text === '-') return null;
            return msg.text;
          })(),
    [analysisCallsignActions, callsignInfoMap, msg, networks, searchText, showPointLinks, tagsMap, unitsMap],
  );
  const hasTextPrimary = Array.isArray(textPrimary) ? textPrimary.some((node) => (node !== null && node !== undefined)) : (textPrimary !== null && textPrimary !== undefined);
  const [showOtherCommentsRest, setShowOtherCommentsRest] = useState(false);
  const otherComments = useMemo(
    () => filterOtherMessageComments(authUserName, currentUser, users, messageComments),
    [authUserName, currentUser, messageComments, users],
  );
  const hasOtherCommentsRest = otherComments.length > OTHER_COMMENTS_PREVIEW_COUNT;
  const visibleOtherComments = showOtherCommentsRest || !hasOtherCommentsRest ? otherComments : otherComments.slice(0, OTHER_COMMENTS_PREVIEW_COUNT);
  const otherCommentsExpandToggleButton = hasOtherCommentsRest ? (
    <Button
      size="small"
      color="primary"
      variant="text"
      onClick={() => setShowOtherCommentsRest((v) => !v)}
      aria-expanded={showOtherCommentsRest}
      aria-label={showOtherCommentsRest ? 'Згорнути додаткові коментарі' : 'Показати додаткові коментарі'}
      endIcon={showOtherCommentsRest ? <ExpandLessIcon fontSize="inherit" aria-hidden /> : <ExpandMoreIcon fontSize="inherit" aria-hidden />}
      sx={{
        flexShrink: 0,
        minHeight: 27,
        py: 0,
        px: 0.5,
        fontSize: '0.875rem',
        fontWeight: 400,
        textTransform: 'none',
        '& .MuiButton-endIcon': { ml: 1, mr: 0, '& i': { fontSize: '0.875rem' } },
        alignSelf: 'flex-start',
      }}
    >
      {showOtherCommentsRest ? 'згорнути' : 'розгорнути'}
    </Button>
  ) : null;

  return (
    <Stack spacing={compact ? 1.5 : 1.25} sx={{ minWidth: 0 }}>
      {imageHrefs.length > 0 ? (
        <Box className="m-1" sx={{ lineHeight: 0 }}>
          {imageHrefs.map((href) => (
            <MessagePictureThumb key={href} href={href} />
          ))}
        </Box>
      ) : null}
      {attachmentMedia.length > 0 ? (
        <Box className="mt-1" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          {attachmentMedia.map((m) => (
            <MessageMediaDownloadLink key={m.id} attachment={m} />
          ))}
        </Box>
      ) : null}
      {hasTextPrimary ? (
        <Typography
          component="div"
          variant="body2"
          className={msg.textMarked && msg.textMarked.length > 0 ? 'text-marked' : undefined}
          sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.35 }}
        >
          {textPrimary}
        </Typography>
      ) : null}
      {(msg.extendedForm !== null && msg.extendedForm !== undefined) && msg.extendedForm.trim() !== '' ? (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <ChatBubbleOutlineOutlinedIcon sx={{ fontSize: 13, color: 'var(--color-icons)', flexShrink: 0 }} titleAccess="Коментар" />
          <Typography variant="caption" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {msg.extendedForm}
          </Typography>
        </Stack>
      ) : null}
      {otherComments.length > 0 ? (
        <Stack
          spacing={0.75}
          sx={{
            minWidth: 0,
            mt: 0.25,
            pl: 1,
            py: 0.25,
            borderLeft: '4px solid',
            borderColor: 'divider',
          }}
        >
          {visibleOtherComments.map((comment, index) => (
            <Stack key={`${comment.messageId}-${comment.id}-${index}`} spacing={0.25} sx={{ minWidth: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 700, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', minWidth: 0 }}>
                {comment.login}
              </Typography>
              <Typography variant="caption" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', lineHeight: 1.4, minWidth: 0 }}>
                {comment.comment}
              </Typography>
            </Stack>
          ))}
          {otherCommentsExpandToggleButton ? <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>{otherCommentsExpandToggleButton}</Box> : null}
        </Stack>
      ) : null}
      {tagsLoading ? (
        <Box sx={{ pt: 0.25, minHeight: 34, display: 'flex', alignItems: 'center' }} aria-label="Завантаження тегів">
          <CircularProgress size={14} />
        </Box>
      ) : hasTags ? (
        <Box sx={{ pt: 0.25, minWidth: 0 }}>
          <span className="inline-flex flex-wrap gap-1 min-w-0 w-full">
            <MessageCardTagChips msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} tagsLayout={tagsLayout} />
          </span>
        </Box>
      ) : null}
      {(analysisCallsignActions !== null && analysisCallsignActions !== undefined) ? (
        <AnalysisCallsignsSection msg={msg} actions={analysisCallsignActions} callsignInfoMap={callsignInfoMap} />
      ) : null}
    </Stack>
  );
}

export const MessageCardContent = MessageCardMessageBody;
