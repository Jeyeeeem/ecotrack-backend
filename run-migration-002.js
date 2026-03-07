/**
 * Run Migration 002: Create approval and workflow tables
 */

const { Pool } = require('pg');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_pRAylQ9eZGI0@ep-jolly-mountain-a1hcta3p-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runMigration() {
  console.log('🔄 Connecting to database...');
  
  try {
    const client = await pool.connect();
    console.log('✅ Connected');
    
    const sql = fs.readFileSync('./migrations/002_create_approval_tables.sql', 'utf-8');
    
    // Split by semicolon
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
    
    console.log(`📝 Running ${statements.length} statements...`);
    
    for (const statement of statements) {
      try {
        await client.query(statement);
      } catch (err) {
        if (!err.message.includes('duplicate') && !err.message.includes('already exists')) {
          console.warn('  ⚠️ ' + err.message.substring(0, 60));
        }
      }
    }
    
    console.log('✅ Migration completed!');
    
    // Verify tables
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('manager_approvals', 'approval_history', 'carbon_footprint_records', 'ecotrust_transactions', 'sustainable_actions')
    `);
    
    console.log('\n📋 Tables created:');
    tables.rows.forEach(r => console.log('   - ' + r.table_name));
    
    client.release();
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
