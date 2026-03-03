const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pRAylQ9eZGI0@ep-jolly-mountain-a1hcta3p-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false }
});

async function checkBusinessProfiles() {
  try {
    const result = await pool.query(
      'SELECT business_id, business_name, contact_email, contact_phone, address FROM business_profiles LIMIT 5'
    );
    console.log('Business Profiles:');
    console.log(JSON.stringify(result.rows, null, 2));
    
    // Also check columns in the table
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'business_profiles'"
    );
    console.log('\nColumns in business_profiles:');
    console.log(columns.rows.map(c => c.column_name).join(', '));
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkBusinessProfiles();

