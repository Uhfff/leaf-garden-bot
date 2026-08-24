// Defaults target the live game/bot. A staging deploy overrides both via
// plain (non-secret) wrangler vars — `--var APP_URL:... --var BOT_USERNAME:...`
// — so the same source file can run as either without a fork.
const DEFAULT_APP_URL = 'https://uhfff.github.io/leaf-garden/';
const DEFAULT_BOT_USERNAME = 'LeafSimulatorBot';
const REFERRAL_BONUS_LEAVES = '5 триллионов';

function openGardenKeyboard(appUrl) {
  return { inline_keyboard: [[{ text: '🌱 Открыть сад', web_app: { url: appUrl } }]] };
}

function welcomeText() {
  return (
    'Листопад 🌳\n\n' +
    'Idle-игра про сад: сажаете деревья, поливаете, удобряете и улучшаете их, ' +
    'копите листья. Чем дольше дерево растёт, тем больше приносит.\n\n' +
    'Нажмите кнопку ниже, чтобы открыть игру. Команда /invite — ваша ' +
    'реферальная ссылка.'
  );
}

const FALLBACK_TEXT = 'Не знаю такой команды. Отправьте /start, чтобы открыть игру.';

function referralLink(botUsername, chatId) {
  return `https://t.me/${botUsername}?start=ref${chatId}`;
}

function inviteText(botUsername, chatId) {
  return (
    `Ваша реферальная ссылка:\n${referralLink(botUsername, chatId)}\n\n` +
    `За каждого друга, который откроет сад по этой ссылке, вы получите ${REFERRAL_BONUS_LEAVES} 🍃.`
  );
}

// Keep in sync with src/data/promoCodes.ts in the game repo — the game
// resolves `?gift=<code>` through that same table, so a code redeemed via
// this bot and the same code typed into the in-game promo modal are one
// redemption, not two.
const PROMO_CODES = ['kirillpidor2t', 'vanyafree', 'luck35', 'newcases', 'specialbonus'];

function normalizePromo(text) {
  return text.trim().toLowerCase();
}

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

    const appUrl = env.APP_URL || DEFAULT_APP_URL;
    const botUsername = env.BOT_USERNAME || DEFAULT_BOT_USERNAME;
    const gardenKeyboard = openGardenKeyboard(appUrl);

    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const startMatch = text.match(/^\/start(?:\s+(\S+))?$/);
    const refMatch = startMatch?.[1]?.match(/^ref(\d+)$/);

    if (refMatch) {
      const referrerId = refMatch[1];
      // A self-referral (someone opening their own link) pays out nothing —
      // dedup on the game side is per browser, not per Telegram account, so
      // without this check the same person could farm their own bonus.
      if (String(referrerId) !== String(chatId)) {
        const giftUrl = `${appUrl}?gift=${encodeURIComponent(`ref:${referrerId}:${chatId}`)}`;
        await sendMessage(
          env.BOT_TOKEN,
          referrerId,
          '🎉 По вашей ссылке в сад пришёл новый садовод! Нажмите кнопку, чтобы забрать бонус.',
          { inline_keyboard: [[{ text: '🎁 Забрать бонус', web_app: { url: giftUrl } }]] },
        );
      }
      await sendMessage(env.BOT_TOKEN, chatId, welcomeText(), gardenKeyboard);
    } else if (startMatch || text === '/help') {
      await sendMessage(env.BOT_TOKEN, chatId, welcomeText(), gardenKeyboard);
    } else if (text === '/invite') {
      await sendMessage(env.BOT_TOKEN, chatId, inviteText(botUsername, chatId), gardenKeyboard);
    } else if (PROMO_CODES.includes(normalizePromo(text))) {
      const giftUrl = `${appUrl}?gift=${encodeURIComponent(normalizePromo(text))}`;
      await sendMessage(env.BOT_TOKEN, chatId, '🎉 Промокод принят! Нажмите кнопку, чтобы забрать бонус.', {
        inline_keyboard: [[{ text: '🎁 Забрать бонус', web_app: { url: giftUrl } }]],
      });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, FALLBACK_TEXT, gardenKeyboard);
    }

    return new Response('OK');
  },
};
