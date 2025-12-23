require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDatabase, getAllScheduledMessages, getPendingCount } = require('./database');
const {
  initializeClient,
  getQRCode,
  isClientReady,
  onMessage,
  onReady,
  onQR,
  onDisconnected,
  disconnect
} = require('./whatsappClient');
const { handleIncomingMessage } = require('./messageHandler');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Store QR code for API access
let currentQRCode = null;
let connectionStatus = 'disconnected';

// Initialize database
initDatabase();

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsappStatus: connectionStatus
  });
});

// Get QR code for connection
app.get('/api/qr', (req, res) => {
  if (isClientReady()) {
    return res.json({
      connected: true,
      message: 'WhatsApp is already connected'
    });
  }

  if (currentQRCode) {
    return res.json({
      connected: false,
      qr: currentQRCode
    });
  }

  res.json({
    connected: false,
    qr: null,
    message: 'Initializing WhatsApp client...'
  });
});

// Get connection status
app.get('/api/status', (req, res) => {
  res.json({
    connected: isClientReady(),
    status: connectionStatus,
    timestamp: new Date().toISOString()
  });
});

// Disconnect and generate new QR code
app.post('/api/disconnect', async (req, res) => {
  console.log('Disconnect endpoint called');
  try {
    await disconnect();
    currentQRCode = null;
    connectionStatus = 'disconnected';
    console.log('Disconnect successful, sending response');
    res.json({
      success: true,
      message: 'Disconnected. New QR code will be generated shortly.'
    });
  } catch (error) {
    console.error('Error disconnecting:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect',
      message: error.message
    });
  }
});

// Get all scheduled messages
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await getAllScheduledMessages();
    const pendingCount = await getPendingCount();

    res.json({
      messages,
      pendingCount,
      total: messages.length
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({
      error: 'Failed to fetch messages',
      message: error.message
    });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const messages = await getAllScheduledMessages();
    const pendingCount = await getPendingCount();
    const sentCount = messages.filter(m => m.status === 'sent').length;
    const failedCount = messages.filter(m => m.status === 'failed').length;

    res.json({
      total: messages.length,
      pending: pendingCount,
      sent: sentCount,
      failed: failedCount,
      connected: isClientReady()
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch stats',
      message: error.message
    });
  }
});

// Serve static files for frontend
const path = require('path');
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// Catch-all middleware - handle API routes and frontend
app.use((req, res, next) => {
  // Return JSON for API routes that don't exist
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'API endpoint not found',
      path: req.path
    });
  }
  // For non-API routes, serve index.html (SPA fallback)
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Initialize WhatsApp client
console.log('Initializing WhatsApp client...');

onQR((qr) => {
  currentQRCode = qr;
  connectionStatus = 'qr_ready';
  console.log('QR Code ready for scanning');
});

onReady(() => {
  currentQRCode = null;
  connectionStatus = 'connected';
  console.log('WhatsApp connected and ready!');

  // Start the scheduler
  startScheduler();
});

onDisconnected((reason) => {
  currentQRCode = null;
  connectionStatus = 'disconnected';
  console.log('WhatsApp disconnected:', reason);
  // Client will be reinitialized automatically
});

onMessage((message) => {
  handleIncomingMessage(message);
});

initializeClient();

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
