// Defaults target the live game/bot. A staging deploy overrides both via
// plain (non-secret) wrangler vars — `--var APP_URL:... --var BOT_USERNAME:...`
// — so the same source file can run as either without a fork.
const DEFAULT_APP_URL = 'https://uhfff.github.io/leaf-garden/';
const DEFAULT_BOT_USERNAME = 'LeafSimulatorBot';
const REFERRAL_BONUS_LEAVES = '2.5 миллиарда';

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
const PROMO_CODES = ['luck35', 'newcases', 'tree67x3', 'luck67', 'exclusive50'];

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
 *  chat id the `users` D1 table has ever recorded — the only "everyone"
 *  the bot knows about, since it never had a user list before this route
 *  existed. */
async function handleBroadcast(request, env) {
  if (!env.BROADCAST_SECRET || request.headers.get('X-Broadcast-Secret') !== env.BROADCAST_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.DB) {
    return new Response('No DB bound on this worker.', { status: 400 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Expected JSON body: { "text": "..." }', { status: 400 });
  }
  if (!body.text) return new Response('Missing "text".', { status: 400 });

  const { results } = await env.DB.prepare('SELECT chat_id FROM users').all();
  let sent = 0;
  let failed = 0;
  for (const row of results) {
    const ok = await sendMessage(env.BOT_TOKEN, row.chat_id, body.text);
    if (ok) sent++;
    else failed++;
  }

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
 *  10 minutes after, keyed by their Telegram id — the only identity it
 *  has, and only available inside the Mini App. Unauthenticated: this is
 *  telemetry about the sender's own play, not something worth guarding.
 *  Lives in D1 rather than KV — this write happens continuously for
 *  every active player, and KV's free tier caps out at 1,000 writes/day
 *  total; D1's is orders of magnitude higher. */
async function handleStatsWrite(request, env) {
  if (!env.DB) return new Response('No DB bound on this worker.', { status: 400, headers: CORS_HEADERS });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Expected JSON body.', { status: 400, headers: CORS_HEADERS });
  }
  if (!body.chatId) return new Response('Missing "chatId".', { status: 400, headers: CORS_HEADERS });
  await env.DB.prepare(
    `INSERT INTO stats (chat_id, leaves, total_earned, income_per_sec, trees, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       leaves = excluded.leaves,
       total_earned = excluded.total_earned,
       income_per_sec = excluded.income_per_sec,
       trees = excluded.trees,
       updated_at = excluded.updated_at`,
  )
    .bind(
      String(body.chatId),
      body.leaves,
      body.totalEarned,
      body.incomePerSec,
      JSON.stringify(body.trees || []),
      Date.now(),
    )
    .run();
  return new Response('OK', { headers: CORS_HEADERS });
}

/** Admin-only, same secret as /broadcast — returns every stats snapshot
 *  currently on file. */
async function handleStatsRead(request, env) {
  if (!env.BROADCAST_SECRET || request.headers.get('X-Broadcast-Secret') !== env.BROADCAST_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.DB) return new Response('No DB bound on this worker.', { status: 400 });

  const { results } = await env.DB.prepare('SELECT * FROM stats').all();
  const players = results.map((row) => ({
    chatId: row.chat_id,
    leaves: row.leaves,
    totalEarned: row.total_earned,
    incomePerSec: row.income_per_sec,
    trees: JSON.parse(row.trees),
    updatedAt: row.updated_at,
  }));

  return new Response(JSON.stringify(players), { headers: { 'Content-Type': 'application/json' } });
}

/** Same data /stats (HTTP) reports, formatted for a chat reply. */
async function statsSummaryText(env) {
  if (!env.DB) return 'Статистика недоступна — не подключено хранилище.';

  const userCountRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
  const { results: statsRows } = await env.DB.prepare('SELECT leaves, trees, updated_at FROM stats').all();

  const now = Date.now();
  let withTrees = 0;
  let activeRecently = 0;
  let totalTrees = 0;
  let totalLeaves = 0;
  for (const row of statsRows) {
    const trees = JSON.parse(row.trees);
    if (trees.length > 0) withTrees++;
    if (now - row.updated_at < 10 * 60 * 1000) activeRecently++;
    totalTrees += trees.length;
    totalLeaves += row.leaves;
  }

  return (
    '📊 Статистика\n\n' +
    `Писали боту: ${userCountRow.c}\n` +
    `Открывали игру: ${statsRows.length}\n` +
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
    // broadcast has someone to reach — best-effort, doesn't block the
    // reply. In D1 (see handleStatsWrite for why), not KV.
    if (env.DB) {
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO users (chat_id, first_seen, last_seen) VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET last_seen = excluded.last_seen`,
        )
          .bind(String(chatId), Date.now(), Date.now())
          .run(),
      );
    }
    const text = (message.text || '').trim();
    const startMatch = text.match(/^\/start(?:\s+(\S+))?$/);
    const refMatch = startMatch?.[1]?.match(/^ref(\d+)$/);

    if (refMatch) {
      const referrerId = refMatch[1];
      // A self-referral (someone opening their own link) pays out nothing —
      // dedup on the game side is per browser, not per Telegram account, so
      // without this check the same person could farm their own bonus.
      //
      // Each invited person is locked to whoever referred them first — the
      // 'referrals' row is written once and never updated, so re-visiting
      // a different referral link later (or the same one again) doesn't
      // let someone collect a second referrer's bonus off the same
      // account, and doesn't spam a second referrer with a notification
      // for a person who was never really "theirs".
      if (String(referrerId) !== String(chatId) && env.DB) {
        const alreadyReferred = await env.DB.prepare('SELECT 1 FROM referrals WHERE chat_id = ?')
          .bind(String(chatId))
          .first();
        if (!alreadyReferred) {
          ctx.waitUntil(
            env.DB.prepare('INSERT INTO referrals (chat_id, referrer_id, created_at) VALUES (?, ?, ?)')
              .bind(String(chatId), String(referrerId), Date.now())
              .run(),
          );
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
