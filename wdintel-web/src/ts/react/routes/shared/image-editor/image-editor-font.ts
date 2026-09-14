export const IMAGE_EDITOR_FONT_FAMILY = 'Open Sans';

export async function loadImageEditorFont(weight: 'normal' | 'bold' = 'normal') {
  if (!document.fonts) return;
  const descriptor = `${weight === 'bold' ? 700 : 400} 36px "${IMAGE_EDITOR_FONT_FAMILY}"`;
  await document.fonts.load(descriptor, 'АаЇїЄєІі');
  if (!document.fonts.check(descriptor, 'АаЇїЄєІі'))
    throw new Error('Не вдалося завантажити шрифт Open Sans для редактора');
}

export async function loadImageEditorFonts() {
  await Promise.all([loadImageEditorFont(), loadImageEditorFont('bold')]);
}
