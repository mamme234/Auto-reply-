require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const winston = require("winston");
const rateLimit = require("express-rate-limit");
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
let openai;
let transporter;

// Initialize OpenAI if key exists
if (config.openaiKey && config.openaiKey !== "your_openai_key_here") {
  openai = new OpenAI({ apiKey: config.openaiKey });
  logger.info("OpenAI initialized");
}

// Initialize email if configured
if (config.smtpHost && config.smtpUser && config.smtpPass) {
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    auth: { user: config.smtpUser, pass: config.smtpPass }
  });
  logger.info("Email transporter initialized");
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

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB connected");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB error:", err);
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

// Ticket schema
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

// Analytics schema
const AnalyticsSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now, index: true },
  metric: String,
  value: Number,
  breakdown: mongoose.Schema.Types.Mixed
});

const User = mongoose.model("User", UserSchema);
const Ticket = mongoose.model("Ticket", TicketSchema);
const Analytics = mongoose.model("Analytics", AnalyticsSchema);

// Simple in-memory cache (replaces Redis)
class SimpleCache {
  constructor() {
    this.cache = new Map();
  }
  
  async get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiry && item.expiry < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }
  
  async set(key, value, ttl = 3600) {
    this.cache.set(key, {
      value: JSON.stringify(value),
      expiry: Date.now() + (ttl * 1000)
    });
  }
  
  async del(key) {
    this.cache.delete(key);
  }
  
  async increment(key) {
    const val = await this.get(key);
    const newVal = val ? parseInt(val) + 1 : 1;
    await this.set(key, newVal);
    return newVal;
  }
}

const cache = new SimpleCache();

