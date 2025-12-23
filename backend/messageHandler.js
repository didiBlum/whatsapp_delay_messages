const { parseTimeCommand, parseSendCommand, formatIsraelTime } = require('./timeParser');
const { saveScheduledMessage } = require('./database');
const { sendMessageToSelf, getUserPhoneNumber } = require('./whatsappClient');

// Store the last forwarded message per chat to track context
const lastForwardedMessage = new Map();

// Store recent contacts list for easy selection
const recentContactsCache = new Map(); // Map of userId -> array of contacts

// Store pending /send command context for contact selection
const pendingSendContext = new Map(); // Map of chatId -> { matches, scheduledTime, message }

// Cache all incoming messages for a day to quickly find original senders when forwarding
// Structure: Map of message body -> array of { senderId, senderName, chatName, timestamp }
const incomingMessageCache = new Map();
const MESSAGE_CACHE_DURATION = 24 * 60 * 60 * 1000; // 1 day in milliseconds (TTL not yet implemented)

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

  console.log(`💾 Cached message from ${senderName} (${senderId})`);
  console.log(`   Cache now has ${incomingMessageCache.size} unique message texts`);
}

// Search cache for matching messages
function searchCachedMessages(messageBody) {
  const matches = incomingMessageCache.get(messageBody);

  if (!matches || matches.length === 0) {
    return [];
  }

  // TODO: Filter by TTL when implemented
  // const now = Date.now();
  // const cutoff = now - MESSAGE_CACHE_DURATION;
  // const recent = matches.filter(m => m.timestamp > cutoff);

  console.log(`🔍 Found ${matches.length} cached sender(s) for this message`);
  return matches;
}

// Cleanup function for TTL (not yet active)
// function cleanupMessageCache() {
//   const now = Date.now();
//   const cutoff = now - MESSAGE_CACHE_DURATION;
//
//   for (const [messageBody, senders] of incomingMessageCache.entries()) {
//     const recentSenders = senders.filter(s => s.timestamp > cutoff);
//
//     if (recentSenders.length === 0) {
//       incomingMessageCache.delete(messageBody);
//     } else {
//       incomingMessageCache.set(messageBody, recentSenders);
//     }
//   }
// }

// Function to get and cache recent chats
async function getRecentContacts(client, userPhone) {
  const cacheKey = userPhone;

  // Check cache (valid for 5 minutes)
  const cached = recentContactsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
    console.log('📋 Using cached contact list');
    return cached.contacts;
  }

  console.log('📋 Fetching recent chats...');
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
        console.log('Could not get contact for chat:', chat.id._serialized);
      }
    }

    // Cache the results
    recentContactsCache.set(cacheKey, {
      contacts,
      timestamp: Date.now()
    });

    console.log(`📋 Found ${contacts.length} recent contacts`);
    return contacts;
  } catch (err) {
    console.error('Error getting recent chats:', err);
    return [];
  }
}

// Get dedicated group ID from environment variable (optional)
// If set, only messages from this group will be processed
// Format: "120363026329878728@g.us" or just the group ID
const DEDICATED_GROUP_ID = process.env.DEDICATED_GROUP_ID || null;

// Track when the server started - only process messages after this time
const SERVER_START_TIME = Date.now();
console.log('Server start time recorded:', new Date(SERVER_START_TIME).toISOString());

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
      console.log('getBody() failed:', err.message);
    }
  }
  
  // Try _data.body
  if (message._data && message._data.body) {
    return message._data.body;
  }
  
  // Try rawData
  if (message.rawData && message.rawData.body) {
    return message.rawData.body;
  }
  
  // Log what we have for debugging
  console.log('Message object keys:', Object.keys(message));
  console.log('Message type:', message.type);
  console.log('Message hasBody:', message.hasBody);
  
  return null;
}

