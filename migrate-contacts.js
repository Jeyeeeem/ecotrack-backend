const pool = require('./database');

async function migrateContacts() {
  try {
    console.log('🔄 Starting contact columns migration...');
    
    // Check columns in business_profiles table
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'business_profiles' AND table_schema = 'public'"
    );
    
    const columnNames = columns.rows.map(c => c.column_name);
    console.log('Current columns:', columnNames.join(', '));
    
    // Add missing columns
    if (!columnNames.includes('contact_email')) {
      await pool.query('ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255)');
      console.log('✅ Added contact_email column');
    }
    
    if (!columnNames.includes('contact_phone')) {
      await pool.query('ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50)');
      console.log('✅ Added contact_phone column');
    }
    
    // Check existing business profiles
    const businesses = await pool.query('SELECT business_id, business_name, contact_email, contact_phone FROM business_profiles');
    console.log('\nCurrent business profiles:', businesses.rows.length);
    
    // Update businesses with sample contact data if they don't have any
    for (const business of businesses.rows) {
      if (!business.contact_email || !business.contact_phone) {
        const sampleEmail = `contact@${business.business_name.toLowerCase().replace(/\s+/g, '')}.com`;
        const samplePhone = `+63${Math.floor(9000000000 + Math.random() * 999999999)}`;
        
        await pool.query(
          'UPDATE business_profiles SET contact_email = $1, contact_phone = $2 WHERE business_id = $3',
          [sampleEmail, samplePhone.slice(0, 10), business.business_id]
        );
        console.log(`✅ Updated business ${business.business_name} with contact info`);
      }
    }
    
    // Verify the update
    const updatedBusinesses = await pool.query('SELECT business_id, business_name, contact_email, contact_phone FROM business_profiles');
    console.log('\nUpdated business profiles:');
    console.log(JSON.stringify(updatedBusinesses.rows, null, 2));
    
    console.log('\n🎉 Migration complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateContacts();

