import { useState, useEffect, useRef } from 'react';
import Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';
import Tus from '@uppy/tus';

import { MESSAGE_TUS_ENDPOINT } from '../message-tus-resume';
import {
  forgetMessageUploadFailure,
  rememberMessageUploadFailure,
} from './message-upload-fallback';

// MESSAGE_ATTACHMENT_LIMIT_SYNC: keep this client upload limit synchronized
// Keep synchronized with `SIGINT_MESSAGE_MAX_ATTACHMENTS` and
// `RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES` in `wdintel-rs/src/config.rs`.
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

function translateAttachmentError(msg: string): string {
  if (msg.toLowerCase().includes('duplicate')) return 'Цей файл вже додано';
  if (msg.toLowerCase().includes('exceeds maximum allowed size'))
    return 'Файл занадто великий (максимум 2 ГБ)';
  if (msg.toLowerCase().includes('exceeds maximum number of files'))
    return `Перевищено максимальну кількість файлів (${MAX_MESSAGE_ATTACHMENTS})`;
  return msg;
}

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

export function useMessageUppy(busy: boolean, occupiedAttachmentCount = 0) {
  const [attachmentErrorMsg, setAttachmentErrorMsg] = useState<string | null>(null);
  const [uppy] = useState(() =>
    new Uppy({
      restrictions: {
        maxNumberOfFiles: MAX_MESSAGE_ATTACHMENTS,
        maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
      autoProceed: false,
    }).use(Tus, {
      endpoint: MESSAGE_TUS_ENDPOINT,
      chunkSize: 5 * 1024 * 1024,
      limit: 3,
      overridePatchMethod: true,
      removeFingerprintOnSuccess: true,
    }),
  );

  const [uppyFiles, setUppyFiles] = useState<UppyFile<any, any>[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: File[], getName: (file: File) => string) => {
    setAttachmentErrorMsg(null);
    files.forEach((file) => {
      const remainingCapacity =
        MAX_MESSAGE_ATTACHMENTS - occupiedAttachmentCount - uppy.getFiles().length;
      if (remainingCapacity <= 0) {
        setAttachmentErrorMsg(
          `Перевищено максимальну кількість файлів (${MAX_MESSAGE_ATTACHMENTS})`,
        );
        return;
      }

      try {
        uppy.addFile({
          name: getName(file),
          type: file.type,
          data: file,
        });
      } catch (err: any) {
        setAttachmentErrorMsg(translateAttachmentError(err.message || 'Помилка додавання файлу'));
      }
    });
  };

  useEffect(() => {
    const updateFiles = () => {
      setUppyFiles([...uppy.getFiles()]);
    };
    const updateFilesAndClearError = () => {
      updateFiles();
      setAttachmentErrorMsg(null);
    };
    const handleRestrictionFailed = (_file: unknown, error: Error) => {
      setAttachmentErrorMsg(translateAttachmentError(error.message));
    };
    const handleUploadError = (
      file: UppyFile<any, any> | undefined,
      error: unknown,
      response?: { status?: number },
    ) => {
      if (file) rememberMessageUploadFailure(uppy, file, error, response?.status);
      updateFiles();
    };
    const handleUploadSuccess = (file: UppyFile<any, any> | undefined) => {
      if (file) forgetMessageUploadFailure(uppy, file.id);
      updateFiles();
    };
    const handleFileRemoved = (file: UppyFile<any, any> | undefined) => {
      if (file) forgetMessageUploadFailure(uppy, file.id);
      updateFilesAndClearError();
    };

    uppy.on('file-added', updateFilesAndClearError);
    uppy.on('file-removed', handleFileRemoved);
    uppy.on('upload-start', updateFiles);
    uppy.on('upload-progress', updateFiles);
    uppy.on('upload-success', handleUploadSuccess);
    uppy.on('upload-error', handleUploadError);
    uppy.on('upload-pause', updateFiles);
    uppy.on('upload-retry', updateFiles);
    uppy.on('restriction-failed', handleRestrictionFailed);
    uppy.on('state-update', updateFiles);
    return () => {
      uppy.off('file-added', updateFilesAndClearError);
      uppy.off('file-removed', handleFileRemoved);
      uppy.off('upload-start', updateFiles);
      uppy.off('upload-progress', updateFiles);
      uppy.off('upload-success', handleUploadSuccess);
      uppy.off('upload-error', handleUploadError);
      uppy.off('upload-pause', updateFiles);
      uppy.off('upload-retry', updateFiles);
      uppy.off('restriction-failed', handleRestrictionFailed);
      uppy.off('state-update', updateFiles);
    };
  }, [uppy]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files), (file) => file.name);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files), (file) => file.name);
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
    addFiles(files, pastedFileName);
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
