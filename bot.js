require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const winston = require("winston");
const rateLimit = require("express-rate-limit");
const Redis = require("ioredis");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const OpenAI = require("openai");
const Joi = require("joi");
const { v4: uuidv4 } = require("uuid");

// ================= PRO LOGGING =================
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// ================= CONFIG =================
const config = {
  botToken: process.env.BOT_TOKEN,
  adminId: String(process.env.ADMIN_ID),
  mongoUri: process.env.MONGO_URI,
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  openaiKey: process.env.OPENAI_KEY,
  smtpHost: process.env.SMTP_HOST,
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  appUrl: process.env.APP_URL || "https://auto-reply-xtnl.onrender.com",
  maxTicketsPerUser: 5,
  slaHours: { low: 48, normal: 24, high: 4, urgent: 1 }
};

// ================= INIT SERVICES =================
const app = express();
const bot = new TelegramBot(config.botToken, { polling: true });
let redis;
let openai;
let transporter;

// Initialize services conditionally
try {
  redis = new Redis(config.redisUrl);
  openai = new OpenAI({ apiKey: config.openaiKey });
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    auth: { user: config.smtpUser, pass: config.smtpPass }
  });
} catch (error) {
  logger.warn("Some services not available", error);
}

// ================= MIDDLEWARE =================
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Request validation
const ticketValidationSchema = Joi.object({
  userId: Joi.number().required(),
  message: Joi.string().min(1).max(5000).required(),
  priority: Joi.string().valid("low", "normal", "high", "urgent"),
  category: Joi.string().valid("technical", "billing", "account", "feature", "other")
});

// ================= DATABASE SCHEMAS =================
mongoose.connect(config.mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000
});

// User schema
const UserSchema = new mongoose.Schema({
  userId: { type: Number, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  email: String,
  language: { type: String, default: "en" },
  timezone: String,
  isAdmin: { type: Boolean, default: false },
  preferences: {
    notifications: { type: Boolean, default: true },
    emailOnReply: { type: Boolean, default: false }
  },
  trustScore: { type: Number, default: 100 },
  totalTickets: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastActiveAt: Date
});

// Ticket schema - SINGLE DECLARATION
const TicketSchema = new mongoose.Schema({
  ticketId: { type: String, unique: true, default: () => `T${Date.now()}-${uuidv4().slice(0, 6)}` },
  userId: Number,
  assigneeId: String,
  category: String,
  priority: { type: String, default: "normal", enum: ["low", "normal", "high", "urgent"] },
  status: { 
    type: String, 
    default: "open",
    enum: ["open", "in_progress", "waiting_customer", "resolved", "closed", "escalated"]
  },
  subject: String,
  message: String,
  attachments: [{
    url: String,
    type: String,
    uploadedAt: Date
  }],
  messages: [{
    from: { type: String, enum: ["user", "admin", "ai"] },
    message: String,
    timestamp: { type: Date, default: Date.now },
    isInternal: { type: Boolean, default: false }
  }],
  slaDeadline: Date,
  firstResponseAt: Date,
  resolvedAt: Date,
  closedAt: Date,
  csatScore: { type: Number, min: 1, max: 5 },
  csatFeedback: String,
  tags: [String],
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Knowledge base schema
const KbSchema = new mongoose.Schema({
  articleId: String,
  title: String,
  content: String,
  tags: [String],
  embedding: [Number],
  views: { type: Number, default: 0 },
  helpful: { type: Number, default: 0 },
  notHelpful: { type: Number, default: 0 },
  language: String,
  createdBy: String,
  createdAt: Date,
  updatedAt: Date
});

// Analytics schema
const AnalyticsSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now, index: true },
  metric: String,
  value: Number,
  breakdown: mongoose.Schema.Types.Mixed
});

const User = mongoose.model("User", UserSchema);
const Ticket = mongoose.model("Ticket", TicketSchema);
const KBArticle = mongoose.model("KBArticle", KbSchema);
const Analytics = mongoose.model("Analytics", AnalyticsSchema);

// ================= CACHE LAYER =================
class CacheManager {
  static async get(key) { 
    if (!redis) return null;
    return redis.get(key); 
  }
  static async set(key, value, ttl = 3600) { 
    if (!redis) return null;
    return redis.set(key, JSON.stringify(value), "EX", ttl); 
  }
  static async del(key) { 
    if (!redis) return null;
    return redis.del(key); 
  }
  static async increment(key) { 
    if (!redis) return null;
    return redis.incr(key); 
  }
}

