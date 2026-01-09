const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let userPhoneNumber = null;
let healthCheckInterval = null;

// Event handlers storage
const eventHandlers = {
  onMessage: null,
  onReady: null,
  onQR: null,
  onDisconnected: null
};

// Session path - use SESSION_PATH env var if set (for Railway volumes), otherwise use local path
// For Railway: Set SESSION_PATH=/data/whatsapp-session in environment variables
const sessionPath = process.env.SESSION_PATH || path.join(__dirname, 'whatsapp-session');
console.log('📁 Session path configured:', sessionPath);
console.log('📁 SESSION_PATH env var:', process.env.SESSION_PATH || 'not set (using default)');

// Function to clear session data
function clearSession() {
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log('Session cleared');
      return true;
    }
  } catch (error) {
    console.error('Error clearing session:', error);
    return false;
  }
  return false;
}

function initializeClient() {
  if (client || isInitializing) {
    console.log('Client already initialized or initializing');
    return client;
  }

  isInitializing = true;
  isReady = false; // Reset ready state
  qrCodeData = null; // Reset QR code

  console.log('Creating WhatsApp client with Puppeteer...');
  console.log('Session path:', sessionPath);

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: sessionPath
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--mute-audio',
        '--hide-scrollbars',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--window-size=1920,1080'
      ]
    }
  });
  console.log('Client created, setting up event handlers...');

  // Loading screen event (shows progress)
  client.on('loading_screen', (percent, message) => {
    console.log(`📱 Loading: ${percent}% - ${message}`);
  });

  // Authenticated event - fires after QR code is scanned
  client.on('authenticated', () => {
    console.log('✅✅✅ WhatsApp authenticated - QR code scanned successfully!');
    console.log('💾 Session will be saved to:', sessionPath);
    
    // Verify session directory exists
    try {
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log('✅ Created session directory');
      }
      console.log('✅ Session directory exists and is accessible');
    } catch (err) {
      console.error('❌ ERROR: Cannot access session directory:', err.message);
      console.error('   This will prevent session from being saved!');
    }
  });

  // QR code event
  client.on('qr', (qr) => {
    console.log('📷 QR Code received');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
    if (eventHandlers.onQR) {
      eventHandlers.onQR(qr);
    }
  });

  // Ready event
  client.on('ready', async () => {
    console.log('WhatsApp client is ready!');
    console.log('💾 Session saved to:', sessionPath);
    isReady = true;
    isInitializing = false;
    qrCodeData = null;

    // Get user's phone number
    const info = client.info;
    if (info && info.wid) {
      userPhoneNumber = info.wid.user;
      console.log('User phone number:', userPhoneNumber);
    }
    
    // Verify session directory exists and is writable
    try {
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log('✅ Created session directory:', sessionPath);
      }
      // Test write permissions
      const testFile = path.join(sessionPath, '.test-write');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      console.log('✅ Session directory is writable');
    } catch (err) {
      console.error('❌ Session directory error:', err.message);
      console.error('   Path:', sessionPath);
    }
    
    // Start health check
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
    }
    healthCheckInterval = setInterval(async () => {
      try {
        const state = await client.getState();
        if (state !== 'CONNECTED') {
          console.log('Health check: Client state is', state, '- may have connection issues');
        }
      } catch (err) {
        console.error('Health check failed:', err.message);
        console.log('Client may be disconnected, attempting to get state failed');
      }
    }, 60000); // Check every minute

    if (eventHandlers.onReady) {
      eventHandlers.onReady();
    }
  });

  // Message event - backup listener (handler has duplicate detection)
  client.on('message', async (message) => {
    console.log('MSG event:', message.from, message.body?.substring(0, 30) || '[no body]');
    if (eventHandlers.onMessage) {
      try {
        await eventHandlers.onMessage(message);
      } catch (error) {
        console.error('Error in message handler:', error.message);
      }
    }
  });

  // Message Create event - primary listener for new messages
  client.on('message_create', async (message) => {
    console.log('MSG_CREATE event:', message.from, message.body?.substring(0, 30) || '[no body]');
    if (eventHandlers.onMessage) {
      try {
        await eventHandlers.onMessage(message);
      } catch (error) {
        console.error('Error in message_create handler:', error.message);
      }
    }
  });

  // Disconnected event
  client.on('disconnected', (reason) => {
    console.log('WhatsApp client disconnected:', reason);
    isReady = false;
    isInitializing = false;
    qrCodeData = null;
    
    // Clear the client reference
    const oldClient = client;
    client = null;
    
    // Clean up the old client
    if (oldClient) {
      try {
        oldClient.removeAllListeners();
      } catch (err) {
        console.error('Error cleaning up client:', err);
      }
    }

    if (eventHandlers.onDisconnected) {
      eventHandlers.onDisconnected(reason);
    }
  });

  // Change state event (shows connection progress)
  client.on('change_state', (state) => {
    console.log(`🔄 State changed to: ${state}`);
    
    // Log important state transitions
    if (state === 'CONNECTING') {
      console.log('📡 Connecting to WhatsApp...');
    } else if (state === 'OPENING') {
      console.log('🔓 Opening WhatsApp Web...');
    } else if (state === 'PAIRING') {
      console.log('🔗 Pairing with phone...');
    } else if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
      console.log('⚠️  Unpaired - QR code will be generated');
    }
  });

  // Auth failure
  client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
    isReady = false;
    isInitializing = false;
    qrCodeData = null;
    
    // Clear session and client
    const oldClient = client;
    client = null;
    
    if (oldClient) {
      try {
        oldClient.removeAllListeners();
      } catch (err) {
        console.error('Error cleaning up client:', err);
      }
    }
    
    // Clear the session data
    clearSession();
    
    // Reinitialize after a short delay
    setTimeout(() => {
      console.log('Reinitializing client after auth failure...');
      initializeClient();
    }, 2000);
  });

  console.log('WhatsApp client initializing...');
  
  // Add error handler before initialize
  client.on('error', (error) => {
    console.error('❌ Client error:', error);
    isInitializing = false;
  });

  // Set a timeout to detect if initialization is hanging
  const initTimeout = setTimeout(() => {
    if (!isReady && !qrCodeData) {
      console.warn('⚠️  Initialization seems to be taking too long...');
      console.warn('⚠️  This might indicate a browser startup issue.');
      console.warn('⚠️  Try clearing the session directory if this persists.');
    }
  }, 30000); // 30 seconds

  // Clear timeout when we get a QR code or ready event
  const originalOnQR = eventHandlers.onQR;
  eventHandlers.onQR = (qr) => {
    clearTimeout(initTimeout);
    if (originalOnQR) originalOnQR(qr);
  };
  
  const originalOnReady = eventHandlers.onReady;
  eventHandlers.onReady = () => {
    clearTimeout(initTimeout);
    if (originalOnReady) originalOnReady();
  };

  try {
    console.log('Calling client.initialize()...');
    client.initialize();
    console.log('Client.initialize() called successfully - waiting for events...');
    console.log('💡 If this hangs, the browser might be having trouble starting.');
    console.log('💡 Try: rm -rf whatsapp-session && restart server');
  } catch (error) {
    clearTimeout(initTimeout);
    console.error('❌ Error calling client.initialize():', error);
    console.error('Error stack:', error.stack);
    isInitializing = false;
    throw error;
  }

  return client;
}

