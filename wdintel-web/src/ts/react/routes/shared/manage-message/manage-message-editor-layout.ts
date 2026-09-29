export const MANAGE_MESSAGE_PAIRED_FIELDS_MIN_WIDTH = 560;
export const MANAGE_MESSAGE_COMPACT_FORM_MIN_WIDTH = 720;
export const MANAGE_MESSAGE_WIDE_FORM_MIN_WIDTH = 900;

export type ManageMessageEmbeddedFormLayout = {
  density: 'single' | 'compact' | 'wide';
  mainColumns: 1 | 2;
  sectionColumns: 1 | 2;
  metadataColumns: 1 | 2;
};

export function resolveManageMessageEmbeddedFormLayout(
  editorWidth: number | null,
): ManageMessageEmbeddedFormLayout {
  if (editorWidth == null || editorWidth < MANAGE_MESSAGE_PAIRED_FIELDS_MIN_WIDTH) {
    return { density: 'single', mainColumns: 1, sectionColumns: 1, metadataColumns: 1 };
  }
  if (editorWidth < MANAGE_MESSAGE_COMPACT_FORM_MIN_WIDTH) {
    return { density: 'compact', mainColumns: 1, sectionColumns: 2, metadataColumns: 2 };
  }
  if (editorWidth < MANAGE_MESSAGE_WIDE_FORM_MIN_WIDTH) {
    return { density: 'compact', mainColumns: 2, sectionColumns: 1, metadataColumns: 2 };
  }
  return { density: 'wide', mainColumns: 2, sectionColumns: 2, metadataColumns: 2 };
}