// ================= AI CLASSIFIER =================
class AIClassifier {
  static async classifyTicket(message) {
    if (!openai) {
      // Simple keyword-based classification
      const msg = message.toLowerCase();
      let category = "other";
      let priority = "normal";
      
      if (msg.includes("login") || msg.includes("password") || msg.includes("account")) category = "account";
      if (msg.includes("pay") || msg.includes("billing") || msg.includes("refund")) category = "billing";
      if (msg.includes("error") || msg.includes("crash") || msg.includes("bug")) category = "technical";
      if (msg.includes("feature") || msg.includes("suggest")) category = "feature";
      
      if (msg.includes("urgent") || msg.includes("emergency") || msg.includes("critical")) priority = "urgent";
      if (msg.includes("important") || msg.includes("blocked")) priority = "high";
      if (msg.includes("not urgent") || msg.includes("whenever")) priority = "low";
      
      return { category, priority, sentiment: "neutral", tags: [] };
    }
    
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{
          role: "system",
          content: "Classify support tickets into: category (technical/billing/account/feature/other), priority (low/normal/high/urgent), sentiment (positive/neutral/negative). Return JSON only."
        }, {
          role: "user",
          content: message
        }],
        temperature: 0.3
      });
      
      return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
      logger.error("AI classification failed", error);
      return { category: "other", priority: "normal", sentiment: "neutral", tags: [] };
    }
  }
  
  static autoReply(text) {
    const t = text.toLowerCase();
    const replies = {
      "login|password|sign in": "🔐 Having login issues? Try:\n1. Reset password via 'Forgot Password'\n2. Clear app cache\n3. Update to latest version",
      "error|bug|crash": "⚠️ Please send a screenshot of the error. Our team will investigate ASAP.",
      "payment|billing|refund|charge": "💰 Payment issues? Transactions take up to 24h. For refunds, please provide order ID.",
      "hello|hi|hey": "👋 Hello! How can I help you today?",
      "thank|thanks": "You're welcome! 😊 Anything else?",
      "slow|lag|freeze": "🐢 Performance issues? Try:\n1. Clear cache\n2. Check internet connection\n3. Update app",
      "feature|suggestion": "💡 Thanks for the suggestion! We'll forward it to our product team.",
      "where|how to": "📚 Check our FAQ or create a ticket for detailed help."
    };
    
    for (const [pattern, reply] of Object.entries(replies)) {
      if (new RegExp(pattern, "i").test(t)) {
        return reply;
      }
    }
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
      tags: classification.tags || [],
      slaDeadline,
      metadata: { ...metadata, sentiment: classification.sentiment }
    });
    
    await User.updateOne(
      { userId }, 
      { $inc: { totalTickets: 1 }, lastActiveAt: new Date() },
      { upsert: true }
    );
    
    await Analytics.create({
      metric: "ticket_created",
      value: 1,
      breakdown: { priority: classification.priority, category: classification.category }
    });
    
    if (classification.priority === "urgent") {
      await this.notifyAdmins(ticket);
    }
    
    return ticket;
  }
  
  static async addReply(ticketId, from, message, isInternal = false) {
    const ticket = await Ticket.findOne({ ticketId });
    if (!ticket) throw new Error("Ticket not found");
    
    ticket.messages.push({ from, message, isInternal, timestamp: new Date() });
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
    const message = `🚨 URGENT TICKET ${ticket.ticketId}\nPriority: ${ticket.priority}\nMessage: ${ticket.message.slice(0, 100)}`;
    
    await bot.sendMessage(config.adminId, message).catch(() => {});
  }
  
  static async logSLABreach(ticket) {
    logger.warn(`SLA breach for ticket ${ticket.ticketId}`);
    await Analytics.create({ metric: "sla_breach", value: 1 });
    
    await bot.sendMessage(config.adminId, `⚠️ SLA BREACH: Ticket ${ticket.ticketId} missed ${ticket.priority} priority SLA`);
  }
  
  static async sendEmailNotification(user, ticket, message) {
    if (!transporter) return;
    
    await transporter.sendMail({
      to: user.email,
      subject: `Support Ticket ${ticket.ticketId} Update`,
      html: `<h3>Ticket #${ticket.ticketId}</h3><p>New reply:</p><p>${message}</p><p>Reply to this email or in Telegram.</p>`
    }).catch(error => logger.error("Email failed", error));
  }
  
  static async getStats(timeframe = "day") {
    const startDate = new Date();
    if (timeframe === "day") startDate.setHours(0, 0, 0, 0);
    if (timeframe === "week") startDate.setDate(startDate.getDate() - 7);
    if (timeframe === "month") startDate.setMonth(startDate.getMonth() - 1);
    
    const [totalTickets, openTickets, avgResponseResult, csatResult, priorityBreakdown, categoryBreakdown] = await Promise.all([
      Ticket.countDocuments({ createdAt: { $gt: startDate } }),
      Ticket.countDocuments({ status: { $in: ["open", "in_progress"] } }),
      Ticket.aggregate([
        { $match: { firstResponseAt: { $exists: true }, createdAt: { $gt: startDate } } },
        { $addFields: { responseMinutes: { $divide: [{ $subtract: ["$firstResponseAt", "$createdAt"] }, 60000] } } },
        { $group: { _id: null, avg: { $avg: "$responseMinutes" } } }
      ]),
      Ticket.aggregate([
        { $match: { csatScore: { $exists: true }, createdAt: { $gt: startDate } } },
        { $group: { _id: null, avg: { $avg: "$csatScore" } } }
      ]),
      Ticket.aggregate([
        { $match: { createdAt: { $gt: startDate } } },
        { $group: { _id: "$priority", count: { $sum: 1 } } }
      ]),
      Ticket.aggregate([
        { $match: { createdAt: { $gt: startDate } } },
        { $group: { _id: "$category", count: { $sum: 1 } } }
      ])
    ]);
    
    return {
      totalTickets,
      openTickets,
      avgFirstResponse: avgResponseResult[0]?.avg || 0,
      csatScore: csatResult[0]?.avg || 0,
      ticketsByPriority: priorityBreakdown,
      ticketsByCategory: categoryBreakdown
    };
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
    console.log(`📝 New user: ${msg.from.first_name} (${msg.from.id})`);
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
    `🚀 **PRO SUPPORT CENTER**\n\n` +
    `Hi ${msg.from.first_name}! How can we help you today?\n\n` +
    `📌 **Quick Commands:**\n` +
    `• ❓ FAQ - Quick answers\n` +
    `• 📞 New Ticket - Create support request\n` +
    `• 📋 My Tickets - Check existing tickets\n` +
    `• ⭐ Status - System health\n\n` +
    `💬 Just type your question and I'll help!`,
    { parse_mode: "Markdown", ...keyboard });
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.from.is_bot) return;
  
  const text = msg.text;
  const lower = text.toLowerCase();
  
  await saveUser(msg);
  
  // Menu handlers
  if (lower === "❓ faq") {
    return bot.sendMessage(msg.chat.id,
      `📌 **FREQUENTLY ASKED QUESTIONS**\n\n` +
      `**Login Issues**\n→ Reset password via app\n→ Clear app cache\n\n` +
      `**Payment Problems**\n→ Wait 24h for processing\n→ Contact support with order ID\n\n` +
      `**App Errors**\n→ Update to latest version\n→ Restart app\n→ Send screenshot to support\n\n` +
      `**Account Access**\n→ Verify email address\n→ Check spam folder\n\n` +
      `❓ Need more help? Create a ticket with "New Ticket"`,
      { parse_mode: "Markdown" });
  }
  
  if (lower === "📞 new ticket") {
    return bot.sendMessage(msg.chat.id, 
      `🎫 **Create New Ticket**\n\n` +
      `Please describe your issue in detail:\n\n` +
      `📌 Include:\n` +
      `• What happened?\n` +
      `• When did it happen?\n` +
      `• Any error messages?\n` +
      `• Screenshots (if any)\n\n` +
      `Just type your message and I'll create a ticket for you!`,
      { parse_mode: "Markdown" });
  }
  
  if (lower === "📋 my tickets") {
    const tickets = await Ticket.find({ userId: msg.from.id }).sort("-createdAt").limit(10);
    
    if (tickets.length === 0) {
      return bot.sendMessage(msg.chat.id, "📭 No tickets found. Create one with 'New Ticket'");
    }
    
    const ticketList = tickets.map(t => 
      `🎫 **${t.ticketId}**\nStatus: ${t.status.toUpperCase()} | Priority: ${t.priority.toUpperCase()}\nCreated: ${t.createdAt.toLocaleDateString()}\n`
    ).join("\n");
    
    return bot.sendMessage(msg.chat.id, `📋 **YOUR TICKETS**\n\n${ticketList}\n\nReply to admin messages to continue conversation.`, { parse_mode: "Markdown" });
  }
  
  if (lower === "⭐ status") {
    const stats = await SupportService.getStats("day");
    const users = await User.countDocuments();
    const openTickets = await Ticket.countDocuments({ status: { $in: ["open", "in_progress"] } });
    
    return bot.sendMessage(msg.chat.id,
      `📊 **SYSTEM STATUS**\n\n` +
      `✅ All systems operational\n` +
      `👥 Total users: ${users}\n` +
      `🎫 Open tickets: ${openTickets}\n` +
      `📈 Today's tickets: ${stats.totalTickets}\n` +
      `⏱️ Avg response: ${Math.round(stats.avgFirstResponse)} minutes\n` +
      `⭐ CSAT score: ${stats.csatScore.toFixed(1)}/5\n\n` +
      `🟢 Bot is online and ready to help!`,
      { parse_mode: "Markdown" });
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
      `✅ **Ticket #${ticket.ticketId} created!**\n\n` +
      `📌 Priority: ${ticket.priority.toUpperCase()}\n` +
      `⏱️ Response time: within ${config.slaHours[ticket.priority]} hours\n\n` +
      `We'll notify you when we reply. You can check status anytime with "My Tickets".`,
      { parse_mode: "Markdown" });
    
    // Notify admin
    bot.sendMessage(config.adminId,
      `📩 **NEW TICKET #${ticket.ticketId}**\n\n` +
      `👤 From: ${msg.from.first_name} (@${msg.from.username || 'no username'})\n` +
      `🆔 User ID: ${msg.from.id}\n` +
      `⚡ Priority: ${ticket.priority.toUpperCase()}\n` +
      `📝 Message: ${text.slice(0, 300)}${text.length > 300 ? '...' : ''}\n\n` +
      `Reply to this user by replying to any message with their ticket #.`,
      { parse_mode: "Markdown" });
      
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
  let ticketId = null;
  
  // Check various patterns
  if (msg.reply_to_message?.text) {
    const text = msg.reply_to_message.text;
    const match = text.match(/#(T\d+-\w+)/);
    if (match) ticketId = match[1];
  }
  
  if (!ticketId) {
    return bot.sendMessage(msg.chat.id, "❌ Could not find ticket ID. Make sure you're replying to a ticket message.");
  }
  
  try {
    await SupportService.addReply(ticketId, "admin", msg.text);
    bot.sendMessage(msg.chat.id, `✅ Reply sent to ticket ${ticketId}`);
    
    // Notify user
    const ticket = await Ticket.findOne({ ticketId });
    if (ticket) {
      bot.sendMessage(ticket.userId, 
        `📩 **ADMIN REPLY**\n\n` +
        `Ticket: ${ticketId}\n\n` +
        `${msg.text}\n\n` +
        `Reply to this message to continue the conversation.`,
        { parse_mode: "Markdown" });
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
  const slaBreaches = await Analytics.countDocuments({ metric: "sla_breach", date: { $gt: new Date(Date.now() - 24*60*60*1000) } });
  
  bot.sendMessage(config.adminId,
    `📊 **PRO SUPPORT STATS**\n\n` +
    `👥 Total Users: ${users}\n` +
    `🎫 Open Tickets: ${openTickets}\n` +
    `📈 Today: ${stats.totalTickets} new\n` +
    `⏱️ Avg Response: ${Math.round(stats.avgFirstResponse)} min\n` +
    `⭐ CSAT: ${stats.csatScore.toFixed(1)}/5\n` +
    `⚠️ SLA Breaches (24h): ${slaBreaches}\n\n` +
    `📌 **Commands:**\n` +
    `/tickets - List open tickets\n` +
    `/resolve <ticketId> - Close ticket\n` +
    `/stats - This view`,
    { parse_mode: "Markdown" });
});

bot.onText(/\/tickets/, async (msg) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  const tickets = await Ticket.find({ status: { $in: ["open", "in_progress"] } }).sort("-priority").limit(20);
  
  if (tickets.length === 0) {
    return bot.sendMessage(config.adminId, "🎫 No open tickets");
  }
  
  let text = "🎫 **OPEN TICKETS**\n\n";
  for (const t of tickets) {
    text += `**${t.ticketId}** | ${t.priority.toUpperCase()} | ${t.status}\n`;
    text += `👤 User: ${t.userId}\n`;
    text += `📝 ${t.message.slice(0, 80)}${t.message.length > 80 ? '...' : ''}\n`;
    text += `⏱️ Created: ${t.createdAt.toLocaleString()}\n\n`;
  }
  
  bot.sendMessage(config.adminId, text, { parse_mode: "Markdown" });
});

