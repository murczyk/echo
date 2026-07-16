import { useState, useEffect, useRef } from 'react';
import Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';
import Tus from '@uppy/tus';

export const MAX_MESSAGE_ATTACHMENTS = 20;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// Generic placeholder names browsers/OSes assign to clipboard screenshots
// (e.g. macOS pastes as "image.png"). Treat these as nameless and synthesize.
const GENERIC_PASTE_NAMES = new Set(['image.png', 'image.jpg', 'image.jpeg', 'image']);

// Monotonic counter so multiple images pasted in the same millisecond (e.g. two images
// in one clipboard event) never collide on the same synthesized name — Uppy rejects
// duplicate file IDs, which would silently drop one of the images.
let pasteNameCounter = 0;

/**
 * Builds a name for a clipboard-pasted file. Screenshots arrive nameless or with a
 * generic placeholder name, so we synthesize a unique timestamped name; real filenames
 * are kept.
 */
export function pastedFileName(file: File, now: Date = new Date()): string {
  if (file.name && !GENERIC_PASTE_NAMES.has(file.name.toLowerCase())) return file.name;
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}` +
    `-${String(now.getMilliseconds()).padStart(3, '0')}-${pasteNameCounter++}`;
  const ext = EXTENSION_BY_MIME[file.type] ?? 'bin';
  return `screenshot-${stamp}.${ext}`;
}

export function useMessageUppy(busy: boolean) {
  const [attachmentErrorMsg, setAttachmentErrorMsg] = useState<string | null>(null);

  const translateError = (msg: string) => {
    if (msg.toLowerCase().includes('duplicate')) return 'Цей файл вже додано';
    if (msg.toLowerCase().includes('exceeds maximum allowed size'))
      return 'Файл занадто великий (максимум 2 ГБ)';
    if (msg.toLowerCase().includes('exceeds maximum number of files'))
      return `Перевищено максимальну кількість файлів (${MAX_MESSAGE_ATTACHMENTS})`;
    return msg;
  };
  const [uppy] = useState(() =>
    new Uppy({
      restrictions: {
        maxNumberOfFiles: MAX_MESSAGE_ATTACHMENTS,
        maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
      autoProceed: false,
    }).use(Tus, {
      endpoint: '/api/sigint/file-upload/tus',
      chunkSize: 5 * 1024 * 1024,
      limit: 3,
    }),
  );

  const [uppyFiles, setUppyFiles] = useState<UppyFile<any, any>[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const updateFiles = () => {
      setUppyFiles(uppy.getFiles());
      setAttachmentErrorMsg(null);
    };
    uppy.on('file-added', updateFiles);
    uppy.on('file-removed', updateFiles);
    return () => {
      uppy.off('file-added', updateFiles);
      uppy.off('file-removed', updateFiles);
      uppy.off('restriction-failed', (file, error) => {
        setAttachmentErrorMsg(translateError(error.message));
      });
    };
  }, [uppy]);

  useEffect(() => {
    uppy.on('restriction-failed', (file, error) => {
      setAttachmentErrorMsg(translateError(error.message));
    });
    return () => {
      // handled above
    };
  }, [uppy]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAttachmentErrorMsg(null);
    if (e.target.files) {
      Array.from(e.target.files).forEach((file) => {
        try {
          uppy.addFile({
            name: file.name,
            type: file.type,
            data: file,
          });
        } catch (err: any) {
          setAttachmentErrorMsg(translateError(err.message || 'Помилка додавання файлу'));
        }
      });
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setAttachmentErrorMsg(null);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach((file) => {
        try {
          uppy.addFile({
            name: file.name,
            type: file.type,
            data: file,
          });
        } catch (err: any) {
          setAttachmentErrorMsg(translateError(err.message || 'Помилка додавання файлу'));
        }
      });
      e.dataTransfer.clearData();
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (busy) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = Array.from(items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    // No files in the clipboard: let the browser paste text/HTML normally.
    if (files.length === 0) return;

    e.preventDefault();
    setAttachmentErrorMsg(null);
    files.forEach((file) => {
      try {
        uppy.addFile({
          name: pastedFileName(file),
          type: file.type,
          data: file,
        });
      } catch (err: any) {
        setAttachmentErrorMsg(translateError(err.message || 'Помилка додавання файлу'));
      }
    });
  };

  const handleDropzoneKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  return {
    uppy,
    uppyFiles,
    fileInputRef,
    handleFileSelect,
    handleDrop,
    handlePaste,
    handleDropzoneKeyDown,
    attachmentErrorMsg,
    setAttachmentErrorMsg,
  };
}
