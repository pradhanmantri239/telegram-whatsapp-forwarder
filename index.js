const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');

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
    
    this.whatsappClient = new Client({
      authStrategy: new LocalAuth({
        clientId: `${this.clientId}`,
        dataPath: `./sessions/${this.clientId}`,
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

      const messageDelay = Math.floor(Math.random() * 2000) + 1000;
      console.log(`⏳ [${this.clientId}] Waiting ${messageDelay}ms before next message...`);
      await this.sleep(messageDelay);
    }

    this.isProcessingQueue = false;
  }

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
        // Disable link preview for text messages
        await this.whatsappClient.sendMessage(groupId, messageText, { linkPreview: false });
        console.log(`✅ [${this.clientId}] Text message sent to WhatsApp group ${i + 1} (no preview)`);
      } else if (messageInfo.fileId) {
        console.log(`📎 [${this.clientId}] Processing ${messageInfo.type} file...`);
        const mediaData = await this.downloadTelegramFile(messageInfo.fileId);
        if (mediaData) {
          const media = new MessageMedia(
            mediaData.mimeType || this.getMimeType(messageInfo.type), 
            mediaData.buffer.toString('base64'), 
            mediaData.fileName || messageInfo.fileName || `file.${this.getFileExtension(messageInfo.type)}`
          );
          // Disable link preview for media captions
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

    if (i < this.config.whatsappGroups.length - 1) {
      await this.sleep(1000);
    }
  }
}
  // FIXED: Improved file download method
  async downloadTelegramFile(fileId) {
    try {
      console.log(`📥 [${this.clientId}] Downloading file: ${fileId}`);
      
      // Get file info
      const fileInfo = await this.telegramBot.getFile(fileId);
      console.log(`📋 [${this.clientId}] File info:`, {
        file_path: fileInfo.file_path,
        file_size: fileInfo.file_size
      });
      
      // Download file as stream/buffer instead of saving to disk
      const fileBuffer = await this.telegramBot.downloadFile(fileId);
      
      if (!fileBuffer) {
        throw new Error('Failed to download file buffer');
      }
      
      console.log(`✅ [${this.clientId}] File downloaded successfully, size: ${fileBuffer.length} bytes`);
      
      // Determine MIME type from file path
      const mimeType = this.getMimeTypeFromPath(fileInfo.file_path);
      const fileName = path.basename(fileInfo.file_path);
      
      return {
        buffer: fileBuffer,
        mimeType: mimeType,
        fileName: fileName,
        size: fileBuffer.length
      };
      
    } catch (error) {
      console.error(`❌ [${this.clientId}] Error downloading file:`, error.message);
      return null;
    }
  }

  // Helper method to get MIME type from file path
  getMimeTypeFromPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.avi': 'video/avi',
      '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain'
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }

  // Helper method to get MIME type from message type
  getMimeType(type) {
    const types = {
      'photo': 'image/jpeg',
      'video': 'video/mp4',
      'audio': 'audio/mpeg',
      'voice': 'audio/ogg',
      'document': 'application/octet-stream'
    };
    
    return types[type] || 'application/octet-stream';
  }

  // Helper method to get file extension
  getFileExtension(type) {
    const extensions = {
      'photo': 'jpg',
      'video': 'mp4',
      'audio': 'mp3',
      'voice': 'ogg',
      'document': 'bin'
    };
    
    return extensions[type] || 'bin';
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  pause() {
    this.isActive = false;
    console.log(`⏸️ [${this.clientId}] Forwarding paused`);
  }

  resume() {
    this.isActive = true;
    console.log(`▶️ [${this.clientId}] Forwarding resumed`);
    if (this.messageQueue.length > 0 && !this.isProcessingQueue) {
      this.processMessageQueue();
    }
  }

  async refreshGroups() {
    if (this.isWhatsAppReady) {
      await this.displayAvailableChats();
      return this.availableGroups;
    } else {
      throw new Error('WhatsApp client not ready');
    }
  }

  getStatus() {
    return {
      clientId: this.clientId,
      isWhatsAppReady: this.isWhatsAppReady,
      isActive: this.isActive,
      queueLength: this.messageQueue.length,
      totalMessages: this.totalMessages,
      failedMessages: this.failedMessages,
      isProcessingQueue: this.isProcessingQueue,
      availableGroups: this.availableGroups
    };
  }
}