// ================= AI CLASSIFIER =================
class AIClassifier {
  static async classifyTicket(message) {
    if (!openai) return { category: "other", priority: "normal", sentiment: "neutral", tags: [] };
    
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{
          role: "system",
          content: "Classify support tickets into: category (technical/billing/account/feature/other), priority (low/normal/high/urgent), sentiment (positive/neutral/negative), and suggested tags. Return JSON only."
        }, {
          role: "user",
          content: message
        }],
        temperature: 0.3
      });
      
      const result = JSON.parse(completion.choices[0].message.content);
      return result;
    } catch (error) {
      logger.error("AI classification failed", error);
      return { category: "other", priority: "normal", sentiment: "neutral", tags: [] };
    }
  }
  
  static async findSimilarArticles(message) {
    if (!openai) return [];
    
    try {
      const embedding = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: message
      });
      
      const articles = await KBArticle.find().limit(3);
      return articles;
    } catch (error) {
      logger.error("Similar articles search failed", error);
      return [];
    }
  }
  
  static autoReply(text) {
    const t = text.toLowerCase();
    if (t.includes("login") || t.includes("password")) return "🔐 Having login issues? Try resetting your password via the 'Forgot Password' link.";
    if (t.includes("error") || t.includes("bug")) return "⚠️ Please send a screenshot of the error so we can investigate faster.";
    if (t.includes("payment") || t.includes("billing")) return "💰 Payments may take up to 24 hours to process. Contact support if longer.";
    if (t.includes("hello") || t.includes("hi")) return "👋 Hello! How can I help you today?";
    if (t.includes("thank")) return "You're welcome! 😊 Anything else I can help with?";
    if (t.includes("slow") || t.includes("lag")) return "🐢 Performance issues? Try clearing cache and updating to latest version.";
    return null;
  }
}

// ================= BUSINESS LOGIC =================
class SupportService {
  static async createTicket(userId, message, metadata = {}) {
    const ticketCount = await Ticket.countDocuments({ 
      userId, 
      createdAt: { $gt: new Date(Date.now() - 24*60*60*1000) }
    });
    
    if (ticketCount >= config.maxTicketsPerUser) {
      throw new Error("Daily ticket limit reached (max 5 tickets per day)");
    }
    
    const classification = await AIClassifier.classifyTicket(message);
    const slaHours = config.slaHours[classification.priority] || config.slaHours.normal;
    const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);
    
    const ticket = await Ticket.create({
      userId,
      message,
      category: classification.category,
      priority: classification.priority,
      tags: classification.tags,
      slaDeadline,
      metadata: { ...metadata, sentiment: classification.sentiment }
    });
    
    await User.updateOne({ userId }, { $inc: { totalTickets: 1 }, lastActiveAt: new Date() });
    
    await Analytics.create({
      metric: "ticket_created",
      value: 1,
      breakdown: { priority: classification.priority, category: classification.category }
    });
    
    const similarArticles = await AIClassifier.findSimilarArticles(message);
    if (similarArticles.length > 0 && bot) {
      await bot.sendMessage(userId, `📚 Related articles:\n${similarArticles.map(a => `• ${a.title}`).join("\n")}`);
    }
    
    if (classification.priority === "urgent") {
      await this.notifyAdmins(ticket);
    }
    
