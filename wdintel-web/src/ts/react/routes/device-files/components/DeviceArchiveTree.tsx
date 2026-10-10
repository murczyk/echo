import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { CircularProgress, Collapse, ListItemButton } from '@mui/material';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AUTH_UNAUTHORIZED_EVENT, emitUnauthorizedEvent } from '../../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../../browser/navigation-guard';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../../services/api/client';
import { toDeviceFileLoadError } from '../helpers';
import {
  archiveMemberSelection,
  isDeviceArchive,
  listDeviceArchive,
  type DeviceFileSelection,
} from '../device-file-archive';
import type { ZipEntry } from '../../shared/message-card/zip-preview.types';

type ArchiveTreeProps = {
  deviceId: string;
  file: DeviceFileSelection;
  depth: number;
  selectedEntryId?: string;
  onSelectFile: (file: DeviceFileSelection) => void;
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
}: {
  name: string;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  onSelect?: () => void;
  entryId?: string;
  selected?: boolean;
  children: ReactNode;
}) {
  const row = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <li className="min-w-0" style={{ '--device-tree-depth': depth } as CSSProperties}>
      <div
        className="flex min-w-0 items-center pr-echo-xs max-echo-lg:pl-[min(calc(var(--device-tree-depth)*8px),32px)]!"
        style={{ paddingLeft: depth * 16 }}
      >
        <PowerIconButton
          size="small"
          aria-label={`${expanded ? 'Згорнути' : 'Розгорнути'} каталог ${name}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </PowerIconButton>
        <ListItemButton
          ref={row}
          component="button"
          data-testid={entryId ? `device-file-${entryId}` : undefined}
          selected={selected}
          aria-current={selected ? 'true' : undefined}
          aria-label={name}
          aria-expanded={expanded}
          onClick={onSelect ?? onToggle}
          className="min-w-0 gap-echo-sm rounded-echo-sm!"
        >
          {expanded ? (
            <FolderOpenOutlinedIcon fontSize="small" />
          ) : (
            <FolderOutlinedIcon fontSize="small" />
          )}
          <span className="truncate text-echo-sm" title={name}>
            {name}
          </span>
        </ListItemButton>
      </div>
      <Collapse in={expanded} unmountOnExit>
        <ul className="m-0 list-none p-0">{children}</ul>
      </Collapse>
    </li>
  );
}

function ArchiveDirectory({
  entries,
  path,
  name,
  ...props
}: ArchiveTreeProps & { entries: ZipEntry[]; path: string; name: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ArchiveFolder
      name={name}
      depth={props.depth}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <ArchiveChildren {...props} depth={props.depth + 1} entries={entries} path={path} />
    </ArchiveFolder>
  );
}

function ArchiveChildren({
  entries,
  path,
  ...props
}: ArchiveTreeProps & { entries: ZipEntry[]; path: string }) {
  return (
    <>
      {entries
        .filter((entry) => {
          const value = entry.path.replace(/\/$/, '');
          return value.slice(0, value.lastIndexOf('/') + 1) === path;
        })
        .map((entry) => {
          const name = entry.path.replace(/\/$/, '').split('/').at(-1)!;
          if (entry.directory)
            return (
              <ArchiveDirectory
                key={entry.index}
                {...props}
                entries={entries}
                path={entry.path}
                name={name}
              />
            );
          const file = archiveMemberSelection(props.file, entry);
          if (isDeviceArchive(file) && !entry.unavailableReason)
            return <DeviceArchiveTree key={entry.index} {...props} file={file} />;
          const selected = props.selectedEntryId === file.entryId;
          return (
            <li
              key={entry.index}
              className="min-w-0 max-echo-lg:pl-[min(calc(var(--device-tree-depth)*8px+8px),40px)]!"
              style={
                {
                  paddingLeft: props.depth * 16 + 8,
                  '--device-tree-depth': props.depth,
                } as CSSProperties
              }
            >
              <ListItemButton
                component="button"
                aria-label={name}
                aria-pressed={selected}
                selected={selected}
                disabled={Boolean(entry.unavailableReason)}
                title={entry.unavailableReason ?? name}
                onClick={() => props.onSelectFile(file)}
                className="min-w-0 gap-echo-sm rounded-echo-sm!"
              >
                <span className="w-9 shrink-0 max-echo-lg:hidden" />
                <InsertDriveFileOutlinedIcon
                  fontSize="small"
                  color={selected ? 'primary' : 'action'}
                />
                <span className="truncate text-echo-sm">{name}</span>
              </ListItemButton>
              {entry.unavailableReason && (
                <p className="m-0 px-echo-sm text-echo-xs text-echo-text-muted">
                  {entry.unavailableReason}
                </p>
              )}
            </li>
          );
        })}
    </>
  );
}

export function DeviceArchiveTree(props: ArchiveTreeProps) {
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [entries, setEntries] = useState<ZipEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const memberKey = props.file.archiveMember?.members.map((entry) => entry.index).join('/');
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
      setEntries(null);
      setExpanded(false);
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
    window.addEventListener(FORCED_NAVIGATION_EVENT, cancel);
    setEntries(null);
    setError(null);
    void listDeviceArchive(props.deviceId, props.file, controller.signal)
      .then((listing) => {
        if (!controller.signal.aborted) setEntries(listing.entries);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        const message = toDeviceFileLoadError(cause, 'Помилка перегляду архіву').message;
        setError(message);
        notifyRef.current({ severity: 'error', message });
        if (cause instanceof HttpRequestError && cause.status === 401) emitUnauthorizedEvent();
      });
    return () => {
      controller.abort();
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, cancel);
    };
  }, [props.deviceId, props.file.fileId, props.file.revision, memberKey, expanded, attempt]);
  return (
    <ArchiveFolder
      name={props.file.name}
      depth={props.depth}
      expanded={expanded}
      entryId={props.file.entryId}
      selected={props.selectedEntryId === props.file.entryId}
      onSelect={() => {
        props.onSelectFile(props.file);
        setExpanded(true);
      }}
      onToggle={() => setExpanded((value) => !value)}
    >
      {error ? (
        <li className="p-echo-sm">
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              <PowerButton onClick={() => setAttempt((value) => value + 1)}>Повторити</PowerButton>
            }
          >
            {error}
          </PowerAlert>
        </li>
      ) : entries === null ? (
        <li className="p-echo-sm">
          <CircularProgress size={20} aria-label={`Завантаження каталогу ${props.file.name}`} />
        </li>
      ) : entries.length === 0 ? (
        <li className="p-echo-sm text-echo-sm text-echo-text-muted">Каталог порожній</li>
      ) : (
        <ArchiveChildren {...props} depth={props.depth + 1} entries={entries} path="" />
      )}
    </ArchiveFolder>
  );
}
