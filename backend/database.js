const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Use DATABASE_PATH env var if set (for Railway volumes), otherwise use local path
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'scheduled.db');
const db = new sqlite3.Database(dbPath);

// Initialize database schema
function initDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL,
        recipient_name TEXT,
        message TEXT NOT NULL,
        scheduled_time DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        error_message TEXT
      )
    `);

    // Create index for faster queries
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_status_time
      ON scheduled_messages(status, scheduled_time)
    `);
  });

  console.log('Database initialized at:', dbPath);
}

// Save a scheduled message
function saveScheduledMessage(recipient, recipientName, message, scheduledTime) {
  return new Promise((resolve, reject) => {
    // Always convert to ISO string for consistent storage and comparison
    const scheduledTimeISO = scheduledTime instanceof Date
      ? scheduledTime.toISOString()
      : new Date(scheduledTime).toISOString();

    const stmt = db.prepare(`
      INSERT INTO scheduled_messages (recipient, recipient_name, message, scheduled_time)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(recipient, recipientName, message, scheduledTimeISO, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });

    stmt.finalize();
  });
}

// Get pending messages that should be sent now
function getPendingMessages() {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.all(
      `SELECT * FROM scheduled_messages
       WHERE status = 'pending' AND scheduled_time <= ?
       ORDER BY scheduled_time ASC`,
      [now],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      }
    );
  });
}

// Update message status
function updateMessageStatus(id, status, errorMessage = null) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      `UPDATE scheduled_messages
       SET status = ?, updated_at = ?, error_message = ?
       WHERE id = ?`,
      [status, now, errorMessage, id],
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

// Get all scheduled messages
function getAllScheduledMessages() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM scheduled_messages
       ORDER BY scheduled_time DESC
       LIMIT 100`,
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      }
    );
  });
}

// Get pending count
function getPendingCount() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as count FROM scheduled_messages WHERE status = 'pending'`,
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count);
        }
      }
    );
  });
}

module.exports = {
  initDatabase,
  saveScheduledMessage,
  getPendingMessages,
  updateMessageStatus,
  getAllScheduledMessages,
  getPendingCount,
  db
};
