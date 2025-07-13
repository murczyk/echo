# Callsign Graph Refactor: Modern D3.js Lit Web Component

## Overview

This refactor replaces the outdated `netjsongraph.min.js` library with a modern, custom D3.js Lit web component. The new implementation will provide better performance, maintainability, and enhanced features while maintaining full compatibility with the existing Elm interface.

## Goals

- ✅ Replace external library with custom D3.js implementation
- ✅ Maintain existing functionality and data structure
- ✅ Improve performance and user experience
- ✅ Add modern features (animations, responsive design)
- ✅ Create reusable Lit web component architecture
- ✅ Enable incremental development and testing

## Architecture

```
Elm App → Port → Lit Web Component → Modern D3.js
```

### File Structure
```
wdintel-web/src/Components/CallsignGraph/
├── callsign-graph.ts           # Lit web component
├── types.ts                    # TypeScript interfaces
├── graph.ts                    # Core D3.js graph logic
├── interactions.ts             # Zoom, pan, hover handlers
├── styling.ts                  # Colors, sizes, themes
├── animations.ts               # Animation utilities
├── performance.ts              # Performance optimizations
├── utils.ts                    # Helper functions
└── callsign-graph.css          # Component styles
```

## Implementation Phases

### Phase 1: Foundation (Week 1)
**Goal**: Create basic Lit web component with minimal D3.js functionality

#### Subtasks:
- [ ] **1.1** Create Lit web component structure and registration
- [ ] **1.2** Implement basic TypeScript interfaces
- [ ] **1.3** Create minimal D3.js force layout
- [ ] **1.4** Add basic node and link rendering
- [ ] **1.5** Implement simple zoom and pan
- [ ] **1.6** Test with existing Elm port interface

**Definition of Done**: Lit web component renders basic graph with nodes and links, responds to zoom/pan

#### Testing Checkpoint:
```bash
# Test basic functionality
npm run test:components
# Manual test: Load RerAnalysis page, toggle callsign graph
```

---

### Phase 2: Core Features (Week 2)
**Goal**: Implement all current functionality with improved UX

#### Subtasks:
- [ ] **2.1** Add node sizing based on count
- [ ] **2.2** Implement link coloring by frequency
- [ ] **2.3** Add hover tooltips with node information
- [ ] **2.4** Implement node labels (with performance optimization)
- [ ] **2.5** Add smooth animations and transitions
- [ ] **2.6** Implement "show all" toggle functionality

**Definition of Done**: All current features work with better performance and UX

#### Testing Checkpoint:
```bash
# Test feature parity
npm run test:graph-features
# Manual test: Verify all existing functionality works
```

---

### Phase 3: Enhanced Features (Week 3)
**Goal**: Add modern features and optimizations

#### Subtasks:
- [ ] **3.1** Add node filtering and search
- [ ] **3.2** Implement responsive design
- [ ] **3.3** Add dark/light theme support
- [ ] **3.4** Optimize performance for large datasets
- [ ] **3.5** Add export capabilities (PNG/SVG)
- [ ] **3.6** Implement error handling and loading states

**Definition of Done**: Enhanced features work smoothly with good performance

#### Testing Checkpoint:
```bash
# Test new features
npm run test:enhanced-features
# Performance test: Load large datasets
```

---

### Phase 4: Polish & Integration (Week 4)
**Goal**: Final polish and integration with existing codebase

#### Subtasks:
- [ ] **4.1** Remove old netjsongraph library
- [ ] **4.2** Update Elm port interface if needed
- [ ] **4.3** Add comprehensive error handling
- [ ] **4.4** Implement accessibility features
- [ ] **4.5** Add comprehensive documentation
- [ ] **4.6** Final performance optimization

**Definition of Done**: Production-ready component with full integration

#### Testing Checkpoint:
```bash
# Full integration test
npm run test:integration
# Manual test: Complete user workflow
```

## Technical Details

