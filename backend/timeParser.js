const chrono = require('chrono-node');

// Israel timezone offset (UTC+2 in winter, UTC+3 in summer with DST)
// DST in Israel: Last Friday before April 2 (spring forward) to last Sunday before Oct 26 (fall back)

function getIsraelTimezoneOffset(date) {
  // Israel observes DST from late March to late October
  const year = date.getFullYear();

  // Find last Friday before April 2
  const dstStart = new Date(year, 2, 26); // March 26 as a baseline
  while (dstStart.getDay() !== 5) { // 5 = Friday
    dstStart.setDate(dstStart.getDate() + 1);
  }

  // Find last Sunday before October 26
  const dstEnd = new Date(year, 9, 25); // October 25 as baseline
  while (dstEnd.getDay() !== 0) { // 0 = Sunday
    dstEnd.setDate(dstEnd.getDate() + 1);
  }

  // Check if date is within DST period
  if (date >= dstStart && date < dstEnd) {
    return 3 * 60; // UTC+3 (180 minutes)
  } else {
    return 2 * 60; // UTC+2 (120 minutes)
  }
}

function convertToIsraelTime(utcDate) {
  const offset = getIsraelTimezoneOffset(utcDate);
  const israelTime = new Date(utcDate.getTime() + offset * 60 * 1000);
  return israelTime;
}

function parseTimeCommand(text) {
  // Check if command includes recipient in various formats:
  // Format 1: /reply to [name/number] in 1 hour message
  // Format 2: /reply 3 in 1 hour message (where 3 is contact index)
  let recipient = null;
  let timeText = text.replace(/^\/reply\s+/i, '').trim();

  // Check if it starts with "to "
  const toMatch = timeText.match(/^to\s+([^\s]+)\s+(.+)$/i);
  if (toMatch) {
    recipient = toMatch[1]; // Extract recipient (name or number)
    timeText = toMatch[2]; // Rest of the command
    console.log('📧 Recipient specified in command (to format):', recipient);
  }
  // Check if it starts with a number (contact index)
  else {
    const numberMatch = timeText.match(/^(\d+)\s+(.+)$/);
    if (numberMatch) {
      recipient = numberMatch[1]; // Extract contact index
      timeText = numberMatch[2]; // Rest of the command
      console.log('📧 Contact index specified in command:', recipient);
    }
  }

  // Extract the time part and message part
  // Examples:
  // "tomorrow at 9 Hello there" -> time: "tomorrow at 9", message: "Hello there"
  // "in 2 hours test message" -> time: "in 2 hours", message: "test message"

  // Try to parse the time
  const parsed = chrono.parse(timeText, new Date(), { forwardDate: true });

  if (parsed.length === 0) {
    return null;
  }

  const match = parsed[0];
  const timeString = timeText.substring(0, match.index + match.text.length);
  const message = timeText.substring(match.index + match.text.length).trim();

  if (!message) {
    return null;
  }

  // Get the parsed date in local time (which chrono gives us in system timezone)
  let parsedDate = match.start.date();

  // Determine if this is a relative time (in X minutes/hours) or absolute time (at X, tomorrow at X)
  const isRelativeTime = /\bin\s+\d+/.test(timeString.toLowerCase()) ||
                         /\bafter\s+\d+/.test(timeString.toLowerCase());

  let scheduledTime;

  if (isRelativeTime) {
    // For relative times (in 1 minute, in 2 hours), use the date as-is from current time
    // chrono already calculated this from now, so just use it directly
    scheduledTime = parsedDate;
    console.log('⏱️  Relative time detected - scheduling from now');
  } else {
    // For absolute times (at 8, tomorrow at 9), interpret as Israel time
    // Convert from system time to UTC, then to Israel time
    const utcDate = new Date(parsedDate.getTime() - parsedDate.getTimezoneOffset() * 60 * 1000);
    scheduledTime = convertToIsraelTime(utcDate);
    console.log('🕐 Absolute time detected - using Israel timezone');
  }

  return {
    scheduledTime: scheduledTime,
    message: message,
    timeString: timeString,
    originalText: text,
    recipient: recipient // null if not specified
  };
}

function formatIsraelTime(date) {
  const offset = getIsraelTimezoneOffset(date);
  const hours = Math.floor(offset / 60);

  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  };

  // Adjust date to Israel timezone
  const israelDate = new Date(date.getTime() - (date.getTimezoneOffset() + hours * 60) * 60 * 1000);

  return israelDate.toLocaleString('en-US', options) + ` (Israel Time, UTC+${hours})`;
}

function parseSendCommand(text) {
  // Parse /send [name] in [time] [message]
  // Example: /send John in 2 hours Hey there!

  // Remove /send prefix
  let content = text.replace(/^\/send\s+/i, '').trim();

  if (!content) {
    return null;
  }

  // Try to find "in" keyword which separates name from time
  const inIndex = content.toLowerCase().indexOf(' in ');

  if (inIndex === -1) {
    return null; // No "in" found
  }

  // Extract recipient name (everything before " in ")
  const recipientName = content.substring(0, inIndex).trim();

  if (!recipientName) {
    return null;
  }

  // Extract time and message part (everything after " in ")
  const timeAndMessage = content.substring(inIndex + 4).trim(); // +4 to skip " in "

  // Parse the time using chrono
  const parsed = chrono.parse(timeAndMessage, new Date(), { forwardDate: true });

  if (parsed.length === 0) {
    return null;
  }

  const match = parsed[0];
  const timeString = timeAndMessage.substring(0, match.index + match.text.length);
  const message = timeAndMessage.substring(match.index + match.text.length).trim();

  if (!message) {
    return null;
  }

  // Get the parsed date in local time (which chrono gives us in system timezone)
  let parsedDate = match.start.date();

  // Determine if this is a relative time (in X minutes/hours) or absolute time (at X, tomorrow at X)
  const isRelativeTime = /\bin\s+\d+/.test(timeString.toLowerCase()) ||
                         /\bafter\s+\d+/.test(timeString.toLowerCase());

  let scheduledTime;

  if (isRelativeTime) {
    // For relative times (in 1 minute, in 2 hours), use the date as-is from current time
    scheduledTime = parsedDate;
    console.log('⏱️  Relative time detected - scheduling from now');
  } else {
    // For absolute times (at 8, tomorrow at 9), interpret as Israel time
    const utcDate = new Date(parsedDate.getTime() - parsedDate.getTimezoneOffset() * 60 * 1000);
    scheduledTime = convertToIsraelTime(utcDate);
    console.log('🕐 Absolute time detected - using Israel timezone');
  }

  return {
    scheduledTime: scheduledTime,
    message: message,
    timeString: timeString,
    originalText: text,
    recipientName: recipientName
  };
}

module.exports = {
  parseTimeCommand,
  parseSendCommand,
  formatIsraelTime,
  convertToIsraelTime,
  getIsraelTimezoneOffset
};
