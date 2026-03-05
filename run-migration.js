/**
 * Run Database Migrations
 * 
 * Usage:
 *   node run-migration.js
 * 
 * Or set environment variable DATABASE_URL and run:
 *   DATABASE_URL="postgresql://..." node run-migration.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Get database URL from environment or use Neon connection
const DATABASE_URL = process.env.DATABASE_URL || process.env.NEON_DB_URL;

if (!DATABASE_URL) {
  console.error('❌ Please set DATABASE_URL or NEON_DB_URL environment variable');
  console.log('\nExample:');
  console.log('  set DATABASE_URL=postgresql://user:pass@host/neondb');
  console.log('  node run-migration.js');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Neon
});

async function runMigration() {
  console.log('🔄 Connecting to Neon database...');
  
  try {
    const client = await pool.connect();
    console.log('✅ Connected to database');
    
    // Read migration file
    const migrationPath = path.join(__dirname, 'migrations', '001_create_driver_locations.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    
    console.log('🔄 Running migration: 001_create_driver_locations.sql');
    
    // Split by semicolon and execute each statement
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const statement of statements) {
      try {
        await client.query(statement);
        successCount++;
      } catch (err) {
        // Ignore duplicate table errors - they already exist
        if (!err.message.includes('duplicate') && !err.message.includes('already exists')) {
          console.warn('⚠️  Warning:', err.message.substring(0, 100));
        }
      }
    }
    
    console.log(`✅ Migration completed! (${successCount} statements executed)`);
    
    // Verify tables were created
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('driver_locations', 'inventory_items', 'route_stops', 'delivery_routes', 'delivery_logs', 'route_optimizations')
    `);
    
    console.log('\n📋 Tables created/verified:');
    tables.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });
    
    client.release();
    await pool.end();
    
    console.log('\n🎉 Database migration complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}

runMigration();

