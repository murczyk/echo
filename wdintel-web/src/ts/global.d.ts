
interface ImportMetaEnv {
  readonly VITE_RELEASES_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  netjson_graphs: any;
}

declare var NetJSONGraph: any;

declare module '*.css';

declare module 'mammoth' {
  export type ConvertToHtmlResult = {
    value: string;
    messages?: Array<{ type?: string; message?: string }>;
  };

  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>): Promise<ConvertToHtmlResult>;
  const mammoth: {
    convertToHtml: typeof convertToHtml;
  };
  export default mammoth;
}
