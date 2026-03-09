import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { MapSearchInput } from './components/MapSearchInput';

const ATTR_RESULTS_COUNT = 'results-count';
const ATTR_SEARCH_LOADING = 'search-loading';
const ATTR_INITIAL_QUERY = 'initial-query';
const ATTR_DISABLED = 'disabled';
const ATTR_PLACEHOLDER = 'placeholder';
const DEFAULT_PLACEHOLDER = 'Точка, лісосмуга або координати';

class AnalysisMapSearchElement extends HTMLElement {
  static observedAttributes = [ATTR_RESULTS_COUNT, ATTR_SEARCH_LOADING, ATTR_INITIAL_QUERY, ATTR_DISABLED, ATTR_PLACEHOLDER];

  private root: Root | null = null;
  private resultsCount: number | null = null;
  private isSearchLoading = false;
  private initialQuery = '';
  private isDisabled = false;
  private placeholder = DEFAULT_PLACEHOLDER;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.resultsCount = this.parseResultsCount(this.getAttribute(ATTR_RESULTS_COUNT));
    this.isSearchLoading = this.getAttribute(ATTR_SEARCH_LOADING) === 'true';
    this.initialQuery = this.getAttribute(ATTR_INITIAL_QUERY) ?? '';
    this.isDisabled = this.getAttribute(ATTR_DISABLED) === 'true';
    this.placeholder = this.getAttribute(ATTR_PLACEHOLDER) ?? DEFAULT_PLACEHOLDER;
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
        placeholder={this.placeholder}
        onSearch={onSearch}
        resultsCount={this.resultsCount}
        isSearchLoading={this.isSearchLoading}
        isInputLoading={this.isDisabled}
        disabled={this.isDisabled}
        minWidth={320}
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
    if (name === ATTR_DISABLED) {
      this.isDisabled = newValue === 'true';
    }
    if (name === ATTR_PLACEHOLDER) {
      this.placeholder = newValue ?? DEFAULT_PLACEHOLDER;
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

  setSearchDisabled(isDisabled: boolean) {
    if (isDisabled) {
      this.setAttribute(ATTR_DISABLED, 'true');
      return;
    }
    this.removeAttribute(ATTR_DISABLED);
  }

  setPlaceholder(placeholder: string) {
    if (!placeholder.trim()) {
      this.removeAttribute(ATTR_PLACEHOLDER);
      return;
    }
    this.setAttribute(ATTR_PLACEHOLDER, placeholder);
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
