type IconSearchDocument = {
  title: string;
  icon: string;
  descrption: string;
};

type IconSearch = {
  addIndex: (field: string) => void;
  addDocuments: (documents: IconSearchDocument[]) => void;
  search: (query: string) => IconSearchDocument[];
};

let iconSearchPromise: Promise<IconSearch> | null = null;

async function loadIconSearch(): Promise<IconSearch> {
  const [module, response] = await Promise.all([
    import('../../../../../static/js-search'),
    fetch('/data/description-icon-title.json'),
  ]);
  const documents = (await response.json()) as IconSearchDocument[];
  const search = new module.Search('icon') as IconSearch;
  search.addIndex('title');
  search.addIndex('descrption');
  search.addIndex('icon');
  search.addDocuments(documents);
  return search;
}

function getIconSearch(): Promise<IconSearch> {
  if (!iconSearchPromise) {
    iconSearchPromise = loadIconSearch();
  }
  return iconSearchPromise;
}

export async function proposeImporterIcons(text: string): Promise<string[]> {
  if (text.trim() === '') return [];
  const search = await getIconSearch();
  return search.search(text).map((item) => item.icon).slice(0, 8);
}
