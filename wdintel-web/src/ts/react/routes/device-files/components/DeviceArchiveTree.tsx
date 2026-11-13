import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { CircularProgress, Collapse, IconButton } from '@mui/material';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { BrowseDeviceFilesReq, DeviceFileTreeEntry } from '../../../../../Bindings';
import { AUTH_UNAUTHORIZED_EVENT } from '../../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../../browser/navigation-guard';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../../services/api/client';
import { browseDeviceFiles } from '../../../services/api/devices';
import {
  appendDeviceFileEntries,
  buildBrowseDeviceFilesReq,
  toDeviceFileLoadError,
} from '../helpers';
import type { DeviceFileTreeBranch } from '../use-device-file-tree';
import {
  archiveMemberSelection,
  isDeviceArchive,
  type DeviceFileSelection,
} from '../device-file-archive';
import { useDeviceArchive } from '../use-device-archive';
import { DeviceFileTreePage } from './DeviceFileTreePage';
import { DeviceFileTreeRow } from './DeviceFileTreeRow';
import { DeviceFileIcon } from './DeviceFileIcon';
import {
  ArchivePreviewList,
  ArchivePreviewRow,
} from '../../shared/message-card/renderers/ArchivePreviewList';

type Filters = Pick<
  BrowseDeviceFilesReq,
  'tagIds' | 'tagMatch' | 'untagged' | 'hasContent' | 'filters'
>;
type ArchiveTreeProps = {
  deviceId: string;
  file: DeviceFileSelection;
  depth: number;
  selectedEntryId?: string;
  expandedEntryIds?: Set<string>;
  revealedBranches?: Record<string, DeviceFileTreeBranch>;
  onSelectFile: (file: DeviceFileSelection) => void;
  onOpenDirectory?: (entryId: string, revision: number | null) => void;
  onAccessDenied?: () => void;
  initialExpanded?: boolean;
  showStatus?: boolean;
  filters?: Filters;
};

