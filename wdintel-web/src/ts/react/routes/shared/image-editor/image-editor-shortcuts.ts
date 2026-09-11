import { ImageEditorTool } from './image-editor.types';

export type ImageEditorToolShortcut = {
  tool: ImageEditorTool;
  code: `Key${string}`;
  key: string;
  ukrainianKey: string;
};

export const IMAGE_EDITOR_TOOL_SHORTCUTS: readonly ImageEditorToolShortcut[] = [
  { tool: ImageEditorTool.Select, code: 'KeyV', key: 'V', ukrainianKey: 'М' },
  { tool: ImageEditorTool.Pan, code: 'KeyH', key: 'H', ukrainianKey: 'Р' },
  { tool: ImageEditorTool.Crop, code: 'KeyC', key: 'C', ukrainianKey: 'С' },
  { tool: ImageEditorTool.Text, code: 'KeyT', key: 'T', ukrainianKey: 'Е' },
  { tool: ImageEditorTool.Rectangle, code: 'KeyR', key: 'R', ukrainianKey: 'К' },
  { tool: ImageEditorTool.Ellipse, code: 'KeyO', key: 'O', ukrainianKey: 'Щ' },
  { tool: ImageEditorTool.Line, code: 'KeyL', key: 'L', ukrainianKey: 'Д' },
  { tool: ImageEditorTool.Arrow, code: 'KeyA', key: 'A', ukrainianKey: 'Ф' },
  { tool: ImageEditorTool.Brush, code: 'KeyB', key: 'B', ukrainianKey: 'І' },
  { tool: ImageEditorTool.Conceal, code: 'KeyU', key: 'U', ukrainianKey: 'Г' },
  { tool: ImageEditorTool.Magnifier, code: 'KeyM', key: 'M', ukrainianKey: 'Ь' },
];

export function imageEditorToolShortcut(tool: ImageEditorTool) {
  return IMAGE_EDITOR_TOOL_SHORTCUTS.find((shortcut) => shortcut.tool === tool);
}

export function imageEditorToolShortcutLabel(tool: ImageEditorTool) {
  const shortcut = imageEditorToolShortcut(tool);
  return shortcut ? `${shortcut.key} (${shortcut.ukrainianKey})` : null;
}

export function imageEditorToolFromKeyboardEvent(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return undefined;
  return IMAGE_EDITOR_TOOL_SHORTCUTS.find((shortcut) => shortcut.code === event.code)?.tool;
}

export function imageEditorPrimaryModifierLabel() {
  return navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
}
