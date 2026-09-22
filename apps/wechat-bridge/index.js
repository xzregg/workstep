#!/usr/bin/env node
/**
 * WorkStep WeChat channel bridge (JSONL sidecar over wechaty).
 *
 * Protocol (all messages are single-line JSON objects):
 *
 *   stdin  (daemon -> sidecar, commands):
 *     {"action":"start","session":{...}|null}  start bot, optionally with a
 *                                               previously-persisted session
 *     {"action":"login"}                        request a fresh QR / verify login
 *     {"action":"logout"}                       sign out and clear the session
 *     {"action":"send_text","chat_id":"..","text":".."}
 *     {"action":"stop"}                         graceful shutdown
 *
 *   stdout (sidecar -> daemon, events):
 *     {"event":"qr_code","qr_code":"<image url or data-url>"}
 *     {"event":"login","account_id":"<wechat id>","session":{...}}
 *     {"event":"logout","account_id":"<wechat id>"}
 *     {"event":"message","chat_id":"..","sender_id":"..","text":".."}
 *     {"event":"error","error":"<message>"}
 *
 * The QR code wechaty emits for WeChat (puppet-wechat4) is an image URL that
 * the web front-end renders directly with <img src=...>. The actual WeChat
 * credential is owned by the puppet's local profile (e.g. puppet-wechat4's
 * browser profile), so a daemon restart that re-spawns this sidecar with
 * `{"action":"start","session":...}` restores the login without re-scanning.
 *
 * The `session` field is treated as opaque by this bridge: it is persisted by
 * the daemon and handed back on the next `start`, acting as a "this account was
 * previously bound" marker. The puppet's own profile is what actually keeps the
 * WeChat session alive across restarts.
 */

import { createInterface } from 'node:readline';

const PUPPET = process.env.WECHATY_PUPPET ?? 'puppet-wechat4';
const BOT_NAME = process.env.WECHATY_NAME ?? 'workstep';

let bot = null;
let started = false;
let loginRequested = false;
let loggedInAccountId = null;
let pendingSession = null;

function emit(obj) {
  // stdout is a JSONL pipe to the daemon — always one JSON object per line.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(...args) {
  // Keep stderr for human diagnostics; never pollute the JSONL stdout.
  console.error('[workstep-wechat-bridge]', ...args);
}

async function loadWeChaty() {
  try {
    return await import('wechaty');
  } catch (error) {
    log('wechaty is not installed:', error.message);
    emit({ event: 'error', error: 'wechaty not installed (run: npm install in apps/wechat-bridge)' });
    process.exit(1);
  }
}

async function createBot() {
  const { WeChatyBuilder } = await loadWeChaty();
  return WeChatyBuilder.build({ puppet: PUPPET, name: BOT_NAME });
}

function resolveChatId(contact) {
  // A WeChat "chat" is either a 1:1 Contact or a group Room. We key messages
  // by the room id when the message came from a group, otherwise by the
  // sender contact id, so the daemon can keep one session per conversation.
  const room = contact.room?.();
  return room ? room.id : contact.id;
}

async function wireEvents() {
  bot.on('qr', (qrcodeStr, status) => {
    if (!qrcodeStr) return;
    log('qr (status=%s)', status);
    // wechaty passes the WeChat QR as an image URL for puppet-wechat4.
    emit({ event: 'qr_code', qr_code: qrcodeStr });
  });

  bot.on('login', async (user) => {
    try {
      const accountId = user?.id ?? '';
      loggedInAccountId = accountId || null;
      loginRequested = false;
      log('login ok account=%s', accountId);
      emit({
        event: 'login',
        account_id: accountId,
        // Persist an opaque marker; the puppet profile is the real credential.
        session: pendingSession ?? { account_id: accountId, bound_at: Date.now() },
      });
    } catch (error) {
      log('login handling failed:', error.message);
      emit({ event: 'error', error: `login: ${error.message}` });
    }
  });

  bot.on('logout', (user) => {
    loggedInAccountId = null;
    log('logout account=%s', user?.id);
    emit({ event: 'logout', account_id: user?.id ?? '' });
  });

  bot.on('message', async (msg) => {
    try {
      if (msg.self()) return; // ignore our own echoes
      const text = (await msg.text()) ?? '';
      if (!text.trim()) return; // first phase: text only
      const talker = await msg.talker();
      const chatId = resolveChatId(talker);
      const senderId = talker.id ?? '';
      log('message chat=%s sender=%s len=%d', chatId, senderId, text.length);
      emit({ event: 'message', chat_id: chatId, sender_id: senderId, text });
    } catch (error) {
      log('message handling failed:', error.message);
      emit({ event: 'error', error: `message: ${error.message}` });
    }
  });

  bot.on('error', (error) => {
    log('bot error:', error.message);
    emit({ event: 'error', error: error.message });
  });
}

async function startBot(session) {
  if (started) return;
  pendingSession = session ?? null;
  bot = await createBot();
  await wireEvents();
  await bot.start();
  started = true;
  log('bot started (puppet=%s)', PUPPET);
}

async function requestLogin() {
  if (!started) await startBot(pendingSession);
  if (!bot || !bot.isLogined?.()) {
    loginRequested = true;
    // Many puppets emit the QR during start(); if we have not seen one yet
    // and the bot is not logged in, ask the puppet to (re)generate it.
    if (typeof bot.login === 'function') {
      try {
        await bot.login();
      } catch (error) {
        log('login() failed:', error.message);
        emit({ event: 'error', error: error.message });
      }
    }
  }
}

async function sendText(chatId, text) {
  if (!bot) throw new Error('bot not started');
  // Resolve the chat: groups are Rooms, 1:1 chats are Contacts.
  let target = null;
  try {
    target = await bot.getContact(chatId);
  } catch {
    target = null;
  }
  if (!target || target.type?.() !== 'room') {
    try {
      const room = await bot.getRoom?.(chatId);
      if (room) target = room;
    } catch {
      /* fall through to contact */
    }
  }
  if (!target) throw new Error(`unknown chat: ${chatId}`);
  await target.say(text);
  log('sent to %s len=%d', chatId, text.length);
}

async function stopBot() {
  if (!bot) return;
  try {
    await bot.stop();
  } catch (error) {
    log('stop failed:', error.message);
  }
  bot = null;
  started = false;
}

async function main() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  process.on('SIGINT', () => { void stopBot(); process.exit(0); });
  process.on('SIGTERM', () => { void stopBot(); process.exit(0); });

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    let command;
    try {
      command = JSON.parse(raw);
    } catch {
      log('ignoring non-JSON stdin line');
      continue;
    }
    try {
      switch (command.action) {
        case 'start':
          await startBot(command.session ?? null);
          break;
        case 'login':
          await requestLogin();
          break;
        case 'send_text':
          await sendText(String(command.chat_id ?? ''), String(command.text ?? ''));
          break;
        case 'logout':
          await stopBot();
          break;
        case 'stop':
          await stopBot();
          return;
        default:
          log('unknown action:', command.action);
      }
    } catch (error) {
      log('command failed:', error.message);
      emit({ event: 'error', error: error.message });
    }
  }
  await stopBot();
}

main().catch((error) => {
  log('fatal:', error.stack ?? error.message);
  emit({ event: 'error', error: error.message });
  process.exit(1);
});
