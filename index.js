import "dotenv/config";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import Groq from "groq-sdk";
import pino from "pino";
import http from "http";
import qrcode from "qrcode-terminal";

// ─── Config ───────────────────────────────────────────────
const GROQ_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4,
  process.env.GROQ_KEY_5,
].filter(Boolean);

const MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-70b-versatile",
  "llama-3.1-8b-instant",
  "llama3-70b-8192",
  "llama3-8b-8192",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
];

async function callAI(messages) {
  for (const model of MODELS) {
    for (const key of GROQ_KEYS) {
      try {
        const groq = new Groq({ apiKey: key });
        const completion = await groq.chat.completions.create({
          model,
          messages,
          max_tokens: 1024,
        });
        console.log(`✅ מודל: ${model}`);
        return completion.choices[0].message.content;
      } catch (err) {
        if (err.message.includes("429") || err.message.includes("rate_limit")) {
          console.log(`⚠️ ${model} + key נגמר, מנסה הבא...`);
          continue;
        }
        throw err;
      }
    }
  }
  throw new Error("כל המפתחות והמודלים נגמרו");
}

const messageStore = new Map();
const MAX_MESSAGES_PER_CHAT = 5000;

function storeMessage(chatId, sender, body, timestamp) {
  if (!messageStore.has(chatId)) messageStore.set(chatId, []);
  const history = messageStore.get(chatId);
  history.push({ sender, body, timestamp });
  if (history.length > MAX_MESSAGES_PER_CHAT) {
    history.splice(0, history.length - MAX_MESSAGES_PER_CHAT);
  }
}

function formatMessages(messages) {
  return messages
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      return `[${time}] ${m.sender}: ${m.body}`;
    })
    .join("\n");
}

// ─── Start Bot ────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 סרוק את הQR הזה עם WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log("❌ התנתק. מתחבר מחדש:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ WhatsApp bot is ready!\n");
      console.log("  !summarize 1h   → סיכום שעה אחרונה");
      console.log("  !ask [שאלה]     → שאל שאלה על הצ'אט");
      console.log("  !leaderboard    → לוח המובילים");
      console.log("  !mood           → מצב רוח הקבוצה");
      console.log("  !judge [שאלה]   → שפוט משהו מהצ'אט");
      console.log("  !test           → בדוק שהכל עובד");
      console.log("  !help           → עזרה\n");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;

    for (const msg of msgs) {
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid;
      const isMe = msg.key.fromMe;
      const sender = isMe ? "אני" : (msg.pushName || msg.key.participant || chatId);
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!body) continue;

      const timestamp = (msg.messageTimestamp || Date.now() / 1000) * 1000;
      storeMessage(chatId, sender, body, timestamp);

      if (isMe) continue;

      console.log(`📨 הודעה מ-${sender}: ${body}`);
      await handleCommand(sock, msg, chatId, body);
    }
  });
}

