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
const PROMO_CODES = ['luck35', 'newcases', 'tree67x3', 'luck67'];

// Only this Telegram username may run /stats in chat — everyone else's
// attempt just falls through to the normal fallback reply, same as any
// other command the bot doesn't recognize.
const STATS_OWNER_USERNAME = 'temamodelka';

// Mirrors src/game/economy.ts's formatLeaves so the numbers in a /stats
// reply read the same way the game itself displays them.
function formatLeaves(n) {
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v < 1000) return sign + v.toFixed(v < 10 ? 1 : 0);
  const units = ['K', 'M', 'B', 'T'];
  let unit = -1;
  let val = v;
  while (val >= 1000 && unit < units.length - 1) {
    val /= 1000;
    unit++;
  }
  return `${sign}${val.toFixed(val < 10 ? 2 : 1)}${units[unit]}`;
}

function normalizePromo(text) {
  return text.trim().toLowerCase();
}

async function sendMessage(token, chatId, text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    }),
  });
  return res.ok;
}

/** Admin-only route, not part of the Telegram webhook contract — Telegram
 *  always POSTs updates to the root path, so /broadcast is free to use for
 *  this. Guarded by its own secret (BROADCAST_SECRET) rather than chat id,
 *  since we don't hardcode who the bot's owner is. Sends `text` to every
 *  chat id the USERS KV has ever recorded — the only "everyone" the bot
 *  knows about, since it never had a user list before this route existed. */