    return ticket;
  }
  
  static async addReply(ticketId, from, message, isInternal = false) {
    const ticket = await Ticket.findOne({ ticketId });
    if (!ticket) throw new Error("Ticket not found");
    
    ticket.messages.push({ from, message, isInternal });
    ticket.updatedAt = new Date();
    
    if (from === "admin" && !ticket.firstResponseAt) {
      ticket.firstResponseAt = new Date();
      
      if (ticket.firstResponseAt > ticket.slaDeadline) {
        await this.logSLABreach(ticket);
      }
    }
    
    if (from === "user" && ticket.status === "waiting_customer") {
      ticket.status = "in_progress";
    }
    
    await ticket.save();
    
    const user = await User.findOne({ userId: ticket.userId });
    if (user?.preferences?.emailOnReply && from === "admin" && transporter) {
      await this.sendEmailNotification(user, ticket, message);
    }
    
    return ticket;
  }
  
  static async resolveTicket(ticketId, csatRequest = true) {
    const ticket = await Ticket.findOneAndUpdate(
      { ticketId },
      { status: "resolved", resolvedAt: new Date() },
      { new: true }
    );
    
    if (csatRequest && bot) {
      await this.requestCSAT(ticket);
    }
    
    await Analytics.create({
      metric: "ticket_resolved",
      value: 1,
      breakdown: { 
        priority: ticket.priority,
        responseTime: (ticket.resolvedAt - ticket.createdAt) / 1000 / 60
      }
    });
    
    return ticket;
  }
  
  static async requestCSAT(ticket) {
    const opts = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⭐ 1", callback_data: `csat_1_${ticket.ticketId}` },
            { text: "⭐ 2", callback_data: `csat_2_${ticket.ticketId}` },
            { text: "⭐ 3", callback_data: `csat_3_${ticket.ticketId}` },
            { text: "⭐ 4", callback_data: `csat_4_${ticket.ticketId}` },
            { text: "⭐ 5", callback_data: `csat_5_${ticket.ticketId}` }
          ]
        ]
      }
    };
    
    await bot.sendMessage(ticket.userId, "How would you rate your support experience?", opts);
  }
  
  static async notifyAdmins(ticket) {
    if (!bot) return;
    
    const admins = await User.find({ isAdmin: true });
    for (const admin of admins) {
      await bot.sendMessage(admin.userId, 
        `🚨 URGENT TICKET ${ticket.ticketId}\nPriority: ${ticket.priority}\nMessage: ${ticket.message.slice(0, 100)}`
      ).catch(() => {});
    }
    
    await bot.sendMessage(config.adminId, 
      `🚨 URGENT TICKET ${ticket.ticketId}\nPriority: ${ticket.priority}\nUser: ${ticket.userId}`
    ).catch(() => {});
  }
  
  static async logSLABreach(ticket) {
    logger.warn(`SLA breach for ticket ${ticket.ticketId}`);
    await Analytics.create({ metric: "sla_breach", value: 1 });
    
    if (bot) {
      await bot.sendMessage(config.adminId, `⚠️ SLA BREACH: Ticket ${ticket.ticketId} missed ${ticket.priority} priority SLA`);
    }
  }
  
  static async sendEmailNotification(user, ticket, message) {
    if (!transporter) return;
    
    await transporter.sendMail({
      to: user.email,
      subject: `Support Ticket ${ticket.ticketId} Update`,
      html: `<p>Your ticket has a new reply:</p><p>${message}</p><p>Ticket ID: ${ticket.ticketId}</p>`
    }).catch(error => logger.error("Email failed", error));
  }
  
  static async getStats(timeframe = "day") {
    const startDate = new Date();
    if (timeframe === "day") startDate.setHours(0, 0, 0, 0);
    if (timeframe === "week") startDate.setDate(startDate.getDate() - 7);
    if (timeframe === "month") startDate.setMonth(startDate.getMonth() - 1);
    
    const stats = {
      totalTickets: await Ticket.countDocuments({ createdAt: { $gt: startDate } }),
      openTickets: await Ticket.countDocuments({ status: { $in: ["open", "in_progress"] } }),
      avgFirstResponse: await this.calculateAvgResponseTime(startDate),
      csatScore: await this.calculateCSAT(startDate),
      ticketsByPriority: await Ticket.aggregate([
        { $match: { createdAt: { $gt: startDate } } },
        { $group: { _id: "$priority", count: { $sum: 1 } } }
      ]),
      ticketsByCategory: await Ticket.aggregate([
        { $match: { createdAt: { $gt: startDate } } },
        { $group: { _id: "$category", count: { $sum: 1 } } }
      ])
    };
    
    return stats;
  }
  
  static async calculateAvgResponseTime(startDate) {
    const result = await Ticket.aggregate([
      { $match: { firstResponseAt: { $exists: true }, createdAt: { $gt: startDate } } },
      { $addFields: { responseMinutes: { $divide: [{ $subtract: ["$firstResponseAt", "$createdAt"] }, 60000] } } },
      { $group: { _id: null, avg: { $avg: "$responseMinutes" } } }
    ]);
    return result[0]?.avg || 0;
  }
  
  static async calculateCSAT(startDate) {
    const result = await Ticket.aggregate([
      { $match: { csatScore: { $exists: true }, createdAt: { $gt: startDate } } },
      { $group: { _id: null, avg: { $avg: "$csatScore" } } }
    ]);
    return result[0]?.avg || 0;
  }
}

// ================= TELEGRAM BOT HANDLERS =================
async function saveUser(msg) {
  let user = await User.findOne({ userId: msg.from.id });
  
  if (!user) {
    user = await User.create({
      userId: msg.from.id,
      username: msg.from.username || "",
      firstName: msg.from.first_name || "",
      lastName: msg.from.last_name || ""
    });
  }
  
  return user;
}

