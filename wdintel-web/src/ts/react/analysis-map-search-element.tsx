import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { SearchInput } from './components/SearchInput';

class AnalysisMapSearchElement extends HTMLElement {
  static observedAttributes = ['results-count', 'search-loading'];
  private root: Root | null = null;
  private resultsCount: number | null = null;
  private isSearchLoading = false;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }
    this.resultsCount = this.parseResultsCount(this.getAttribute('results-count'));
    this.isSearchLoading = this.getAttribute('search-loading') === 'true';
    this.renderComponent();
  }

  private renderComponent() {
    if (!this.root) {
      return;
    }
    const onSearch = (value: string) => {
      this.dispatchEvent(new CustomEvent('search-points', { detail: value, bubbles: true, composed: true }));
    };
    this.root.render(
      <SearchInput
        placeholder="Точка, лісосмуга або координати"
        onSearch={onSearch}
        resultsCount={this.resultsCount}
        isSearchLoading={this.isSearchLoading}
      />,
    );
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (name !== 'results-count' && name !== 'search-loading') {
      return;
    }
    if (name === 'results-count') {
      this.resultsCount = this.parseResultsCount(newValue);
    }
    if (name === 'search-loading') {
      this.isSearchLoading = newValue === 'true';
    }
    this.renderComponent();
  }

  setResultsCount(count: number | null) {
    if (count === null || Number.isNaN(count)) {
      this.removeAttribute('results-count');
      return;
    }
    this.setAttribute('results-count', String(count));
  }

  setSearchLoading(isLoading: boolean) {
    if (isLoading) {
      this.setAttribute('search-loading', 'true');
      return;
    }
    this.removeAttribute('search-loading');
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private parseResultsCount(value: string | null): number | null {
    if (value === null || value.trim() === '') {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }
}

if (!customElements.get('analysis-map-search')) {
  customElements.define('analysis-map-search', AnalysisMapSearchElement);
}
