import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteAiAgentUpload,
  listAiAgentUploads,
  uploadAiAgentFile,
  type AiAgentUpload,
} from '../../services/api/ai-agent';

// Mirrors the backend limits in wdintel-rs/src/config.rs (AI_AGENT_UPLOAD_*);
// the server stays authoritative.
export const AI_CHAT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const AI_CHAT_UPLOAD_MAX_PER_MESSAGE = 10;
export const AI_CHAT_UPLOAD_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'pdf',
  'docx',
  'doc',
  'rtf',
  'odt',
  'xlsx',
  'xlsm',
  'xls',
  'ods',
  'pptx',
  'ppt',
  'odp',
  'html',
  'htm',
  'xml',
  'zip',
  'rar',
  '7z',
  'png',
  'jpg',
  'jpeg',
  'webp',
];
export const AI_CHAT_UPLOAD_ACCEPT = AI_CHAT_UPLOAD_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(',');
const STATE_POLL_MS = 3_000;

export type ComposerAttachment = {
  localId: string;
  fileName: string;
  sizeBytes: number;
  status: 'uploading' | 'uploaded' | 'error';
  upload?: AiAgentUpload;
  error?: string;
};

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function attachmentProblem(file: File): string | null {
  if (!AI_CHAT_UPLOAD_EXTENSIONS.includes(extension(file.name))) {
    return 'Непідтримуваний формат';
  }
  if (file.size === 0) return 'Файл порожній';
  if (file.size > AI_CHAT_UPLOAD_MAX_BYTES) return 'Файл більший за 50 МБ';
  return null;
}

/** Clipboard images arrive as `image.png`; give each a distinct name. */
export function pastedFiles(items: DataTransferItemList | null | undefined): File[] {
  return Array.from(items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
    .map((file, index) =>
      file.name && file.name !== 'image.png'
        ? file
        : new File([file], `знімок-${Date.now()}-${index + 1}.png`, { type: file.type }),
    );
}

/**
 * Draft uploads for the next message. Files upload as soon as they are
 * picked; extraction continues on the server and the request waits for it.
 */
export function useComposerAttachments(conversationId: string | null) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const update = useCallback((localId: string, change: Partial<ComposerAttachment>) => {
    setAttachments((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
    );
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const room = AI_CHAT_UPLOAD_MAX_PER_MESSAGE - attachmentsRef.current.length;
      const accepted = files.slice(0, Math.max(0, room));
      const added = accepted.map((file) => {
        const problem = attachmentProblem(file);
        return {
          file,
          item: {
            localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            fileName: file.name,
            sizeBytes: file.size,
            status: problem ? 'error' : 'uploading',
            ...(problem ? { error: problem } : {}),
          } satisfies ComposerAttachment,
        };
      });
      setAttachments((current) => [...current, ...added.map(({ item }) => item)]);
      for (const { file, item } of added) {
        if (item.status !== 'uploading') continue;
        const controller = new AbortController();
        controllers.current.set(item.localId, controller);
        uploadAiAgentFile(file, conversationId, controller.signal)
          .then((upload) => update(item.localId, { status: 'uploaded', upload }))
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            update(item.localId, {
              status: 'error',
              error: error instanceof Error ? error.message : 'Не вдалося завантажити файл',
            });
          })
          .finally(() => controllers.current.delete(item.localId));
      }
      return files.length - accepted.length;
    },
    [conversationId, update],
  );

  const remove = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    const item = attachmentsRef.current.find((current) => current.localId === localId);
    if (item?.upload) void deleteAiAgentUpload(item.upload.id).catch(() => undefined);
    setAttachments((current) => current.filter((current) => current.localId !== localId));
  }, []);

  /** Forgets the uploads the server accepted with a message; newer drafts stay. */
  const clearSent = useCallback((uploadIds: string[]) => {
    const sent = new Set(uploadIds);
    setAttachments((current) =>
      current.filter((item) => !item.upload || !sent.has(item.upload.id)),
    );
  }, []);

  /**
   * Drafts belong to the viewed conversation; navigation discards them.
   * Uploads of a send still in flight are only dropped locally, because the
   * server may be binding them to that request.
   */
  const discardAll = useCallback(
    (sendingUploadIds: readonly string[] = []) => {
      const sending = new Set(sendingUploadIds);
      for (const item of attachmentsRef.current) {
        if (item.upload && sending.has(item.upload.id)) continue;
        remove(item.localId);
      }
      setAttachments([]);
    },
    [remove],
  );

  // Refresh extraction state so chips show processing results.
  const pendingIds = attachments
    .filter((item) => item.upload && ['uploaded', 'extracting'].includes(item.upload.state))
    .map((item) => item.upload!.id)
    .join(',');
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!pendingIds) return;
    const timer = window.setTimeout(() => {
      listAiAgentUploads(pendingIds.split(','))
        .then((uploads) => {
          const byId = new Map(uploads.map((upload) => [upload.id, upload]));
          setAttachments((current) =>
            current.map((item) =>
              item.upload && byId.has(item.upload.id)
                ? { ...item, upload: byId.get(item.upload.id) }
                : item,
            ),
          );
        })
        .catch(() => undefined)
        .finally(() => setPollTick((tick) => tick + 1));
    }, STATE_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [pendingIds, pollTick]);

  return {
    attachments,
    addFiles,
    remove,
    clearSent,
    discardAll,
    uploading: attachments.some((item) => item.status === 'uploading'),
    uploadIds: attachments
      .filter((item) => item.status === 'uploaded' && item.upload)
      .map((item) => item.upload!.id),
  };
}
