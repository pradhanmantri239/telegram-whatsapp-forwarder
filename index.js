const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const https = require('https');

class SingleClientForwarder {
  constructor(clientId, config) {
    this.clientId = clientId;
    this.config = config;
    this.whatsappClient = null;
    this.telegramBot = null;
    this.isWhatsAppReady = false;
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.messageVariations = ["", " ", ".", "...", " ."];
    this.isActive = true;
    this.totalMessages = 0;
    this.failedMessages = 0;
    this.availableGroups = [];
  }

  async initializeWhatsApp() {
    console.log(`🚀 [${this.clientId}] Initializing WhatsApp client...`);
    
    // FIXED: Ensure sessions directory exists
    const sessionsDir = `./sessions/${this.clientId}`;
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      console.log(`📁 [${this.clientId}] Sessions directory ensured: ${sessionsDir}`);
    } catch (error) {
      console.log(`📁 [${this.clientId}] Sessions directory already exists or created`);
    }
    
    this.whatsappClient = new Client({
      authStrategy: new LocalAuth({
        clientId: `${this.clientId}`,
        dataPath: sessionsDir,
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-extensions",
          "--disable-blink-features=AutomationControlled",
          "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      }
    });

    this.whatsappClient.on("qr", (qr) => {
      console.log(`\n📱 [${this.clientId}] NEW QR CODE - Previous one expired, use this fresh one:`);
      qrcode.generate(qr, { small: true });
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
      console.log(`\n🔗 [${this.clientId}] Fresh QR URL: ${qrUrl}`);
      console.log(`\n⚠️ [${this.clientId}] IMPORTANT: Scan within 20 seconds or it will expire!`);
      console.log(`\n[${this.clientId}] After scanning, wait for connection...\n`);
    });

    this.whatsappClient.on("ready", async () => {
      console.log(`✅ [${this.clientId}] WhatsApp client is ready!`);
      this.isWhatsAppReady = true;
      this.reconnectAttempts = 0;
      
      setTimeout(async () => {
        try {
          await this.displayAvailableChats();
          this.processMessageQueue();
        } catch (error) {
          console.error(`❌ [${this.clientId}] Error displaying chats:`, error.message);
          setTimeout(async () => {
            try {
              await this.displayAvailableChats();
            } catch (retryError) {
              console.error(`❌ [${this.clientId}] Retry failed:`, retryError.message);
            }
          }, 5000);
        }
      }, 3000);
    });

    this.whatsappClient.on('loading_screen', (percent, message) => {
      console.log(`⏳ [${this.clientId}] Loading: ${percent}% - ${message}`);
    });

    this.whatsappClient.on('change_state', state => {
      console.log(`🔄 [${this.clientId}] Connection state: ${state}`);
    });

    this.whatsappClient.on("authenticated", () => {
      console.log(`✅ [${this.clientId}] WhatsApp authenticated successfully`);
    });

    this.whatsappClient.on("auth_failure", (msg) => {
      console.error(`❌ [${this.clientId}] WhatsApp authentication failed:`, msg);
      this.handleWhatsAppReconnect();
    });

    this.whatsappClient.on("disconnected", (reason) => {
      console.log(`⚠️ [${this.clientId}] WhatsApp disconnected:`, reason);
      this.isWhatsAppReady = false;
      this.availableGroups = [];
      this.handleWhatsAppReconnect();
    });

    await this.whatsappClient.initialize();
  }

  async displayAvailableChats() {
    try {
      console.log(`📋 [${this.clientId}] Fetching WhatsApp chats...`);
      
      const chats = await this.whatsappClient.getChats();
      console.log(`📊 [${this.clientId}] Total chats found: ${chats.length}`);
      
      const groups = chats.filter((chat) => chat.isGroup);
      console.log(`📊 [${this.clientId}] Groups found: ${groups.length}`);
      
      this.availableGroups = groups.map(group => ({
        name: group.name,
        id: group.id._serialized,
        participants: group.participants ? group.participants.length : 0
      }));
      
      console.log(`\n📋 [${this.clientId}] Available WhatsApp Groups:`);
      console.log("=====================================");
      
      if (groups.length === 0) {
        console.log(`❌ [${this.clientId}] No groups found. Make sure you're added to WhatsApp groups.`);
        return;
      }

      groups.forEach((group, index) => {
        const participantCount = group.participants ? group.participants.length : 0;
        console.log(`${index + 1}. ${group.name}`);
        console.log(`   📍 ID: ${group.id._serialized}`);
        console.log(`   👥 Participants: ${participantCount}`);
        console.log(`   📅 Created: ${group.createdAt ? new Date(group.createdAt.low * 1000).toLocaleDateString() : 'Unknown'}`);
        console.log('');
      });
      console.log("=====================================\n");
      
      const individualChats = chats.filter(chat => !chat.isGroup);
      console.log(`📊 [${this.clientId}] Individual chats: ${individualChats.length}`);
      console.log(`📊 [${this.clientId}] Total chats: ${chats.length}\n`);
      
    } catch (error) {
      console.error(`❌ [${this.clientId}] Error getting chats:`, error.message);
      console.error(`❌ [${this.clientId}] Error details:`, error);
      
      try {
        console.log(`🔄 [${this.clientId}] Trying alternative method to get chats...`);
        const state = await this.whatsappClient.getState();
        console.log(`📊 [${this.clientId}] WhatsApp state: ${state}`);
      } catch (stateError) {
        console.error(`❌ [${this.clientId}] Could not get WhatsApp state:`, stateError.message);
      }
    }
  }

  async handleWhatsAppReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`❌ [${this.clientId}] Max reconnection attempts reached.`);
      return;
    }

    this.reconnectAttempts++;
    console.log(`🔄 [${this.clientId}] Attempting to reconnect WhatsApp (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.whatsappClient.destroy();
        await this.initializeWhatsApp();
      } catch (error) {
        console.error(`❌ [${this.clientId}] Reconnection failed:`, error.message);
        this.handleWhatsAppReconnect();
      }
    }, 10000);
  }

  initializeTelegram() {
    console.log(`🚀 [${this.clientId}] Initializing Telegram bot...`);
    
    this.telegramBot = new TelegramBot(this.config.telegramBotToken, {
      polling: true,
    });

    this.telegramBot.on("message", async (msg) => {
      if (!this.isActive) {
        console.log(`⏸️ [${this.clientId}] Forwarding paused, message skipped`);
        return;
      }

      try {
        const chatId = msg.chat.id.toString();
        if (!this.config.telegramGroups || !this.config.telegramGroups.includes(chatId)) {
          return;
        }
        await this.handleTelegramMessage(msg);
      } catch (error) {
        console.error(`❌ [${this.clientId}] Error processing Telegram message:`, error.message);
      }
    });

    this.telegramBot.on("polling_error", (error) => {
      console.error(`❌ [${this.clientId}] Telegram polling error:`, error.message);
    });

    console.log(`✅ [${this.clientId}] Telegram bot initialized and listening`);
  }

  async handleTelegramMessage(msg) {
    const messageInfo = {
      text: msg.text || msg.caption || "",
      from: msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ""),
      chat: msg.chat.title || "Private Chat",
      timestamp: new Date(msg.date * 1000).toLocaleString(),
      type: "text",
    };

    if (msg.photo) {
      messageInfo.type = "photo";
      messageInfo.fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document) {
      messageInfo.type = "document";
      messageInfo.fileId = msg.document.file_id;
      messageInfo.fileName = msg.document.file_name;
    } else if (msg.video) {
      messageInfo.type = "video";
      messageInfo.fileId = msg.video.file_id;
    } else if (msg.audio || msg.voice) {
      messageInfo.type = "audio";
      messageInfo.fileId = (msg.audio || msg.voice).file_id;
    }

    this.messageQueue.push(messageInfo);
    console.log(`📨 [${this.clientId}] New message queued: ${messageInfo.type}`);

    if (!this.isProcessingQueue) {
      this.processMessageQueue();
    }
  }

  // FIXED: Updated delays - 8-13 seconds between messages
  async processMessageQueue() {
    if (this.isProcessingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      if (!this.isWhatsAppReady || !this.isActive) {
        if (!this.isActive) {
          console.log(`⏸️ [${this.clientId}] Forwarding paused`);
        } else {
          console.log(`⏳ [${this.clientId}] WhatsApp not ready, waiting...`);
        }
        await this.sleep(5000);
        continue;
      }

      const messageInfo = this.messageQueue.shift();
      await this.forwardToWhatsApp(messageInfo);

      // FIXED: 8-13 seconds delay between messages
      const messageDelay = Math.floor(Math.random() * 5000) + 8000; // 8000-13000ms
      console.log(`⏳ [${this.clientId}] Waiting ${messageDelay}ms before next message...`);
      await this.sleep(messageDelay);
    }

    this.isProcessingQueue = false;
  }

  // FIXED: Updated group delays and fixed file download
  async forwardToWhatsApp(messageInfo) {
    if (!this.config.whatsappGroups || this.config.whatsappGroups.length === 0) {
      console.log(`⚠️ [${this.clientId}] No WhatsApp groups configured, skipping message`);
      return;
    }

    let messageText = messageInfo.text;
    if (messageText) {
      const randomVariation = this.messageVariations[Math.floor(Math.random() * this.messageVariations.length)];
      messageText = messageInfo.text + randomVariation;
    }

    for (let i = 0; i < this.config.whatsappGroups.length; i++) {
      const groupId = this.config.whatsappGroups[i];
      
      try {
        if (messageInfo.type === "text" && messageText) {
          await this.whatsappClient.sendMessage(groupId, messageText, { linkPreview: false });
          console.log(`✅ [${this.clientId}] Text message sent to WhatsApp group ${i + 1} (no preview)`);
        } else if (messageInfo.fileId) {
          console.log(`📎 [${this.clientId}] Processing ${messageInfo.type} file...`);
          const mediaData = await this.downloadTelegramFile(messageInfo.fileId);
          if (mediaData) {
            const media = new MessageMedia(
              mediaData.mimeType, 
              mediaData.buffer.toString('base64'), 
              mediaData.fileName
            );
            await this.whatsappClient.sendMessage(groupId, media, { 
              caption: messageText || "",
              linkPreview: false
            });
            console.log(`✅ [${this.clientId}] ${messageInfo.type} message sent to WhatsApp group ${i + 1} (no preview)`);
          } else {
            console.log(`❌ [${this.clientId}] Failed to download ${messageInfo.type} file`);
            this.failedMessages++;
            continue;
          }
        }

        this.totalMessages++;
      } catch (error) {
        console.error(`❌ [${this.clientId}] Failed to send message to group ${i + 1}:`, error.message);
        this.failedMessages++;
      }

      // FIXED: 3-5 seconds delay between groups
      if (i < this.config.whatsappGroups.length - 1) {
        const groupDelay = Math.floor(Math.random() * 2000) + 3000; // 3000-5000ms
        console.log(`⏳ [${this.clientId}] Waiting ${groupDelay}ms before next group...`);
        await this.sleep(groupDelay);
      }
    }
  }

  // FIXED: Complete file download implementation
  async downloadTelegramFile(fileId) {
    try {
      console.log(`📥 [${this.clientId}] Downloading file: ${fileId}`);
      
      // Get file info from Telegram
      const fileInfo = await this.telegramBot.getFile(fileId);
      console.log(`📋 [${this.clientId}] File info:`, {
        path: fileInfo.file_path,
        size: fileInfo.file_size
      });

      if (!fileInfo.file_path) {
        throw new Error('File path not available from Telegram API');
      }

      // Construct the download URL
      const fileUrl = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${fileInfo.file_path}`;
      console.log(`🔗 [${this.clientId}] Download URL: ${fileUrl}`);

      // Download file as buffer using https module
      const buffer = await new Promise((resolve, reject) => {
        const chunks = [];
        https.get(fileUrl, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download file: ${response.statusCode}`));
            return;
          }

          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const fileBuffer = Buffer.concat(chunks);
            console.log(`✅ [${this.clientId}] File downloaded successfully: ${fileBuffer.length} bytes`);
            resolve(fileBuffer);
          });
          response.on('error', reject);
        }).on('error', reject);
      });

      // Determine MIME type and filename
      const fileName = fileInfo.file_path.split('/').pop() || 'file';
      const mimeType = this.getMimeTypeFromPath(fileInfo.file_path);

      return {
        buffer: buffer,
        mimeType: mimeType,
        fileName: fileName
      };

    } catch (error) {
      console.error(`❌ [${this.clientId}] Error downloading file:`, error.message);
      return null;
    }
  }

  // Helper function to determine MIME type from file path
  getMimeTypeFromPath(filePath) {
    const extension = filePath.split('.').pop().toLowerCase();
    const mimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'ogg': 'audio/ogg',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'txt': 'text/plain'
    };
    return mimeTypes[extension] || 'application/octet-stream';
  }

  getMimeType(type) {
    const mimeTypes = {
      photo: "image/jpeg",
      video: "video/mp4",
      audio: "audio/mpeg",
      voice: "audio/ogg",
      document: "application/octet-stream",
    };
    return mimeTypes[type] || "application/octet-stream";
  }

  getFileExtension(type) {
    const extensions = {
      photo: "jpg",
      video: "mp4",
      audio: "mp3",
      voice: "ogg",
      document: "bin",
    };
    return extensions[type] || "bin";
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async start() {
    console.log(`🚀 [${this.clientId}] Starting forwarder...`);
    await this.initializeWhatsApp();
    this.initializeTelegram();
  }

  async stop() {
    console.log(`🛑 [${this.clientId}] Stopping forwarder...`);
    this.isActive = false;
    if (this.whatsappClient) {
      await this.whatsappClient.destroy();
    }
    if (this.telegramBot) {
      this.telegramBot.stopPolling();
    }
  }

  getStats() {
    return {
      clientId: this.clientId,
      isActive: this.isActive,
      isWhatsAppReady: this.isWhatsAppReady,
      totalMessages: this.totalMessages,
      failedMessages: this.failedMessages,
      queueLength: this.messageQueue.length,
      availableGroups: this.availableGroups.length,
    };
  }
}

class MultiClientManager {
  constructor() {
    this.clients = new Map();
    this.app = express();
    this.port = process.env.PORT || 3000;
  }

  async loadClientConfig(clientId) {
    try {
      const configPath = `./configs/${clientId}.json`;
      const configData = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.error(`❌ Failed to load config for ${clientId}:`, error.message);
      throw error;
    }
  }

  async startClient(clientId) {
    try {
      if (this.clients.has(clientId)) {
        console.log(`⚠️ Client ${clientId} is already running`);
        return;
      }

      const config = await this.loadClientConfig(clientId);
      const client = new SingleClientForwarder(clientId, config);
      
      this.clients.set(clientId, client);
      await client.start();
      
      console.log(`✅ Client ${clientId} started successfully`);
    } catch (error) {
      console.error(`❌ Failed to start client ${clientId}:`, error.message);
    }
  }

  async stopClient(clientId) {
    if (!this.clients.has(clientId)) {
      console.log(`⚠️ Client ${clientId} is not running`);
      return;
    }

    const client = this.clients.get(clientId);
    await client.stop();
    this.clients.delete(clientId);
    
    console.log(`🛑 Client ${clientId} stopped successfully`);
  }

  setupAPI() {
    this.app.use(express.json());

    this.app.get('/', (req, res) => {
      res.json({
        status: 'Multi-Client Telegram to WhatsApp Forwarder',
        clients: Array.from(this.clients.keys()),
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/clients', (req, res) => {
      const clientStats = Array.from(this.clients.entries()).map(([id, client]) => ({
        id,
        ...client.getStats()
      }));
      res.json(clientStats);
    });

    this.app.post('/clients/:clientId/start', async (req, res) => {
      try {
        await this.startClient(req.params.clientId);
        res.json({ success: true, message: `Client ${req.params.clientId} started` });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/clients/:clientId/stop', async (req, res) => {
      try {
        await this.stopClient(req.params.clientId);
        res.json({ success: true, message: `Client ${req.params.clientId} stopped` });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.listen(this.port, () => {
      console.log(`🌐 API server running on port ${this.port}`);
    });
  }

  async start() {
    console.log('🚀 Starting Multi-Client Manager...');
    
    this.setupAPI();
    
    // Auto-start client1
    await this.startClient('client1');
  }
}

// Start the application
const manager = new MultiClientManager();
manager.start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  for (const [clientId, client] of manager.clients) {
    await client.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  for (const [clientId, client] of manager.clients) {
    await client.stop();
  }
  process.exit(0);
});
