import { ImageEditorObjectRole } from './image-editor.types';

const IMAGE_EDITOR_OBJECT_ROLES = new Set<string>(Object.values(ImageEditorObjectRole));

export const TRANSIENT_CROP_ROLES = new Set<ImageEditorObjectRole>([
  ImageEditorObjectRole.Crop,
  ImageEditorObjectRole.CropMask,
]);
export const NON_DELETABLE_ROLES = new Set<ImageEditorObjectRole>([
  ImageEditorObjectRole.Concealment,
  ImageEditorObjectRole.DerivedArrow,
  ...TRANSIENT_CROP_ROLES,
]);
export const STYLEABLE_ANNOTATION_ROLES = new Set<ImageEditorObjectRole>([
  ImageEditorObjectRole.Rectangle,
  ImageEditorObjectRole.Ellipse,
  ImageEditorObjectRole.Line,
  ImageEditorObjectRole.Arrow,
  ImageEditorObjectRole.Brush,
  ImageEditorObjectRole.Highlight,
]);
export const SHAPE_ROLES = new Set<ImageEditorObjectRole>([
  ImageEditorObjectRole.Rectangle,
  ImageEditorObjectRole.Ellipse,
]);
export const DASH_SUPPORTING_ROLES = new Set<ImageEditorObjectRole>([
  ...SHAPE_ROLES,
  ImageEditorObjectRole.Line,
  ImageEditorObjectRole.Arrow,
]);

export function isImageEditorObjectRole(value: unknown): value is ImageEditorObjectRole {
  return typeof value === 'string' && IMAGE_EDITOR_OBJECT_ROLES.has(value);
}

export function isTransientCropRole(value: unknown) {
  return isImageEditorObjectRole(value) && TRANSIENT_CROP_ROLES.has(value);
}
