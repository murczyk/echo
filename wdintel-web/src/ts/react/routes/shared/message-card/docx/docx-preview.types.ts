export type DocxPageSize = {
  widthTwips: number;
  heightTwips: number;
};

export type DocxPreviewResult = {
  html: string;
  pageSize: DocxPageSize | null;
};
