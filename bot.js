require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const axios = require("axios");

const app = express();

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const ADMIN_ID = process.env.ADMIN_ID;

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("MongoDB Connected"))
.catch(err => console.log(err));

const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  firstName: String
});

const User = mongoose.model("User", userSchema);

app.get("/", (req, res) => {
  res.send("Helper Bot Running");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server Started");
});

async function saveUser(msg) {
  const exist = await User.findOne({
    userId: msg.from.id
  });

  if (!exist) {
    await User.create({
      userId: msg.from.id,
      username: msg.from.username || "",
      firstName: msg.from.first_name || ""
    });
  }
}

bot.onText(/\/start/, async (msg) => {

  await saveUser(msg);

  bot.sendMessage(msg.chat.id,
`🎓 Welcome to StudyBuddy Helper Bot

Use this bot to:
• Ask questions
• Get support
• Report problems
• Contact admin`,
{
reply_markup: {
keyboard: [
["❓ FAQ", "📞 Support"],
["👨‍💻 Contact Admin", "🌐 Open App"]
],
resize_keyboard: true
}
});
});

bot.on("message", async (msg) => {

  if (!msg.text) return;

  await saveUser(msg);

  const text = msg.text;

  if (
    text.startsWith("/start") ||
    text.startsWith("/broadcast") ||
    text.startsWith("/stats")
  ) return;

  // FAQ
  if (text === "❓ FAQ") {

    return bot.sendMessage(msg.chat.id,
`📌 FAQ

1. How to earn?
👉 Watch ads & invite friends

2. Withdrawal time?
👉 Usually instant

3. Referral reward?
👉 You get bonus coins

4. Need more help?
👉 Contact admin`);
  }

  // Contact admin
  if (text === "👨‍💻 Contact Admin") {

    return bot.sendMessage(
      msg.chat.id,
      "📩 Send your message. Admin will reply."
    );
  }

  // Support
  if (text === "📞 Support") {

    return bot.sendMessage(
      msg.chat.id,
      "🛠 Describe your problem."
    );
  }

  // Open App
  if (text === "🌐 Open App") {

    return bot.sendMessage(
      msg.chat.id,
      "🚀 Open your app:\nhttps://yourapp.onrender.com"
    );
  }

  // Forward messages to admin
  if (msg.from.id.toString() !== ADMIN_ID) {

    bot.sendMessage(
      ADMIN_ID,
`📩 New Support Message

👤 ${msg.from.first_name}
🆔 ${msg.from.id}
📛 @${msg.from.username || "none"}

💬 ${text}`);
  }

  // AI Auto Reply
  let reply = "🤖 I received your message.";

  const lower = text.toLowerCase();

  if (lower.includes("withdraw")) {
    reply = "💸 Withdrawals are usually processed instantly.";
  }

  else if (lower.includes("bonus")) {
    reply = "🎁 Invite friends to earn bonus rewards.";
  }

  else if (lower.includes("problem")) {
    reply = "🛠 Your issue was sent to admin.";
  }

  else if (lower.includes("hello")) {
    reply = "👋 Hello! How can I help you?";
  }

  bot.sendMessage(msg.chat.id, reply);
});

// Reply to users
bot.on("reply_to_message", async (msg) => {

  if (msg.from.id.toString() !== ADMIN_ID) return;

  const original = msg.reply_to_message.text;

  const idMatch = original.match(/🆔 (\\d+)/);

  if (!idMatch) return;

  const userId = idMatch[1];

  bot.sendMessage(
    userId,
`📩 Admin Reply

${msg.text}`);
});

// Broadcast
bot.onText(/\/broadcast (.+)/, async (msg, match) => {

  if (msg.from.id.toString() !== ADMIN_ID) return;

  const text = match[1];

  const users = await User.find();

  let sent = 0;

  for (const user of users) {
    try {
      await bot.sendMessage(user.userId, text);
      sent++;
    } catch (e) {}
  }

  bot.sendMessage(
    ADMIN_ID,
    `✅ Broadcast sent to ${sent} users`
  );
});

// Stats
bot.onText(/\/stats/, async (msg) => {

  if (msg.from.id.toString() !== ADMIN_ID) return;

  const count = await User.countDocuments();

  bot.sendMessage(
    ADMIN_ID,
    `👥 Total Users: ${count}`
  );
});
