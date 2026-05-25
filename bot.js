require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");

const app = express();
app.use(express.json());

// ================= CONFIG =================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = String(process.env.ADMIN_ID);
const CHANNEL_ID = process.env.CHANNEL_ID;

// ================= DB =================
mongoose.connect(process.env.MONGO_URI);

// ================= USER MODEL =================
const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  firstName: String,
  balance: { type: Number, default: 0 },
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  referrals: { type: Number, default: 0 },
  refBy: { type: Number, default: null },
  joinedChannel: { type: Boolean, default: false },
  lastAd: { type: Number, default: 0 },
  lastDaily: { type: Number, default: 0 }
});

const User = mongoose.model("User", userSchema);

// ================= WITHDRAW =================
const withdrawSchema = new mongoose.Schema({
  userId: Number,
  amount: Number,
  method: String,
  status: { type: String, default: "pending" }
});

const Withdraw = mongoose.model("Withdraw", withdrawSchema);

// ================= ADS CONFIG =================
const ADS_REWARD = 2;
const ADS_COOLDOWN = 30000;

// ================= SAVE USER =================
async function saveUser(msg, ref = null) {
  let user = await User.findOne({ userId: msg.from.id });

  if (!user) {
    user = await User.create({
      userId: msg.from.id,
      username: msg.from.username || "",
      firstName: msg.from.first_name || "",
      refBy: ref
    });

    if (ref && ref !== msg.from.id) {
      await User.updateOne(
        { userId: ref },
        { $inc: { balance: 5, referrals: 1 } }
      );
    }
  }

  return user;
}

// ================= SERVER =================
app.post("/reward-ad", async (req, res) => {
  const { userId } = req.body;

  const user = await User.findOne({ userId });
  if (!user) return res.sendStatus(404);

  const now = Date.now();

  if (now - user.lastAd < ADS_COOLDOWN) {
    return res.json({ success: false, msg: "Cooldown" });
  }

  user.balance += ADS_REWARD;
  user.xp += 1;
  user.lastAd = now;

  if (user.xp >= user.level * 10) {
    user.level += 1;
    user.xp = 0;
  }

  await user.save();

  res.json({ success: true, balance: user.balance });
});

app.listen(process.env.PORT || 3000);

// ================= START =================
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  await saveUser(msg, match?.[1] ? Number(match[1]) : null);

  bot.sendMessage(msg.chat.id,
`🚀 V5 EARN BOT

💰 Earn from Ads
👥 Referral System
🎁 Daily Rewards`,
{
reply_markup: {
keyboard: [
["💰 Wallet", "📺 Watch Ads"],
["🎁 Daily", "👥 Referral"],
["💸 Withdraw"]
],
resize_keyboard: true
}
});
});

// ================= MAIN =================
bot.on("message", async (msg) => {
  if (!msg.text || msg.from.is_bot) return;

  const text = msg.text.toLowerCase();
  const user = await saveUser(msg);

  // ================= WALLET =================
  if (text === "💰 wallet") {
    return bot.sendMessage(msg.chat.id,
`💰 Wallet

Balance: ${user.balance}
Level: ${user.level}
XP: ${user.xp}/${user.level * 10}`);
  }

  // ================= REF =================
  if (text === "👥 referral") {
    return bot.sendMessage(msg.chat.id,
`👥 Invite Link:
https://t.me/YourBot?start=${msg.from.id}`);
  }

  // ================= DAILY =================
  if (text === "🎁 daily") {
    const now = Date.now();

    if (now - user.lastDaily < 86400000) {
      return bot.sendMessage(msg.chat.id, "⏳ Already claimed");
    }

    user.balance += 3;
    user.lastDaily = now;
    await user.save();

    return bot.sendMessage(msg.chat.id, "🎁 +3 coins");
  }

  // ================= ADS =================
  if (text === "📺 watch ads") {
    return bot.sendMessage(msg.chat.id,
`📺 Watch Ad & Earn`,
{
reply_markup: {
inline_keyboard: [[
{
text: "▶️ Watch Ad",
web_app: {
url: "https://yourdomain.com/ads.html"
}
}
]]
}
});
  }

  // ================= WITHDRAW =================
  if (text.startsWith("withdraw")) {
    const parts = text.split(" ");
    const amount = Number(parts[1]);
    const method = parts.slice(2).join(" ");

    if (user.balance < amount) {
      return bot.sendMessage(msg.chat.id, "❌ Not enough balance");
    }

    user.balance -= amount;
    await user.save();

    const w = await Withdraw.create({
      userId: msg.from.id,
      amount,
      method
    });

    bot.sendMessage(msg.chat.id, "✅ Withdraw sent");

    bot.sendMessage(ADMIN_ID,
`💸 Withdraw

ID: ${w._id}
User: ${msg.from.id}
Amount: ${amount}
Method: ${method}`);
  }

  // ================= ADMIN =================
  if (msg.from.id.toString() !== ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
`📩 User
🆔 ${msg.from.id}
💬 ${msg.text}`);
  }
});

// ================= ADMIN REPLY =================
bot.on("reply_to_message", async (msg) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const match = msg.reply_to_message?.text?.match(/🆔 (\d+)/);

  if (!match) return;

  bot.sendMessage(match[1], `📩 Admin Reply\n\n${msg.text}`);
});
