import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { MapSearchInput } from './components/MapSearchInput';

const ATTR_RESULTS_COUNT = 'results-count';
const ATTR_SEARCH_LOADING = 'search-loading';
const ATTR_INITIAL_QUERY = 'initial-query';

class AnalysisMapSearchElement extends HTMLElement {
  static observedAttributes = [ATTR_RESULTS_COUNT, ATTR_SEARCH_LOADING, ATTR_INITIAL_QUERY];

  private root: Root | null = null;
  private resultsCount: number | null = null;
  private isSearchLoading = false;
  private initialQuery = '';

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.resultsCount = this.parseResultsCount(this.getAttribute(ATTR_RESULTS_COUNT));
    this.isSearchLoading = this.getAttribute(ATTR_SEARCH_LOADING) === 'true';
    this.initialQuery = this.getAttribute(ATTR_INITIAL_QUERY) ?? '';
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
      <MapSearchInput
        placeholder="Точка, лісосмуга або координати"
        onSearch={onSearch}
        resultsCount={this.resultsCount}
        isSearchLoading={this.isSearchLoading}
        initialValue={this.initialQuery || undefined}
      />,
    );
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (name === ATTR_RESULTS_COUNT) {
      this.resultsCount = this.parseResultsCount(newValue);
    }

    if (name === ATTR_SEARCH_LOADING) {
      this.isSearchLoading = newValue === 'true';
    }

    if (name === ATTR_INITIAL_QUERY) {
      this.initialQuery = newValue ?? '';
    }

    if (this.root) {
      this.renderComponent();
    }
  }

  setResultsCount(count: number | null) {
    if (count === null || Number.isNaN(count)) {
      this.removeAttribute(ATTR_RESULTS_COUNT);
      return;
    }

    this.setAttribute(ATTR_RESULTS_COUNT, String(count));
  }

  setSearchLoading(isLoading: boolean) {
    if (isLoading) {
      this.setAttribute(ATTR_SEARCH_LOADING, 'true');
      return;
    }

    this.removeAttribute(ATTR_SEARCH_LOADING);
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