function ArchiveFolder({
  name,
  depth,
  expanded,
  onToggle,
  onSelect,
  entryId,
  selected = false,
  children,
  failed = false,
  hasContent,
  showStatus = false,
  sizeBytes,
  directory = true,
  archive,
}: {
  name: string;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  onSelect?: () => void;
  entryId?: string;
  selected?: boolean;
  children: ReactNode;
  failed?: boolean;
  hasContent?: boolean;
  showStatus?: boolean;
  sizeBytes?: number | null;
  directory?: boolean;
  archive?: DeviceFileSelection['archive'];
}) {
  const childrenId = useId();
  const toggleLabel = `${expanded ? 'Згорнути' : 'Розгорнути'} ${failed || hasContent === false ? 'файл' : 'каталог'} ${name}`;
  return (
    <li className="min-w-0">
      {showStatus ? (
        <ArchivePreviewRow
          name={name}
          directory={directory}
          sizeBytes={sizeBytes}
          hasContent={hasContent}
          selected={selected}
          expanded={expanded}
          childrenId={childrenId}
          onOpen={onSelect ?? onToggle}
          toggle={
            <IconButton
              size="small"
              aria-label={toggleLabel}
              aria-expanded={expanded}
              aria-controls={childrenId}
              onClick={onToggle}
            >
              {expanded ? (
                <ExpandMoreIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
          }
        />
      ) : (
        <DeviceFileTreeRow
          name={name}
          label={name}
          depth={depth}
          entryId={entryId}
          selected={selected}
          hasContent={hasContent}
          expanded={expanded}
          childrenId={childrenId}
          toggleLabel={toggleLabel}
          onToggle={onToggle}
          onClick={onSelect ?? onToggle}
          icon={
            <DeviceFileIcon
              entry={{
                kind: directory ? 'directory' : 'file',
                name,
                isArchive: !directory,
                archive,
              }}
              expanded={expanded}
            />
          }
        />
      )}
      <Collapse in={expanded} unmountOnExit id={childrenId}>
        {showStatus ? (
          <ArchivePreviewList>{children}</ArchivePreviewList>
        ) : (
          <ul className="m-0 list-none p-0">{children}</ul>
        )}
      </Collapse>
    </li>
  );
}

function ArchiveDirectory(
  props: ArchiveTreeProps & { directory: DeviceFileTreeEntry; archiveId: string },
) {
  const revealed = props.expandedEntryIds?.has(props.directory.entryId) ?? false;
  const [expanded, setExpanded] = useState(revealed);
  useEffect(() => {
    if (revealed) setExpanded(true);
  }, [revealed, props.selectedEntryId]);
  return (
    <ArchiveFolder
      name={props.directory.name}
      depth={props.depth}
      expanded={expanded}
      entryId={props.directory.entryId}
      selected={props.selectedEntryId === props.directory.entryId}
      showStatus={props.showStatus}
      onSelect={
        props.onOpenDirectory
          ? () => {
              setExpanded(true);
              props.onOpenDirectory?.(
                props.directory.entryId,
                props.directory.revision ?? props.file.revision,
              );
            }
          : undefined
      }
      onToggle={() => setExpanded((value) => !value)}
    >
      <ArchiveChildren {...props} depth={props.depth + 1} directoryId={props.directory.entryId} />
    </ArchiveFolder>
  );
}

function ArchiveChildren(
  props: ArchiveTreeProps & { archiveId: string; directoryId: string | null },
) {
  const [entries, setEntries] = useState<DeviceFileTreeEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController | null>(null);
  const lastCursor = useRef<string | null>(null);
  const authorizedScope = useRef<string | null>(null);
  const revealed = props.revealedBranches?.[props.directoryId ?? props.file.fileId!];
  const revealedEntries =
    revealed?.archiveRevision === props.file.revision &&
    !revealed.error &&
    !revealed.loading &&
    !revealed.refreshing
      ? revealed.entries.filter(
          (entry) =>
            entry.revision === props.file.revision &&
            entry.archiveOrigin?.archiveId === props.archiveId,
        )
      : [];
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const scope = JSON.stringify([
    props.deviceId,
    props.file.fileId,
    props.file.revision,
    props.archiveId,
    props.directoryId,
    props.filters,
  ]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const load = async (after: string | null) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    lastCursor.current = after;
    setLoading(true);
    setError(null);
    try {
      const page = await browseDeviceFiles(
        {
          ...buildBrowseDeviceFilesReq({
            deviceId: props.deviceId,
            parentEntryId: props.directoryId ?? props.file.fileId!,
            archiveRevision: props.file.revision!,
            cursor: after,
            hasContent: props.filters?.hasContent,
            filters: props.filters?.filters,
            tagFilter: {
              tagIds: props.filters?.tagIds ?? [],
              tagMatch: props.filters?.tagMatch ?? 'any',
              untagged: props.filters?.untagged ?? false,
            },
          }),
          includeBreadcrumbs: false,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      authorizedScope.current = scope;
      setEntries((previous) =>
        appendDeviceFileEntries(
          after === null ? page.entries : appendDeviceFileEntries(previous, page.entries),
          revealedEntries,
        ),
      );
      setCursor(page.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted || scopeRef.current !== scope || isAbortError(cause)) return;
      const message = toDeviceFileLoadError(cause, 'Помилка завантаження каталогу').message;
      setError(message);
      notifyRef.current({ severity: 'error', message });
      if (cause instanceof HttpRequestError && [401, 403, 404].includes(cause.status)) {
        authorizedScope.current = null;
        setEntries([]);
        setCursor(null);
        lastCursor.current = null;
        props.onAccessDenied?.();
      }
    } finally {
      if (!controller.signal.aborted && scopeRef.current === scope) setLoading(false);
    }
  };
  useEffect(() => {
    authorizedScope.current = null;
    setEntries([]);
    setCursor(null);
    void load(null);
    const cancel = () => {
      authorizedScope.current = null;
      active.current?.abort();
      setEntries([]);
      setCursor(null);
      lastCursor.current = null;
      setError('Помилка доступу до архіву.');
      setLoading(false);
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
    window.addEventListener(FORCED_NAVIGATION_EVENT, cancel);
    return () => {
      active.current?.abort();
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, cancel);
    };
  }, [scope, attempt]);
  useEffect(() => {
    if (authorizedScope.current === scope && revealedEntries.length > 0)
      setEntries((previous) => appendDeviceFileEntries(previous, revealedEntries));
  }, [revealed, scope]);
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'directory')
          return <ArchiveDirectory key={entry.entryId} {...props} directory={entry} />;
        const file = archiveMemberSelection(props.file, entry);
        if (isDeviceArchive(file))
          return (
            <DeviceArchiveTree key={entry.entryId} {...props} file={file} initialExpanded={false} />
          );
        return (
          <li key={entry.entryId} className="min-w-0">
            {props.showStatus ? (
              <ArchivePreviewRow
                name={entry.name}
                sizeBytes={entry.sizeBytes}
                hasContent={entry.hasContent}
                selected={props.selectedEntryId === entry.entryId}
                onOpen={() => props.onSelectFile(file)}
              />
            ) : (
              <DeviceFileTreeRow
                name={entry.name}
                label={entry.name}
                depth={props.depth}
                entryId={entry.entryId}
                hasContent={entry.hasContent}
                selected={props.selectedEntryId === entry.entryId}
                onClick={() => props.onSelectFile(file)}
                icon={<DeviceFileIcon entry={entry} />}
              />
            )}
          </li>
        );
      })}
      {props.showStatus && loading && (
        <li className="p-echo-sm">
          <CircularProgress size={20} aria-label="Завантаження каталогу архіву" />
        </li>
      )}
      {props.showStatus && error && (
        <li className="p-echo-sm">
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              <PowerButton
                disabled={loading}
                onClick={() =>
                  lastCursor.current === null
                    ? setAttempt((value) => value + 1)
                    : void load(lastCursor.current)
                }
              >
                Повторити читання
              </PowerButton>
            }
          >
            {error}
          </PowerAlert>
        </li>
      )}
      {props.showStatus && !loading && !error && entries.length === 0 && (
        <li className="p-echo-sm text-echo-sm text-echo-text-muted">Каталог порожній</li>
      )}
      {cursor &&
        !loading &&
        !error &&
        (props.showStatus ? (
          <li className="p-echo-sm">
            <PowerButton onClick={() => void load(cursor)}>Показати ще</PowerButton>
          </li>
        ) : (
          <DeviceFileTreePage cursor={cursor} onLoadMore={() => void load(cursor)} />
        ))}
    </>
  );
}

