require('dotenv').config({ override: true });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pRAylQ9eZGI0@ep-jolly-mountain-a1hcta3p-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS manager_approvals (
      id SERIAL PRIMARY KEY,
      approval_type VARCHAR(50) NOT NULL,
      related_table VARCHAR(50),
      related_record_id INTEGER,
      alert_id INTEGER,
      delivery_id INTEGER,
      route_id INTEGER,
      inventory_id INTEGER,
      required_role VARCHAR(50) NOT NULL,
      requested_by INTEGER,
      request_notes TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      decision_by INTEGER,
      decision_notes TEXT,
      manager_comment TEXT,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      business_id INTEGER,
      request_data JSONB,
      decision_data JSONB
    )
  `);
  console.log('manager_approvals');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS approval_history (
      id SERIAL PRIMARY KEY,
      approval_id INTEGER,
      approval_type VARCHAR(50),
      related_record_id INTEGER,
      related_table VARCHAR(50),
      actor_user_id INTEGER,
      actor_role VARCHAR(50),
      actor_name VARCHAR(255),
      action VARCHAR(50),
      previous_status VARCHAR(50),
      new_status VARCHAR(50),
      notes TEXT,
      comment TEXT,
      action_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      business_id INTEGER
    )
  `);
  console.log('approval_history');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS carbon_footprint_records (
      id SERIAL PRIMARY KEY,
      record_type VARCHAR(50) NOT NULL,
      delivery_id INTEGER,
      route_id INTEGER,
      inventory_id INTEGER,
      business_id INTEGER,
      calculation_method VARCHAR(50),
      record_date DATE,
      delivery_date TIMESTAMP,
      transportation_carbon_kg DECIMAL(10,2) DEFAULT 0,
      storage_carbon_kg DECIMAL(10,2) DEFAULT 0,
      total_carbon_kg DECIMAL(10,2) DEFAULT 0,
      distance_km DECIMAL(10,2),
      fuel_liters DECIMAL(10,2),
      vehicle_type VARCHAR(50),
      load_factor DECIMAL(5,2),
      verification_status VARCHAR(50) DEFAULT 'pending',
      verified_by INTEGER,
      verified_at TIMESTAMP,
      verification_comment TEXT,
      is_actual BOOLEAN DEFAULT FALSE,
      is_verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ecotrust_points_awarded DECIMAL(10,2) DEFAULT 0,
      ecotrust_transaction_id INTEGER
    )
  `);
  console.log('carbon_footprint_records');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS ecotrust_transactions (
      id SERIAL PRIMARY KEY,
      business_id INTEGER,
      action_id INTEGER,
      action_type VARCHAR(100),
      points_earned DECIMAL(10,2) NOT NULL,
      related_record_type VARCHAR(50),
      related_record_id INTEGER,
      verification_status VARCHAR(50) DEFAULT 'pending',
      verified_by INTEGER,
      verified_at TIMESTAMP,
      description TEXT,
      transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('ecotrust_transactions');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS sustainable_actions (
      id SERIAL PRIMARY KEY,
      action_type VARCHAR(100) NOT NULL UNIQUE,
      action_name VARCHAR(255) NOT NULL,
      description TEXT,
      points_value DECIMAL(10,2) NOT NULL DEFAULT 0,
      category VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('sustainable_actions');
  
  await client.query(`
    INSERT INTO sustainable_actions (action_type, action_name, description, points_value, category) VALUES
      ('spoilage_prevention', 'Spoilage Prevention', 'Prevented food from spoiling', 50, 'spoilage'),
      ('route_optimization_approved', 'Route Optimization Approved', 'Approved AI route', 25, 'logistics'),
      ('carbon_verified', 'Carbon Verified', 'Verified carbon', 15, 'carbon'),
      ('delivery_completed', 'Delivery Completed', 'Driver completed', 20, 'delivery'),
      ('eco_delivery', 'Eco-Friendly Delivery', 'Less carbon', 30, 'delivery')
    ON CONFLICT (action_type) DO NOTHING
  `);
  console.log('default actions');
  
  client.release();
  await pool.end();
  console.log('DONE');
}

migrate().catch(e => { console.error(e); process.exit(1); });
