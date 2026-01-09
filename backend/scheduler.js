const cron = require('node-cron');
const { getPendingMessages, updateMessageStatus } = require('./database');
const { sendMessage, sendMessageToSelf, isClientReady } = require('./whatsappClient');

let isProcessing = false;

async function sendScheduledMessages() {
  if (isProcessing || !isClientReady()) {
    return;
  }

  isProcessing = true;

  try {
    const messages = await getPendingMessages();

    if (messages.length === 0) {
      isProcessing = false;
      return;
    }

    console.log(`Sending ${messages.length} scheduled message(s)`);

    for (const msg of messages) {
      try {
        await sendMessage(msg.recipient, msg.message);
        await updateMessageStatus(msg.id, 'sent');

        console.log(`Sent message ${msg.id} to ${msg.recipient_name || msg.recipient}`);

        try {
          await sendMessageToSelf(
            `✅ Scheduled message sent to *${msg.recipient_name || msg.recipient}*\n\n` +
            `💬 "${msg.message}"`
          );
        } catch (confirmError) {
          // Ignore confirmation errors
        }

      } catch (error) {
        console.error(`Failed to send message ${msg.id}:`, error.message);
        await updateMessageStatus(msg.id, 'failed', error.message);

        try {
          await sendMessageToSelf(
            `❌ Failed to send scheduled message\n\n` +
            `To: ${msg.recipient_name || msg.recipient}\n` +
            `Error: ${error.message}`
          );
        } catch (notifyError) {
          // Ignore notification errors
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

  } catch (error) {
    console.error('Scheduler error:', error.message);
  } finally {
    isProcessing = false;
  }
}

function startScheduler() {
  console.log('Scheduler started');

  cron.schedule('* * * * *', () => {
    sendScheduledMessages();
  });

  setTimeout(() => {
    sendScheduledMessages();
  }, 5000);
}

module.exports = {
  startScheduler,
  sendScheduledMessages
};
