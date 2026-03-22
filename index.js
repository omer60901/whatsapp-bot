require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const Groq = require("groq-sdk");

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

// ─── WhatsApp Client ──────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "summarizer-bot" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 60000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  },
});

client.on("qr", (qr) => {
  console.log("\n📱 Scan this QR code with WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("✅ WhatsApp bot is ready!\n");
  console.log("  !summarize 1h   → סיכום שעה אחרונה");
  console.log("  !ask [שאלה]     → שאל שאלה על הצ'אט");
  console.log("  !leaderboard    → לוח המובילים");
  console.log("  !mood           → מצב רוח הקבוצה");
  console.log("  !mood @שם       → מצב רוח של חבר");
  console.log("  !judge [שאלה]   → שפוט משהו מהצ'אט");
  console.log("  !test           → בדוק שהכל עובד");
  console.log("  !help           → עזרה\n");
});

client.on("auth_failure", () => {
  console.error("❌ Authentication failed. Delete .wwebjs_auth and restart.");
});

client.on("disconnected", (reason) => {
  console.log("⚠️ Disconnected:", reason);
});

// ─── Store messages ───────────────────────────────────────
client.on("message", async (msg) => {
  console.log("📨 נכנסה הודעה:", msg.from, msg.body);
  await storeMessage(msg);
  await handleCommand(msg);
});

client.on("message_create", async (msg) => {
  if (!msg.fromMe) return;
  await storeMessage(msg);
  if (!msg.body.startsWith("🤔") &&
      !msg.body.startsWith("⏳") &&
      !msg.body.startsWith("⚖️") &&
      !msg.body.startsWith("🔍") &&
      !msg.body.startsWith("🔄") &&
      !msg.body.startsWith("✅") &&
      !msg.body.startsWith("📋") &&
      !msg.body.startsWith("💬") &&
      !msg.body.startsWith("📊") &&
      !msg.body.startsWith("🤖") &&
      !msg.body.startsWith("🏆")) {
    console.log("📨 הודעה שלי:", msg.body);
    await handleCommand(msg);
  }
});

async function storeMessage(msg) {
  try {
    const chat = await msg.getChat();
    const chatId = chat.id._serialized;
    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.name || msg.from;

    if (!messageStore.has(chatId)) messageStore.set(chatId, []);
    const history = messageStore.get(chatId);

    const alreadyExists = history.some((m) => m.id === msg.id._serialized);
    if (alreadyExists) return;

    history.push({
      id: msg.id._serialized,
      sender: msg.fromMe ? "אני" : senderName,
      body: msg.body,
      timestamp: msg.timestamp * 1000,
    });

    if (history.length > MAX_MESSAGES_PER_CHAT) {
      history.splice(0, history.length - MAX_MESSAGES_PER_CHAT);
    }
  } catch (e) {}
}

function formatMessages(messages) {
  return messages
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      return `[${time}] ${m.sender}: ${m.body}`;
    })
    .join("\n");
}

