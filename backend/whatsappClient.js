const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let userPhoneNumber = null;

// Event handlers storage
const eventHandlers = {
  onMessage: null,
  onReady: null,
  onQR: null,
  onDisconnected: null
};

// Function to clear session data
function clearSession() {
  const sessionPath = path.join(__dirname, 'whatsapp-session');
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
  
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './whatsapp-session'
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu'
      ]
    }
  });
  console.log('Client created, setting up event handlers...');

  // Loading screen event (shows progress)
  client.on('loading_screen', (percent, message) => {
    console.log(`📱 Loading: ${percent}% - ${message}`);
  });

  // Authenticated event
  client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated');
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
    isReady = true;
    isInitializing = false;
    qrCodeData = null;

    // Get user's phone number
    const info = client.info;
    if (info && info.wid) {
      userPhoneNumber = info.wid.user;
      console.log('User phone number:', userPhoneNumber);
    }
    
    console.log('');
    console.log('💡 To rename this device in WhatsApp:');
    console.log('   1. Open WhatsApp on your phone');
    console.log('   2. Go to Settings > Linked Devices');
    console.log('   3. Tap on this device');
    console.log('   4. Tap "Rename" and enter a custom name (e.g., "My Server")');
    console.log('');

    if (eventHandlers.onReady) {
      eventHandlers.onReady();
    }
  });

  // Message event - DISABLED to avoid duplicate processing with message_create
  // We only use message_create which fires specifically for NEW messages
  /*
  client.on('message', async (message) => {
    const eventTime = Date.now();
    const messageTime = message.timestamp ? new Date(message.timestamp * 1000) : null;
    const timeSinceMessage = messageTime ? Math.floor((eventTime - message.timestamp * 1000) / 1000) : 'unknown';
    
    console.log('\n🔔🔔🔔 MESSAGE EVENT FIRED IN CLIENT 🔔🔔🔔');
    console.log('Event received at:', new Date(eventTime).toISOString());
    console.log('Message ID:', message.id ? message.id._serialized : 'no ID');
    console.log('Message from:', message.from);
    console.log('Message author:', message.author);
    console.log('Message type:', message.type);
    // Log common message types for reference:
    // chat, image, video, audio, document, sticker, location, vcard, ptt (voice),
    // notification_template, notification, protocol, gp2, e2e_notification
    console.log('Message timestamp:', messageTime ? messageTime.toISOString() : 'no timestamp');
    console.log('Time since message:', timeSinceMessage, typeof timeSinceMessage === 'number' ? 'seconds' : '');
    console.log('Message body (direct):', message.body ? message.body.substring(0, 50) : 'no body');
    
    // Log if this looks like a new message (received within last 10 seconds)
    if (typeof timeSinceMessage === 'number' && timeSinceMessage < 10) {
      const messageBody = message.body || message._data?.body || 'no body';
      const sender = message.from || message.author || 'unknown';
      console.log('🆕 This looks like a NEW message (received', timeSinceMessage, 'seconds ago)');
      console.log('   Type:', message.type);
      console.log('   Sender:', sender);
      console.log('   Body:', messageBody.substring(0, 100) + (messageBody.length > 100 ? '...' : ''));
      
      // Highlight if it's a chat message
      if (message.type === 'chat' || message.type === 'image' || message.type === 'video' || 
          message.type === 'audio' || message.type === 'document') {
        console.log('   ✅✅✅ THIS IS A CHAT MESSAGE - SHOULD BE PROCESSED! ✅✅✅');
      }
    } else if (typeof timeSinceMessage === 'number' && timeSinceMessage >= 10) {
      console.log('📜 This looks like an OLD message (received', timeSinceMessage, 'seconds ago)');
      console.log('   Type:', message.type);
      if (message.type === 'chat' || message.type === 'image' || message.type === 'video') {
        console.log('   ⚠️  This is a CHAT message but it\'s old - will be filtered out');
      }
    }
    
    if (eventHandlers.onMessage) {
      console.log('✅ Message handler registered, calling it...');
      try {
        await eventHandlers.onMessage(message);
        console.log('✅ Message handler completed');
      } catch (error) {
        console.error('❌ Error in message handler:', error);
        console.error('Stack:', error.stack);
      }
    } else {
      console.log('⚠️  No message handler registered - messages will not be processed!');
    }
  });
  */

  // Message Create event - specifically for NEW messages only
  client.on('message_create', async (message) => {
    console.log('\n📩📩📩 MESSAGE_CREATE EVENT FIRED 📩📩📩');
    console.log('This event ONLY fires for brand new messages, not old ones');
    console.log('Message from:', message.from);
    console.log('Message type:', message.type);
    console.log('Message body:', message.body ? message.body.substring(0, 100) : 'no body');
    console.log('Is fromMe:', message.fromMe);

    // Also call the message handler for message_create events
    if (eventHandlers.onMessage) {
      console.log('✅ Calling message handler for message_create event...');
      try {
        await eventHandlers.onMessage(message);
        console.log('✅ Message handler completed for message_create');
      } catch (error) {
        console.error('❌ Error in message handler (message_create):', error);
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

  try {
    const chatId = `${userPhoneNumber}@c.us`;
    await client.sendMessage(chatId, message);
    console.log('Message sent to self');
    return true;
  } catch (error) {
    console.error('Error sending message to self:', error);
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
  getUserPhoneNumber,
  onMessage,
  onReady,
  onQR,
  onDisconnected,
  disconnect
};
