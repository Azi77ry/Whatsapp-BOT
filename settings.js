require('dotenv').config();
const crypto = require('crypto');

// Generate dynamic one-time random token if ADMIN_PASSWORD is not provided in .env
const dynamicFallbackPass = crypto.randomBytes(8).toString('hex');

const settings = {
  packname: process.env.BOT_NAME || 'Knight Bot',
  author: process.env.BOT_OWNER || 'Azirytech',
  botName: process.env.BOT_NAME || 'Knight Bot',
  botOwner: process.env.BOT_OWNER || 'Azirytech',
  ownerNumber: (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, ''),
  giphyApiKey: process.env.GIPHY_API_KEY || '',
  commandMode: process.env.COMMAND_MODE || 'public',
  maxStoreMessages: parseInt(process.env.MAX_STORE_MESSAGES || '20', 10),
  storeWriteInterval: parseInt(process.env.STORE_WRITE_INTERVAL || '10000', 10),
  description: 'Enterprise WhatsApp Multi-Session Bot Platform by Azirytech',
  version: '3.0.7',
  port: parseInt(process.env.PORT || '3000', 10),
  adminUsername: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || dynamicFallbackPass,
  maxSessions: parseInt(process.env.MAX_SESSIONS || '100', 10),
  supportEmail: process.env.SUPPORT_EMAIL || 'support@azirytech.com',
  supportWhatsApp: (process.env.SUPPORT_WA || '').replace(/[^0-9]/g, ''),
  supportTelegram: process.env.SUPPORT_TG || 'https://t.me/azirytech',
  supportChannel: process.env.SUPPORT_CHANNEL || 'https://whatsapp.com/channel/0029Va90zAnIHphOuO8Msp3A',
  updateZipUrl: 'https://github.com/mruniquehacker/Knightbot-MD/archive/refs/heads/main.zip',
};

module.exports = settings;
