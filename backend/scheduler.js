const cron = require('node-cron');
const { getPendingMessages, updateMessageStatus } = require('./database');
const { sendMessage, sendMessageToSelf, isClientReady } = require('./whatsappClient');

let isProcessing = false;

async function sendScheduledMessages() {
  if (isProcessing) {
    console.log('Already processing messages, skipping...');
    return;
  }

  if (!isClientReady()) {
    console.log('WhatsApp client not ready, skipping...');
    return;
  }

  isProcessing = true;

  try {
    const messages = await getPendingMessages();

    if (messages.length === 0) {
      console.log('No pending messages to send');
      isProcessing = false;
      return;
    }

    console.log(`Found ${messages.length} pending message(s) to send`);

    for (const msg of messages) {
      try {
        console.log(`Sending message ${msg.id} to ${msg.recipient_name || msg.recipient}`);

        // Send the message
        await sendMessage(msg.recipient, msg.message);

        // Update status to sent
        await updateMessageStatus(msg.id, 'sent');

        console.log(`✅ Message ${msg.id} sent successfully`);

        // Send confirmation to user
        try {
          await sendMessageToSelf(
            `✅ Scheduled message sent to *${msg.recipient_name || msg.recipient}*\n\n` +
            `💬 Message: "${msg.message}"\n` +
            `ID: ${msg.id}`
          );
        } catch (confirmError) {
          console.error('Failed to send confirmation:', confirmError);
        }

      } catch (error) {
        console.error(`❌ Error sending message ${msg.id}:`, error);

        // Update status to failed with error message
        const errorMessage = error.message || 'Unknown error';
        await updateMessageStatus(msg.id, 'failed', errorMessage);

        // Notify user about the failure
        try {
          await sendMessageToSelf(
            `❌ Failed to send scheduled message\n\n` +
            `Recipient: ${msg.recipient_name || msg.recipient}\n` +
            `Message: "${msg.message}"\n` +
            `Error: ${errorMessage}\n` +
            `ID: ${msg.id}\n\n` +
            `The message status has been marked as failed.`
          );
        } catch (notifyError) {
          console.error('Failed to send failure notification:', notifyError);
        }
      }

      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

  } catch (error) {
    console.error('Error in sendScheduledMessages:', error);
  } finally {
    isProcessing = false;
  }
}

function startScheduler() {
  console.log('Starting scheduler - checking every minute for pending messages');

  // Run every minute
  cron.schedule('* * * * *', () => {
    console.log('Scheduler tick:', new Date().toISOString());
    sendScheduledMessages();
  });

  // Also run immediately on start (after 5 seconds)
  setTimeout(() => {
    console.log('Running initial scheduler check');
    sendScheduledMessages();
  }, 5000);
}

module.exports = {
  startScheduler,
  sendScheduledMessages
};