export function DeviceArchiveTree(props: ArchiveTreeProps) {
  const revealed = props.expandedEntryIds?.has(props.file.entryId) ?? false;
  const [expanded, setExpanded] = useState((props.initialExpanded ?? false) || revealed);
  useEffect(() => {
    if (revealed && props.selectedEntryId !== props.file.entryId) setExpanded(true);
  }, [revealed, props.selectedEntryId, props.file.entryId]);
  const key = `${props.deviceId}/${props.file.fileId}/${props.file.revision}`;
  const [deniedKey, setDeniedKey] = useState<string | null>(null);
  const onAccessDenied = useCallback(() => {
    setDeniedKey(key);
    props.onAccessDenied?.();
  }, [key, props.onAccessDenied]);
  const archive = useDeviceArchive(props.deviceId, props.file, expanded && deniedKey !== key);
  useEffect(() => {
    if (archive.denied) onAccessDenied();
  }, [archive.denied, onAccessDenied]);
  const denied = archive.denied || deniedKey === key;
  const error = archive.error ?? (denied ? 'Помилка доступу до архіву.' : null);
  const state = archive.summary?.state;
  const ready = !denied && state === 'ready' && archive.summary?.archiveId;
  const hasContent = archive.status ? state !== 'missing_content' : props.file.hasContent;
  const message = !hasContent
    ? 'Контент файлу відсутній'
    : state === 'failed'
      ? `${archive.summary?.message ?? 'Не вдалося підготувати архів'}${archive.summary?.limitName ? ` (${archive.summary.limitName})` : ''}`
      : state === 'queued'
        ? 'Очікує підготовки'
        : state === 'retry_wait'
          ? 'Тимчасова помилка сховища. Очікується повторна спроба'
          : 'Готується';
  return (
    <ArchiveFolder
      name={props.file.name}
      depth={props.depth}
      expanded={expanded}
      failed={state === 'failed'}
      hasContent={hasContent}
      entryId={props.file.entryId}
      selected={props.selectedEntryId === props.file.entryId}
      showStatus={props.showStatus}
      sizeBytes={props.file.sizeBytes}
      directory={false}
      archive={archive.summary}
      onSelect={() => {
        if (ready && props.onOpenDirectory && props.file.revision != null) {
          props.onOpenDirectory(props.file.entryId, props.file.revision);
          setExpanded(true);
          return;
        }
        props.onSelectFile(props.file);
        setExpanded((value) => !value);
      }}
      onToggle={() => setExpanded((value) => !value)}
    >
      {props.showStatus && error && (
        <li className="p-echo-sm">
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              <PowerButton
                onClick={() => {
                  setDeniedKey(null);
                  archive.retry();
                }}
              >
                Повторити читання
              </PowerButton>
            }
          >
            {error}
          </PowerAlert>
        </li>
      )}
      {ready ? (
        <ArchiveChildren
          {...props}
          onAccessDenied={onAccessDenied}
          key={`${ready}/${JSON.stringify(props.filters)}`}
          depth={props.depth + 1}
          archiveId={ready}
          directoryId={null}
        />
      ) : props.showStatus ? (
        <li className="p-echo-sm text-echo-sm" role="status">
          {message}
          {state === 'retry_wait' && archive.status?.nextAttemptAt && (
            <>
              {' — '}
              <time dateTime={archive.status.nextAttemptAt}>
                {new Date(archive.status.nextAttemptAt).toLocaleString('uk-UA')}
              </time>
            </>
          )}
        </li>
      ) : null}
    </ArchiveFolder>
  );
}
