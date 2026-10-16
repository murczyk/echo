import { describe, expect, it } from 'vitest';

import {
  analysisRightDockColumn,
  analysisWorkspaceColumns,
  shouldInlineAnalysisLeftPanel,
} from '../analysis-editor-layout';

describe('analysisRightDockColumn', () => {
  it('caps the editor while allowing Analytics to use the available width', () => {
    expect(analysisRightDockColumn(true)).toBe('clamp(640px, 48%, 800px)');
    expect(analysisRightDockColumn(false)).toBe('minmax(0, 1fr)');
  });
});

describe('analysisWorkspaceColumns', () => {
  it.each([
    {
      left: false,
      right: false,
      expected: '0px minmax(0, 1fr) minmax(0, 0fr)',
    },
    {
      left: false,
      right: true,
      expected: '0px minmax(0, 1fr) minmax(0, 1fr)',
    },
    {
      left: true,
      right: false,
      expected: '256px minmax(0, 1fr) minmax(0, 0fr)',
    },
    {
      left: true,
      right: true,
      expected: '256px minmax(0, 1fr) minmax(0, 1fr)',
    },
  ])('builds the workspace for left=$left and right=$right', ({ left, right, expected }) => {
    expect(
      analysisWorkspaceColumns({
        inlineLeftPanelVisible: left,
        inlineRightDockVisible: right,
        editorOpen: false,
      }),
    ).toBe(expected);
  });

  it('uses the Analytics track when the right dock contains the editor', () => {
    expect(
      analysisWorkspaceColumns({
        inlineLeftPanelVisible: false,
        inlineRightDockVisible: true,
        editorOpen: true,
      }),
    ).toBe('0px minmax(0, 1fr) clamp(640px, 48%, 800px)');
  });
});

describe('shouldInlineAnalysisLeftPanel', () => {
  it.each([
    { width: 1599, editor: true, expected: false },
    { width: 1600, editor: true, expected: true },
    { width: 1199, editor: false, expected: false },
    { width: 1200, editor: false, expected: true },
  ])('resolves inline filters at $width', ({ width, editor, expected }) => {
    expect(
      shouldInlineAnalysisLeftPanel({
        layoutWidth: width,
        viewportWidth: width,
        desktop: true,
        leftPanelOpen: true,
        editorOpen: editor,
      }),
    ).toBe(expected);
  });

  it('moves filters to the drawer when the shell cannot leave a 360px center', () => {
    expect(
      shouldInlineAnalysisLeftPanel({
        layoutWidth: 1360,
        viewportWidth: 1600,
        desktop: true,
        leftPanelOpen: true,
        editorOpen: true,
      }),
    ).toBe(false);
  });

  it('never inlines a closed panel or a non-desktop layout', () => {
    expect(
      shouldInlineAnalysisLeftPanel({
        layoutWidth: 1920,
        viewportWidth: 1920,
        desktop: false,
        leftPanelOpen: true,
        editorOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldInlineAnalysisLeftPanel({
        layoutWidth: 1920,
        viewportWidth: 1920,
        desktop: true,
        leftPanelOpen: false,
        editorOpen: false,
      }),
    ).toBe(false);
  });
});