async function handleIncomingMessage(message) {
  const handlerStartTime = Date.now();
  console.log('\n========================================');
  console.log('📨 INCOMING MESSAGE EVENT TRIGGERED');
  console.log('========================================');
  console.log('Handler started at:', new Date(handlerStartTime).toISOString());
  
  // Get message ID for duplicate detection
  const messageId = message.id && message.id._serialized ? message.id._serialized : null;

  // Check if we've already processed this exact message
  if (messageId && processedMessageIds.has(messageId)) {
    console.log('⏭️  Skipping DUPLICATE message (ID already processed)');
    console.log('   Message ID:', messageId);
    return;
  }

  // Check if this is an old message (from before the server started)
  const messageTimestamp = message.timestamp ? message.timestamp * 1000 : null;

  if (messageTimestamp) {
    const messageDate = new Date(messageTimestamp);
    const serverStartDate = new Date(SERVER_START_TIME);
    const now = Date.now();
    const ageSeconds = Math.floor((now - messageTimestamp) / 1000);

    // Check if message is older than server start time
    if (messageTimestamp < SERVER_START_TIME) {
      const ageMinutes = Math.floor(ageSeconds / 60);
      console.log('⏭️  Skipping OLD message (from before server started)');
      console.log('   Message time:', messageDate.toISOString());
      console.log('   Server started:', serverStartDate.toISOString());
      console.log('   Age:', ageMinutes > 0 ? `${ageMinutes} minutes` : `${ageSeconds} seconds`);
      return;
    }

    console.log('✅ NEW message detected');
    console.log('   Message time:', messageDate.toISOString());
    console.log('   Server started:', serverStartDate.toISOString());
    console.log('   Current time:', new Date(now).toISOString());
    console.log('   Message is', Math.floor((messageTimestamp - SERVER_START_TIME) / 1000), 'seconds after server start');
    console.log('   Message is', Math.floor((now - messageTimestamp) / 1000), 'seconds old');
  } else {
    console.log('⚠️  Message with no timestamp - processing anyway (might be new, might be old)');
    console.log('   This could be a system message or message from before timestamp tracking');
  }

  // Mark this message as processed
  if (messageId) {
    processedMessageIds.add(messageId);
    console.log('✅ Message ID added to processed set:', messageId);
  }
  console.log('Raw message.from:', message.from);
  console.log('Raw message.type:', message.type);
  console.log('Raw message.hasMedia:', message.hasMedia);
  console.log('Raw message.author:', message.author);
  console.log('Raw message.timestamp:', messageTimestamp ? new Date(messageTimestamp).toISOString() : 'no timestamp');
  
  try {
    // Filter out status updates early - check before getting chat
    // Status updates can come from 'status@broadcast' or have specific types
    if (message.from === 'status@broadcast' || 
        (message.from && typeof message.from === 'string' && message.from.includes('status'))) {
      console.log('⏭️  Skipping: Status update (from:', message.from, ')');
      return;
    }
    
    if (message.type === 'e2e_notification' ||
        (message.hasMedia && message.type === 'image' && message.from && message.from.includes('broadcast'))) {
      console.log('⏭️  Skipping: Broadcast/notification message');
      return;
    }
    
    // Filter out group notifications, protocol messages, and template messages
    // Common message types in WhatsApp Web.js:
    // - 'chat' - regular text message
    // - 'image', 'video', 'audio', 'document', 'sticker' - media messages
    // - 'location', 'vcard', 'ptt' (voice note) - special types
    // - 'notification_template' - system notification templates
    // - 'notification' - system notifications
    // - 'protocol' - protocol messages
    // - 'gp2' - group protocol messages
    // - 'e2e_notification' - end-to-end encryption notifications
    if (message.type === 'gp2' || 
        message.type === 'notification' || 
        message.type === 'protocol' ||
        message.type === 'notification_template' ||
        message.type === 'e2e_notification') {
      console.log('⏭️  Skipping: System message (type:', message.type, ')');
      console.log('   Common system types: notification_template, notification, protocol, gp2, e2e_notification');
      return;
    }
    
    // Log all message types we see for debugging
    console.log('📋 Message type:', message.type);
    if (message.type === 'chat' || message.type === 'image' || message.type === 'video' || 
        message.type === 'audio' || message.type === 'document' || message.type === 'sticker') {
      console.log('   ✅ This is a CHAT message type - should be processed!');
    } else {
      console.log('   ⚠️  Unusual message type - might still be processable');
    }
    console.log('   Common chat types: chat, image, video, audio, document, sticker, location, vcard, ptt');
    
    console.log('✅ Message passed initial filters, processing...');
    
    // Now get chat info for actual messages
    console.log('Getting chat info...');
    const chat = await message.getChat();
    const chatId = chat.id._serialized;
    
    console.log('Chat retrieved:');
    console.log('  From:', message.from);
    console.log('  Message type:', message.type);
    console.log('  Has media:', message.hasMedia);
    console.log('  Is forwarded:', message.isForwarded);
    console.log('  Chat type:', chat.isGroup ? 'Group' : 'Individual');
    console.log('  Chat ID:', chatId);
    
    // Log chat ID for easy setup - this helps user find their group ID
    if (chat.isGroup && !DEDICATED_GROUP_ID) {
      console.log('💡 TIP: To use this group, set DEDICATED_GROUP_ID=' + chatId + ' in your .env file');
    }
    
    // Print the entire message object (safely, avoiding circular references)
    console.log('=== FULL MESSAGE OBJECT ===');
    try {
      // Use JSON.stringify with replacer to avoid circular references
      const messageStr = JSON.stringify(message, (key, value) => {
        // Skip functions and circular references
        if (typeof value === 'function') {
          return '[Function]';
        }
        if (typeof value === 'object' && value !== null) {
          // Limit depth to avoid too much output
          if (key === 'client' || key === '_client') {
            return '[Client Object]';
          }
          if (key === 'chat' || key === '_chat') {
            return '[Chat Object]';
          }
        }
        return value;
      }, 2);
      console.log(messageStr);
    } catch (err) {
      console.log('Could not stringify message object:', err.message);
      // Fallback: print key properties
      console.log('Message keys:', Object.keys(message));
      for (const key of Object.keys(message)) {
        if (typeof message[key] !== 'function' && key !== 'client' && key !== '_client') {
          try {
            console.log(`  ${key}:`, typeof message[key] === 'object' ? '[Object]' : message[key]);
          } catch (e) {
            console.log(`  ${key}: [Could not access]`);
          }
        }
      }
    }
    console.log('=== END MESSAGE OBJECT ===');
    
    // Get message body using helper function
    const messageBody = await getMessageBody(message);
    console.log('Body:', messageBody);

    if (!messageBody) {
      console.log('⚠️  No message body found - might be media or system message');
      console.log('Message keys:', Object.keys(message));
      console.log('⚠️  Returning early - cannot process message without body');
      return;
    }

    // Get user phone number
    const userPhone = getUserPhoneNumber();
    console.log('User phone:', userPhone);
    console.log('Dedicated group ID configured:', DEDICATED_GROUP_ID || 'None (using self-chat mode)');

    // Check if using dedicated group mode
    if (DEDICATED_GROUP_ID) {
      // Normalize the group ID (remove @g.us if already present, then add it)
      const normalizedGroupId = DEDICATED_GROUP_ID.includes('@g.us') 
        ? DEDICATED_GROUP_ID 
        : `${DEDICATED_GROUP_ID}@g.us`;
      
      // Only process messages from the dedicated group
      if (chatId !== normalizedGroupId) {
        console.log('⏭️  Skipping: Not from dedicated group');
        console.log('   Expected:', normalizedGroupId);
        console.log('   Got:', chatId);
        return;
      }
      
      // In a group, check if message is from the user
      const author = message.author || message.from;
      const isFromUser = author && author.includes(userPhone);
      
      console.log('Message author:', author);
      console.log('Is from user in group?', isFromUser);
      
      if (!isFromUser) {
        console.log('❌ Ignoring: Not from user in dedicated group');
        console.log('   Author:', author);
        console.log('   User phone:', userPhone);
        return;
      }
      
      console.log('✅ Message from user in dedicated group');
    } else {
      // Original logic: check self-chat or individual messages from user
      const author = message.author || message.from;

      // Check if it's the user's self-chat (120363026329878728@g.us format or similar)
      // OR if the author is the user's phone number
      const isSelfChat = chatId.includes('@g.us') && message.from === chatId;
      const isFromUser = author && author.includes(userPhone);

      console.log('Message author:', author);
      console.log('Is self-chat?', isSelfChat);
      console.log('Is from user?', isFromUser);

      if (!isSelfChat && !isFromUser) {
        console.log('📥 Message from someone else - caching for forwarded message detection');

        // Cache this incoming message so we can find it later when the user forwards it
        if (messageBody && !message.isForwarded) {
          try {
            // Get sender name
            let senderName = chatId;
            let senderId = chatId;

            try {
              const contactChat = await message.getChat();
              const contact = await contactChat.getContact();
              senderName = contact.name || contact.pushname || contact.number || chatId;
              senderId = contactChat.id._serialized;
            } catch (err) {
              // If getting contact fails, use chat info
              senderName = chat.name || chatId;
            }

            // Cache the message
            cacheIncomingMessage(messageBody, senderId, senderName, chat.name || chatId, Date.now());
          } catch (err) {
            console.log('⚠️  Failed to cache message:', err.message);
          }
        }

        console.log('❌ Ignoring: Not from user and not self-chat');
        return; // Ignore messages from other people (but we cached it first!)
      }

      console.log('✅ Message from user');
    }

    console.log('✅ Processing message from user:', messageBody);

    // Check if this is a forwarded message
    if (message.isForwarded) {
      console.log('📨 Forwarded message detected, searching cache for original sender...');
      console.log('   Message text:', messageBody.substring(0, 100));

      // Search the message cache for who sent this message
      try {
        const cachedMatches = searchCachedMessages(messageBody);

        // Convert cache format to match format for consistency
        const matches = cachedMatches.map(cached => ({
          chatId: cached.senderId,
          contactName: cached.senderName,
          timestamp: cached.timestamp
        }));

        console.log(`🔍 Found ${matches.length} potential sender(s) in cache`);

        if (matches.length === 0) {
          console.log('⚠️  Could not find original sender in recent messages');
          console.log('   Storing forwarded message for fallback');
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
          // Exactly one match - use it automatically!
          const match = matches[0];
          console.log('✅ Found original sender:', match.contactName);

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
          // Multiple matches - ask user to choose
          console.log('❓ Multiple potential senders found, asking user to choose');

          let choiceMessage = `❓ Found ${matches.length} people who sent this message:\n\n`;
          matches.forEach((match, index) => {
            choiceMessage += `${index + 1}. ${match.contactName}\n`;
          });
          choiceMessage += `\nReply with the number of who you want to reply to, then use:\n/reply in [time] [message]`;

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

          await sendMessageToSelf(choiceMessage);
          return;
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
        console.log('Stored forwarded message context from:', message.from);
        return;
      }
    }

    // Check if user is responding with a number to select from multiple forwarded message matches
    const forwardedContext = lastForwardedMessage.get(chat.id._serialized);
    if (forwardedContext && forwardedContext.matchOptions && /^\d+$/.test(messageBody.trim())) {
      const selection = parseInt(messageBody.trim()) - 1;
      console.log('User selecting from multiple matches, index:', selection);

      if (selection >= 0 && selection < forwardedContext.matchOptions.length) {
        const selectedMatch = forwardedContext.matchOptions[selection];
        console.log('✅ User selected:', selectedMatch.contactName);

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
      } else {
        await sendMessageToSelf(`❌ Invalid selection: ${messageBody}\n\nPlease choose a number between 1 and ${forwardedContext.matchOptions.length}`);
        return;
      }
    }

    // Check if user is responding to a /send contact selection
    const sendContext = pendingSendContext.get(chat.id._serialized);
    if (sendContext && /^\d+$/.test(messageBody.trim())) {
      const selection = parseInt(messageBody.trim()) - 1;
      console.log('User selecting contact for /send command, index:', selection);

      if (selection >= 0 && selection < sendContext.matches.length) {
        const selectedContact = sendContext.matches[selection];
        console.log('✅ User selected:', selectedContact.name);

        // Clear the context
        pendingSendContext.delete(chat.id._serialized);

        // Schedule the message
        try {
          await saveScheduledMessage(
            selectedContact.id,
            selectedContact.name,
            sendContext.message,
            sendContext.scheduledTime
          );

          await sendMessageToSelf(
            `✅ Message scheduled!\n\n` +
            `📧 To: *${selectedContact.name}*\n` +
            `💬 Message: "${sendContext.message}"\n` +
            `⏰ Time: ${formatIsraelTime(sendContext.scheduledTime)}`
          );

          console.log('✅ Message scheduled successfully via /send selection');
        } catch (err) {
          console.error('❌ Error scheduling message:', err);
          await sendMessageToSelf('❌ Error scheduling message. Please try again.');
        }
        return;
      } else {
        await sendMessageToSelf(`❌ Invalid selection. Please choose a number between 1 and ${sendContext.matches.length}`);
        return;
      }
    }

    // Check if this is a /send command
    if (messageBody && messageBody.toLowerCase().startsWith('/send')) {
      console.log('Processing /send command:', messageBody);

      const parsed = parseSendCommand(messageBody);

      if (!parsed) {
        await sendMessageToSelf('❌ Could not parse /send command.\n\nFormat: `/send [name] in [time] [message]`\n\nExample: /send John in 2 hours Hey there!');
        return;
      }

      console.log('Parsed /send:', parsed);

      // Search for contacts matching the name
      const allContacts = await getRecentContacts(message.client, userPhone);
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
          await saveScheduledMessage(
            contact.id,
            contact.name,
            parsed.message,
            parsed.scheduledTime
          );

          await sendMessageToSelf(
            `✅ Message scheduled!\n\n` +
            `📧 To: *${contact.name}*\n` +
            `💬 Message: "${parsed.message}"\n` +
            `⏰ Time: ${formatIsraelTime(parsed.scheduledTime)}`
          );

          console.log('✅ Message scheduled successfully via /send');
        } catch (err) {
          console.error('❌ Error scheduling message:', err);
          await sendMessageToSelf('❌ Error scheduling message. Please try again.');
        }
        return;
      } else {
        // Multiple matches - ask user to choose
        console.log('❓ Multiple matches found, asking user to choose');

        let choiceMessage = `❓ Found ${matches.length} contacts matching "*${parsed.recipientName}*":\n\n`;
        matches.forEach((contact, index) => {
          choiceMessage += `${index + 1}. ${contact.name}\n`;
        });
        choiceMessage += `\nReply with the number to schedule the message.`;

        // Store context for selection
        pendingSendContext.set(chat.id._serialized, {
          matches: matches,
          scheduledTime: parsed.scheduledTime,
          message: parsed.message
        });

        await sendMessageToSelf(choiceMessage);
        return;
      }
    }

    // Check if this is a /list command
    if (messageBody && messageBody.toLowerCase().trim() === '/list') {
      console.log('Processing /list command');

      // Get recent contacts
      const contacts = await getRecentContacts(message.client, userPhone);

      if (contacts.length === 0) {
        await sendMessageToSelf('❌ No recent contacts found.');
        return;
      }

      // Build contacts list message
      let listMessage = '📋 *Recent Contacts*\n\n';
      listMessage += 'To schedule a reply, use:\n';
      listMessage += '`/reply [number] in [time] [message]`\n\n';
      contacts.forEach((contact, index) => {
        listMessage += `${index + 1}. ${contact.name}\n`;
      });
      listMessage += `\n💡 Example: /reply 1 in 2 hours hey there!`;

      await sendMessageToSelf(listMessage);
      console.log('📤 Sent contacts list to user');
      return;
    }

    // Check if this is a /show command
    if (messageBody && messageBody.toLowerCase().trim() === '/show') {
      console.log('Processing /show command');

      try {
        const { getPendingMessages } = require('./database');
        const messages = await getPendingMessages();

        if (messages.length === 0) {
          await sendMessageToSelf('📭 *No scheduled messages*\n\nYou have no pending messages to send.');
          return;
        }

        let showMessage = `📬 *Scheduled Messages* (${messages.length})\n\n`;
        messages.forEach((msg, index) => {
          const scheduledDate = new Date(msg.scheduled_time);
          const formattedTime = formatIsraelTime(scheduledDate);

          showMessage += `*${index + 1}. ID: ${msg.id}*\n`;
          showMessage += `📧 To: ${msg.recipient_name || msg.recipient}\n`;
          showMessage += `💬 Message: "${msg.message.substring(0, 50)}${msg.message.length > 50 ? '...' : ''}"\n`;
          showMessage += `⏰ Time: ${formattedTime}\n`;
          showMessage += `\n`;
        });

        showMessage += `\n💡 To cancel: /cancel [id]`;

        await sendMessageToSelf(showMessage);
        console.log('📤 Sent scheduled messages list to user');
        return;
      } catch (err) {
        console.error('❌ Error fetching scheduled messages:', err);
        await sendMessageToSelf('❌ Error fetching scheduled messages. Please try again.');
        return;
      }
    }

    // Check if this is a /cancel command
    if (messageBody && messageBody.toLowerCase().startsWith('/cancel')) {
      console.log('Processing /cancel command');

      const cancelMatch = messageBody.match(/^\/cancel\s+(\d+)$/i);
      if (!cancelMatch) {
        await sendMessageToSelf('❌ Invalid format.\n\nUsage: `/cancel [id]`\n\nExample: /cancel 5\n\nUse /show to see message IDs.');
        return;
      }

      const messageId = parseInt(cancelMatch[1]);
      console.log('Cancelling message ID:', messageId);

      try {
        const { updateMessageStatus } = require('./database');
        await updateMessageStatus(messageId, 'cancelled', 'Cancelled by user');

        await sendMessageToSelf(`✅ *Message ${messageId} cancelled*\n\nThe scheduled message has been cancelled and will not be sent.\n\nUse /show to see remaining messages.`);
        console.log('✅ Message cancelled successfully');
        return;
      } catch (err) {
        console.error('❌ Error cancelling message:', err);
        await sendMessageToSelf(`❌ Error cancelling message ${messageId}. Please make sure the ID is correct.\n\nUse /show to see valid IDs.`);
        return;
      }
    }

    // Check if this is a /reply command
    if (!messageBody || !messageBody.toLowerCase().startsWith('/reply')) {
      console.log('ℹ️  Message is not a /send, /reply, /list, /show, or /cancel command, ignoring:', messageBody ? messageBody.substring(0, 50) : '[no body]');
      return;
    }

    console.log('Processing /reply command:', messageBody);

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
  } finally {
    const handlerEndTime = Date.now();
    const handlerDuration = handlerEndTime - handlerStartTime;
    console.log('⏱️  Message handler completed in', handlerDuration, 'ms');
    console.log('========================================\n');
  }
}

module.exports = {
  handleIncomingMessage
};
