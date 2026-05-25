require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = String(process.env.ADMIN_ID);
const APP_URL = "https://auto-reply-xtnl.onrender.com";

// ================= DB =================
mongoose.connect(process.env.MONGO_URI);

// ================= USER =================
const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  firstName: String
});

const User = mongoose.model("User", userSchema);

// ================= TICKET =================
const ticketSchema = new mongoose.Schema({
  ticketId: String,
  userId: Number,
  message: String,
  status: { type: String, default: "open" },
  createdAt: { type: Date, default: Date.now }
});

const Ticket = mongoose.model("Ticket", ticketSchema);

// ================= SAVE USER =================
async function saveUser(msg) {
  let user = await User.findOne({ userId: msg.from.id });

  if (!user) {
    user = await User.create({
      userId: msg.from.id,
      username: msg.from.username || "",
      firstName: msg.from.first_name || ""
    });
  }

  return user;
}

// ================= AUTO REPLY =================
function autoReply(text) {
  const t = text.toLowerCase();

  if (t.includes("login")) return "🔐 Try resetting your password.";
  if (t.includes("error")) return "⚠️ Please send screenshot.";
  if (t.includes("payment")) return "💰 Payments may take up to 24h.";
  if (t.includes("app")) return "📲 Open app and update latest version.";
  if (t.includes("hello")) return "👋 Hello! How can I help you?";

  return null;
}

// ================= CREATE TICKET =================
async function createTicket(msg) {
  const id = "T" + Date.now();

  await Ticket.create({
    ticketId: id,
    userId: msg.from.id,
    message: msg.text
  });

  return id;
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  await saveUser(msg);

  bot.sendMessage(msg.chat.id,
`🚀 V100 PRO SUPPORT SYSTEM

💬 App Help Center
🎫 Ticket-based support
⚡ Fast responses`,
{
reply_markup: {
keyboard: [
["❓ FAQ", "📞 Support"],
["🎫 My Ticket", "🌐 Open App"]
],
resize_keyboard: true
}
});
});

// ================= MAIN =================
bot.on("message", async (msg) => {
  if (!msg.text || msg.from.is_bot) return;

  const text = msg.text;
  const lower = text.toLowerCase();

  await saveUser(msg);

  // ================= FAQ =================
  if (lower === "❓ faq") {
    return bot.sendMessage(msg.chat.id,
`📌 FAQ

1. Login issue → reset password
2. Payment delay → wait 24h
3. App error → send screenshot`);
  }

  // ================= OPEN APP =================
  if (lower === "🌐 open app") {
    return bot.sendMessage(msg.chat.id,
`🚀 Open App:
${APP_URL}`);
  }

  // ================= SUPPORT =================
  if (lower === "📞 support") {
    const ticketId = await createTicket(msg);

    return bot.sendMessage(msg.chat.id,
`🎫 Ticket Created

ID: ${ticketId}
Status: OPEN

We will reply soon.`);
  }

  // ================= AUTO REPLY =================
  const reply = autoReply(text);

  if (reply) {
    return bot.sendMessage(msg.chat.id, reply);
  }

  // ================= USER MESSAGE → ADMIN =================
  if (msg.from.id.toString() !== ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
`📩 NEW MESSAGE

👤 ${msg.from.first_name}
🆔 ${msg.from.id}

💬 ${text}`);
  }

  // default reply
  bot.sendMessage(msg.chat.id, "🤖 Message received. Support will reply soon.");
});

// ================= ADMIN REPLY =================
bot.on("reply_to_message", async (msg) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const match = msg.reply_to_message?.text?.match(/🆔 (\d+)/);

  if (!match) return;

  const userId = match[1];

  bot.sendMessage(userId,
`📩 ADMIN REPLY

${msg.text}`);
});

// ================= ADMIN TICKETS LIST =================
bot.onText(/\/tickets/, async (msg) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const tickets = await Ticket.find({ status: "open" }).limit(10);

  let text = "🎫 OPEN TICKETS:\n\n";

  tickets.forEach(t => {
    text += `ID: ${t.ticketId} | USER: ${t.userId}\n`;
  });

  bot.sendMessage(ADMIN_ID, text || "No tickets");
});

// ================= CLOSE TICKET =================
bot.onText(/\/close (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const id = match[1];

  await Ticket.findOneAndUpdate(
    { ticketId: id },
    { status: "closed" }
  );

  bot.sendMessage(ADMIN_ID, "✅ Ticket closed");
});

// ================= STATS =================
bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const users = await User.countDocuments();
  const tickets = await Ticket.countDocuments();

  bot.sendMessage(ADMIN_ID,
`📊 V100 PRO STATS

Users: ${users}
Tickets: ${tickets}`);
});