bot.onText(/\/start/, async (msg) => {
  await saveUser(msg);
  
  const keyboard = {
    reply_markup: {
      keyboard: [
        ["❓ FAQ", "📞 New Ticket"],
        ["📋 My Tickets", "⭐ Status"]
      ],
      resize_keyboard: true
    }
  };
  
  bot.sendMessage(msg.chat.id,
    `🚀 PRO SUPPORT CENTER\n\nHi ${msg.from.first_name}! How can we help you today?\n\n` +
    `• Click "New Ticket" to create a support request\n` +
    `• Check "My Tickets" for existing tickets\n` +
    `• FAQ for quick answers`, keyboard);
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.from.is_bot) return;
  
  const text = msg.text;
  const lower = text.toLowerCase();
  
  await saveUser(msg);
  
  // Menu handlers
  if (lower === "❓ faq") {
    return bot.sendMessage(msg.chat.id,
      `📌 FREQUENTLY ASKED QUESTIONS\n\n` +
      `1. **Login Issues** - Reset password via app\n` +
      `2. **Payment Delays** - Wait 24h, then contact us\n` +
      `3. **App Crashes** - Update to latest version\n` +
      `4. **Account Access** - Verify your email\n\n` +
      `Need more help? Create a ticket with "New Ticket"`);
  }
  
  if (lower === "📞 new ticket") {
    return bot.sendMessage(msg.chat.id, 
      `🎫 Please describe your issue in detail:\n\n` +
      `Include:\n` +
      `• What happened?\n` +
      `• When did it happen?\n` +
      `• Any error messages?\n\n` +
      `I'll create a ticket for you.`);
  }
  
  if (lower === "📋 my tickets") {
    const tickets = await Ticket.find({ userId: msg.from.id }).sort("-createdAt").limit(10);
    
    if (tickets.length === 0) {
      return bot.sendMessage(msg.chat.id, "📭 No tickets found. Create one with 'New Ticket'");
    }
    
    const ticketList = tickets.map(t => 
      `🎫 ${t.ticketId}\nStatus: ${t.status} | Priority: ${t.priority}\nCreated: ${t.createdAt.toLocaleDateString()}\n`
    ).join("\n");
    
    return bot.sendMessage(msg.chat.id, `📋 YOUR TICKETS\n\n${ticketList}`);
  }
  
  if (lower === "⭐ status") {
    const stats = await SupportService.getStats("day");
    return bot.sendMessage(msg.chat.id,
      `📊 SYSTEM STATUS\n\n` +
      `✅ All systems operational\n` +
      `📈 Today's tickets: ${stats.totalTickets}\n` +
      `⏱️ Avg response: ${Math.round(stats.avgFirstResponse)} minutes\n` +
      `⭐ CSAT score: ${stats.csatScore.toFixed(1)}/5`);
  }
  
  // Auto-reply first
  const autoResponse = AIClassifier.autoReply(text);
  if (autoResponse) {
    return bot.sendMessage(msg.chat.id, autoResponse);
  }
  
  // Create ticket for other messages
  try {
    const ticket = await SupportService.createTicket(msg.from.id, text, { source: "telegram" });
    bot.sendMessage(msg.chat.id, 
      `✅ Ticket #${ticket.ticketId} created\n\n` +
      `Priority: ${ticket.priority.toUpperCase()}\n` +
      `Response time: within ${config.slaHours[ticket.priority]} hours\n\n` +
      `We'll notify you when we reply!`);
    
    // Notify admin
    bot.sendMessage(config.adminId,
      `📩 NEW TICKET #${ticket.ticketId}\n` +
      `From: ${msg.from.first_name} (@${msg.from.username || 'no username'})\n` +
      `Priority: ${ticket.priority}\n` +
      `Message: ${text.slice(0, 200)}`);
      
  } catch (error) {
    bot.sendMessage(msg.chat.id, `⚠️ ${error.message}`);
  }
});

// CSAT callback handler
bot.on("callback_query", async (query) => {
  if (query.data.startsWith("csat_")) {
    const parts = query.data.split("_");
    const score = parseInt(parts[1]);
    const ticketId = parts[2];
    
    await Ticket.findOneAndUpdate(
      { ticketId }, 
      { csatScore: score, status: "closed", closedAt: new Date() }
    );
    
    bot.sendMessage(query.from.id, `Thank you for your feedback! ⭐ ${score}/5`);
    bot.answerCallbackQuery(query.id, { text: "Thanks for rating!" });
  }
});

