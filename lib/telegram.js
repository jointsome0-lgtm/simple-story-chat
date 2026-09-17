export function createTelegram(api, chatId, now = () => Date.now()) {
  let nextDraftAt = 0;
  return {
    async send(text, rows = []) {
      return api.sendMessage({ chat_id: chatId, text, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
    },
    async draft(jobId, text) {
      if (!text || now() < nextDraftAt) return;
      nextDraftAt = now() + 1200;
      try {
        await api.sendRichMessageDraft({ chat_id: chatId, draft_id: Number(jobId.slice(1)), rich_message: { markdown: text } });
      } catch (error) {
        // Drafts are optional previews. A rate limit delays subsequent previews;
        // a preview failure must not turn a successful model run into a retry.
        nextDraftAt = now() + (error.parameters?.retry_after ?? 5) * 1000;
      }
    },
    async final(text, rows = []) {
      return api.sendRichMessage({ chat_id: chatId, rich_message: { markdown: text }, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
    },
  };
}
