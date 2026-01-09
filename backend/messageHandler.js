const { parseTimeCommand, parseSendCommand, formatIsraelTime } = require('./timeParser');
const { saveScheduledMessage } = require('./database');
const { sendMessageToSelf, sendListToSelf, sendButtonsToSelf, getUserPhoneNumber } = require('./whatsappClient');

// Store the last forwarded message per chat to track context
const lastForwardedMessage = new Map();

// Store recent contacts list for easy selection
const recentContactsCache = new Map(); // Map of userId -> array of contacts

// Store pending /send command context for contact selection
const pendingSendContext = new Map(); // Map of chatId -> { matches, scheduledTime, message }

// Cache all incoming messages for a day to quickly find original senders when forwarding
// Structure: Map of message body -> array of { senderId, senderName, chatName, timestamp }
const incomingMessageCache = new Map();
const MESSAGE_CACHE_DURATION = 3 * 60 * 60 * 1000; // 3 hours in milliseconds

// Store incoming message in cache
function cacheIncomingMessage(messageBody, senderId, senderName, chatName, timestamp) {
  if (!messageBody || messageBody.trim().length === 0) {
    return; // Don't cache empty messages
  }

  const existing = incomingMessageCache.get(messageBody) || [];

  // Add new entry
  existing.push({
    senderId: senderId,
    senderName: senderName,
    chatName: chatName,
    timestamp: timestamp
  });

  incomingMessageCache.set(messageBody, existing);

}

// Search cache for matching messages
function searchCachedMessages(messageBody) {
  const matches = incomingMessageCache.get(messageBody);

  if (!matches || matches.length === 0) {
    return [];
  }

  // Filter by TTL - only return messages within the cache duration
  const now = Date.now();
  const cutoff = now - MESSAGE_CACHE_DURATION;
  const recentMatches = matches.filter(m => m.timestamp > cutoff);

  return recentMatches;
}

// Cleanup function to remove expired messages from cache
function cleanupMessageCache() {
  const now = Date.now();
  const cutoff = now - MESSAGE_CACHE_DURATION;

  let removedMessages = 0;
  let removedEntries = 0;

  for (const [messageBody, senders] of incomingMessageCache.entries()) {
    const recentSenders = senders.filter(s => s.timestamp > cutoff);
    const expiredCount = senders.length - recentSenders.length;

    if (recentSenders.length === 0) {
      // All senders are expired, remove the entire entry
      incomingMessageCache.delete(messageBody);
      removedEntries++;
      removedMessages += expiredCount;
    } else if (expiredCount > 0) {
      // Some senders expired, update the entry
      incomingMessageCache.set(messageBody, recentSenders);
      removedMessages += expiredCount;
    }
  }

}

// Run cleanup every hour
setInterval(cleanupMessageCache, 60 * 60 * 1000);

// Function to get and cache recent chats
async function getRecentContacts(client, userPhone) {
  const cacheKey = userPhone;

  // Check cache (valid for 5 minutes)
  const cached = recentContactsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
    return cached.contacts;
  }
  try {
    const chats = await client.getChats();

    // Filter to only include individual chats (not groups, not self)
    const individualChats = chats
      .filter(chat => !chat.isGroup && chat.id._serialized !== userPhone + '@c.us')
      .sort((a, b) => b.timestamp - a.timestamp) // Sort by most recent
      .slice(0, 20); // Get top 20

    const contacts = [];
    for (const chat of individualChats) {
      try {
        // Use chat properties directly, try getContact but don't fail if it doesn't work
        let contactName = chat.name || chat.id.user;

        try {
          const contact = await chat.getContact();
          contactName = contact.name || contact.pushname || contact.number || contactName;
        } catch (contactErr) {
          // If getContact fails, use what we have from the chat
        }

        contacts.push({
          id: chat.id._serialized,
          name: contactName,
          number: chat.id.user,
          timestamp: chat.timestamp
        });
      } catch (err) {
        // Ignore contact fetch errors
      }
    }

    recentContactsCache.set(cacheKey, {
      contacts,
      timestamp: Date.now()
    });

    return contacts;
  } catch (err) {
    console.error('Error getting contacts:', err.message);
    return [];
  }
}