// ─── Reply Helper ─────────────────────────────────────────
async function reply(sock, msg, text) {
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

// ─── Command Handler ──────────────────────────────────────
async function handleCommand(sock, msg, chatId, body) {
  const bodyLower = body.trim().toLowerCase();

  if (bodyLower === "!help") {
    await reply(sock, msg,
      `🤖 *WhatsApp Summarizer Bot*\n\n` +
      `פקודות:\n` +
      `• *!summarize 30m/1h/2h/6h/24h/3d* – סיכום\n` +
      `• *!ask [שאלה]* – שאל שאלה על הצ'אט\n` +
      `• *!leaderboard* – לוח המובילים\n` +
      `• *!mood* – מצב רוח הקבוצה\n` +
      `• *!judge [שאלה]* – שפוט משהו מהצ'אט\n` +
      `• *!test* – בדוק שהכל עובד\n`
    );
    return;
  }

  if (bodyLower === "!test") {
    await reply(sock, msg, "🔄 בודק את כל המערכת...");
    try {
      const testAnswer = await callAI([
        { role: "system", content: "You are a helpful assistant. Always reply in Hebrew." },
        { role: "user", content: "אמור רק את המילה: עובד" }
      ]);
      await reply(sock, msg, `✅ *AI:* ${testAnswer.trim()}`);
    } catch (err) {
      await reply(sock, msg, `❌ *AI לא עובד!*\nשגיאה: ${err.message}`);
      return;
    }
    const history = messageStore.get(chatId) || [];
    await reply(sock, msg, `✅ *היסטוריה:* ${history.length} הודעות שמורות\n\n🎉 *הכל עובד תקין!*`);
    return;
  }

  const askMatch = body.trim().match(/^!ask\s+(.+)$/i);
  if (askMatch) {
    const question = askMatch[1];
    const history = messageStore.get(chatId) || [];
    if (!history.length) { await reply(sock, msg, "⚠️ אין הודעות שמורות."); return; }
    await reply(sock, msg, "🤔 מחפש תשובה...");
    try {
      const answer = await callAI([
        { role: "system", content: `You are an intelligent assistant that analyzes WhatsApp conversations. Always reply in Hebrew.` },
        { role: "user", content: `Based on this chat:\n\n${formatMessages(history.slice(-500))}\n\nAnswer: ${question}` }
      ]);
      await reply(sock, msg, `💬 *תשובה:*\n\n${answer}`);
    } catch (err) {
      await reply(sock, msg, "❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
    }
    return;
  }

  if (bodyLower === "!leaderboard") {
    const history = messageStore.get(chatId) || [];
    if (!history.length) { await reply(sock, msg, "⚠️ אין הודעות שמורות."); return; }

    const stats = {};
    for (const m of history) {
      if (!stats[m.sender]) stats[m.sender] = { messages: 0, words: 0, emojis: 0 };
      stats[m.sender].messages++;
      stats[m.sender].words += m.body.split(/\s+/).filter(Boolean).length;
      stats[m.sender].emojis += (m.body.match(/[\u{1F300}-\u{1FFFF}]/gu) || []).length;
    }

    const sorted = Object.entries(stats).sort((a, b) => b[1].messages - a[1].messages);
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    let text = `🏆 *לוח המובילים*\n\n`;
    sorted.slice(0, 10).forEach(([sender, s], i) => {
      text += `${medals[i]} *${sender}*\n   💬 ${s.messages} הודעות | 📝 ${s.words} מילים | 😂 ${s.emojis} אמוג'ים\n\n`;
    });

    const hourCounts = new Array(24).fill(0);
    for (const m of history) hourCounts[new Date(m.timestamp).getHours()]++;
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
    text += `⏰ *שעת השיא:* ${peakHour}:00-${peakHour + 1}:00\n`;
    text += `📊 *סה"כ הודעות:* ${history.length}`;
    await reply(sock, msg, text);
    return;
  }

  if (bodyLower.startsWith("!mood")) {
    const history = messageStore.get(chatId) || [];
    if (!history.length) { await reply(sock, msg, "⚠️ אין הודעות שמורות."); return; }
    await reply(sock, msg, "🔍 מנתח את המצב רוח של הקבוצה...");
    try {
      const mood = await callAI([
        { role: "system", content: `You are a mood analyzer for WhatsApp chats. Always reply in Hebrew. Give a fun mood breakdown with emojis and percentages, a one-sentence personality description, and one funny observation. Be sarcastic and fun.` },
        { role: "user", content: `Analyze the mood of the group:\n\n${formatMessages(history.slice(-200))}` }
      ]);
      await reply(sock, msg, `📊 *מצב רוח הקבוצה*\n\n${mood}`);
    } catch (err) {
      await reply(sock, msg, "❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
    }
    return;
  }

  const judgeMatch = body.trim().match(/^!judge\s+(.+)$/i);
  if (judgeMatch) {
    const question = judgeMatch[1];
    const history = messageStore.get(chatId) || [];
    if (!history.length) { await reply(sock, msg, "⚠️ אין הודעות שמורות."); return; }
    await reply(sock, msg, "⚖️ שופט...");
    try {
      const verdict = await callAI([
        { role: "system", content: `You are a dramatic TV judge analyzing a WhatsApp chat. Always reply in Hebrew. Give a confident verdict with funny reasoning. Be dramatic and savage. End with a strong one-liner.` },
        { role: "user", content: `Chat history:\n\n${formatMessages(history.slice(-200))}\n\nJudge: ${question}` }
      ]);
      await reply(sock, msg, `⚖️ *פסיקת השופט*\n\n${verdict}`);
    } catch (err) {
      await reply(sock, msg, "❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
    }
    return;
  }

  const summarizeMatch = bodyLower.match(/^!summarize\s+(\d+)(m|h|d)$/);
  if (!summarizeMatch) return;

  const amount = parseInt(summarizeMatch[1]);
  const unit = summarizeMatch[2];
  let ms;
  if (unit === "m") ms = amount * 60 * 1000;
  else if (unit === "h") ms = amount * 60 * 60 * 1000;
  else if (unit === "d") ms = amount * 24 * 60 * 60 * 1000;

  const labelMap = { m: `${amount} דקות`, h: `${amount} שעות`, d: `${amount} ימים` };
  const timeLabel = labelMap[unit];

  const history = messageStore.get(chatId) || [];
  const cutoff = Date.now() - ms;
  const filtered = history.filter((m) => m.timestamp >= cutoff);

  if (!filtered.length) { await reply(sock, msg, `⚠️ לא נמצאו הודעות מה-${timeLabel} האחרונות.`); return; }
  await reply(sock, msg, `⏳ מסכם את ה-${timeLabel} האחרונות (${filtered.length} הודעות)...`);

  try {
    const summary = await callAI([
      { role: "system", content: `You are a WhatsApp chat summarizer. Always reply in Hebrew. Write a detailed summary in a few natural paragraphs. Do NOT quote messages directly. Focus on main topics, decisions, and flow.` },
      { role: "user", content: `Summarize this WhatsApp conversation from the last ${timeLabel}:\n\n${formatMessages(filtered)}` }
    ]);
    await reply(sock, msg, `📋 *סיכום – ${timeLabel} אחרונות*\n\n${summary}`);
  } catch (err) {
    await reply(sock, msg, "❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
  }
}

// ─── HTTP Server ──────────────────────────────────────────
http.createServer((req, res) => res.end("Bot is running!")).listen(process.env.PORT || 3000);

// ─── Start ────────────────────────────────────────────────
console.log("🚀 Starting WhatsApp Bot (Baileys)...");
startBot();