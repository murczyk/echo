export const TEXT_BACKGROUND_PADDING_MIN = 0;
export const TEXT_BACKGROUND_PADDING_MAX = 32;
export const TEXT_BACKGROUND_PADDING_DEFAULT = 6;
export const IMAGE_EDITOR_TEXT_TYPE = 'image-editor-text';

export function registerPaddedTextAnnotation(fabric: typeof import('fabric')) {
  try {
    if (fabric.classRegistry.getClass(IMAGE_EDITOR_TEXT_TYPE)) return;
  } catch {
    // Register the class below when this is the first editor instance.
  }
  class ImageEditorText extends fabric.IText {
    static type = IMAGE_EDITOR_TEXT_TYPE;
    annotationBackgroundEnabled = false;
    annotationBackgroundColor = '#ffffff';
    annotationBackgroundPadding = TEXT_BACKGROUND_PADDING_DEFAULT;

    constructor(text: string, options: Record<string, unknown> = {}) {
      super(text, options as never);
      this.annotationBackgroundEnabled = options.annotationBackgroundEnabled === true;
      if (typeof options.annotationBackgroundColor === 'string')
        this.annotationBackgroundColor = options.annotationBackgroundColor;
      if (typeof options.annotationBackgroundPadding === 'number')
        this.annotationBackgroundPadding = options.annotationBackgroundPadding;
    }

    renderAnnotationBackground(ctx: CanvasRenderingContext2D) {
      if (this.annotationBackgroundEnabled) {
        const padding = Math.max(
          TEXT_BACKGROUND_PADDING_MIN,
          Math.min(TEXT_BACKGROUND_PADDING_MAX, this.annotationBackgroundPadding),
        );
        ctx.save();
        ctx.fillStyle = this.annotationBackgroundColor;
        ctx.fillRect(
          -this.width! / 2 - padding,
          -this.height! / 2 - padding,
          this.width! + padding * 2,
          this.height! + padding * 2,
        );
        ctx.restore();
      }
    }

    _render(ctx: CanvasRenderingContext2D) {
      this.renderAnnotationBackground(ctx);
      super._render(ctx);
    }

    _getCacheCanvasDimensions() {
      const dimensions = super._getCacheCanvasDimensions();
      const padding = this.annotationBackgroundEnabled
        ? Math.max(
            TEXT_BACKGROUND_PADDING_MIN,
            Math.min(TEXT_BACKGROUND_PADDING_MAX, this.annotationBackgroundPadding),
          )
        : 0;
      if (!padding) return dimensions;
      const scaled = dimensions as typeof dimensions & { zoomX: number; zoomY: number };
      return {
        ...dimensions,
        width: dimensions.width + padding * 2 * scaled.zoomX,
        height: dimensions.height + padding * 2 * scaled.zoomY,
      };
    }
  }
  const FabricObject = fabric.FabricObject as unknown as { customProperties?: string[] };
  FabricObject.customProperties = [
    ...(FabricObject.customProperties ?? []),
    'editorRole',
    'annotationBackgroundEnabled',
    'annotationBackgroundColor',
    'annotationBackgroundPadding',
    'attachedArrowTargetX',
    'attachedArrowTargetY',
  ];
  ImageEditorText.cacheProperties = [
    ...fabric.IText.cacheProperties,
    'annotationBackgroundEnabled',
    'annotationBackgroundColor',
    'annotationBackgroundPadding',
  ];
  fabric.classRegistry.setClass(ImageEditorText, IMAGE_EDITOR_TEXT_TYPE);
}

export function createPaddedTextAnnotation({
  fabric,
  text,
  options,
}: {
  fabric: typeof import('fabric');
  text: string;
  options: Record<string, unknown>;
}) {
  registerPaddedTextAnnotation(fabric);
  const Text = fabric.classRegistry.getClass(IMAGE_EDITOR_TEXT_TYPE) as typeof fabric.IText;
  return new Text(text, options);
}