const DEDICATED_GROUP_ID = process.env.DEDICATED_GROUP_ID || null;
const SERVER_START_TIME = Date.now();

// Track processed message IDs to prevent duplicates
const processedMessageIds = new Set();

// Helper function to get message body reliably
async function getMessageBody(message) {
  // Try different methods to get the body
  if (message.body) {
    return message.body;
  }
  
  // Try getBody() method if available
  if (typeof message.getBody === 'function') {
    try {
      const body = await message.getBody();
      if (body) return body;
    } catch (err) {
      // Ignore
    }
  }

  if (message._data && message._data.body) {
    return message._data.body;
  }

  if (message.rawData && message.rawData.body) {
    return message.rawData.body;
  }

  return null;
}

async function handleIncomingMessage(message) {
  // Get message ID for duplicate detection
  const messageId = message.id && message.id._serialized ? message.id._serialized : null;

  // Skip duplicates
  if (messageId && processedMessageIds.has(messageId)) {
    return;
  }

  // Skip old messages (from before server started)
  const messageTimestamp = message.timestamp ? message.timestamp * 1000 : null;
  if (messageTimestamp && messageTimestamp < SERVER_START_TIME) {
    return;
  }

  // Mark as processed
  if (messageId) {
    processedMessageIds.add(messageId);
  }

  try {
    // Filter out status updates and system messages
    if (message.from === 'status@broadcast' ||
        (message.from && typeof message.from === 'string' && message.from.includes('status'))) {
      return;
    }

    if (message.type === 'e2e_notification' ||
        message.type === 'gp2' ||
        message.type === 'notification' ||
        message.type === 'protocol' ||
        message.type === 'notification_template' ||
        (message.hasMedia && message.type === 'image' && message.from && message.from.includes('broadcast'))) {
      return;
    }

    // Get chat info
    const chat = await message.getChat();
    const chatId = chat.id._serialized;

    // Log chat ID for easy setup - helps user find their group ID
    if (chat.isGroup && !DEDICATED_GROUP_ID) {
      console.log('TIP: To use this group, set DEDICATED_GROUP_ID=' + chatId);
    }

    // Get message body using helper function
    const messageBody = await getMessageBody(message);

    if (!messageBody) {
      return;
    }

    // Get user phone number
    const userPhone = getUserPhoneNumber();

    // Check if it's the user's self-chat
    const isSelfChat = (!chat.isGroup && chatId.includes(userPhone)) ||
                       (chatId.includes('@g.us') && message.from === chatId);

    // Check if using dedicated group mode
    if (DEDICATED_GROUP_ID) {
      const normalizedGroupId = DEDICATED_GROUP_ID.includes('@g.us')
        ? DEDICATED_GROUP_ID
        : `${DEDICATED_GROUP_ID}@g.us`;

      if (chatId !== normalizedGroupId) {
        return;
      }

      const author = message.author || message.from;
      const isFromUser = author && author.includes(userPhone);

      if (!isFromUser) {
        return;
      }
    } else {
      const author = message.author || message.from;
      const isSelfChat = chatId.includes('@g.us') && message.from === chatId;
      const isFromUser = author && author.includes(userPhone);

      if (!isSelfChat && !isFromUser) {
        // Cache incoming messages for forwarded message detection
        if (messageBody && !message.isForwarded) {
          try {
            let senderName = chatId;
            let senderId = chatId;
            try {
              const contactChat = await message.getChat();
              const contact = await contactChat.getContact();
              senderName = contact.name || contact.pushname || contact.number || chatId;
              senderId = contactChat.id._serialized;
            } catch (err) {
              senderName = chat.name || chatId;
            }
            cacheIncomingMessage(messageBody, senderId, senderName, chat.name || chatId, Date.now());
          } catch (err) {
            // Ignore cache errors
          }
        }
        return;
      }
    }

    // Log command being processed
    if (messageBody.startsWith('/')) {
      console.log('Command:', messageBody.split(' ')[0]);
    }

    // Check if this is a forwarded message (only process forwarded messages in self-chat)
    if (message.isForwarded && isSelfChat) {

      // Search the message cache for who sent this message
      try {
        const cachedMatches = searchCachedMessages(messageBody);

        // Convert cache format to match format for consistency
        const matches = cachedMatches.map(cached => ({
          chatId: cached.senderId,
          contactName: cached.senderName,
          timestamp: cached.timestamp
        }));

        if (matches.length === 0) {
          lastForwardedMessage.set(chat.id._serialized, {
            timestamp: message.timestamp,
            from: message.from,
            forwardingScore: message.forwardingScore,
            message: message,
            searchedForOriginal: true,
            foundMatches: 0
          });
          await sendMessageToSelf('⚠️ Could not find who sent this message in your recent chats.\n\nTo schedule a reply:\n1. Send /list to see contacts\n2. Use /reply [number] in [time] message');
          return;
        } else if (matches.length === 1) {
          const match = matches[0];

          lastForwardedMessage.set(chat.id._serialized, {
            timestamp: message.timestamp,
            from: match.chatId,
            forwardingScore: message.forwardingScore,
            message: message,
            originalSender: match.contactName,
            searchedForOriginal: true,
            foundMatches: 1
          });

          await sendMessageToSelf(`✅ Found original sender: *${match.contactName}*\n\nNow send:\n/reply in [time] [message]\n\nExample: /reply in 2 hours hey there!`);
          return;
        } else {

          try {
            // Create list items from matches
            const rows = matches.map((match, index) => ({
              id: `sender_${index}`,
              title: match.contactName,
              description: `Sent at ${new Date(match.timestamp).toLocaleTimeString()}`
            }));

            const sections = [
              {
                title: 'Select Original Sender',
                rows: rows
              }
            ];

            // Store all matches for selection
            lastForwardedMessage.set(chat.id._serialized, {
              timestamp: message.timestamp,
              from: message.from,
              forwardingScore: message.forwardingScore,
              message: message,
              searchedForOriginal: true,
              foundMatches: matches.length,
              matchOptions: matches
            });

            await sendListToSelf(
              `📋 Found ${matches.length} people who sent this message.\n\nSelect who you want to reply to:`,
              'Choose Sender',
              sections
            );
            return;
          } catch (listError) {
            console.error('Failed to send list, falling back to numbered menu:', listError);
            // Fallback to old numbered menu
            let choiceMessage = `❓ Found ${matches.length} people who sent this message:\n\n`;
            matches.forEach((match, index) => {
              choiceMessage += `${index + 1}. ${match.contactName}\n`;
            });
            choiceMessage += `\nReply with the number of who you want to reply to, then use:\n/reply in [time] [message]`;

            lastForwardedMessage.set(chat.id._serialized, {
              timestamp: message.timestamp,
              from: message.from,
              forwardingScore: message.forwardingScore,
              message: message,
              searchedForOriginal: true,
              foundMatches: matches.length,
              matchOptions: matches
            });

            await sendMessageToSelf(choiceMessage);
            return;
          }
        }
      } catch (err) {
        console.error('Error searching for original sender:', err);
        // Fall back to old behavior
        lastForwardedMessage.set(chat.id._serialized, {
          timestamp: message.timestamp,
          from: message.from,
          forwardingScore: message.forwardingScore,
          message: message
        });
        return;
      }
    }

    // Check if user is responding with a number or list ID to select from multiple forwarded message matches
    const forwardedContext = lastForwardedMessage.get(chat.id._serialized);
    if (forwardedContext && forwardedContext.matchOptions) {
      let selection = -1;

      // Check if it's a list ID (sender_X)
      const listIdMatch = messageBody.trim().match(/^sender_(\d+)$/);
      if (listIdMatch) {
        selection = parseInt(listIdMatch[1]);
      } else if (/^\d+$/.test(messageBody.trim())) {
        selection = parseInt(messageBody.trim()) - 1;
      }

      if (selection >= 0 && selection < forwardedContext.matchOptions.length) {
        const selectedMatch = forwardedContext.matchOptions[selection];

        // Update the forwarded context with the selected sender
        lastForwardedMessage.set(chat.id._serialized, {
          timestamp: forwardedContext.timestamp,
          from: selectedMatch.chatId,
          forwardingScore: forwardedContext.forwardingScore,
          message: forwardedContext.message,
          originalSender: selectedMatch.contactName,
          searchedForOriginal: true,
          foundMatches: 1
        });

        await sendMessageToSelf(`✅ Selected: *${selectedMatch.contactName}*\n\nNow send:\n/reply in [time] [message]\n\nExample: /reply in 2 hours hey there!`);
        return;
      } else if (selection !== -1) {
        await sendMessageToSelf(`❌ Invalid selection: ${messageBody}\n\nPlease choose a number between 1 and ${forwardedContext.matchOptions.length}`);
        return;
      }
    }

    // Check if user is responding to a /send contact selection
    const sendContext = pendingSendContext.get(chat.id._serialized);
    if (sendContext) {
      let selection = -1;

      // Check if it's a list ID (contact_X)
      const listIdMatch = messageBody.trim().match(/^contact_(\d+)$/);
      if (listIdMatch) {
        selection = parseInt(listIdMatch[1]);
        console.log('User selected contact from list, index:', selection);
      }
      // Check if it's a plain number
      else if (/^\d+$/.test(messageBody.trim())) {
        selection = parseInt(messageBody.trim()) - 1;
        console.log('User selected contact by number, index:', selection);
      }

      if (selection >= 0 && selection < sendContext.matches.length) {
        const selectedContact = sendContext.matches[selection];
        console.log('✅ User selected:', selectedContact.name);

        // Clear the context
        pendingSendContext.delete(chat.id._serialized);

        // Schedule the message
        try {
          const messageId = await saveScheduledMessage(
            selectedContact.id,
            selectedContact.name,
            sendContext.message,
            sendContext.scheduledTime
          );

          await sendMessageToSelf(
            `✅ Message scheduled!\n\n` +
            `📧 To: *${selectedContact.name}*\n` +
            `💬 Message: "${sendContext.message}"\n` +
            `⏰ Time: ${formatIsraelTime(sendContext.scheduledTime)}\n` +
            `🆔 ID: ${messageId}`
          );

          console.log('✅ Message scheduled successfully via /send selection');
        } catch (err) {
          console.error('❌ Error scheduling message:', err);
          await sendMessageToSelf('❌ Error scheduling message. Please try again.');
        }
        return;
      } else if (selection !== -1) {
        await sendMessageToSelf(`❌ Invalid selection. Please choose a number between 1 and ${sendContext.matches.length}`);
        return;
      }
    }

    // Check if this is a /send command
    if (messageBody && messageBody.toLowerCase().startsWith('/send')) {
      try {
        console.log('Processing /send command:', messageBody);

        const parsed = parseSendCommand(messageBody);

      if (!parsed) {
        await sendMessageToSelf('❌ Could not parse /send command.\n\nFormat: `/send [name] in [time] [message]`\n\nExample: /send John in 2 hours Hey there!');
        return;
      }

      console.log('Parsed /send:', parsed);

      // Search for contacts matching the name
      console.log('Fetching contacts...');
      const allContacts = await getRecentContacts(message.client, userPhone);
      console.log('Got', allContacts.length, 'contacts');
      const searchTerm = parsed.recipientName.toLowerCase();

      // Find matching contacts (name or number contains the search term)
      const matches = allContacts.filter(contact =>
        contact.name.toLowerCase().includes(searchTerm) ||
        contact.number.includes(searchTerm)
      );

      console.log(`Found ${matches.length} contact(s) matching "${parsed.recipientName}"`);

      if (matches.length === 0) {
        await sendMessageToSelf(`❌ No contacts found matching "*${parsed.recipientName}*"\n\nSend /list to see all contacts.`);
        return;
      } else if (matches.length === 1) {
        // Exactly one match - schedule directly
        const contact = matches[0];
        console.log('✅ Found exact match:', contact.name);

        try {
          const messageId = await saveScheduledMessage(
            contact.id,
            contact.name,
            parsed.message,
            parsed.scheduledTime
          );

          await sendMessageToSelf(
            `✅ Message scheduled!\n\n` +
            `📧 To: *${contact.name}*\n` +
            `💬 Message: "${parsed.message}"\n` +
            `⏰ Time: ${formatIsraelTime(parsed.scheduledTime)}\n` +
            `🆔 ID: ${messageId}`
          );

          console.log('✅ Message scheduled successfully via /send');
        } catch (err) {
          console.error('❌ Error scheduling message:', err);
          await sendMessageToSelf('❌ Error scheduling message. Please try again.');
        }
        return;
      } else {
        // Multiple matches - ask user to choose using a list
        console.log('❓ Multiple matches found, asking user to choose');

        try {
          // Create list items from matches
          const rows = matches.map((contact, index) => ({
            id: `contact_${index}`,
            title: contact.name,
            description: contact.number
          }));

          const sections = [
            {
              title: 'Select Contact',
              rows: rows
            }
          ];

          // Store context for selection
          pendingSendContext.set(chat.id._serialized, {
            matches: matches,
            scheduledTime: parsed.scheduledTime,
            message: parsed.message
          });

          await sendListToSelf(
            `📋 Found ${matches.length} contacts matching "*${parsed.recipientName}*"\n\nSelect the contact to send to:`,
            'Choose Contact',
            sections
          );
          return;
        } catch (listError) {
          console.error('Failed to send list, falling back to numbered menu:', listError);
          // Fallback to old numbered menu
          let choiceMessage = `❓ Found ${matches.length} contacts matching "*${parsed.recipientName}*":\n\n`;
          matches.forEach((contact, index) => {
            choiceMessage += `${index + 1}. ${contact.name}\n`;
          });
          choiceMessage += `\nReply with the number to schedule the message.`;

          pendingSendContext.set(chat.id._serialized, {
            matches: matches,
            scheduledTime: parsed.scheduledTime,
            message: parsed.message
          });

          await sendMessageToSelf(choiceMessage);
          return;
        }
      }
      } catch (err) {
        console.error('Error in /send command:', err.message);
        await sendMessageToSelf(`❌ Error processing /send command: ${err.message}`);
      }
      return;
    }

    // Check if this is a /up command (health check)
    if (messageBody && messageBody.toLowerCase().trim() === '/up') {
      try {
        const { getPendingCount } = require('./database');
        const pendingCount = await getPendingCount();
        await sendMessageToSelf(`✅ *Bot is running*\n\nPending messages: ${pendingCount}\nCache entries: ${incomingMessageCache.size}`);
      } catch (err) {
        await sendMessageToSelf(`⚠️ *Bot is running but DB error*\n\n${err.message}`);
      }
      return;
    }

    // Check if this is a /list command
    if (messageBody && messageBody.toLowerCase().trim() === '/list') {
      try {
        const contacts = await getRecentContacts(message.client, userPhone);

        if (contacts.length === 0) {
          await sendMessageToSelf('❌ No recent contacts found.');
          return;
        }

        let listMessage = '📋 *Recent Contacts*\n\n';
        contacts.forEach((contact, index) => {
          listMessage += `*${index + 1}.* ${contact.name}\n`;
          listMessage += `   📞 ${contact.number}\n\n`;
        });
        listMessage += `💡 *How to use:*\n`;
        listMessage += `• /reply [number] in [time] [message]\n`;
        listMessage += `• /send [name] in [time] [message]\n\n`;
        listMessage += `📝 Example: /reply 1 in 2 hours hey there!`;

        await sendMessageToSelf(listMessage);
      } catch (err) {
        console.error('Error in /list:', err.message);
      }
      return;
    }

    // Check if this is a /show command
    if (messageBody && messageBody.toLowerCase().trim() === '/show') {
      try {
        const { getAllPendingMessages } = require('./database');
        const messages = await getAllPendingMessages();

        if (messages.length === 0) {
          await sendMessageToSelf('📭 *No scheduled messages*\n\nYou have no pending messages to send.');
          return;
        }

        let showMessage = `📬 *Scheduled Messages* (${messages.length})\n\n`;
        messages.forEach((msg, index) => {
          const scheduledDate = new Date(msg.scheduled_time);
          const formattedTime = formatIsraelTime(scheduledDate);

          showMessage += `━━━━━━━━━━━━━━━━━━━━\n`;
          showMessage += `*ID: ${msg.id}*\n\n`;
          showMessage += `👤 *To:* ${msg.recipient_name || msg.recipient}\n`;
          showMessage += `💬 *Message:*\n"${msg.message.substring(0, 100)}${msg.message.length > 100 ? '...' : ''}"\n\n`;
          showMessage += `⏰ *Scheduled:* ${formattedTime}\n`;
          showMessage += `\n`;
        });

        showMessage += `━━━━━━━━━━━━━━━━━━━━\n\n`;
        showMessage += `💡 *To cancel:* /cancel [id]\n`;
        showMessage += `📝 *Example:* /cancel ${messages[0].id}`;

        await sendMessageToSelf(showMessage);
        return;
      } catch (err) {
        console.error('Error in /show:', err.message);
        await sendMessageToSelf('❌ Error fetching scheduled messages. Please try again.');
        return;
      }
    }

    // Check if this is a /cancel command
    if (messageBody && messageBody.toLowerCase().startsWith('/cancel')) {
      const cancelMatch = messageBody.match(/^\/cancel\s+(\d+)$/i);
      if (!cancelMatch) {
        await sendMessageToSelf('❌ Invalid format.\n\nUsage: `/cancel [id]`\n\nExample: /cancel 5\n\nUse /show to see message IDs.');
        return;
      }

      const messageId = parseInt(cancelMatch[1]);

      try {
        const { updateMessageStatus } = require('./database');
        await updateMessageStatus(messageId, 'cancelled', 'Cancelled by user');

        await sendMessageToSelf(`✅ *Message ${messageId} cancelled*\n\nUse /show to see remaining messages.`);
        return;
      } catch (err) {
        console.error('Error in /cancel:', err.message);
        await sendMessageToSelf(`❌ Error cancelling message ${messageId}. Please try again.`);
        return;
      }
    }

    // Check if this is a /reply command
    if (!messageBody || !messageBody.toLowerCase().startsWith('/reply')) {
      return;
    }

    // Parse the time and message
    const parsed = parseTimeCommand(messageBody);

    if (!parsed) {
      console.log('❌ ERROR: Could not parse the time or message');
      console.log('Command received:', messageBody);
      return;
    }

    // RECIPIENT DETECTION WORKFLOW (multiple methods):
    // Method 1: Recipient specified in command (/reply to [name/number] ...)
    // Method 2: Reply/quote to a message
    // Method 3: Use last forwarded message
    let recipientId = null;
    let quotedMessageId = null;

    // METHOD 1: Check if recipient was specified in the command
    if (parsed.recipient) {
      console.log('✅ Recipient specified in command:', parsed.recipient);

      // Check if it's a contact index (1-2 digits)
      if (/^\d{1,2}$/.test(parsed.recipient)) {
        const contactIndex = parseInt(parsed.recipient) - 1; // Convert to 0-based index
        console.log('📇 Looking up contact at index:', contactIndex);

        // Get recent contacts
        const contacts = await getRecentContacts(message.client, userPhone);

        if (contactIndex >= 0 && contactIndex < contacts.length) {
          const contact = contacts[contactIndex];
          recipientId = contact.id;
          console.log('✅ Found contact from index:', contact.name, '-', recipientId);
        } else {
          console.log('❌ ERROR: Invalid contact index:', parsed.recipient);
          console.log(`   Valid range: 1-${contacts.length}`);
          await sendMessageToSelf(`❌ Invalid contact number: ${parsed.recipient}\n\nValid range: 1-${contacts.length}\n\nSend /list to see your contacts.`);
          return;
        }
      }
      // Check if it's a phone number (3+ digits or starts with +)
      else if (/^[\d+]{3,}$/.test(parsed.recipient) || parsed.recipient.startsWith('+')) {
        // It's a phone number - format it properly
        let phoneNumber = parsed.recipient.replace(/\+/g, ''); // Remove + sign
        recipientId = `${phoneNumber}@c.us`;
        console.log('📱 Formatted as phone number:', recipientId);
      } else {
        // It's a name - try to find the contact
        console.log('👤 Searching for contact by name:', parsed.recipient);
        try {
          const contacts = await message.client.getContacts();
          const contact = contacts.find(c =>
            (c.name && c.name.toLowerCase().includes(parsed.recipient.toLowerCase())) ||
            (c.pushname && c.pushname.toLowerCase().includes(parsed.recipient.toLowerCase()))
          );

          if (contact) {
            recipientId = contact.id._serialized;
            console.log('✅ Found contact:', contact.name || contact.pushname, '-', recipientId);
          } else {
            console.log('❌ ERROR: Could not find contact with name:', parsed.recipient);
            console.log('💡 Try using the phone number instead');
            console.log('   Example: /reply to 972501234567 in 1 minute test');
            return;
          }
        } catch (err) {
          console.log('❌ ERROR searching contacts:', err.message);
          return;
        }
      }
    }

    // METHOD 2: Check quoted message (only if recipient not already determined)
    if (!recipientId && message.hasQuotedMsg) {
      console.log('✅ Message has a quoted message - analyzing...');
      try {
        const quotedMsg = await message.getQuotedMessage();
      console.log('📋 Quoted message details:');
      console.log('   From:', quotedMsg.from);
      console.log('   Author:', quotedMsg.author);
      console.log('   FromMe:', quotedMsg.fromMe);
      console.log('   IsForwarded:', quotedMsg.isForwarded);
      console.log('   Type:', quotedMsg.type);

      // Store the quoted message ID for replying later
      if (quotedMsg.id && quotedMsg.id._serialized) {
        quotedMessageId = quotedMsg.id._serialized;
        console.log('   Message ID:', quotedMessageId);
      }

      // Try multiple methods to extract the recipient

      // Method 1: Check if quoted message has a different 'from' (received from someone)
      if (!quotedMsg.fromMe && quotedMsg.from && quotedMsg.from !== userPhone + '@c.us') {
        recipientId = quotedMsg.from;
        console.log('✅ Method 1: Recipient from quoted message "from" field:', recipientId);
      }
      // Method 2: Check author field (for group messages or forwarded messages)
      else if (quotedMsg.author && quotedMsg.author !== userPhone + '@c.us') {
        recipientId = quotedMsg.author;
        console.log('✅ Method 2: Recipient from quoted message "author" field:', recipientId);
      }
      // Method 3: Check _data for any original sender info
      else if (quotedMsg._data) {
        console.log('🔍 Checking _data for recipient info...');
        console.log('   _data.from:', quotedMsg._data.from);
        console.log('   _data.author:', quotedMsg._data.author);
        console.log('   _data.participant:', quotedMsg._data.participant);

        // Try participant field (sometimes used for the actual sender)
        if (quotedMsg._data.participant && quotedMsg._data.participant !== userPhone + '@c.us') {
          recipientId = quotedMsg._data.participant;
          console.log('✅ Method 3: Recipient from _data.participant:', recipientId);
        }
      }

      // Method 4: Try to get contact info from the message
      if (!recipientId && quotedMsg.getContact) {
        try {
          const contact = await quotedMsg.getContact();
          if (contact && contact.id && contact.id._serialized !== userPhone + '@c.us') {
            recipientId = contact.id._serialized;
            console.log('✅ Method 4: Recipient from contact:', recipientId);
          }
        } catch (err) {
          console.log('⚠️  Could not get contact from quoted message');
        }
      }

      // If no recipient found from quoted message, we'll try forwarded context below
      if (!recipientId) {
        console.log('⚠️  Could not extract recipient from quoted message');
        console.log('   Will try forwarded message context next...');
      }
    } catch (err) {
        console.log('⚠️  Error getting quoted message:', err.message);
        console.log('   Will try forwarded message context next...');
      }
    }

    // METHOD 3: Try forwarded message context (only if recipient not already determined)
    if (!recipientId) {
      console.log('ℹ️  Recipient not found yet, checking forwarded message context');
      const forwardedContext = lastForwardedMessage.get(chat.id._serialized);

      if (forwardedContext) {
        console.log('✅ Found forwarded message context');
        console.log('   From:', forwardedContext.from);
        console.log('   Timestamp:', new Date(forwardedContext.timestamp * 1000).toISOString());

        // Extract recipient from forwarded message
        recipientId = forwardedContext.from;
        console.log('📧 Recipient extracted from forwarded message context:', recipientId);
      }
    }

    // Final check: if still no recipient, show contacts list
    if (!recipientId) {
      console.log('❌ No recipient specified - showing contacts list');

      // Get recent contacts
      const contacts = await getRecentContacts(message.client, userPhone);

      if (contacts.length === 0) {
        await sendMessageToSelf('❌ No recent contacts found.\n\nTry using:\n/reply to [phone number] in 1 hour message');
        return;
      }

      // Build contacts list message
      let listMessage = '📋 *Recent Contacts*\n\n';
      listMessage += 'Send `/reply [number] in [time] [message]`\n\n';
      contacts.forEach((contact, index) => {
        listMessage += `${index + 1}. ${contact.name}\n`;
      });
      listMessage += `\n💡 Example: /reply 1 in 2 hours hey there!`;

      await sendMessageToSelf(listMessage);
      console.log('📤 Sent contacts list to user');
      return;
    }

    // Try to get contact name, fallback to just using the ID
    let recipientName = recipientId;
    try {
      const recipientContact = await message.client.getContactById(recipientId);
      recipientName = recipientContact.name || recipientContact.pushname || recipientContact.number || recipientId;
    } catch (err) {
      console.log('Could not fetch contact details, using ID:', recipientId);
      // Extract phone number from ID if possible (format: number@c.us)
      const phonePart = recipientId.split('@')[0];
      recipientName = phonePart || recipientId;
    }

    console.log('Recipient:', recipientName, recipientId);
    console.log('Scheduled time:', parsed.scheduledTime);
    console.log('Message:', parsed.message);

    // Check if scheduled time is in the future
    const now = new Date();
    if (parsed.scheduledTime <= now) {
      console.log('❌ ERROR: Scheduled time is in the past');
      console.log('Scheduled time:', parsed.scheduledTime);
      console.log('Current time:', now);
      return;
    }

    // Save to database
    try {
      const messageId = await saveScheduledMessage(
        recipientId,
        recipientName,
        parsed.message,
        parsed.scheduledTime.toISOString()
      );

      // Send ONE confirmation message
      const formattedTime = formatIsraelTime(parsed.scheduledTime);
      const confirmation = `✅ Scheduled reply to *${recipientName}*\n\n` +
        `📅 Time: ${formattedTime}\n` +
        `💬 Message: "${parsed.message}"\n\n` +
        `ID: ${messageId}`;

      await sendMessageToSelf(confirmation);

      console.log('✅ SUCCESS: Scheduled message created and confirmation sent');
      console.log('Recipient:', recipientName);
      console.log('Time:', formattedTime);
      console.log('Message:', parsed.message);
      console.log('Message ID:', messageId);

      // Clear the forwarded message context
      lastForwardedMessage.delete(chat.id._serialized);
    } catch (error) {
      console.error('❌ ERROR: Failed to save scheduled message:', error);
    }

  } catch (error) {
    console.error('❌ ERROR: Failed to handle message:', error);
    console.error('Stack trace:', error.stack);
  }
}

module.exports = {
  handleIncomingMessage
};
