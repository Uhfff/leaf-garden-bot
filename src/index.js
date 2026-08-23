const APP_URL = 'https://uhfff.github.io/leaf-garden/';
const OPEN_GARDEN_KEYBOARD = {
  inline_keyboard: [[{ text: '🌱 Открыть сад', web_app: { url: APP_URL } }]],
};

const WELCOME_TEXT =
  'Листопад 🌳\n\n' +
  'Idle-игра про сад: сажаете деревья, поливаете, удобряете и улучшаете их, ' +
  'копите листья. Чем дольше дерево растёт, тем больше приносит.\n\n' +
  'Нажмите кнопку ниже, чтобы открыть игру.';

const FALLBACK_TEXT = 'Не знаю такой команды. Отправьте /start, чтобы открыть игру.';

async function sendMessage(token, chatId, text, replyMarkup) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    }),
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Leaf Garden bot is running.');
    }

    // Telegram lets a webhook require a shared secret header so random
    // requests to this public URL can't pretend to be real updates.
    if (env.WEBHOOK_SECRET) {
      const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (header !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('OK');
    }

    const message = update.message;
    if (!message || !message.chat) return new Response('OK');

    const chatId = message.chat.id;
    const text = (message.text || '').trim();

    if (text === '/start' || text === '/help') {
      await sendMessage(env.BOT_TOKEN, chatId, WELCOME_TEXT, OPEN_GARDEN_KEYBOARD);
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, FALLBACK_TEXT, OPEN_GARDEN_KEYBOARD);
    }

    return new Response('OK');
  },
};
