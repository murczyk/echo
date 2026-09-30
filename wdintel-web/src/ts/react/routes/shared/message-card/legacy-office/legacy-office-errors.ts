export enum LegacyOfficePreviewErrorCode {
  FileTooLarge = 'LEGACY_OFFICE_FILE_TOO_LARGE',
  DownloadTimeout = 'LEGACY_OFFICE_DOWNLOAD_TIMEOUT',
  ParseTimeout = 'LEGACY_OFFICE_PARSE_TIMEOUT',
  InvalidCfb = 'LEGACY_OFFICE_INVALID_CFB',
  UnsupportedVersion = 'LEGACY_OFFICE_UNSUPPORTED_VERSION',
  Encrypted = 'LEGACY_OFFICE_ENCRYPTED',
  Malformed = 'LEGACY_OFFICE_MALFORMED',
  MalformedWorkerResponse = 'LEGACY_OFFICE_MALFORMED_WORKER_RESPONSE',
  ResourceLimit = 'LEGACY_OFFICE_RESOURCE_LIMIT',
  UnsupportedStructure = 'LEGACY_OFFICE_UNSUPPORTED_STRUCTURE',
  Cancelled = 'LEGACY_OFFICE_CANCELLED',
}

export class LegacyOfficePreviewError extends Error {
  constructor(public readonly code: LegacyOfficePreviewErrorCode) {
    super(code);
    this.name = 'LegacyOfficePreviewError';
  }
}

export function formatLegacyOfficePreviewError(
  code: string | null,
  extension: 'DOC' | 'XLS',
): string {
  switch (code) {
    case LegacyOfficePreviewErrorCode.FileTooLarge:
      return `Файл ${extension} завеликий для попереднього перегляду. Максимум: 10 МБ.`;
    case LegacyOfficePreviewErrorCode.DownloadTimeout:
      return 'Не вдалося завантажити файл за відведений час.';
    case LegacyOfficePreviewErrorCode.ParseTimeout:
      return `Попередній перегляд ${extension} перевищив відведений час.`;
    case LegacyOfficePreviewErrorCode.InvalidCfb:
    case LegacyOfficePreviewErrorCode.Malformed:
      return `Не вдалося відкрити ${extension}: файл пошкоджено.`;
    case LegacyOfficePreviewErrorCode.MalformedWorkerResponse:
      return `Не вдалося безпечно відобразити ${extension}.`;
    case LegacyOfficePreviewErrorCode.Encrypted:
      return `Зашифрований або захищений паролем ${extension} не підтримується.`;
    case LegacyOfficePreviewErrorCode.ResourceLimit:
      return `Попередній перегляд ${extension} перевищив безпечні обмеження.`;
    case LegacyOfficePreviewErrorCode.UnsupportedVersion:
    case LegacyOfficePreviewErrorCode.UnsupportedStructure:
      return `Структура файлу ${extension} не підтримується.`;
    default:
      return `Не вдалося відкрити ${extension}.`;
  }
}
