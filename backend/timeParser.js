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

function convertFromIsraelTimeToUTC(israelLocalTime) {
  // Given a "naive" time that represents Israel local time,
  // convert it to UTC by subtracting the Israel offset
  const offset = getIsraelTimezoneOffset(israelLocalTime);
  const utcTime = new Date(israelLocalTime.getTime() - offset * 60 * 1000);
  return utcTime;
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
    // chrono already calculated this from now, so just use it directly in UTC
    scheduledTime = parsedDate;
    console.log('⏱️  Relative time detected - scheduling from now:', scheduledTime.toISOString());
  } else {
    // For absolute times (at 8, tomorrow at 9), interpret as Israel time
    // chrono gives us the time in system timezone, but we want to treat it as Israel time
    // So we need to convert: treat parsedDate as Israel local time → convert to UTC
    scheduledTime = convertFromIsraelTimeToUTC(parsedDate);
    console.log('🕐 Absolute time detected - Israel time converted to UTC:', scheduledTime.toISOString());
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
  // Parse /send [name] in/at [time] [message]
  // Examples:
  //   /send John in 2 hours Hey there!
  //   /send John at 8:30 Hey there!
  //   /send John at 8 Good morning!

  // Remove /send prefix
  let content = text.replace(/^\/send\s+/i, '').trim();

  if (!content) {
    return null;
  }

  // Try to find " in " or " at " keyword which separates name from time
  let separatorIndex = -1;
  let separatorKeyword = '';

  const inIndex = content.toLowerCase().indexOf(' in ');
  const atIndex = content.toLowerCase().indexOf(' at ');

  // Find which separator comes first (and exists)
  if (inIndex !== -1 && (atIndex === -1 || inIndex < atIndex)) {
    separatorIndex = inIndex;
    separatorKeyword = 'in';
  } else if (atIndex !== -1) {
    separatorIndex = atIndex;
    separatorKeyword = 'at';
  }

  if (separatorIndex === -1) {
    return null; // No separator found
  }

  // Extract recipient name (everything before " in " or " at ")
  const recipientName = content.substring(0, separatorIndex).trim();

  if (!recipientName) {
    return null;
  }

  // Extract time and message part
  // For "at", keep the "at" prefix (chrono needs it to parse "at 8")
  // For "in", strip it (chrono doesn't need it)
  let timeAndMessage;
  if (separatorKeyword === 'at') {
    timeAndMessage = content.substring(separatorIndex + 1).trim(); // +1 to skip the space before "at"
  } else {
    timeAndMessage = content.substring(separatorIndex + 4).trim(); // +4 to skip " in "
  }

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

  // Determine if this is a relative time or absolute time
  // If user used "in" keyword, it's relative (in 2 hours, in 30 minutes)
  // If user used "at" keyword, it's absolute (at 8, at 8:30)
  const isRelativeTime = separatorKeyword === 'in';

  let scheduledTime;

  if (isRelativeTime) {
    // For relative times (in 1 minute, in 2 hours), use the date as-is from current time
    scheduledTime = parsedDate;
    console.log('⏱️  Relative time detected - scheduling from now:', scheduledTime.toISOString());
  } else {
    // For absolute times (at 8, tomorrow at 9), interpret as Israel time
    // chrono gives us the time in system timezone, but we want to treat it as Israel time
    // So we need to convert: treat parsedDate as Israel local time → convert to UTC
    scheduledTime = convertFromIsraelTimeToUTC(parsedDate);
    console.log('🕐 Absolute time detected - Israel time converted to UTC:', scheduledTime.toISOString());
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
  convertFromIsraelTimeToUTC,
  getIsraelTimezoneOffset
};
