(() => {
  const POLL_INTERVAL_MS = 4000;
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  const REACTIONS = ["➕", "➖", "👍", "👎", "❤️", "👀"];
  const state = {
    capability: null,
    chats: [],
    chatCursor: null,
    selectedChat: null,
    messages: [],
    messageCursor: null,
    replyMessage: null,
    polling: null,
    loadingChats: false,
    loadingMessagesFor: null,
    markingRead: false,
  };

  const elements = {};
  let markVisibleReadTimer = null;

  function cacheElements() {
    [
      "chatsTabBtn",
      "chatsTab",
      "chatError",
      "chatList",
      "loadOlderChatsBtn",
      "chatConversationEmpty",
      "chatConversationContent",
      "chatTitle",
      "chatSubtitle",
      "chatMessages",
      "loadOlderMessagesBtn",
      "markAllReadBtn",
      "chatBackBtn",
      "chatSendForm",
      "chatMessageInput",
      "chatFileInput",
      "chatSelectedFiles",
      "chatReplyBar",
      "chatReplyText",
      "cancelReplyBtn",
      "chatLegend",
      "chatSettingsBtn",
      "chatSettingsDialog",
      "chatSettingsForm",
      "closeChatSettingsBtn",
      "cancelChatSettingsBtn",
      "chatSettingsClient",
      "hidePrivateChats",
      "hideGroupChats",
      "privateFilterLabel",
      "groupFilterLabel",
      "privateChatFilters",
      "groupChatFilters",
      "privateWebhookAction",
      "groupWebhookAction",
      "privateWebhookUrl",
      "groupWebhookUrl",
      "storeChatData",
      "chatSettingsStatus",
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
  }

  function showError(error) {
    elements.chatError.textContent =
      typeof error?.message === "string"
        ? error.message
        : "Не вдалося виконати дію. Повторіть спробу.";
    elements.chatError.classList.remove("hidden");
  }

  function clearError() {
    elements.chatError.textContent = "";
    elements.chatError.classList.add("hidden");
  }

  function unreadLabel(count) {
    return count > 99 ? "99+" : String(count);
  }

  function chatIcon(kind) {
    return kind === "group" ? "👥" : "👤";
  }

  function formatTime(value) {
    const timestamp = new Date(`${value}Z`);
    if (Number.isNaN(timestamp.valueOf())) return "";
    return new Intl.DateTimeFormat("uk-UA", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);
  }

  function renderChatList() {
    if (state.chats.length === 0) {
      elements.chatList.innerHTML =
        '<p class="chat-placeholder">Доступних чатів немає.</p>';
    } else {
      elements.chatList.innerHTML = state.chats
        .map(
          (chat) => `
          <button class="chat-list-item" type="button" data-chat-id="${escapeHtml(chat.id)}" aria-current="${chat.id === state.selectedChat?.id}">
            <span class="chat-avatar" style="color:${escapeHtml(chat.accountColor)}" aria-hidden="true">${chatIcon(chat.kind)}</span>
            <span class="min-w-0">
              <span class="flex items-center justify-between gap-2"><strong class="truncate text-sm">${escapeHtml(chat.title)}</strong><time class="text-[0.65rem] text-zinc-500">${escapeHtml(formatTime(chat.lastMessageAt))}</time></span>
              <span class="chat-preview"><strong>${escapeHtml(chat.previewSender)}:</strong> ${escapeHtml(chat.preview)}</span>
            </span>
            ${chat.unreadCount > 0 ? `<span class="chat-unread-badge" aria-label="Непрочитаних: ${chat.unreadCount}">${unreadLabel(chat.unreadCount)}</span>` : ""}
          </button>`,
        )
        .join("");
    }
    elements.loadOlderChatsBtn.classList.toggle("hidden", !state.chatCursor);
    renderLegend();
  }

  function renderLegend() {
    const accounts = new Map();
    state.chats.forEach((chat) => {
      accounts.set(`${chat.clientId}:${chat.accountId}`, {
        color: chat.accountColor,
        label: `${chat.clientName}: ${chat.accountLabel}`,
      });
    });
    elements.chatLegend.innerHTML = [
      '<h2 class="mb-3 text-xs font-semibold uppercase text-zinc-500">Акаунти</h2>',
      ...Array.from(accounts.values()).map(
        (account) =>
          `<div class="chat-legend-item"><span class="chat-legend-dot" style="background:${escapeHtml(account.color)}"></span><span>${escapeHtml(account.label)}</span></div>`,
      ),
    ].join("");
  }

  async function loadChats({ older = false, refreshing = false } = {}) {
    if (state.loadingChats) return;
    state.loadingChats = true;
    if (!refreshing) clearError();
    if (!older && !refreshing) {
      elements.chatList.innerHTML =
        '<p class="chat-placeholder">Завантаження…</p>';
    }
    const cursor = older ? state.chatCursor : null;
    try {
      const query = cursor ? `?before=${encodeURIComponent(cursor)}` : "";
      const page = await request(appUrl(`/ui-api/chats${query}`));
      state.chats =
        older || refreshing
          ? mergeById(state.chats, page.chats).sort((left, right) =>
              right.lastMessageAt.localeCompare(left.lastMessageAt),
            )
          : page.chats;
      if (!refreshing) state.chatCursor = page.nextCursor;
      if (state.selectedChat) {
        state.selectedChat =
          state.chats.find((chat) => chat.id === state.selectedChat.id) ||
          state.selectedChat;
      }
      renderChatList();
      if (!page.unreadAvailable) {
        showError(
          new Error(
            "Стан непрочитаних повідомлень тимчасово недоступний; історія чатів залишається доступною.",
          ),
        );
      }
    } catch (error) {
      if (!refreshing) {
        elements.chatList.innerHTML = `<p class="chat-placeholder text-red-400">${escapeHtml(error.message)}</p>`;
      }
      showError(error);
    } finally {
      state.loadingChats = false;
    }
  }

  function mergeById(current, added) {
    const values = new Map(current.map((value) => [value.id, value]));
    added.forEach((value) => values.set(value.id, value));
    return Array.from(values.values());
  }

  function attachmentMarkup(attachment) {
    const name = escapeHtml(attachment.name || "Вкладення");
    const url = escapeHtml(appUrl(attachment.url));
    if (!attachment.available) {
      return `<span class="text-sm text-zinc-400">📎 ${name} — файл недоступний</span>`;
    }
    if (attachment.mediaKind === "image") {
      return `<a href="${url}" target="_blank" rel="noopener"><img class="chat-media" src="${url}" alt="${name}" loading="lazy" /></a>`;
    }
    if (attachment.mediaKind === "video") {
      return `<video class="chat-media" controls preload="metadata"><source src="${url}" type="${escapeHtml(attachment.contentType)}" /><a href="${url}" download>${name}</a></video>`;
    }
    if (attachment.mediaKind === "audio") {
      return `<audio class="w-full" controls preload="metadata"><source src="${url}" type="${escapeHtml(attachment.contentType)}" /><a href="${url}" download>${name}</a></audio>`;
    }
    return `<a class="text-sm text-sky-300 underline" href="${url}" download>⬇ ${name}</a>`;
  }

  function messageMarkup(message) {
    const directionClass = message.outgoing
      ? "chat-message-outgoing"
      : "chat-message-incoming";
    const senderClass = message.outgoing
      ? "chat-sender-outgoing"
      : "chat-sender-incoming";
    const reply = message.reply
      ? `<div class="chat-reply-preview"><strong>${escapeHtml(message.reply.senderName)}:</strong> ${escapeHtml(message.reply.body)}</div>`
      : "";
    const attachments = message.attachments.length
      ? `<div class="chat-attachments">${message.attachments.map(attachmentMarkup).join("")}</div>`
      : "";
    const actions = message.inboxId
      ? `<div class="chat-message-actions"><button type="button" class="chat-secondary-button" data-reply-id="${message.inboxId}">Відповісти</button>${REACTIONS.map((reaction) => `<button type="button" class="chat-icon-button" data-reaction-id="${message.inboxId}" data-reaction-code="${reaction}" aria-label="Реакція ${reaction}">${reaction}</button>`).join("")}</div>`
      : "";
    return `
      <article id="chat-message-${escapeHtml(message.id.replace(":", "-"))}" class="chat-message ${directionClass} ${message.unread ? "chat-message-unread" : ""}" data-message-id="${escapeHtml(message.id)}">
        ${reply}${attachments}
        <strong class="${senderClass}">${escapeHtml(message.senderName)}:</strong>
        <div class="chat-message-body">${escapeHtml(message.body)}</div>
        ${message.reactions.length ? `<div class="mt-2 text-sm">${message.reactions.map(escapeHtml).join(" ")}</div>` : ""}
        ${actions}
        <div class="chat-message-meta"><span>${escapeHtml(message.deliveryStatus)}</span> · <time>${escapeHtml(formatTime(message.timestamp))}</time></div>
      </article>`;
  }

  function renderMessages({
    preserveScroll = false,
    preservePosition = false,
    stickToBottom = false,
    opening = false,
  } = {}) {
    const previousHeight = elements.chatMessages.scrollHeight;
    const previousTop = elements.chatMessages.scrollTop;
    elements.chatMessages.innerHTML = state.messages
      .map(messageMarkup)
      .join("");
    if (preserveScroll) {
      elements.chatMessages.scrollTop =
        elements.chatMessages.scrollHeight - previousHeight + previousTop;
    } else if (preservePosition) {
      elements.chatMessages.scrollTop = previousTop;
    } else if (stickToBottom) {
      elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    } else if (opening) {
      scrollToLastViewedAnchor();
    }
    elements.loadOlderMessagesBtn.classList.toggle(
      "hidden",
      !state.messageCursor,
    );
  }

  function scrollToLastViewedAnchor() {
    const firstUnreadIndex = state.messages.findIndex(
      (message) => !message.outgoing && message.unread,
    );
    if (firstUnreadIndex < 0) {
      elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
      return;
    }
    if (firstUnreadIndex === 0) {
      elements.chatMessages.scrollTop = 0;
      return;
    }
    const anchor = state.messages[firstUnreadIndex - 1];
    document
      .querySelector(`[data-message-id="${CSS.escape(anchor.id)}"]`)
      ?.scrollIntoView({ block: "end" });
  }

  function requestMessagePage(selectedId, cursor = null) {
    const query = cursor ? `?before=${encodeURIComponent(cursor)}` : "";
    return request(
      appUrl(
        `/ui-api/chats/${encodeURIComponent(selectedId)}/messages${query}`,
      ),
    );
  }

  async function loadPollingPages(selectedId) {
    const knownIds = new Set(state.messages.map((message) => message.id));
    if (knownIds.size === 0) {
      return requestMessagePage(selectedId);
    }
    let messages = [];
    let cursor = null;
    let unreadAvailable = true;
    let overlapsKnown = false;
    do {
      const page = await requestMessagePage(selectedId, cursor);
      messages = mergeById(page.messages, messages);
      unreadAvailable &&= page.unreadAvailable;
      overlapsKnown = page.messages.some((message) => knownIds.has(message.id));
      cursor = page.nextCursor;
    } while (cursor && !overlapsKnown);
    return { messages, unreadAvailable };
  }

  async function loadMessages({ older = false, polling = false } = {}) {
    if (!state.selectedChat) return;
    const selectedId = state.selectedChat.id;
    if (state.loadingMessagesFor === selectedId) return;
    state.loadingMessagesFor = selectedId;
    const stickToBottom =
      elements.chatMessages.scrollHeight -
        elements.chatMessages.scrollTop -
        elements.chatMessages.clientHeight <=
      8;
    try {
      const cursor = older ? state.messageCursor : null;
      const page = polling
        ? await loadPollingPages(selectedId)
        : await requestMessagePage(selectedId, cursor);
      if (state.selectedChat?.id !== selectedId) return;
      if (older) {
        state.messages = mergeById(page.messages, state.messages);
        state.messageCursor = page.nextCursor;
        renderMessages({ preserveScroll: true });
      } else if (polling) {
        if (state.messages.length === 0) {
          state.messageCursor = page.nextCursor;
        }
        state.messages = mergeById(state.messages, page.messages);
        renderMessages({
          preservePosition: !stickToBottom,
          stickToBottom,
        });
      } else {
        state.messages = page.messages;
        state.messageCursor = page.nextCursor;
        renderMessages({ opening: true });
      }
      if (!page.unreadAvailable) {
        showError(
          new Error(
            "Стан непрочитаних повідомлень тимчасово недоступний; повідомлення не позначено прочитаними.",
          ),
        );
      } else {
        await afterRender();
        await markVisibleUnread();
      }
    } catch (error) {
      showError(error);
    } finally {
      if (state.loadingMessagesFor === selectedId) {
        state.loadingMessagesFor = null;
      }
    }
  }

  function afterRender() {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }

  async function markRead(ids) {
    if (!state.selectedChat) return;
    const selectedId = state.selectedChat.id;
    try {
      await request(
        appUrl(`/ui-api/chats/${encodeURIComponent(selectedId)}/read`),
        { method: "POST", body: JSON.stringify({ inboxMessageIds: ids }) },
      );
      if (state.selectedChat?.id !== selectedId) return;
      const idSet = new Set(ids);
      state.messages.forEach((message) => {
        if (idSet.has(message.inboxId)) message.unread = false;
      });
      const chat = state.chats.find((item) => item.id === selectedId);
      if (chat) chat.unreadCount = Math.max(0, chat.unreadCount - ids.length);
      renderMessages({ preservePosition: true });
      renderChatList();
    } catch (error) {
      showError(error);
    }
  }

  async function markVisibleUnread() {
    if (!state.selectedChat || state.markingRead) return;
    const bounds = elements.chatMessages.getBoundingClientRect();
    const ids = state.messages
      .filter(
        (message) => !message.outgoing && message.unread && message.inboxId,
      )
      .filter((message) => {
        const item = elements.chatMessages.querySelector(
          `[data-message-id="${CSS.escape(message.id)}"]`,
        );
        if (!item) return false;
        const itemBounds = item.getBoundingClientRect();
        return itemBounds.bottom > bounds.top && itemBounds.top < bounds.bottom;
      })
      .map((message) => message.inboxId);
    if (ids.length === 0) return;
    state.markingRead = true;
    try {
      await markRead(ids);
    } finally {
      state.markingRead = false;
    }
  }

  async function markAllRead() {
    if (!state.selectedChat) return;
    clearError();
    try {
      await request(
        appUrl(
          `/ui-api/chats/${encodeURIComponent(state.selectedChat.id)}/read-all`,
        ),
        { method: "POST" },
      );
      state.messages.forEach((message) => {
        message.unread = false;
      });
      const chat = state.chats.find(
        (item) => item.id === state.selectedChat.id,
      );
      if (chat) chat.unreadCount = 0;
      renderMessages();
      renderChatList();
    } catch (error) {
      showError(error);
    }
  }

  async function selectChat(chatId) {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;
    state.selectedChat = chat;
    state.messages = [];
    state.messageCursor = null;
    clearReply();
    elements.chatConversationEmpty.classList.add("hidden");
    elements.chatConversationContent.classList.remove("hidden");
    elements.chatConversationContent.classList.add("flex");
    elements.chatTitle.textContent = chat.title;
    elements.chatSubtitle.textContent = `${chat.clientName} · ${chat.accountLabel}`;
    document.querySelector(".chat-layout")?.classList.add("chat-focused");
    renderChatList();
    elements.chatMessages.innerHTML =
      '<p class="chat-placeholder">Завантаження…</p>';
    await loadMessages();
    restartPolling();
  }

  function restartPolling() {
    clearInterval(state.polling);
    state.polling = setInterval(() => {
      if (!document.hidden && state.selectedChat) {
        loadMessages({ polling: true });
      }
      if (!document.hidden) loadChats({ refreshing: true });
    }, POLL_INTERVAL_MS);
  }

  function setReply(message) {
    state.replyMessage = message;
    elements.chatReplyText.textContent = `${message.senderName}: ${message.body}`;
    elements.chatReplyBar.classList.remove("hidden");
    elements.chatMessageInput.focus();
  }

  function clearReply() {
    state.replyMessage = null;
    elements.chatReplyBar.classList.add("hidden");
    elements.chatReplyText.textContent = "";
  }

  function renderSelectedFiles() {
    const files = Array.from(elements.chatFileInput.files || []);
    elements.chatSelectedFiles.textContent = files
      .map((file) => `${file.name} (${Math.ceil(file.size / 1024)} КБ)`)
      .join(", ");
    elements.chatSelectedFiles.classList.toggle("hidden", files.length === 0);
  }

  async function fileInput(file) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Файл «${file.name}» перевищує 25 МБ.`);
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(new Error(`Не вдалося прочитати файл «${file.name}».`));
      reader.readAsDataURL(file);
    });
    return {
      contentBase64: String(dataUrl).split(",", 2)[1],
      filename: file.name,
    };
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!state.selectedChat) return;
    clearError();
    const submit = elements.chatSendForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const attachments = await Promise.all(
        Array.from(elements.chatFileInput.files || []).map(fileInput),
      );
      const text = elements.chatMessageInput.value;
      const endpoint = state.replyMessage
        ? `/ui-api/chats/${encodeURIComponent(state.selectedChat.id)}/replies`
        : `/ui-api/chats/${encodeURIComponent(state.selectedChat.id)}/messages`;
      const payload = state.replyMessage
        ? {
            inboxMessageId: state.replyMessage.inboxId,
            text,
            attachments,
          }
        : { text, attachments };
      const queued = await request(appUrl(endpoint), {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.messages.push(queued.message);
      renderMessages();
      elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
      elements.chatMessageInput.value = "";
      elements.chatFileInput.value = "";
      renderSelectedFiles();
      clearReply();
      await loadChats({ refreshing: true });
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  }

  async function react(inboxMessageId, code) {
    if (!state.selectedChat) return;
    clearError();
    try {
      await request(
        appUrl(
          `/ui-api/chats/${encodeURIComponent(state.selectedChat.id)}/reactions`,
        ),
        {
          method: "POST",
          body: JSON.stringify({ inboxMessageId, code }),
        },
      );
      await loadMessages({ polling: true });
    } catch (error) {
      showError(error);
    }
  }

  function selectedValues(select) {
    return Array.from(select.selectedOptions).map((option) => option.value);
  }

  function renderFilterOptions(select, options, selected) {
    const selectedIds = new Set(selected);
    select.innerHTML = options
      .map(
        (option) =>
          `<option value="${escapeHtml(option.id)}" ${selectedIds.has(option.id) ? "selected" : ""}>${escapeHtml(option.title)} — ${escapeHtml(option.accountLabel)}</option>`,
      )
      .join("");
  }

  function updateFilterLabels() {
    elements.privateFilterLabel.textContent = elements.hidePrivateChats.checked
      ? "Дозволені контакти (allowlist)"
      : "Приховані контакти (denylist)";
    elements.groupFilterLabel.textContent = elements.hideGroupChats.checked
      ? "Дозволені групи (allowlist)"
      : "Приховані групи (denylist)";
  }

  function updateWebhookInput(action, input) {
    input.classList.toggle("hidden", action.value !== "replace");
    input.required = action.value === "replace";
  }

  async function loadSettings() {
    const clientId = Number(elements.chatSettingsClient.value);
    elements.chatSettingsStatus.textContent = "Завантаження…";
    try {
      const [settings, options] = await Promise.all([
        request(appUrl(`/ui-api/chat-clients/${clientId}/settings`)),
        request(appUrl(`/ui-api/chat-clients/${clientId}/filter-options`)),
      ]);
      elements.hidePrivateChats.checked = settings.hidePrivate;
      elements.hideGroupChats.checked = settings.hideGroups;
      elements.storeChatData.checked = settings.storeData30Days;
      renderFilterOptions(
        elements.privateChatFilters,
        options.private,
        settings.privateFilters,
      );
      renderFilterOptions(
        elements.groupChatFilters,
        options.groups,
        settings.groupFilters,
      );
      elements.privateWebhookAction.value = "keep";
      elements.groupWebhookAction.value = "keep";
      elements.privateWebhookUrl.value = "";
      elements.groupWebhookUrl.value = "";
      updateWebhookInput(
        elements.privateWebhookAction,
        elements.privateWebhookUrl,
      );
      updateWebhookInput(elements.groupWebhookAction, elements.groupWebhookUrl);
      updateFilterLabels();
      elements.chatSettingsStatus.textContent = [
        settings.privateWebhookConfigured
          ? "Приватний webhook налаштовано."
          : "Приватний webhook не налаштовано.",
        settings.groupWebhookConfigured
          ? "Груповий webhook налаштовано."
          : "Груповий webhook не налаштовано.",
      ].join(" ");
    } catch (error) {
      elements.chatSettingsStatus.textContent = error.message;
      showError(error);
    }
  }

  function webhookUpdate(action, input) {
    if (action.value === "replace") {
      return { action: "replace", value: input.value.trim() };
    }
    return { action: action.value };
  }

  async function saveSettings(event) {
    event.preventDefault();
    const clientId = Number(elements.chatSettingsClient.value);
    elements.chatSettingsStatus.textContent = "Збереження…";
    try {
      await request(appUrl(`/ui-api/chat-clients/${clientId}/settings`), {
        method: "PUT",
        body: JSON.stringify({
          hidePrivate: elements.hidePrivateChats.checked,
          hideGroups: elements.hideGroupChats.checked,
          privateFilters: selectedValues(elements.privateChatFilters),
          groupFilters: selectedValues(elements.groupChatFilters),
          privateWebhook: webhookUpdate(
            elements.privateWebhookAction,
            elements.privateWebhookUrl,
          ),
          groupWebhook: webhookUpdate(
            elements.groupWebhookAction,
            elements.groupWebhookUrl,
          ),
          storeData30Days: elements.storeChatData.checked,
        }),
      });
      elements.chatSettingsStatus.textContent = "Збережено.";
      await loadChats();
      state.selectedChat = null;
      elements.chatConversationContent.classList.add("hidden");
      elements.chatConversationEmpty.classList.remove("hidden");
      elements.chatSettingsDialog.close();
    } catch (error) {
      elements.chatSettingsStatus.textContent = error.message;
      showError(error);
    }
  }

  async function openSettings() {
    elements.chatSettingsClient.innerHTML = state.capability.clients
      .map(
        (client) =>
          `<option value="${client.id}">${escapeHtml(client.name)}</option>`,
      )
      .join("");
    elements.chatSettingsDialog.showModal();
    await loadSettings();
  }

  function bindEvents() {
    elements.chatList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-chat-id]");
      if (button) selectChat(button.dataset.chatId);
    });
    elements.loadOlderChatsBtn.addEventListener("click", () =>
      loadChats({ older: true }),
    );
    elements.loadOlderMessagesBtn.addEventListener("click", () =>
      loadMessages({ older: true }),
    );
    elements.markAllReadBtn.addEventListener("click", markAllRead);
    elements.chatBackBtn.addEventListener("click", () => {
      document.querySelector(".chat-layout")?.classList.remove("chat-focused");
    });
    elements.chatMessages.addEventListener("click", (event) => {
      const replyButton = event.target.closest("[data-reply-id]");
      if (replyButton) {
        const message = state.messages.find(
          (item) => item.inboxId === Number(replyButton.dataset.replyId),
        );
        if (message) setReply(message);
        return;
      }
      const reactionButton = event.target.closest("[data-reaction-id]");
      if (reactionButton) {
        react(
          Number(reactionButton.dataset.reactionId),
          reactionButton.dataset.reactionCode,
        );
      }
    });
    elements.chatMessages.addEventListener("scroll", () => {
      clearTimeout(markVisibleReadTimer);
      markVisibleReadTimer = setTimeout(markVisibleUnread, 150);
    });
    elements.chatSendForm.addEventListener("submit", sendMessage);
    elements.chatMessageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        elements.chatSendForm.requestSubmit();
      }
    });
    elements.chatFileInput.addEventListener("change", renderSelectedFiles);
    elements.cancelReplyBtn.addEventListener("click", clearReply);
    elements.chatSettingsBtn.addEventListener("click", openSettings);
    elements.closeChatSettingsBtn.addEventListener("click", () =>
      elements.chatSettingsDialog.close(),
    );
    elements.cancelChatSettingsBtn.addEventListener("click", () =>
      elements.chatSettingsDialog.close(),
    );
    elements.chatSettingsClient.addEventListener("change", loadSettings);
    elements.hidePrivateChats.addEventListener("change", updateFilterLabels);
    elements.hideGroupChats.addEventListener("change", updateFilterLabels);
    elements.privateWebhookAction.addEventListener("change", () =>
      updateWebhookInput(
        elements.privateWebhookAction,
        elements.privateWebhookUrl,
      ),
    );
    elements.groupWebhookAction.addEventListener("change", () =>
      updateWebhookInput(elements.groupWebhookAction, elements.groupWebhookUrl),
    );
    elements.chatSettingsForm.addEventListener("submit", saveSettings);
  }

  async function initialize() {
    cacheElements();
    bindEvents();
    try {
      state.capability = await request(appUrl("/ui-api/chats/capability"));
      if (!state.capability.enabled) return;
      elements.chatsTabBtn.classList.remove("hidden");
      window.setActiveMessengerTab("chats");
      await loadChats();
      restartPolling();
    } catch (error) {
      showError(error);
    }
  }

  window.echoChats = {
    activate() {
      if (state.capability?.enabled && state.chats.length === 0) loadChats();
    },
  };

  initialize();
})();