### Lit Web Component Interface
```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('callsign-graph')
export class CallsignGraph extends LitElement {
  @property({ type: Object })
  data: NetJsonGraphAndMeta;

  @property({ type: Object })
  config: GraphConfig = {
    width: 800,
    height: 600,
    nodeSizeRange: [5, 20],
    linkWidthRange: [1, 5],
    colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57'],
    darkMode: false
  };

  private graph: D3Graph;
  private resizeObserver: ResizeObserver;

  connectedCallback() {
    super.connectedCallback();
    this.initGraph();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.destroyGraph();
  }

  updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('data')) {
      this.updateGraph();
    }
  }

  private initGraph() {
    const container = this.shadowRoot?.getElementById('graph-container');
    if (container) {
      this.graph = new D3Graph(container, this.config);
      this.setupResizeObserver();
    }
  }

  private updateGraph() {
    if (this.graph && this.data) {
      this.graph.updateData(this.data);
    }
  }

  private destroyGraph() {
    if (this.graph) {
      this.graph.destroy();
    }
  }

  render() {
    return html`
      <div id="graph-container" class="graph-container">
        <div class="loading" ?hidden=${!this.loading}>
          <div class="spinner"></div>
        </div>
      </div>
    `;
  }

  static styles = css`
    .graph-container {
      width: 100%;
      height: 100%;
      position: relative;
    }
    
    .loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }
    
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #f3f3f3;
      border-top: 4px solid #3498db;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
}
```

### TypeScript Interfaces
```typescript
// types.ts
interface CallsignNode {
  id: string;
  name: string;
  count: number;
  properties?: {
    freqs?: string[];
  };
}

interface CallsignLink {
  source: string;
  target: string;
  cost: number;
  category?: string;
  properties?: {
    freq?: string;
  };
}

interface CallsignGraphData {
  nodes: CallsignNode[];
  links: CallsignLink[];
  linkCategories?: LinkCategory[];
  overallCount?: number;
}

interface GraphConfig {
  width: number;
  height: number;
  nodeSizeRange: [number, number];
  linkWidthRange: [number, number];
  colors: string[];
  darkMode: boolean;
}
```

### Elm Port Updates
```elm
-- Minimal changes to existing port
port port_initNetjsonGraph :
    { elemId : String
    , graphDataAndMeta : B.NetJsonGraphAndMeta
    }
    -> Cmd msg

-- Optional: Add new port for enhanced interactions
port port_graphInteraction : (GraphInteraction -> msg) -> Sub msg
```

### Performance Targets
- **Rendering**: < 100ms for 100 nodes
- **Interactions**: 60fps during zoom/pan
- **Memory**: < 50MB for 1000 nodes
- **Load time**: < 2s for initial render

## Risk Mitigation

### High Risk Items
- **Data structure changes**: Keep existing `NetJsonGraphAndMeta` structure
- **Performance issues**: Implement progressive rendering for large datasets
- **Browser compatibility**: Test on Chrome, Firefox, Safari

### Mitigation Strategies
- **Incremental development**: Each phase is testable independently
- **Feature flags**: Enable/disable new features during development
- **Fallback mechanism**: Keep old library as backup during transition

## Success Criteria

### Functional Requirements
- ✅ All existing features work identically
- ✅ Performance is equal or better than current implementation
- ✅ No breaking changes to Elm interface
- ✅ Responsive design works on all screen sizes

### Non-Functional Requirements
- ✅ Code is maintainable and well-documented
- ✅ Component is reusable across the application
- ✅ Accessibility standards are met
- ✅ Error handling is comprehensive

## Rollback Plan

If issues arise during development:
1. **Phase 1-2**: Revert to old library, continue development
2. **Phase 3-4**: Feature flags to disable new features
3. **Production**: Gradual rollout with A/B testing

## Dependencies

```json
{
  "dependencies": {
    "lit": "^2.7.0",
    "d3": "^7.8.5",
    "@types/d3": "^7.4.3"
  }
}
```

## Timeline Summary

| Phase | Duration | Key Deliverables | Risk Level |
|-------|----------|------------------|------------|
| 1 | 1 week | Basic Lit web component | Low |
| 2 | 1 week | Feature parity | Medium |
| 3 | 1 week | Enhanced features | Medium |
| 4 | 1 week | Polish & integration | Low |

**Total Duration**: 4 weeks with incremental testing at each phase

## Development Commands

```bash
# Install dependencies
npm install lit d3 @types/d3

# Build component
npm run build:components

# Test component
npm run test:components

# Development server
npm run dev
```

## Component Usage

```html
<!-- In Elm view -->
<div id="callsign-graph-div">
  <callsign-graph 
    .data=${graphDataAndMeta}
    .config=${graphConfig}>
  </callsign-graph>
</div>
```

This approach allows for continuous validation and early detection of issues, ensuring a smooth transition from the old library to the new Lit web component implementation. 