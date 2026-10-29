export type FileTypeCategoryDef = {
  color: string;
  icon: string;
  /** Lowercase, without the leading dot, matching backend stats extensions. */
  fileExtensions: string[];
};

export const OTHER_FILE_TYPE_CATEGORY = 'Інше';

export const FILE_TYPE_CATEGORIES: Record<string, FileTypeCategoryDef> = {
  Документи: {
    color: '#3b82f6',
    icon: '📄',
    fileExtensions: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'ppt', 'pptx', 'cdr'],
  },
  Таблиці: {
    color: '#10b981',
    icon: '📊',
    fileExtensions: ['csv', 'xls', 'xlsx', 'tsv', 'tsb'],
  },
  Архіви: {
    color: '#eab308',
    icon: '📦',
    fileExtensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  },
  Зображення: {
    color: '#8b5cf6',
    icon: '🖼️',
    fileExtensions: [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'bmp',
      'svg',
      'webp',
      'tiff',
      'tif',
      'ico',
      'heic',
      'heif',
    ],
  },
  Відео: {
    color: '#ef4444',
    icon: '🎬',
    fileExtensions: [
      'mp4',
      'avi',
      'mkv',
      'mov',
      'wmv',
      'flv',
      'webm',
      'm4v',
      'mpg',
      'mpeg',
      '3gp',
      'mts',
      'm2ts',
    ],
  },
  Аудіо: {
    color: '#ec4899',
    icon: '🎵',
    fileExtensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
  },
  Геофайли: {
    color: '#2dd4bf',
    icon: '🗺️',
    fileExtensions: [
      'kml',
      'kmz',
      'kme',
      'ldk',
      'set',
      'trk',
      'wpt',
      'are',
      'rte',
      'pgd',
      'gpx',
      'geojson',
      'shp',
      'shx',
      'dbf',
      'gml',
      'gdb',
      'mbtiles',
      'osm',
      'pbf',
    ],
  },
  'Код та скрипти': {
    color: '#22d3ee',
    icon: '💻',
    fileExtensions: [
      'js',
      'ts',
      'jsx',
      'tsx',
      'py',
      'java',
      'cpp',
      'c',
      'h',
      'cs',
      'php',
      'rb',
      'go',
      'rs',
      'swift',
      'kt',
      'html',
      'css',
      'scss',
      'sass',
      'json',
      'yaml',
      'yml',
      'sql',
      'sh',
      'bat',
    ],
  },
  'Бази даних': {
    color: '#64748b',
    icon: '🗄️',
    fileExtensions: ['db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'sql', 'dump'],
  },
  '3D та CAD': {
    color: '#6366f1',
    icon: '🧊',
    fileExtensions: [
      'obj',
      'fbx',
      'stl',
      'blend',
      '3ds',
      'dae',
      'gltf',
      'glb',
      'dwg',
      'dxf',
      'step',
      'stp',
      'iges',
      'igs',
    ],
  },
  'Електронні книги': {
    color: '#84cc16',
    icon: '📚',
    fileExtensions: ['epub', 'mobi', 'azw', 'azw3', 'fb2'],
  },
  [OTHER_FILE_TYPE_CATEGORY]: {
    color: '#9ca3af',
    icon: '📄',
    fileExtensions: [],
  },
};

export const FILE_TYPE_CATEGORY_NAMES = Object.keys(FILE_TYPE_CATEGORIES);

// First definition wins for extensions listed twice (e.g. `sql`).
const CATEGORY_BY_EXTENSION = new Map<string, string>();
for (const [name, def] of Object.entries(FILE_TYPE_CATEGORIES)) {
  for (const extension of def.fileExtensions) {
    if (!CATEGORY_BY_EXTENSION.has(extension)) CATEGORY_BY_EXTENSION.set(extension, name);
  }
}

/** Takes a stats extension: lowercase, no leading dot, `''` when the file has none. */
export function fileTypeCategoryForExtension(extension: string): string {
  return CATEGORY_BY_EXTENSION.get(extension) ?? OTHER_FILE_TYPE_CATEGORY;
}
