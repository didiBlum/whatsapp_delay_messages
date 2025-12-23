// API base URL - use environment variable or default to localhost
const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.origin;

let isConnected = false;
let refreshInterval = null;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  console.log('App initialized');
  checkConnection();
  checkQRCode(); // Always check for QR code on load
  loadMessages();
  loadStats();

  // Set up refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    loadMessages();
    loadStats();
  });

  // Set up disconnect button (will be shown when connected)
  const disconnectBtn = document.getElementById('disconnect-btn');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', handleDisconnect);
  }

  // Auto-refresh every 30 seconds
  refreshInterval = setInterval(() => {
    checkConnection();
    loadMessages();
    loadStats();
  }, 30000);
});

// Check WhatsApp connection status
async function checkConnection() {
  try {
    const response = await fetch(`${API_URL}/api/status`);
    const data = await response.json();

    isConnected = data.connected;
    updateConnectionUI(data.connected);

    if (!data.connected) {
      checkQRCode();
    }
  } catch (error) {
    console.error('Error checking connection:', error);
    updateConnectionUI(false);
  }
}

// Update connection UI
function updateConnectionUI(connected) {
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const qrLoading = document.getElementById('qr-loading');
  const qrCode = document.getElementById('qr-code');
  const qrConnected = document.getElementById('qr-connected');

  if (connected) {
    statusIndicator.className = 'status connected';
    statusText.textContent = 'Connected';
    qrLoading.style.display = 'none';
    qrCode.style.display = 'none';
    qrConnected.style.display = 'block';
  } else {
    statusIndicator.className = 'status disconnected';
    statusText.textContent = 'Disconnected';
    qrConnected.style.display = 'none';
  }
}

// Check for QR code
async function checkQRCode() {
  try {
    const response = await fetch(`${API_URL}/api/qr`);
    const data = await response.json();

    const qrLoading = document.getElementById('qr-loading');
    const qrCode = document.getElementById('qr-code');
    const qrImage = document.getElementById('qr-image');

    if (data.connected) {
      qrLoading.style.display = 'none';
      qrCode.style.display = 'none';
    } else if (data.qr) {
      // Convert QR text to image using QR code API
      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.qr)}`;
      qrImage.src = qrImageUrl;
      qrLoading.style.display = 'none';
      qrCode.style.display = 'block';
    } else {
      qrLoading.style.display = 'block';
      qrCode.style.display = 'none';
    }
  } catch (error) {
    console.error('Error checking QR code:', error);
  }
}

// Handle disconnect button click
async function handleDisconnect() {
  const disconnectBtn = document.getElementById('disconnect-btn');
  if (!disconnectBtn) return;

  // Disable button and show loading state
  disconnectBtn.disabled = true;
  disconnectBtn.textContent = 'Disconnecting...';

  try {
    const response = await fetch(`${API_URL}/api/disconnect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Check if response is OK and is JSON
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Server error: ${response.status} - ${text.substring(0, 100)}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
    }

    const data = await response.json();

    if (data.success) {
      // Update UI to show loading state
      updateConnectionUI(false);
      const qrLoading = document.getElementById('qr-loading');
      const qrCode = document.getElementById('qr-code');
      const qrConnected = document.getElementById('qr-connected');
      
      qrConnected.style.display = 'none';
      qrLoading.style.display = 'block';
      qrLoading.textContent = 'Disconnecting... Generating new QR code...';

      // Poll for new QR code
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds max
      const pollInterval = setInterval(async () => {
        attempts++;
        try {
          const qrResponse = await fetch(`${API_URL}/api/qr`);
          const qrData = await qrResponse.json();
          
          if (qrData.qr) {
            clearInterval(pollInterval);
            checkQRCode();
          } else if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            qrLoading.textContent = 'Failed to generate QR code. Please refresh the page.';
          }
        } catch (error) {
          console.error('Error polling for QR code:', error);
          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
          }
        }
      }, 1000);
    } else {
      alert('Failed to disconnect: ' + (data.message || data.error || 'Unknown error'));
      disconnectBtn.disabled = false;
      disconnectBtn.textContent = '🔌 Disconnect & Generate New QR';
    }
  } catch (error) {
    console.error('Error disconnecting:', error);
    console.error('API_URL:', API_URL);
    console.error('Full error:', error);
    alert('Error disconnecting: ' + error.message + '\n\nPlease check the browser console for more details.');
    disconnectBtn.disabled = false;
    disconnectBtn.textContent = '🔌 Disconnect & Generate New QR';
  }
}

// Load statistics
async function loadStats() {
  try {
    const response = await fetch(`${API_URL}/api/stats`);
    const data = await response.json();

    document.getElementById('stat-total').textContent = data.total || 0;
    document.getElementById('stat-pending').textContent = data.pending || 0;
    document.getElementById('stat-sent').textContent = data.sent || 0;
    document.getElementById('stat-failed').textContent = data.failed || 0;
  } catch (error) {
    console.error('Error loading stats:', error);
  }
}

// Load scheduled messages
async function loadMessages() {
  const messagesContainer = document.getElementById('messages-container');
  const messagesLoading = document.getElementById('messages-loading');
  const messagesTable = document.getElementById('messages-table');
  const messagesEmpty = document.getElementById('messages-empty');

  messagesLoading.style.display = 'block';
  messagesTable.style.display = 'none';
  messagesEmpty.style.display = 'none';

  try {
    const response = await fetch(`${API_URL}/api/messages`);
    const data = await response.json();

    messagesLoading.style.display = 'none';

    if (!data.messages || data.messages.length === 0) {
      messagesEmpty.style.display = 'block';
      return;
    }

    // Build table
    const tableHTML = `
      <div class="messages-table">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Recipient</th>
              <th>Message</th>
              <th>Scheduled Time</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${data.messages.map(msg => `
              <tr>
                <td>${msg.id}</td>
                <td><strong>${escapeHtml(msg.recipient_name || msg.recipient)}</strong></td>
                <td>${escapeHtml(truncate(msg.message, 50))}</td>
                <td>${formatDate(msg.scheduled_time)}</td>
                <td><span class="status-badge status-${msg.status}">${msg.status}</span></td>
                <td>${formatDate(msg.created_at)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    messagesTable.innerHTML = tableHTML;
    messagesTable.style.display = 'block';
  } catch (error) {
    console.error('Error loading messages:', error);
    messagesLoading.style.display = 'none';
    messagesEmpty.style.display = 'block';
  }
}

// Utility functions
function formatDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function truncate(str, maxLength) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
