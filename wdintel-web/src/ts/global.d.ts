
interface ImportMetaEnv {
  readonly VITE_RELEASES_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  navigation: any;
  netjson_graphs: any;
}

declare var NetJSONGraph: any;
