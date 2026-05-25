require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");

const app = express();

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const ADMIN_ID = String(process.env.ADMIN_ID);
const CHANNEL_ID = process.env.CHANNEL_ID;

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log(err));

// ================= USER =================
const userSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  firstName: String,
  balance: { type: Number, default: 0 },
  referrals: { type: Number, default: 0 },
  refBy: { type: Number, default: null },
  vip: { type: Number, default: 0 },
  joinedChannel: { type: Boolean, default: false },
  lastAdWatch: { type: Number, default: 0 }
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

// ================= SERVER =================
app.get("/", (req, res) => res.send("V3 Bot Running 🚀"));
app.listen(process.env.PORT || 3000);

// ================= HELPERS =================
async function checkChannel(userId) {
  try {
    const res = await bot.getChatMember(CHANNEL_ID, userId);
    return ["member", "administrator", "creator"].includes(res.status);
  } catch {
    return false;
  }
}

function antiSpam(map, id, limit = 1200) {
  const now = Date.now();
  const last = map.get(id) || 0;
  if (now - last < limit) return true;
  map.set(id, now);
  return false;
}

const spamMap = new Map();

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

// ================= START =================
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  await saveUser(msg, match?.[1] ? Number(match[1]) : null);

  const joined = await checkChannel(msg.from.id);

  bot.sendMessage(msg.chat.id,
`🚀 Welcome to V3 Earn Bot

${joined ? "✅ Channel Verified" : "❌ Please join channel first"}

💰 Earn via ads & tasks
👥 Referral rewards active`,
{
reply_markup: {
keyboard: [
["💰 Wallet", "🎁 Daily Reward"],
["📺 Watch Ad", "🛠 Tasks"],
["👥 Referral", "💸 Withdraw"],
["📢 Verify Channel"]
],
resize_keyboard: true
}
});
});

// ================= MESSAGE =================
bot.on("message", async (msg) => {
  if (!msg.text || msg.from.is_bot) return;
  if (antiSpam(spamMap, msg.from.id)) return;

  await saveUser(msg);

  const text = msg.text.toLowerCase();

  if (text.startsWith("/start")) return;

  const user = await User.findOne({ userId: msg.from.id });

  // ================= VERIFY CHANNEL =================
  if (text === "📢 verify channel") {
    const joined = await checkChannel(msg.from.id);

    if (joined) {
      user.joinedChannel = true;
      await user.save();
      return bot.sendMessage(msg.chat.id, "✅ Verified!");
    }

    return bot.sendMessage(msg.chat.id, "❌ Join channel first");
  }

  // ================= BLOCK NON-JOINED =================
  if (!user.joinedChannel) {
    return bot.sendMessage(msg.chat.id, "⚠️ You must join channel first");
  }

  // ================= WALLET =================
  if (text === "💰 wallet") {
    return bot.sendMessage(msg.chat.id,
`💰 Wallet

Balance: ${user.balance}
VIP Level: ${user.vip}`);
  }

  // ================= DAILY =================
  if (text === "🎁 daily reward") {
    const now = Date.now();

    if (now - user.lastAdWatch < 86400000) {
      return bot.sendMessage(msg.chat.id, "⏳ Already claimed today");
    }

    user.balance += 3;
    user.lastAdWatch = now;
    await user.save();

    return bot.sendMessage(msg.chat.id, "🎁 +3 coins added");
  }

  // ================= AD SYSTEM =================
  if (text === "📺 watch ad") {
    const now = Date.now();

    if (now - user.lastAdWatch < 30000) {
      return bot.sendMessage(msg.chat.id, "⏳ Wait before watching next ad");
    }

    user.balance += 2;
    user.lastAdWatch = now;
    await user.save();

    return bot.sendMessage(msg.chat.id,
`📺 Ad completed
💰 +2 coins`);
  }

  // ================= REFERRAL =================
  if (text === "👥 referral") {
    return bot.sendMessage(msg.chat.id,
`👥 Your link:
https://t.me/YourBot?start=${msg.from.id}`);
  }

  // ================= TASKS =================
  if (text === "🛠 tasks") {
    return bot.sendMessage(msg.chat.id,
`🛠 Tasks

1. Watch ad = 2 coins
2. Invite friend = 5 coins
3. Daily reward = 3 coins`);
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
`💸 Withdraw Request

ID: ${w._id}
User: ${msg.from.id}
Amount: ${amount}
Method: ${method}`);
  }

  // ================= ADMIN FORWARD =================
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

  const text = msg.reply_to_message?.text;
  const match = text?.match(/🆔 (\d+)/);

  if (!match) return;

  bot.sendMessage(match[1], `📩 Admin Reply\n\n${msg.text}`);
});

// ================= ADMIN APPROVE =================
bot.onText(/\/approve (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const id = match[1];

  const w = await Withdraw.findByIdAndUpdate(id, { status: "approved" });

  bot.sendMessage(ADMIN_ID, "✅ Approved");
});

// ================= ADMIN REJECT =================
bot.onText(/\/reject (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const id = match[1];

  const w = await Withdraw.findById(id);

  if (w) {
    await User.updateOne(
      { userId: w.userId },
      { $inc: { balance: w.amount } }
    );
    await w.deleteOne();
  }

  bot.sendMessage(ADMIN_ID, "❌ Rejected & refunded");
});

// ================= STATS =================
bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id.toString() !== ADMIN_ID) return;

  const users = await User.countDocuments();
  const withdraws = await Withdraw.countDocuments();

  bot.sendMessage(ADMIN_ID,
`📊 V3 Stats

Users: ${users}
Withdraws: ${withdraws}`);
});