// Admin reply handler
bot.on("reply_to_message", async (msg) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  // Extract ticket ID from replied message
  const match = msg.reply_to_message?.text?.match(/#(T\d+-\w+)/);
  if (!match) return;
  
  const ticketId = match[1];
  
  try {
    await SupportService.addReply(ticketId, "admin", msg.text);
    bot.sendMessage(msg.chat.id, `✅ Reply sent to ticket ${ticketId}`);
    
    // Notify user
    const ticket = await Ticket.findOne({ ticketId });
    if (ticket && bot) {
      bot.sendMessage(ticket.userId, 
        `📩 ADMIN REPLY\n\nTicket: ${ticketId}\n\n${msg.text}\n\nReply to this message to continue.`);
    }
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
  }
});

// Admin commands
bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  const stats = await SupportService.getStats();
  const users = await User.countDocuments();
  const openTickets = await Ticket.countDocuments({ status: { $in: ["open", "in_progress"] } });
  
  bot.sendMessage(config.adminId,
    `📊 PRO SUPPORT STATS\n\n` +
    `👥 Total Users: ${users}\n` +
    `🎫 Open Tickets: ${openTickets}\n` +
    `📈 Today: ${stats.totalTickets} new\n` +
    `⏱️ Avg Response: ${Math.round(stats.avgFirstResponse)}min\n` +
    `⭐ CSAT: ${stats.csatScore.toFixed(1)}/5\n` +
    `📅 SLA Breaches: ${await Analytics.countDocuments({ metric: "sla_breach", date: { $gt: new Date(Date.now() - 24*60*60*1000) } })}`);
});

bot.onText(/\/tickets/, async (msg) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  const tickets = await Ticket.find({ status: { $in: ["open", "in_progress"] } }).sort("-priority").limit(20);
  
  if (tickets.length === 0) {
    return bot.sendMessage(config.adminId, "No open tickets");
  }
  
  let text = "🎫 OPEN TICKETS\n\n";
  for (const t of tickets) {
    text += `${t.ticketId} | ${t.priority.toUpperCase()} | ${t.status}\n`;
    text += `User: ${t.userId}\n`;
    text += `Msg: ${t.message.slice(0, 60)}...\n\n`;
  }
  
  bot.sendMessage(config.adminId, text);
});

bot.onText(/\/resolve (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  const ticketId = match[1];
  await SupportService.resolveTicket(ticketId);
  bot.sendMessage(config.adminId, `✅ Ticket ${ticketId} resolved`);
});

// ================= API ENDPOINTS =================
app.post("/api/ticket", async (req, res) => {
  const { error, value } = ticketValidationSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  
  try {
    const ticket = await SupportService.createTicket(value.userId, value.message, req.body.metadata);
    res.json({ ticketId: ticket.ticketId, priority: ticket.priority });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/ticket/:id", async (req, res) => {
  const ticket = await Ticket.findOne({ ticketId: req.params.id });
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  res.json(ticket);
});

app.get("/api/stats", async (req, res) => {
  const stats = await SupportService.getStats(req.query.timeframe);
  res.json(stats);
});

app.get("/health", async (req, res) => {
  const dbState = mongoose.connection.readyState === 1;
  res.json({
    status: dbState ? "healthy" : "degraded",
    db: dbState ? "connected" : "disconnected",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ================= CRON JOBS =================
cron.schedule("0 * * * *", async () => {
  const breachedTickets = await Ticket.find({
    status: { $in: ["open", "in_progress"] },
    slaDeadline: { $lt: new Date() }
  });
  
  for (const ticket of breachedTickets) {
    await SupportService.logSLABreach(ticket);
  }
});

cron.schedule("0 9 * * *", async () => {
  const stats = await SupportService.getStats("day");
  await bot.sendMessage(config.adminId, 
    `📈 DAILY REPORT\n\n` +
    `Tickets: ${stats.totalTickets}\n` +
    `Open: ${stats.openTickets}\n` +
    `CSAT: ${stats.csatScore.toFixed(1)}\n` +
    `Avg Response: ${Math.round(stats.avgFirstResponse)}min`);
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 PRO Support Center running on port ${PORT}`);
  console.log(`🤖 Bot active | Admin: ${config.adminId}`);
  console.log(`📊 API: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("Shutting down gracefully...");
  if (redis) await redis.quit();
  await mongoose.disconnect();
  process.exit(0);
});
