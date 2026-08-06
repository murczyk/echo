import { createRoot, type Root } from 'react-dom/client';

import type { CreateUnitReq, Unit } from '../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../snake-to-camel';
import { NeoMuiThemeProvider } from './mui-theme';
import { UnitFormDialog } from './routes/rer-units-neo/components/UnitFormDialog';

function UnitEditDialog({
  unit,
  submitting,
  onClose,
  onSubmit,
}: {
  unit: Unit;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (unit: CreateUnitReq) => void;
}) {
  return (
    <UnitFormDialog
      open
      unit={unit}
      units={[]}
      devicesSectionEnabled={false}
      submitting={submitting}
      error={null}
      orbitUnits={[]}
      orbitLinksLoading={false}
      orbitLinksError={null}
      canLinkOrbitUnit={false}
      unlinkingOrbitUnitId={null}
      onClose={onClose}
      onSubmit={(value) => onSubmit(value.unit)}
      onLinkOrbitUnit={() => undefined}
      onUnlinkOrbitUnit={() => undefined}
    />
  );
}

class UnitEditDialogElement extends HTMLElement {
  private root: Root | null = null;
  private parsedUnitData: string | null | undefined;
  private parsedUnit: Unit | null = null;

  static get observedAttributes() {
    return ['data-unit', 'data-submitting'];
  }

  private dispatchDialogEvent(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  private dispatchSubmit = (unit: CreateUnitReq) => {
    this.dispatchEvent(
      new CustomEvent('unit-edit-submit', {
        detail: transformCamelToSnake(unit),
        bubbles: true,
        composed: true,
      }),
    );
  };

  private parseUnit() {
    const unitData = this.getAttribute('data-unit');
    if (unitData === this.parsedUnitData) return this.parsedUnit;
    this.parsedUnitData = unitData;
    try {
      this.parsedUnit = transformSnakeToCamel<Unit>(JSON.parse(unitData ?? 'null'));
    } catch {
      this.parsedUnit = null;
    }
    return this.parsedUnit;
  }

  private renderRoot() {
    if (!this.root) return;
    const unit = this.parseUnit();
    if (unit === null) {
      this.root.render(null);
      return;
    }
    this.root.render(
      <NeoMuiThemeProvider>
        <UnitEditDialog
          key={unit.id}
          unit={unit}
          submitting={this.getAttribute('data-submitting') === 'true'}
          onClose={() => this.dispatchDialogEvent('unit-edit-close')}
          onSubmit={this.dispatchSubmit}
        />
      </NeoMuiThemeProvider>,
    );
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue !== newValue) this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('unit-edit-dialog')) {
  customElements.define('unit-edit-dialog', UnitEditDialogElement);
}
