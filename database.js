// database.js
require("dotenv").config();
const { Pool } = require("pg");

// Always use the production Neon database to avoid mismatched env vars.
const connectionString =
  "postgresql://neondb_owner:npg_pRAylQ9eZGI0@ep-jolly-mountain-a1hcta3p-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

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
