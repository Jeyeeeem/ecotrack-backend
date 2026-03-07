require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pRAylQ9eZGI0@ep-jolly-mountain-a1hcta3p-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function seed() {
  const client = await pool.connect();
  await client.query(
    "INSERT INTO sustainable_actions (action_id, action_name, description, points_value, action_category) VALUES " +
    "('spoilage_prevention', 'Spoilage Prevention', 'Prevented food from spoiling', 50, 'spoilage')," +
    "('route_optimization_approved', 'Route Optimization Approved', 'Approved AI route', 25, 'logistics')," +
    "('carbon_verified', 'Carbon Verified', 'Verified carbon', 15, 'carbon')," +
    "('delivery_completed', 'Delivery Completed', 'Driver completed', 20, 'delivery')," +
    "('eco_delivery', 'Eco-Friendly Delivery', 'Less carbon', 30, 'delivery') " +
    "ON CONFLICT (action_id) DO NOTHING"
  );
  console.log('DONE');
  client.release();
  await pool.end();
}

seed().catch(e => { console.error(e.message); process.exit(1); });