class MultiClientManager {
  constructor() {
    this.clients = [];
    this.configPath = './configs';
  }

  async initialize() {
    try {
      await this.loadConfigs();
      await this.startAllClients();
    } catch (error) {
      console.error('❌ Error initializing multi-client manager:', error.message);
    }
  }

  async loadConfigs() {
    try {
      const files = await fs.readdir(this.configPath);
      const configFiles = files.filter(file => file.endsWith('.json'));

      for (const file of configFiles) {
        const configPath = path.join(this.configPath, file);
        const configData = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(configData);
        const clientId = path.basename(file, '.json');

        const client = new SingleClientForwarder(clientId, config);
        this.clients.push(client);
        console.log(`📋 Loaded config for client: ${clientId}`);
      }
    } catch (error) {
      console.error('❌ Error loading configs:', error.message);
    }
  }

  async startAllClients() {
    console.log(`🚀 Starting ${this.clients.length} clients...`);
    
    for (let i = 0; i < this.clients.length; i++) {
      const client = this.clients[i];
      
      try {
        await client.initializeWhatsApp();
        client.initializeTelegram();
        
        if (i < this.clients.length - 1) {
          console.log(`⏳ Waiting 10 seconds before starting next client...`);
          await this.sleep(10000);
        }
      } catch (error) {
        console.error(`❌ Error starting client ${client.clientId}:`, error.message);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getAllStatus() {
    return this.clients.map(client => client.getStatus());
  }

  getClient(clientId) {
    return this.clients.find(client => client.clientId === clientId);
  }
}

// Express server setup
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const manager = new MultiClientManager();

app.get('/', (req, res) => {
  const clientStatus = manager.getAllStatus();
  
  res.json({
    status: 'Bot is running',
    timestamp: new Date().toISOString(),
    clients: clientStatus,
    summary: {
      totalClients: clientStatus.length,
      readyClients: clientStatus.filter(c => c.isWhatsAppReady).length,
      activeClients: clientStatus.filter(c => c.isActive).length,
      totalGroups: clientStatus.reduce((sum, c) => sum + (c.availableGroups?.length || 0), 0)
    }
  });
});

app.get('/status', (req, res) => {
  res.json(manager.getAllStatus());
});

app.get('/groups', (req, res) => {
  const allGroups = {};
  manager.clients.forEach(client => {
    allGroups[client.clientId] = client.availableGroups || [];
  });
  res.json(allGroups);
});

app.post('/client/:clientId/refresh-groups', async (req, res) => {
  const client = manager.getClient(req.params.clientId);
  if (client) {
    try {
      const groups = await client.refreshGroups();
      res.json({ success: true, groups });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  } else {
    res.status(404).json({ success: false, message: 'Client not found' });
  }
});

app.post('/client/:clientId/pause', (req, res) => {
  const client = manager.getClient(req.params.clientId);
  if (client) {
    client.pause();
    res.json({ success: true, message: `Client ${req.params.clientId} paused` });
  } else {
    res.status(404).json({ success: false, message: 'Client not found' });
  }
});

app.post('/client/:clientId/resume', (req, res) => {
  const client = manager.getClient(req.params.clientId);
  if (client) {
    client.resume();
    res.json({ success: true, message: `Client ${req.params.clientId} resumed` });
  } else {
    res.status(404).json({ success: false, message: 'Client not found' });
  }
});

app.listen(PORT, async () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`🔗 Access status at: http://localhost:${PORT}`);
  
  await manager.initialize();
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Graceful shutdown initiated...');
  
  for (const client of manager.clients) {
    try {
      if (client.whatsappClient) {
        await client.whatsappClient.destroy();
      }
      if (client.telegramBot) {
        await client.telegramBot.stopPolling();
      }
    } catch (error) {
      console.error(`❌ Error during shutdown for client ${client.clientId}:`, error.message);
    }
  }
  
  console.log('✅ Shutdown complete');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down...');
  
  for (const client of manager.clients) {
    try {
      if (client.whatsappClient) {
        await client.whatsappClient.destroy();
      }
      if (client.telegramBot) {
        await client.telegramBot.stopPolling();
      }
    } catch (error) {
      console.error(`❌ Error during shutdown for client ${client.clientId}:`, error.message);
    }
  }
  
  process.exit(0);
});