function getClient() {
  return client;
}

function getQRCode() {
  return qrCodeData;
}

function isClientReady() {
  return isReady;
}

function getUserPhoneNumber() {
  return userPhoneNumber;
}

async function sendMessage(chatId, message) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready');
  }

  try {
    await client.sendMessage(chatId, message);
    console.log(`Message sent to ${chatId}`);
    return true;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}

async function sendMessageToSelf(message) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready');
  }

  if (!userPhoneNumber) {
    throw new Error('User phone number not set - client may not be fully initialized');
  }

  try {
    const chatId = `${userPhoneNumber}@c.us`;
    console.log('Sending message to self:', chatId);
    await client.sendMessage(chatId, message);
    console.log('Message sent to self successfully');
    return true;
  } catch (error) {
    console.error('Error sending message to self:', error);
    throw error;
  }
}

// Send a list message (dropdown style) to self
async function sendListToSelf(body, buttonText, sections) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready');
  }

  try {
    const { MessageMedia, Buttons, List } = require('whatsapp-web.js');
    const chatId = `${userPhoneNumber}@c.us`;

    const list = new List(body, buttonText, sections, body);
    await client.sendMessage(chatId, list);
    console.log('List message sent to self');
    return true;
  } catch (error) {
    console.error('Error sending list to self:', error);
    // Fallback to regular message if lists not supported
    throw error;
  }
}

// Send a message with buttons to self
async function sendButtonsToSelf(body, buttons) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready');
  }

  try {
    const { Buttons } = require('whatsapp-web.js');
    const chatId = `${userPhoneNumber}@c.us`;

    const buttonMessage = new Buttons(body, buttons, body);
    await client.sendMessage(chatId, buttonMessage);
    console.log('Button message sent to self');
    return true;
  } catch (error) {
    console.error('Error sending buttons to self:', error);
    throw error;
  }
}

function onMessage(handler) {
  eventHandlers.onMessage = handler;
}

function onReady(handler) {
  eventHandlers.onReady = handler;
}

function onQR(handler) {
  eventHandlers.onQR = handler;
}

function onDisconnected(handler) {
  eventHandlers.onDisconnected = handler;
}

// Function to disconnect and clear session
async function disconnect() {
  console.log('Disconnecting WhatsApp client...');
  
  // Reset state
  isReady = false;
  qrCodeData = null;
  
  // Clean up client if it exists
  if (client) {
    try {
      // Try to logout first if method exists
      if (typeof client.logout === 'function') {
        await client.logout();
      }
    } catch (error) {
      console.error('Error logging out client:', error);
    }
    
    // Remove all event listeners and clear reference
    try {
      client.removeAllListeners();
    } catch (error) {
      console.error('Error removing listeners:', error);
    }
    
    client = null;
  }
  
  // Clear session
  clearSession();
  
  // Reset initialization flag
  isInitializing = false;
  
  // Reinitialize after a short delay
  setTimeout(() => {
    console.log('Reinitializing client after disconnect...');
    initializeClient();
  }, 1000);
  
  return true;
}

module.exports = {
  initializeClient,
  getClient,
  getQRCode,
  isClientReady,
  sendMessage,
  sendMessageToSelf,
  sendListToSelf,
  sendButtonsToSelf,
  getUserPhoneNumber,
  onMessage,
  onReady,
  onQR,
  onDisconnected,
  disconnect
};
