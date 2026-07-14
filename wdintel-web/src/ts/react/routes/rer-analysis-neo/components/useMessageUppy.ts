import { useState, useEffect, useRef } from 'react';
import Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';
import Tus from '@uppy/tus';

export function useMessageUppy(busy: boolean) {
  const [attachmentErrorMsg, setAttachmentErrorMsg] = useState<string | null>(null);

  const translateError = (msg: string) => {
    if (msg.toLowerCase().includes('duplicate')) return 'Цей файл вже додано';
    if (msg.toLowerCase().includes('exceeds maximum allowed size'))
      return 'Файл занадто великий (максимум 2 ГБ)';
    if (msg.toLowerCase().includes('exceeds maximum number of files'))
      return 'Перевищено максимальну кількість файлів (20)';
    return msg;
  };
  const [uppy] = useState(() =>
    new Uppy({
      restrictions: {
        maxNumberOfFiles: 20,
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
    handleDropzoneKeyDown,
    attachmentErrorMsg,
    setAttachmentErrorMsg,
  };
}