// ─── Command Handler ──────────────────────────────────────
async function handleCommand(msg) {
  const body = msg.body.trim();
  const bodyLower = body.toLowerCase();

  // ─── !help ────────────────────────────────────────────
  if (bodyLower === "!help") {
    await msg.reply(
      `🤖 *WhatsApp Summarizer Bot*\n\n` +
      `פקודות:\n` +
      `• *!summarize 30m/1h/2h/6h/24h/3d* – סיכום\n` +
      `• *!ask [שאלה]* – שאל שאלה על הצ'אט\n` +
      `• *!leaderboard* – לוח המובילים\n` +
      `• *!mood* – מצב רוח הקבוצה\n` +
      `• *!mood @שם* – מצב רוח של חבר\n` +
      `• *!judge [שאלה]* – שפוט משהו מהצ'אט\n` +
      `• *!test* – בדוק שהכל עובד\n`
    );
    return;
  }

  // ─── !test ────────────────────────────────────────────
  if (bodyLower === "!test") {
    await msg.reply("🔄 בודק את כל המערכת...");
    try {
      const testAnswer = await callAI([
        { role: "system", content: "You are a helpful assistant. Always reply in Hebrew." },
        { role: "user", content: "אמור רק את המילה: עובד" }
      ]);
      await msg.reply(`✅ *AI:* ${testAnswer.trim()}`);
    } catch (err) {
      await msg.reply(`❌ *AI לא עובד!*\nשגיאה: ${err.message}`);
      return;
    }
    const chat = await msg.getChat();
    const history = messageStore.get(chat.id._serialized) || [];
    await msg.reply(`✅ *היסטוריה:* ${history.length} הודעות שמורות`);
    const start = Date.now();
    await callAI([
      { role: "system", content: "Reply in Hebrew." },
      { role: "user", content: "אמור שלום" }
    ]);
    const elapsed = Date.now() - start;
    await msg.reply(`✅ *מהירות:* ${elapsed}ms\n\n🎉 *הכל עובד תקין!*`);
    return;
  }

  // ─── !ask ─────────────────────────────────────────────
  const askMatch = body.match(/^!ask\s+(.+)$/i);
  if (askMatch) {
    const question = askMatch[1];
    const chat = await msg.getChat();
    const history = messageStore.get(chat.id._serialized) || [];
    if (!history.length) { await msg.reply("⚠️ אין הודעות שמורות."); return; }
    await msg.reply("🤔 מחפש תשובה...");
    try {
      const answer = await callAI([
        { role: "system", content: `You are an intelligent assistant that analyzes WhatsApp conversations. Always reply in Hebrew. Think deeply, make logical inferences, read between the lines, and understand context. Be smart and analytical.` },
        { role: "user", content: `Based on this chat:\n\n${formatMessages(history.slice(-500))}\n\nAnswer: ${question}` }
      ]);
      await msg.reply(`💬 *תשובה:*\n\n${answer}`);
    } catch (err) {
      console.error("AI error:", err.message);
      await msg.reply("❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
    }
    return;
  }

  // ─── !leaderboard ─────────────────────────────────────
  if (bodyLower === "!leaderboard") {
    const chat = await msg.getChat();
    const history = messageStore.get(chat.id._serialized) || [];
    if (!history.length) { await msg.reply("⚠️ אין הודעות שמורות."); return; }

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
    await msg.reply(text);
    return;
  }

  // ─── !mood ────────────────────────────────────────────
  if (bodyLower.startsWith("!mood")) {
    const chat = await msg.getChat();
    const history = messageStore.get(chat.id._serialized) || [];
    if (!history.length) { await msg.reply("⚠️ אין הודעות שמורות."); return; }

    const mentionedContacts = await msg.getMentions();
    let targetName = null;
    let targetMessages = [];

    if (mentionedContacts.length > 0) {
      const contact = mentionedContacts[0];
      targetName = contact.pushname || contact.name || contact.number;
      targetMessages = history.filter(m =>
        m.sender.toLowerCase().includes(targetName.toLowerCase()) ||
        targetName.toLowerCase().includes(m.sender.toLowerCase())
      ).slice(-200);
      if (!targetMessages.length) { await msg.reply(`⚠️ לא נמצאו הודעות של ${targetName}.`); return; }
    } else {
      targetMessages = history.slice(-200);
    }

    await msg.reply(targetName ? `🔍 מנתח את המצב רוח של ${targetName}...` : "🔍 מנתח את המצב רוח של הקבוצה...");
    try {
      const mood = await callAI([
        { role: "system", content: `You are a mood analyzer for WhatsApp chats. Always reply in Hebrew. Give a fun mood breakdown with emojis and percentages, a one-sentence personality description, and one funny observation. Be sarcastic and fun.` },
        { role: "user", content: `Analyze the mood of ${targetName || "the group"}:\n\n${formatMessages(targetMessages)}` }
      ]);
      const title = targetName ? `😈 *מצב רוח של ${targetName}*` : `📊 *מצב רוח הקבוצה*`;
      await msg.reply(`${title}\n\n${mood}`);
    } catch (err) {
      console.error("AI error:", err.message);
      await msg.reply("❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
    }
    return;
  }

  // ─── !judge ───────────────────────────────────────────
  const judgeMatch = body.match(/^!judge\s+(.+)$/i);
  if (judgeMatch) {
    const question = judgeMatch[1];
    const chat = await msg.getChat();
    const history = messageStore.get(chat.id._serialized) || [];
    if (!history.length) { await msg.reply("⚠️ אין הודעות שמורות."); return; }
    await msg.reply("⚖️ שופט...");
    try {
      const verdict = await callAI([
        { role: "system", content: `You are a dramatic TV judge analyzing a WhatsApp chat. Always reply in Hebrew. Answer the question based on the chat history. Give a confident verdict with funny reasoning. Be dramatic and savage. End with a strong one-liner.` },
        { role: "user", content: `Chat history:\n\n${formatMessages(history.slice(-200))}\n\nJudge: ${question}` }
      ]);
      await msg.reply(`⚖️ *פסיקת השופט*\n\n${verdict}`);
    } catch (err) {
      console.error("AI error:", err.message);
      await msg.reply("❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
    }
    return;
  }

  // ─── !summarize ───────────────────────────────────────
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

  const chat = await msg.getChat();
  const history = messageStore.get(chat.id._serialized) || [];
  const cutoff = Date.now() - ms;
  const filtered = history.filter((m) => m.timestamp >= cutoff);

  if (!filtered.length) { await msg.reply(`⚠️ לא נמצאו הודעות מה-${timeLabel} האחרונות.`); return; }
  await msg.reply(`⏳ מסכם את ה-${timeLabel} האחרונות (${filtered.length} הודעות)...`);

  try {
    const summary = await callAI([
      { role: "system", content: `You are a WhatsApp chat summarizer. Always reply in Hebrew. Write a detailed summary in a few natural paragraphs. Do NOT quote messages directly. Focus on main topics, decisions, and flow. Write naturally.` },
      { role: "user", content: `Summarize this WhatsApp conversation from the last ${timeLabel}:\n\n${formatMessages(filtered)}` }
    ]);
    await msg.reply(`📋 *סיכום – ${timeLabel} אחרונות*\n\n${summary}`);
  } catch (err) {
    console.error("AI error:", err.message);
    await msg.reply("❌ כל המפתחות נגמרו להיום. נסה מחר 😔");
  }
}

// ─── Start ────────────────────────────────────────────────
console.log("🚀 Starting WhatsApp Summarizer Bot (Groq - 5 accounts, 7 models!)...");
const http = require("http");
http.createServer((req, res) => res.end("Bot is running!")).listen(process.env.PORT || 3000);
client.initialize();