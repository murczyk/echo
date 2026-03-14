import * as L from 'leaflet';

export interface MapSettingsControl extends L.Control {
  setPelengLabelsVisible: (visible: boolean) => void;
}

export function createMapSettingsControl(
  initialShowPelengLabels: boolean,
  onPelengLabelsChange: (show: boolean) => void
): MapSettingsControl {
  const MapSettingsControlClass = L.Control.extend({
    _showPelengLabels: initialShowPelengLabels,
    _isCollapsed: true,

    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create(
        'div',
        'leaflet-bar leaflet-control layer-switch-control map-settings-control'
      );
      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      this._render();
      return this._container;
    },

    _toggleCollapsed: function () {
      this._isCollapsed = !this._isCollapsed;
      this._render();
    },

    _render: function () {
      if (!this._container) return;
      this._container.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'layer-switch-header';

      if (this._isCollapsed) {
        const gearButton = document.createElement('button');
        gearButton.className = 'layer-switch-icon';
        gearButton.type = 'button';
        gearButton.setAttribute('aria-label', 'Налаштування мапи');
        gearButton.title = 'Налаштування мапи';
        gearButton.innerHTML = '<i class="bi bi-gear"></i>';
        gearButton.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleCollapsed();
        });
        header.appendChild(gearButton);
      } else {
        const title = document.createElement('h3');
        title.textContent = 'Налаштування';
        const closeButton = document.createElement('button');
        closeButton.className = 'layer-switch-toggle-button';
        closeButton.innerHTML = '<i class="bi bi-chevron-down"></i>';
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', 'Згорнути');
        closeButton.title = 'Згорнути';
        closeButton.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleCollapsed();
        });
        header.appendChild(title);
        header.appendChild(closeButton);
      }

      const listContainer = document.createElement('div');
      listContainer.className = 'layer-switch-list';

      const checkboxItem = document.createElement('div');
      checkboxItem.className = 'layer-switch-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this._showPelengLabels;
      checkbox.className = 'layer-switch-radio';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'layer-switch-label';
      labelSpan.textContent = 'Показувати підписи пеленгів';
      checkboxItem.appendChild(checkbox);
      checkboxItem.appendChild(labelSpan);
      checkboxItem.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          this._showPelengLabels = checkbox.checked;
          onPelengLabelsChange(checkbox.checked);
        }
      });
      checkbox.addEventListener('change', () => {
        this._showPelengLabels = checkbox.checked;
        onPelengLabelsChange(checkbox.checked);
      });
      listContainer.appendChild(checkboxItem);

      this._container.appendChild(header);
      this._container.appendChild(listContainer);

      if (this._isCollapsed) {
        this._container.classList.add('collapsed');
      } else {
        this._container.classList.remove('collapsed');
      }
    },

    setPelengLabelsVisible: function (visible: boolean) {
      if (this._showPelengLabels === visible) return;
      this._showPelengLabels = visible;
      this._render();
    },
  });

  return new MapSettingsControlClass({ position: 'bottomleft' }) as MapSettingsControl;
}
