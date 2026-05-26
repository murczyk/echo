import { messagesCountText } from '../../maps/utils/language-utils';
import type { ContentNode } from '../../../Bindings';
import { Message } from './types';
import {
  normalizeUnknownUnitFilterValue,
  normalizeUnknownUnitDisplayValue,
} from '../../react/routes/shared/analysis-unit-filter';
import { updateStateUrl } from './url-state';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectPointEtalons(nodes: ContentNode[]): string[] {
  const etalons: string[] = [];
  for (const node of nodes) {
    if (typeof node !== 'string' && 'CNPointC' in node && node.CNPointC?.etalon != null) {
      const etalon = String(node.CNPointC.etalon).trim();
      if (etalon !== '') {
        etalons.push(etalon);
      }
    }
  }
  return etalons;
}

function renderMarkedText(nodes: ContentNode[]): string {
  const allPointEtalons = collectPointEtalons(nodes);

  return nodes
    .map((node) => {
      if (typeof node === 'string') {
        return node === 'CNNewlineC' ? '<br>' : '';
      }

      if ('CNTextC' in node) {
        return escapeHtml(node.CNTextC.text);
      }

      if ('CNHighlightC' in node) {
        const text = node.CNHighlightC.text.trim();
        return text === '' ? '' : `<span class="badge-highlighed-token badge-highlighed-token--callsign">${escapeHtml(text)}</span>`;
      }

      if ('CNCallsignC' in node) {
        const text = node.CNCallsignC.text.trim();
        return text === '' ? '' : `<span class="badge-highlighed-token badge-highlighed-token--callsign">${escapeHtml(text)}</span>`;
      }

      if ('CNSignalC' in node) {
        const text = node.CNSignalC.text.trim();
        return text === '' ? '' : `<span class="content-token--ADV">${escapeHtml(text)}</span>`;
      }

      if ('CNPointC' in node) {
        const text = node.CNPointC.text.trim();
        const cleanEtalon = String(node.CNPointC.etalon ?? '').trim();
        if (text === '' || cleanEtalon === '') {
          return '';
        }

        const title =
          allPointEtalons.length > 1
            ? `Відкрити на мапі аналізу: ${allPointEtalons.join(', ')}`
            : `Відкрити на мапі аналізу: ${cleanEtalon}`;

        return `<span class="content-token--point" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
      }

      return '';
    })
    .join('');
}

function renderMessageText(message: Message[1]): string {
  const markedText = message.text_marked ?? null;
  if (Array.isArray(markedText) && markedText.length > 0) {
    return renderMarkedText(markedText);
  }

  return escapeHtml(message.text).replace(/\n/g, '<br>');
}

function liTemplate(message_: Message, selectedUnits: string[]) {
  const rawUnit = message_[1].unit;
  const unitValue = normalizeUnknownUnitFilterValue(rawUnit);
  const unitDisplay = normalizeUnknownUnitDisplayValue(rawUnit);
  const escapedDisplay = escapeHtml(unitDisplay);
  const escapedAttr = escapeHtml(unitValue);
  const isUnitSelected = selectedUnits.some((selectedUnit) => normalizeUnknownUnitFilterValue(selectedUnit) === unitValue);
  const unitBlock = `
            <div>
              <span style="font-weight: 700; line-height: 22px;">Підрозділ:</span> 
              <span class="pointer" style="color: #0d6efd" id="map-message-id-${message_[0]}" data-unitname="${escapedAttr}">
                ${escapedDisplay}
                <i class="bi bi-${isUnitSelected ? 'dash' : 'plus'}-square" > </i>
              </span>
            </div>
            `;

  return `
          <li>
            ${message_[1].message_uid ? `<p style="line-height: 22px;"><span style="font-weight: 700;">Посилання: </span><a href="${updateStateUrl(window.location.href, message_[1].message_uid)}">${escapeHtml(message_[1].message_uid)}</a></p>` : ''}
            ${message_[1].freq ? `<p style="line-height: 22px;"><span style="font-weight: 700;">Частота:</span> ${escapeHtml(message_[1].freq)}</p>` : ''}
            ${message_[1].coords ? `<p style="line-height: 16px;"><span style="font-weight: 700;">Координати:</span> ${escapeHtml(String(message_[1].coords))}</p>` : ''}
            ${message_[1].coords ? '<span style="font-weight: 700; line-height: 22px;">Повідомлення:</span><br>' : ''}
            ${(message_[1].date && message_[1].time) ? `${escapeHtml(message_[1].date)} ${escapeHtml(message_[1].time)}<br>` : ''}
            ${renderMessageText(message_[1])}
            ${unitBlock}
            <div class="divider"></div>
          </li>
    `;
}

export function getPointPopupTemplate(sortedMessages: Message[], selectedUnits: string[]) {
  const body = sortedMessages
    .map((message) => {
      return liTemplate(message, selectedUnits);
    })
    .join('');

  return `
    <div class="messages-popup" >
      <p class="title" > ${messagesCountText(sortedMessages.length)} </p>
        <ul>
            ${body}
  </ul>
    </div>
      `;
}