async function handleBroadcast(request, env) {
  if (!env.BROADCAST_SECRET || request.headers.get('X-Broadcast-Secret') !== env.BROADCAST_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.USERS) {
    return new Response('No USERS KV bound on this worker.', { status: 400 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Expected JSON body: { "text": "..." }', { status: 400 });
  }
  if (!body.text) return new Response('Missing "text".', { status: 400 });

  let sent = 0;
  let failed = 0;
  let cursor;
  do {
    // 'user:' prefix keeps this scoped to real chat-id registrations —
    // the KV also holds 'stats:<id>' entries that aren't valid recipients.
    const page = await env.USERS.list({ prefix: 'user:', cursor });
    for (const key of page.keys) {
      const chatId = key.name.slice('user:'.length);
      const ok = await sendMessage(env.BOT_TOKEN, chatId, body.text);
      if (ok) sent++;
      else failed++;
    }
    cursor = page.cursor;
  } while (cursor);

  return new Response(JSON.stringify({ sent, failed }), { headers: { 'Content-Type': 'application/json' } });
}

// The game posts stats from the browser (uhfff.github.io), a different
// origin than this worker, so the write route needs CORS headers or the
// browser drops the request before it ever reaches here.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** The game posts a snapshot of one player's state here on load and every
 *  minute after, keyed by their Telegram id — the only identity it has,
 *  and only available inside the Mini App. Unauthenticated: this is
 *  telemetry about the sender's own play, not something worth guarding. */
async function handleStatsWrite(request, env) {
  if (!env.USERS) return new Response('No USERS KV bound on this worker.', { status: 400, headers: CORS_HEADERS });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Expected JSON body.', { status: 400, headers: CORS_HEADERS });
  }
  if (!body.chatId) return new Response('Missing "chatId".', { status: 400, headers: CORS_HEADERS });
  await env.USERS.put(
    `stats:${body.chatId}`,
    JSON.stringify({
      leaves: body.leaves,
      totalEarned: body.totalEarned,
      incomePerSec: body.incomePerSec,
      trees: body.trees,
      updatedAt: Date.now(),
    }),
  );
  return new Response('OK', { headers: CORS_HEADERS });
}

/** Admin-only, same secret as /broadcast — returns every stats snapshot
 *  currently on file. */
async function handleStatsRead(request, env) {
  if (!env.BROADCAST_SECRET || request.headers.get('X-Broadcast-Secret') !== env.BROADCAST_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.USERS) return new Response('No USERS KV bound on this worker.', { status: 400 });

  const players = [];
  let cursor;
  do {
    const page = await env.USERS.list({ prefix: 'stats:', cursor });
    for (const key of page.keys) {
      const raw = await env.USERS.get(key.name);
      if (raw) players.push({ chatId: key.name.slice('stats:'.length), ...JSON.parse(raw) });
    }
    cursor = page.cursor;
  } while (cursor);

  return new Response(JSON.stringify(players), { headers: { 'Content-Type': 'application/json' } });
}

/** Same data /stats (HTTP) reports, formatted for a chat reply. */
async function statsSummaryText(env) {
  if (!env.USERS) return 'Статистика недоступна — не подключено хранилище.';

  let totalUsers = 0;
  let cursor;
  do {
    const page = await env.USERS.list({ prefix: 'user:', cursor });
    totalUsers += page.keys.length;
    cursor = page.cursor;
  } while (cursor);

  const players = [];
  cursor = undefined;
  do {
    const page = await env.USERS.list({ prefix: 'stats:', cursor });
    for (const key of page.keys) {
      const raw = await env.USERS.get(key.name);
      if (raw) players.push(JSON.parse(raw));
    }
    cursor = page.cursor;
  } while (cursor);

  const now = Date.now();
  const withTrees = players.filter((p) => (p.trees || []).length > 0).length;
  const activeRecently = players.filter((p) => now - (p.updatedAt || 0) < 10 * 60 * 1000).length;
  const totalTrees = players.reduce((sum, p) => sum + (p.trees ? p.trees.length : 0), 0);
  const totalLeaves = players.reduce((sum, p) => sum + (p.leaves || 0), 0);

  return (
    '📊 Статистика\n\n' +
    `Писали боту: ${totalUsers}\n` +
    `Открывали игру: ${players.length}\n` +
    `С посаженными деревьями: ${withTrees}\n` +
    `Активны за последние 10 мин: ${activeRecently}\n` +
    `Всего деревьев посажено: ${totalTrees}\n` +
    `Листьев на руках у всех: ${formatLeaves(totalLeaves)} 🍃`
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/stats' && request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (url.pathname === '/stats') {
      return request.method === 'POST' ? handleStatsWrite(request, env) : handleStatsRead(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('Leaf Garden bot is running.');
    }

    if (url.pathname === '/broadcast') {
      return handleBroadcast(request, env);
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
    // Records every chat id that has ever messaged the bot, so a future
    // broadcast has someone to reach — best-effort, doesn't block the reply.
    if (env.USERS) ctx.waitUntil(env.USERS.put(`user:${chatId}`, String(Date.now())));
    const text = (message.text || '').trim();
    const startMatch = text.match(/^\/start(?:\s+(\S+))?$/);
    const refMatch = startMatch?.[1]?.match(/^ref(\d+)$/);

    if (refMatch) {
      const referrerId = refMatch[1];
      // A self-referral (someone opening their own link) pays out nothing —
      // dedup on the game side is per browser, not per Telegram account, so
      // without this check the same person could farm their own bonus.
      //
      // Each invited person is locked to whoever referred them first —
      // 'referred:<chatId>' records that once and never gets overwritten,
      // so re-visiting a different referral link later (or the same one
      // again) doesn't let someone collect a second referrer's bonus off
      // the same account, and doesn't spam a second referrer with a
      // notification for a person who was never really "theirs".
      if (String(referrerId) !== String(chatId) && env.USERS) {
        const alreadyReferred = await env.USERS.get(`referred:${chatId}`);
        if (!alreadyReferred) {
          ctx.waitUntil(env.USERS.put(`referred:${chatId}`, referrerId));
          const giftUrl = `${appUrl}?gift=${encodeURIComponent(`ref:${referrerId}:${chatId}`)}`;
          await sendMessage(
            env.BOT_TOKEN,
            referrerId,
            '🎉 По вашей ссылке в сад пришёл новый садовод! Нажмите кнопку, чтобы забрать бонус.',
            { inline_keyboard: [[{ text: '🎁 Забрать бонус', web_app: { url: giftUrl } }]] },
          );
        }
      }
      await sendMessage(env.BOT_TOKEN, chatId, welcomeText(), gardenKeyboard);
    } else if (startMatch || text === '/help') {
      await sendMessage(env.BOT_TOKEN, chatId, welcomeText(), gardenKeyboard);
    } else if (text === '/invite') {
      await sendMessage(env.BOT_TOKEN, chatId, inviteText(botUsername, chatId), gardenKeyboard);
    } else if (text === '/stats' && (message.from?.username || '').toLowerCase() === STATS_OWNER_USERNAME) {
      await sendMessage(env.BOT_TOKEN, chatId, await statsSummaryText(env));
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
