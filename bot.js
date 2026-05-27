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
  appUrl: "https://auto-reply-xtnl.onrender.com",
  maxTicketsPerUser: 5,
  slaHours: { low: 48, normal: 24, high: 4, urgent: 1 }
};

// ================= INIT SERVICES =================
const app = express();
const bot = new TelegramBot(config.botToken, { polling: true });
const redis = new Redis(config.redisUrl);
const openai = new OpenAI({ apiKey: config.openaiKey });

// Email transporter
const transporter = nodemailer.createTransport({
  host: config.smtpHost,
  auth: { user: config.smtpUser, pass: config.smtpPass }
});

// ================= MIDDLEWARE =================
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Request validation
const ticketSchema = Joi.object({
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

// User schema with preferences
const userSchema = new mongoose.Schema({
  userId: { type: Number, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  email: String,
  language: { type: String, default: "en" },
  timezone: String,
  preferences: {
    notifications: { type: Boolean, default: true },
    emailOnReply: { type: Boolean, default: false }
  },
  trustScore: { type: Number, default: 100 },
  totalTickets: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastActiveAt: Date
});

// Ticket schema with full features
const ticketSchema = new mongoose.Schema({
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
const kbSchema = new mongoose.Schema({
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
const analyticsSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now, index: true },
  metric: String,
  value: Number,
  breakdown: mongoose.Schema.Types.Mixed
});

const User = mongoose.model("User", userSchema);
const Ticket = mongoose.model("Ticket", ticketSchema);
const KBArticle = mongoose.model("KBArticle", kbSchema);
const Analytics = mongoose.model("Analytics", analyticsSchema);

// ================= CACHE LAYER =================
class CacheManager {
  static async get(key) { return redis.get(key); }
  static async set(key, value, ttl = 3600) { return redis.set(key, JSON.stringify(value), "EX", ttl); }
  static async del(key) { return redis.del(key); }
  static async increment(key) { return redis.incr(key); }
}

// ================= AI CLASSIFIER =================
class AIClassifier {
  static async classifyTicket(message) {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{
          role: "system",
          content: "Classify support tickets into: category (technical/billing/account/feature/other), priority (low/normal/high/urgent), sentiment (positive/neutral/negative), and suggested tags."
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
  
  static async findSimilarArticles(message) {
    // Get embedding for message
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message
    });
    
    // Find similar articles (simplified - use vector DB in production)
    const articles = await KBArticle.find({
      $vectorSearch: { index: "vector_index", vector: embedding.data[0].embedding, limit: 3 }
    });
    
    return articles;
  }
}

// ================= BUSINESS LOGIC =================
class SupportService {
  static async createTicket(userId, message, metadata = {}) {
    // Rate limiting per user
    const ticketCount = await Ticket.countDocuments({ 
      userId, 
      createdAt: { $gt: new Date(Date.now() - 24*60*60*1000) }
    });
    
    if (ticketCount >= config.maxTicketsPerUser) {
      throw new Error("Daily ticket limit reached");
    }
    
    // AI classification
    const classification = await AIClassifier.classifyTicket(message);
    
    // Calculate SLA deadline
    const slaHours = config.slaHours[classification.priority];
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
    
    // Update user stats
    await User.updateOne({ userId }, { $inc: { totalTickets: 1 }, lastActiveAt: new Date() });
    
    // Log analytics
    await Analytics.create({
      metric: "ticket_created",
      value: 1,
      breakdown: { priority: classification.priority, category: classification.category }
    });
    
    // Check for auto-suggested articles
    const similarArticles = await AIClassifier.findSimilarArticles(message);
    if (similarArticles.length > 0) {
      await bot.sendMessage(userId, `📚 Related articles that might help:\n${similarArticles.map(a => `• ${a.title}`).join("\n")}`);
    }
    
    // Notify admins for urgent tickets
    if (classification.priority === "urgent") {
      await this.notifyAdmins(ticket);
    }
    
    return ticket;
  }
  
  static async assignTicket(ticketId, assigneeId) {
    const ticket = await Ticket.findOneAndUpdate(
      { ticketId },
      { assigneeId, status: "in_progress", updatedAt: new Date() },
      { new: true }
    );
    
    await this.logAssignment(ticket, assigneeId);
    return ticket;
  }
  
  static async addReply(ticketId, from, message, isInternal = false) {
    const ticket = await Ticket.findOne({ ticketId });
    
    ticket.messages.push({ from, message, isInternal });
    
    if (from === "admin" && !ticket.firstResponseAt) {
      ticket.firstResponseAt = new Date();
      
      // Check SLA compliance
      if (ticket.firstResponseAt > ticket.slaDeadline) {
        await this.logSLABreach(ticket);
      }
    }
    
    if (from === "user" && ticket.status === "waiting_customer") {
      ticket.status = "in_progress";
    }
    
    ticket.updatedAt = new Date();
    await ticket.save();
    
    // Send email notification if user opted in
    const user = await User.findOne({ userId: ticket.userId });
    if (user.preferences.emailOnReply && from === "admin") {
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
    
    if (csatRequest) {
      await this.requestCSAT(ticket);
    }
    
    await Analytics.create({
      metric: "ticket_resolved",
      value: 1,
      breakdown: { 
        priority: ticket.priority,
        responseTime: (ticket.resolvedAt - ticket.createdAt) / 1000 / 60 // minutes
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
    const admins = await User.find({ isAdmin: true });
    for (const admin of admins) {
      await bot.sendMessage(admin.userId, 
        `🚨 URGENT TICKET ${ticket.ticketId}\nPriority: ${ticket.priority}\nMessage: ${ticket.message.slice(0, 100)}`
      );
    }
  }
  
  static async logSLABreach(ticket) {
    logger.warn(`SLA breach for ticket ${ticket.ticketId}`);
    await Analytics.create({ metric: "sla_breach", value: 1 });
    
    // Notify supervisor
    await bot.sendMessage(config.adminId, `⚠️ SLA BREACH: Ticket ${ticket.ticketId} missed ${ticket.priority} priority SLA`);
  }
  
  static async sendEmailNotification(user, ticket, message) {
    await transporter.sendMail({
      to: user.email,
      subject: `Support Ticket ${ticket.ticketId} Update`,
      html: `<p>Your ticket has a new reply:</p><p>${message}</p><a href="${config.appUrl}/ticket/${ticket.ticketId}">View Ticket</a>`
    });
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
// Intelligent routing
bot.on("message", async (msg) => {
  if (!msg.text || msg.from.is_bot) return;
  
  const user = await User.findOneAndUpdate(
    { userId: msg.from.id },
    { lastActiveAt: new Date() },
    { upsert: true, new: true }
  );
  
  const text = msg.text;
  const lower = text.toLowerCase();
  
  // Command handlers
  if (lower === "/start") {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📝 New Ticket", callback_data: "new_ticket" }],
          [{ text: "📋 My Tickets", callback_data: "my_tickets" }],
          [{ text: "❓ FAQ", callback_data: "faq" }, { text: "⭐ Status", callback_data: "status" }]
        ]
      }
    };
    await bot.sendMessage(msg.chat.id, `🎯 PRO SUPPORT CENTER\n\nHi ${msg.from.first_name}! How can we help you today?`, keyboard);
    return;
  }
  
  // Process as ticket message
  try {
    const ticket = await SupportService.createTicket(msg.from.id, text, { source: "telegram" });
    await bot.sendMessage(msg.chat.id, `✅ Ticket #${ticket.ticketId} created\nPriority: ${ticket.priority}\nWe'll respond within ${config.slaHours[ticket.priority]} hours.`);
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `⚠️ ${error.message}`);
  }
});

// Callback handlers
bot.on("callback_query", async (query) => {
  const [action, param1, param2] = query.data.split("_");
  
  if (action === "csat") {
    const score = parseInt(param1);
    const ticketId = param2;
    
    await Ticket.findOneAndUpdate({ ticketId }, { csatScore: score, status: "closed", closedAt: new Date() });
    await bot.sendMessage(query.from.id, `Thank you for your feedback! ⭐ ${score}/5`);
  }
  
  if (action === "new") {
    await bot.sendMessage(query.from.id, "Please describe your issue in detail:");
  }
  
  if (action === "my") {
    const tickets = await Ticket.find({ userId: query.from.id }).sort("-createdAt").limit(10);
    const message = tickets.map(t => `${t.ticketId}: ${t.status} - ${t.priority}`).join("\n") || "No tickets found";
    await bot.sendMessage(query.from.id, `📋 Your tickets:\n${message}`);
  }
  
  await bot.answerCallbackQuery(query.id);
});

// Admin commands
bot.onText(/\/admin (.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  const [command, param] = match[1].split(" ");
  
  switch(command) {
    case "stats":
      const stats = await SupportService.getStats();
      await bot.sendMessage(config.adminId, 
        `📊 SUPPORT STATS\n\nTickets: ${stats.totalTickets}\nOpen: ${stats.openTickets}\nAvg Response: ${Math.round(stats.avgFirstResponse)}min\nCSAT: ${stats.csatScore.toFixed(1)}⭐`
      );
      break;
      
    case "assign":
      await SupportService.assignTicket(param, msg.from.id);
      await bot.sendMessage(config.adminId, `✅ Ticket ${param} assigned to you`);
      break;
      
    case "resolve":
      await SupportService.resolveTicket(param);
      await bot.sendMessage(config.adminId, `✅ Ticket ${param} resolved`);
      break;
      
    case "priority":
      await Ticket.findOneAndUpdate({ ticketId: param }, { priority: match[1].split(" ")[2] });
      await bot.sendMessage(config.adminId, `✅ Ticket ${param} priority updated`);
      break;
  }
});

// Reply handler for admin responses
bot.on("reply_to_message", async (msg) => {
  if (msg.from.id.toString() !== config.adminId) return;
  
  const match = msg.reply_to_message?.text?.match(/Ticket #(\S+)/);
  if (!match) return;
  
  const ticketId = match[1];
  await SupportService.addReply(ticketId, "admin", msg.text);
  await bot.sendMessage(msg.chat.id, `✅ Reply sent to ticket ${ticketId}`);
});

// ================= WEBHOOKS & API =================
app.post("/api/webhook/telegram", async (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/api/ticket", async (req, res) => {
  const { error, value } = ticketSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  
  const ticket = await SupportService.createTicket(value.userId, value.message, req.body.metadata);
  res.json({ ticketId: ticket.ticketId, priority: ticket.priority });
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

app.post("/api/kb/search", async (req, res) => {
  const articles = await AIClassifier.findSimilarArticles(req.body.query);
  res.json(articles);
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

// Daily analytics summary
cron.schedule("0 9 * * *", async () => {
  const stats = await SupportService.getStats("day");
  await bot.sendMessage(config.adminId, 
    `📈 DAILY REPORT\n\nTickets: ${stats.totalTickets}\nOpen: ${stats.openTickets}\nCSAT: ${stats.csatScore.toFixed(1)}\nSLA Breaches: ${await Analytics.countDocuments({ metric: "sla_breach", date: { $gt: new Date(Date.now() - 24*60*60*1000) } })}`
  );
});

// Auto-close stale resolved tickets after 7 days
cron.schedule("0 0 * * *", async () => {
  await Ticket.updateMany(
    { status: "resolved", resolvedAt: { $lt: new Date(Date.now() - 7*24*60*60*1000) } },
    { status: "closed", closedAt: new Date() }
  );
});

// ================= HEALTH CHECK =================
app.get("/health", async (req, res) => {
  const dbState = mongoose.connection.readyState === 1;
  const redisState = await redis.ping() === "PONG";
  
  res.json({
    status: dbState && redisState ? "healthy" : "degraded",
    db: dbState ? "connected" : "disconnected",
    redis: redisState ? "connected" : "disconnected",
    uptime: process.uptime()
  });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 PRO Support Center running on port ${PORT}`);
  console.log(`🤖 Bot active | Admin: ${config.adminId}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("Shutting down gracefully...");
  await mongoose.disconnect();
  await redis.quit();
  process.exit(0);
});
