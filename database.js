// database.js
require("dotenv").config();
const { Pool } = require("pg");

/**
 * Preferred: set NEON_DATABASE_URL (or DATABASE_URL) in .env
 * Example format: postgresql://user:pass@host/db?sslmode=require&channel_binding=require
 */
const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Database connection string missing. Set NEON_DATABASE_URL or DATABASE_URL.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // required for Neon
});

// connect once to test
pool.connect()
  .then(client => {
    try {
      const parsed = new URL(connectionString);
      console.log("✅ Database connected successfully ->", parsed.hostname);
    } catch (_) {
      console.log("✅ Database connected successfully -> (connection string parsed)");
    }
    client.release();
  })
  .catch(err => console.error("❌ Database connection error:", err.stack));

module.exports = pool;
