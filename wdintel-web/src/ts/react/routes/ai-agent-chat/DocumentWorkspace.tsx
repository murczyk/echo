import CloseIcon from '@mui/icons-material/Close';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import RedoIcon from '@mui/icons-material/Redo';
import UndoIcon from '@mui/icons-material/Undo';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import {
  CircularProgress,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import dayjs from 'dayjs';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AiAgentDocumentTarget } from '../../../../Bindings';
import { designTokens } from '../../../../design-system/design-tokens';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import {
  aiAgentDocumentFileUrl,
  aiAgentUploadUrl,
  type AiAgentDocument,
  type AiAgentDocumentWorkspace,
  type AiAgentUpload,
} from '../../services/api/ai-agent';
import type { DocumentFileSelection } from './document-files';
import { DocxPagePreview } from './DocxPagePreview';
import { useConversationFiles, useDocumentWorkspace } from './use-document-workspace';
import './documents.css';

export type DocumentEditTarget = AiAgentDocumentTarget & { title: string };

const ORIGIN_LABELS: Record<string, string> = { agent: 'ШІ', user: 'Ви' };

function formatTime(value: number): string {
  return dayjs(value).format('DD.MM HH:mm');
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function isDocx(upload: AiAgentUpload): boolean {
  return upload.fileName.toLowerCase().endsWith('.docx');
}

function VersionList({
  workspace,
  previewRevision,
  busy,
  onPreview,
  onRestore,
}: {
  workspace: AiAgentDocumentWorkspace;
  previewRevision: number;
  busy: boolean;
  onPreview: (revision: number) => void;
  onRestore: (revision: number) => void;
}) {
  const head = workspace.document.headRevision;
  return (
    <section className="ai-document-panel-section" aria-label="Версії">
      <h3>Версії</h3>
      <List dense disablePadding>
        {workspace.revisions.map((revision) => (
          <ListItemButton
            key={revision.revision}
            selected={revision.revision === previewRevision}
            onClick={() => onPreview(revision.revision)}
            data-testid={`ai-document-revision-${revision.revision}`}
          >
            <ListItemText
              primary={`v${revision.revision}${revision.revision === head ? ' · поточна' : ''}`}
              secondary={[
                ORIGIN_LABELS[revision.origin] ?? revision.origin,
                formatTime(revision.createdAt),
                revision.summary,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          </ListItemButton>
        ))}
      </List>
      {previewRevision !== head ? (
        <div className="ai-document-panel-actions">
          <PowerButton
            size="small"
            variant="outlined"
            disabled={busy}
            onClick={() => onRestore(previewRevision)}
          >
            Зробити v{previewRevision} поточною
          </PowerButton>
        </div>
      ) : null}
    </section>
  );
}

function FilesPanel({
  documents,
  uploads,
  selection,
  versions,
  onSelect,
  onUseTemplate,
}: {
  documents: AiAgentDocument[];
  uploads: AiAgentUpload[];
  selection: DocumentFileSelection | null;
  versions: React.ReactNode;
  onSelect: (selection: DocumentFileSelection) => void;
  onUseTemplate: (upload: AiAgentUpload) => void;
}) {
  return (
    <aside className="ai-document-panel" aria-label="Файли розмови">
      <section className="ai-document-panel-section" aria-label="Документи">
        <h3>Документи</h3>
        {documents.length ? (
          <List dense disablePadding>
            {documents.map((document) => (
              <ListItemButton
                key={document.id}
                selected={selection?.kind === 'document' && selection.documentId === document.id}
                onClick={() => onSelect({ kind: 'document', documentId: document.id })}
              >
                <DescriptionOutlinedIcon fontSize="small" className="mr-echo-sm" />
                <ListItemText
                  primary={document.title}
                  secondary={`v${document.headRevision} · ${formatTime(document.updatedAt)}`}
                />
              </ListItemButton>
            ))}
          </List>
        ) : (
          <p className="ai-document-panel-empty">
            Документів ще немає. Додайте .docx-зразок і опишіть, які дані в нього внести.
          </p>
        )}
      </section>
      {versions}
      <section className="ai-document-panel-section" aria-label="Завантажені файли">
        <h3>Завантажені файли</h3>
        {uploads.length ? (
          <List dense disablePadding>
            {uploads.map((upload) => (
              <li key={upload.id} className="ai-document-upload">
                <ListItemButton
                  component="div"
                  selected={selection?.kind === 'upload' && selection.uploadId === upload.id}
                  onClick={() => onSelect({ kind: 'upload', uploadId: upload.id })}
                >
                  <InsertDriveFileOutlinedIcon fontSize="small" className="mr-echo-sm" />
                  <ListItemText
                    primary={upload.fileName}
                    secondary={formatSize(upload.sizeBytes)}
                  />
                </ListItemButton>
                {isDocx(upload) ? (
                  <PowerButton size="small" onClick={() => onUseTemplate(upload)}>
                    Використати як шаблон
                  </PowerButton>
                ) : null}
              </li>
            ))}
          </List>
        ) : (
          <p className="ai-document-panel-empty">У розмові ще немає вкладених файлів.</p>
        )}
      </section>
    </aside>
  );
}

function UploadStage({ upload }: { upload: AiAgentUpload }) {
  if (isDocx(upload))
    return <DocxPagePreview href={aiAgentUploadUrl(upload.id)} title={upload.fileName} />;
  return (
    <div className="ai-document-preview-overlay">
      <p>Попередній перегляд доступний для файлів .docx.</p>
      <a href={aiAgentUploadUrl(upload.id)} target="_blank" rel="noopener noreferrer">
        Відкрити {upload.fileName}
      </a>
    </div>
  );
}

/** The conversation's files beside the docked chat: a page preview of the
 * selected document or upload and, on the right, files and versions. */
export function DocumentWorkspace({
  conversationId,
  selection,
  refreshToken = 0,
  onSelect,
  onClose,
  onTargetChange,
  onUseTemplate,
}: {
  conversationId: string;
  selection: DocumentFileSelection | null;
  refreshToken?: number;
  onSelect: (selection: DocumentFileSelection) => void;
  onClose: () => void;
  onTargetChange?: (target: DocumentEditTarget | null) => void;
  onUseTemplate: (upload: AiAgentUpload) => void;
}) {
  const wide = useMediaQuery(`(min-width: ${designTokens.breakpoint.lg})`);
  const files = useConversationFiles(conversationId, refreshToken);
  const documentId = selection?.kind === 'document' ? selection.documentId : null;
  const state = useDocumentWorkspace(documentId, refreshToken);
  const workspace = state.workspace?.document.id === documentId ? state.workspace : null;
  const [panelOpen, setPanelOpen] = useState(true);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onTargetChangeRef = useRef(onTargetChange);
  onTargetChangeRef.current = onTargetChange;

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setPreviewRevision(selection?.kind === 'document' ? (selection.revision ?? null) : null);
  }, [selection]);
  useEffect(() => {
    if (selection) return;
    const first = files.documents[0];
    if (first) onSelect({ kind: 'document', documentId: first.id });
    else if (files.uploads[0]) onSelect({ kind: 'upload', uploadId: files.uploads[0].id });
  }, [files.documents, files.uploads, onSelect, selection]);
  useEffect(() => {
    onTargetChangeRef.current?.(
      workspace
        ? {
            documentId: workspace.document.id,
            revision: workspace.document.headRevision,
            title: workspace.document.title,
          }
        : null,
    );
  }, [workspace]);
  useEffect(() => () => onTargetChangeRef.current?.(null), []);

  const head = workspace?.document.headRevision ?? null;
  const shownRevision = previewRevision ?? head;
  const upload =
    selection?.kind === 'upload'
      ? (files.uploads.find((item) => item.id === selection.uploadId) ?? null)
      : null;
  const title = workspace?.document.title ?? upload?.fileName ?? 'Файли розмови';

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  async function restore(revision: number) {
    await state.setHead(revision);
    setPreviewRevision(null);
  }

  let stage: React.ReactNode;
  if (documentId && state.failed) {
    stage = (
      <div className="ai-document-preview-overlay">
        <PowerAlert severity="error">Документ недоступний.</PowerAlert>
        <PowerButton onClick={state.retry}>Спробувати ще раз</PowerButton>
      </div>
    );
  } else if (workspace && shownRevision) {
    stage = (
      <DocxPagePreview
        key={`${workspace.document.id}:${shownRevision}`}
        href={aiAgentDocumentFileUrl(workspace.document.id, shownRevision)}
        title={`${workspace.document.title}, версія ${shownRevision}`}
      />
    );
  } else if (upload) {
    stage = <UploadStage upload={upload} />;
  } else if (documentId || files.documents.length || files.uploads.length) {
    stage = (
      <div className="ai-document-preview-overlay">
        <CircularProgress />
      </div>
    );
  } else {
    stage = (
      <div className="ai-document-preview-overlay">
        <p>
          Додайте до повідомлення звіт .docx і опишіть нові дані — агент створить документ у тому ж
          оформленні.
        </p>
      </div>
    );
  }

  const content = (
    <section
      className="ai-document-workspace"
      aria-label="Документи розмови"
      data-testid="ai-document-workspace"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="ai-document-topbar">
        <span className="ai-document-title" title={title}>
          {title}
        </span>
        {workspace && shownRevision ? (
          <span className="ai-document-version">
            v{shownRevision}
            {shownRevision === head ? '' : ` · поточна v${head}`}
          </span>
        ) : null}
        {state.busy ? <CircularProgress size={16} aria-label="Зберігаємо" /> : null}
        {workspace ? (
          <>
            <Tooltip title="Попередня версія">
              <span>
                <IconButton
                  aria-label="Повернути попередню версію"
                  disabled={state.busy || workspace.undoRevision == null}
                  onClick={() => void restore(workspace.undoRevision!)}
                >
                  <UndoIcon />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Наступна версія">
              <span>
                <IconButton
                  aria-label="Повторити наступну версію"
                  disabled={state.busy || workspace.redoRevision == null}
                  onClick={() => void restore(workspace.redoRevision!)}
                >
                  <RedoIcon />
                </IconButton>
              </span>
            </Tooltip>
          </>
        ) : null}
        {workspace && shownRevision ? (
          <Tooltip title="Завантажити .docx">
            <IconButton
              component="a"
              href={aiAgentDocumentFileUrl(workspace.document.id, shownRevision)}
              download={workspace.document.fileName}
              aria-label={`Завантажити ${workspace.document.fileName}`}
            >
              <DownloadOutlinedIcon />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip title={panelOpen ? 'Сховати панель' : 'Показати панель'}>
          <IconButton
            aria-label={panelOpen ? 'Сховати панель файлів' : 'Показати панель файлів'}
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((open) => !open)}
          >
            <ViewSidebarOutlinedIcon />
          </IconButton>
        </Tooltip>
        <IconButton ref={closeRef} aria-label="Закрити файли" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </header>
      {files.failed ? (
        <div className="p-echo-sm">
          <PowerAlert severity="error">Не вдалося завантажити файли розмови.</PowerAlert>
          <PowerButton onClick={files.retry}>Спробувати ще раз</PowerButton>
        </div>
      ) : null}
      <div className={`ai-document-body${panelOpen ? ' has-panel' : ''}`}>
        <div className="ai-document-stage">{stage}</div>
        {panelOpen ? (
          <FilesPanel
            documents={files.documents}
            uploads={files.uploads}
            selection={selection}
            onSelect={onSelect}
            onUseTemplate={onUseTemplate}
            versions={
              workspace && shownRevision ? (
                <VersionList
                  workspace={workspace}
                  previewRevision={shownRevision}
                  busy={state.busy}
                  onPreview={(revision) => setPreviewRevision(revision === head ? null : revision)}
                  onRestore={(revision) => void restore(revision)}
                />
              ) : null
            }
          />
        ) : null}
      </div>
    </section>
  );
  return wide ? (
    <div className="ai-document-workspace-frame">{content}</div>
  ) : (
    <Drawer anchor="right" open onClose={onClose} slotProps={{ paper: { className: 'w-full' } }}>
      {content}
    </Drawer>
  );
}
