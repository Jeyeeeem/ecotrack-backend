const pool = require('./database');

async function checkDriversData() {
  try {
    console.log('=== USERS (drivers) ===');
    const drivers = await pool.query("SELECT user_id, full_name, name, username, email, role FROM users WHERE role = 'driver' ORDER BY user_id");
    console.log(JSON.stringify(drivers.rows, null, 2));

    console.log('\n=== DELIVERY_ROUTES (active) ===');
    const routes = await pool.query(`
      SELECT route_id, route_name, status, driver_name, driver_user_id, vehicle_type, created_at 
      FROM delivery_routes 
      WHERE LOWER(COALESCE(status, '')) IN ('pending','assigned','accepted','in_progress','planned')
      ORDER BY created_at DESC LIMIT 10
    `);
    console.log(JSON.stringify(routes.rows, null, 2));

    console.log('\n=== ROUTE_APPROVALS (pending) ===');
    const approvals = await pool.query(`
      SELECT id, driver_name, status, route_type, from_location, submitted_at 
      FROM route_approvals 
      WHERE LOWER(COALESCE(status, '')) IN ('pending','awaiting_approval','submitted','in_review')
      ORDER BY submitted_at DESC LIMIT 10
    `);
    console.log(JSON.stringify(approvals.rows, null, 2));

    console.log('\n=== DELIVERIES (active) ===');
    const deliveries = await pool.query(`
      SELECT delivery_id, route_id, status, driver_name, driver_user_id 
      FROM deliveries 
      WHERE LOWER(COALESCE(status, '')) IN ('pending','assigned','accepted','in_progress')
      ORDER BY created_at DESC LIMIT 10
    `);
    console.log(JSON.stringify(deliveries.rows, null, 2));

    // Check table columns
    const tables = ['delivery_routes', 'route_approvals', 'deliveries', 'users'];
    for (const table of tables) {
      try {
        const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`, [table]);
        console.log(`\n${table} columns:`, cols.rows.map(c => c.column_name));
      } catch(e) {
        console.log(`\n${table} columns: ERROR`);
      }
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkDriversData();