bot.onText(/\/resolve (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  const ticketId = match[1];
  await SupportService.resolveTicket(ticketId);
  bot.sendMessage(config.adminId, `✅ Ticket ${ticketId} resolved and CSAT requested`);
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
  const botState = bot ? "running" : "stopped";
  
  res.json({
    status: dbState ? "healthy" : "degraded",
    db: dbState ? "connected" : "disconnected",
    bot: botState,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "Pro Support Center",
    version: "2.0.0",
    status: "operational",
    endpoints: {
      health: "/health",
      stats: "/api/stats",
      ticket: "/api/ticket/:id",
      createTicket: "POST /api/ticket"
    }
  });
});

// ================= CRON JOBS =================
// SLA monitoring every hour
cron.schedule("0 * * * *", async () => {
  const breachedTickets = await Ticket.find({
    status: { $in: ["open", "in_progress"] },
    slaDeadline: { $lt: new Date() }
  });
  
  for (const ticket of breachedTickets) {
    await SupportService.logSLABreach(ticket);
  }
});

// Daily report at 9 AM
cron.schedule("0 9 * * *", async () => {
  const stats = await SupportService.getStats("day");
  await bot.sendMessage(config.adminId, 
    `📈 **DAILY REPORT**\n\n` +
    `📅 Date: ${new Date().toLocaleDateString()}\n` +
    `📊 New Tickets: ${stats.totalTickets}\n` +
    `🔄 Open: ${stats.openTickets}\n` +
    `⭐ CSAT: ${stats.csatScore.toFixed(1)}/5\n` +
    `⏱️ Avg Response: ${Math.round(stats.avgFirstResponse)} min`,
    { parse_mode: "Markdown" });
});

// Auto-close stale resolved tickets after 7 days
cron.schedule("0 0 * * *", async () => {
  const result = await Ticket.updateMany(
    { status: "resolved", resolvedAt: { $lt: new Date(Date.now() - 7*24*60*60*1000) } },
    { status: "closed", closedAt: new Date() }
  );
  if (result.modifiedCount > 0) {
    logger.info(`Auto-closed ${result.modifiedCount} stale resolved tickets`);
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 PRO Support Center running on port ${PORT}`);
  console.log(`\n✅ Bot is active!`);
  console.log(`📊 Admin ID: ${config.adminId}`);
  console.log(`🌐 API: https://auto-reply-xtnl.onrender.com`);
  console.log(`❤️ Health check: https://auto-reply-xtnl.onrender.com/health\n`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("Shutting down gracefully...");
  await mongoose.disconnect();
  process.exit(0);
});
