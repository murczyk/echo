import { messagesCountText } from '../../maps/utils/language-utils';
import { Message, NetworkUnit } from './types';
import { updateStateUrl } from './url-state';

function liTemplate(message_: Message, networkUnitName_: string | undefined, selectedUnits: string[]) {
  const unitName = networkUnitName_ ?? message_[1].unit ?? 'Не визначено';
  const unitBlock = `
            <div>
              <span style="font-weight: 700; line-height: 22px;">Підрозділ:</span> 
              <span class="pointer" style="color: #0d6efd" id="map-message-id-${message_[0]}", data-unitname="${unitName}">
                ${unitName}
                <i class="bi bi-${selectedUnits.includes(unitName) ? 'dash' : 'plus'}-square" > </i>
              </span>
            </div>
            `;

  return `
          <li>
            ${message_[1].message_uid ? `<p style="line-height: 22px;"><span style="font-weight: 700;">Посилання: </span><a href="${updateStateUrl(window.location.href, message_[1].message_uid)}">${message_[1].message_uid}</a></p>` : ''}
            ${message_[1].freq ? `<p style="line-height: 22px;"><span style="font-weight: 700;">Частота:</span> ${message_[1].freq}</p>` : ''}
            ${message_[1].coords ? `<p style="line-height: 16px;"><span style="font-weight: 700;">Координати:</span> ${message_[1].coords}</p>` : ''}
            ${message_[1].coords ? '<span style="font-weight: 700; line-height: 22px;">Повідомлення:</span><br>' : ''}
            ${(message_[1].date && message_[1].time) ? `${message_[1].date} ${message_[1].time}<br>` : ''}
            ${message_[1].text.replace(/\n/g, '<br>')}
            ${unitBlock}
            <div class="divider"></div>
          </li>
    `;
}

export function getPointPopupTemplate(sortedMessages: Message[], networkUnits: NetworkUnit[], selectedUnits: string[]) {
  const body = sortedMessages
    .map((message) => {
      const freq = message[1].freq;
      const networkIds = message[1].network_ids;
      const shouldUseNetworkUnits = Array.isArray(networkIds) && networkIds.length > 0 && !!freq;
      const networkUnitName = shouldUseNetworkUnits
        ? networkUnits.find((unit) => unit.frequencies.includes(freq!))?.name
        : undefined;
      return liTemplate(message, networkUnitName, selectedUnits);
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
