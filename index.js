const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

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
    this.isActive = true; // Control forwarding
    this.totalMessages = 0;
    this.failedMessages = 0;
  }
    async initializeWhatsApp() {
        console.log(`🚀 [${this.clientId}] Initializing WhatsApp client...`);

        this.whatsappClient = new Client({
            authStrategy: new LocalAuth({
                clientId: `${this.clientId}`, // Fixed - no Date.now()
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
                ],
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false,
            },
        });

        this.whatsappClient.on("qr", (qr) => {
            console.log(`\n📱 [${this.clientId}] Scan this QR code with your WhatsApp:`);
            qrcode.generate(qr, { small: true });
            console.log(`\n[${this.clientId}] After scanning, the client will connect automatically...\n`);
        });

        this.whatsappClient.on("ready", async () => {
            console.log(`✅ [${this.clientId}] WhatsApp client is ready!`);
            this.isWhatsAppReady = true;
            this.reconnectAttempts = 0;
            await this.displayAvailableChats();
            this.processMessageQueue();
        });

        this.whatsappClient.on("authenticated", () => {
            console.log(`✅ [${this.clientId}] WhatsApp authenticated successfully`);
        });

        this.whatsappClient.on("auth_failure", (msg) => {
            console.error(`❌ [${this.clientId}] WhatsApp authentication failed:`, msg);
            this.handleWhatsAppReconnect();
        });

        this.whatsappClient.on("disconnected", (reason) => {
            console.log(`⚠️  [${this.clientId}] WhatsApp disconnected:`, reason);
            this.isWhatsAppReady = false;
            this.handleWhatsAppReconnect();
        });

        await this.whatsappClient.initialize();
    }
  /*async initializeWhatsApp() {
    console.log(`🚀 [${this.clientId}] Initializing WhatsApp client...`);

    this.whatsappClient = new Client({
      authStrategy: new LocalAuth({
        clientId: `${this.clientId}-${Date.now()}`,
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
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
    });

    this.whatsappClient.on("qr", (qr) => {
      console.log(`\n📱 [${this.clientId}] Scan this QR code with WhatsApp:`);
      qrcode.generate(qr, { small: true });
      console.log(`\n[${this.clientId}] After scanning, the client will connect automatically...\n`);
    });

    this.whatsappClient.on("ready", async () => {
      console.log(`✅ [${this.clientId}] WhatsApp client is ready!`);
      this.isWhatsAppReady = true;
      this.reconnectAttempts = 0;
      await this.displayAvailableChats();
      this.processMessageQueue();
    });

    this.whatsappClient.on("authenticated", () => {
      console.log(`✅ [${this.clientId}] WhatsApp authenticated successfully`);
    });

    this.whatsappClient.on("auth_failure", (msg) => {
      console.error(`❌ [${this.clientId}] WhatsApp authentication failed:`, msg);
      this.handleWhatsAppReconnect();
    });

    this.whatsappClient.on("disconnected", (reason) => {
      console.log(`⚠️  [${this.clientId}] WhatsApp disconnected:`, reason);
      this.isWhatsAppReady = false;
      this.handleWhatsAppReconnect();
    });

    await this.whatsappClient.initialize();
  }*/

  async displayAvailableChats() {
    try {
      const chats = await this.whatsappClient.getChats();
      const groups = chats.filter((chat) => chat.isGroup);

      console.log(`\n📋 [${this.clientId}] Available WhatsApp Groups:`);
      console.log("=====================================");

      if (groups.length === 0) {
        console.log(`[${this.clientId}] No groups found.`);
        return;
      }

      groups.forEach((group, index) => {
        console.log(`${index + 1}. ${group.name}`);
        console.log(`   ID: ${group.id._serialized}`);
      });
      console.log("=====================================\n");
    } catch (error) {
      console.error(`❌ [${this.clientId}] Error getting chats:`, error.message);
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
        if (messageInfo.type === "text") {
          await this.whatsappClient.sendMessage(groupId, messageText);
        } else {
          await this.forwardMediaMessage(groupId, messageInfo, messageText);
        }

        console.log(`✅ [${this.clientId}] Message forwarded to group: ${groupId.substring(0, 20)}...`);
        this.totalMessages++;

        if (i < this.config.whatsappGroups.length - 1) {
          const groupDelay = Math.floor(Math.random() * 4000) + 1000;
          console.log(`⏳ [${this.clientId}] Waiting ${groupDelay}ms before next group...`);
          await this.sleep(groupDelay);
        }
      } catch (error) {
        console.error(`❌ [${this.clientId}] Failed to forward to group ${groupId}:`, error.message);
        this.failedMessages++;

        if (i < this.config.whatsappGroups.length - 1) {
          const groupDelay = Math.floor(Math.random() * 4000) + 1000;
          await this.sleep(groupDelay);
        }
      }
    }
  }

  async forwardMediaMessage(groupId, messageInfo, captionText) {
    try {
      const fileLink = await this.telegramBot.getFileLink(messageInfo.fileId);
      const media = await MessageMedia.fromUrl(fileLink);

      if (messageInfo.fileName) {
        media.filename = messageInfo.fileName;
      }

      await this.whatsappClient.sendMessage(groupId, media, { caption: captionText });
    } catch (error) {
      console.error(`❌ [${this.clientId}] Error forwarding media:`, error.message);
      const randomVariation = this.messageVariations[Math.floor(Math.random() * this.messageVariations.length)];
      const fallbackText = captionText + `\n\n📎 *Media file (${messageInfo.type})* could not be forwarded.` + randomVariation;
      await this.whatsappClient.sendMessage(groupId, fallbackText);
    }
  }

  // Client control methods
  pause() {
    this.isActive = false;
    console.log(`⏸️ [${this.clientId}] Forwarding PAUSED`);
  }

  resume() {
    this.isActive = true;
    console.log(`▶️ [${this.clientId}] Forwarding RESUMED`);
    if (!this.isProcessingQueue && this.messageQueue.length > 0) {
      this.processMessageQueue();
    }
  }

  getStatus() {
    return {
      clientId: this.clientId,
      isActive: this.isActive,
      isWhatsAppReady: this.isWhatsAppReady,
      queueLength: this.messageQueue.length,
      totalMessages: this.totalMessages,
      failedMessages: this.failedMessages,
      whatsappGroups: this.config.whatsappGroups?.length || 0,
      telegramGroups: this.config.telegramGroups?.length || 0
    };
  }

  async destroy() {
    console.log(`🛑 [${this.clientId}] Shutting down...`);
    if (this.whatsappClient) {
      await this.whatsappClient.destroy();
    }
    if (this.telegramBot) {
      this.telegramBot.stopPolling();
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class MultiClientForwarder {
  constructor() {
    this.clients = new Map();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async loadConfigs() {
    try {
      const files = await fs.readdir('./configs');
      const configFiles = files.filter(file => file.endsWith('.json'));

      if (configFiles.length === 0) {
        console.log('❌ No config files found in ./configs/ directory');
        console.log('📝 Create config files like: client1.json, client2.json, etc.');
        process.exit(1);
      }

      for (const configFile of configFiles) {
        try {
          const configData = await fs.readFile(`./configs/${configFile}`, 'utf8');
          const config = JSON.parse(configData);
          const clientId = configFile.replace('.json', '');
          
          if (!config.telegramBotToken) {
            console.log(`⚠️ [${clientId}] Missing telegram bot token, skipping...`);
            continue;
          }

          console.log(`✅ Loaded config for client: ${clientId}`);
          const client = new SingleClientForwarder(clientId, config);
          this.clients.set(clientId, client);
        } catch (error) {
          console.error(`❌ Error loading ${configFile}:`, error.message);
        }
      }

      console.log(`\n🎯 Total clients loaded: ${this.clients.size}\n`);
    } catch (error) {
      console.error('❌ Error reading configs directory:', error.message);
      console.log('📁 Please create ./configs/ directory with client config files');
      process.exit(1);
    }
  }

  async startAllClients() {
    for (const [clientId, client] of this.clients) {
      try {
        await client.initializeWhatsApp();
        client.initializeTelegram();
      } catch (error) {
        console.error(`❌ [${clientId}] Failed to start:`, error.message);
      }
    }
  }

  // Control methods
  pauseClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.pause();
      return true;
    }
    return false;
  }

  resumeClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.resume();
      return true;
    }
    return false;
  }

  getAllStatus() {
    const statuses = [];
    for (const [clientId, client] of this.clients) {
      statuses.push(client.getStatus());
    }
    return statuses;
  }

  showStatus() {
    console.log('\n📊 CLIENT STATUS DASHBOARD');
    console.log('============================');
    
    const statuses = this.getAllStatus();
    statuses.forEach(status => {
      const activeIcon = status.isActive ? '✅' : '⏸️';
      const whatsappIcon = status.isWhatsAppReady ? '🟢' : '🔴';
      
      console.log(`${activeIcon} ${status.clientId} | WA:${whatsappIcon} | Queue:${status.queueLength} | Sent:${status.totalMessages} | Failed:${status.failedMessages}`);
    });
    console.log('============================\n');
  }

  startControlInterface() {
    console.log('\n🎮 CONTROL COMMANDS:');
    console.log('- status : Show all clients status');
    console.log('- pause [clientId] : Pause specific client');
    console.log('- resume [clientId] : Resume specific client');
    console.log('- list : List all clients');
    console.log('- quit : Exit application');
    console.log('========================\n');

    const handleCommand = (input) => {
      const [command, clientId] = input.trim().split(' ');

      switch (command.toLowerCase()) {
        case 'status':
          this.showStatus();
          break;

        case 'pause':
          if (clientId) {
            if (this.pauseClient(clientId)) {
              console.log(`✅ Client ${clientId} paused`);
            } else {
              console.log(`❌ Client ${clientId} not found`);
            }
          } else {
            console.log('❌ Please specify clientId: pause client1');
          }
          break;

        case 'resume':
          if (clientId) {
            if (this.resumeClient(clientId)) {
              console.log(`✅ Client ${clientId} resumed`);
            } else {
              console.log(`❌ Client ${clientId} not found`);
            }
          } else {
            console.log('❌ Please specify clientId: resume client1');
          }
          break;

        case 'list':
          console.log('📋 Available clients:');
          for (const clientId of this.clients.keys()) {
            console.log(`- ${clientId}`);
          }
          break;

        case 'quit':
          console.log('🛑 Shutting down all clients...');
          this.shutdown();
          return;

        default:
          console.log('❌ Unknown command. Type "status", "pause", "resume", "list", or "quit"');
      }

      this.rl.question('💬 Command: ', handleCommand);
    };

    this.rl.question('💬 Command: ', handleCommand);
  }

  async shutdown() {
    for (const [clientId, client] of this.clients) {
      await client.destroy();
    }
    this.rl.close();
    process.exit(0);
  }

  async start() {
    console.log('🤖 Starting Multi-Client Telegram to WhatsApp Forwarder...\n');

    try {
      await this.loadConfigs();
      await this.startAllClients();

      console.log('\n✅ All clients initialized!');
      console.log('📱 Scan QR codes above for each client');
      console.log('🔄 All forwarders are now running...\n');

      // Auto-show status every 30 seconds
      setInterval(() => {
        this.showStatus();
      }, 30000);

      this.startControlInterface();

      // Handle graceful shutdown
      process.on("SIGINT", async () => {
        await this.shutdown();
      });

    } catch (error) {
      console.error('❌ Failed to start application:', error.message);
      process.exit(1);
    }
  }
}

// Start the multi-client forwarder
const forwarder = new MultiClientForwarder();
forwarder.start().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
});
// Add this at the end of your index.js file
const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <h1>Telegram-WhatsApp Forwarder Bot</h1>
    <p>Status: Running</p>
    <p>Active Clients: ${activeClients.length}</p>
    <p>Uptime: ${process.uptime()} seconds</p>
  `);
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

// Multi-client management
const activeClients = [];
const configsDir = path.join(__dirname, 'configs');

async function loadAndStartAllClients() {
  try {
    // Check if configs directory exists
    if (!fs.existsSync(configsDir)) {
      console.error('❌ configs directory not found!');
      return;
    }

    // Read all JSON files from configs directory
    const configFiles = await fs.readdir(configsDir);
    const jsonFiles = configFiles.filter(file => file.endsWith('.json'));

    console.log(`📋 Found ${configFiles.length} config files`);

    // Start each client
    for (const configFile of configFiles) {
      const clientId = path.basename(configFile, '.json');
      const configPath = path.join(configsDir, configFile);
      
      try {
        const configData = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(configData);
        console.log(`🚀 Starting ${clientId}...`);
        
        const forwarder = new SingleClientForwarder(clientId, config);
        activeClients.push(forwarder);
        
        // Initialize with delay between clients to avoid conflicts
        setTimeout(async () => {
          try {
            await forwarder.initializeWhatsApp();
            forwarder.initializeTelegram();
            console.log(`✅ ${clientId} started successfully!`);
          } catch (error) {
            console.error(`❌ Error starting ${clientId}:`, error.message);
          }
        }, activeClients.length * 10000); // 10 second delay between each client

      } catch (error) {
        console.error(`❌ Error loading config ${configFile}:`, error.message);
      }
    }

    console.log(`🎉 All ${activeClients.length} clients queued for startup`);

  } catch (error) {
    console.error('❌ Error loading clients:', error.message);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  for (const client of activeClients) {
    try {
      if (client.whatsappClient) {
        await client.whatsappClient.destroy();
      }
      if (client.telegramBot) {
        client.telegramBot.stopPolling();
      }
    } catch (error) {
      console.error(`Error shutting down client:`, error.message);
    }
  }
  process.exit(0);
});

// Start all clients
loadAndStartAllClients();
