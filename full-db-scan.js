const pool = require('./database');

async function fullDbScan() {
  try {
    const tables = ['delivery_routes', 'route_approvals', 'deliveries', 'delivery_logs', 'delivery_items', 'driver_locations', 'users'];
    
    for (const table of tables) {
      try {
        // Get columns first
        const colsRes = await pool.query(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = $1 AND table_schema = 'public' 
          ORDER BY ordinal_position
        `, [table]);
        const cols = colsRes.rows.map(c => c.column_name);
        
        // Count rows
        const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM ${table}`);
        const count = parseInt(countRes.rows[0].cnt);
        console.log(`\n📊 ${table}: ${count} rows`);
        console.log('Columns:', cols.join(', '));
        
        if (count > 0 && count <= 20) {
          // Get all data if small
          const dataRes = await pool.query(`SELECT * FROM ${table} ORDER BY created_at DESC NULLS LAST LIMIT 20`);
          console.log('Sample data:', JSON.stringify(dataRes.rows, null, 2));
        } else if (count > 0) {
          // Sample + driver/route columns
          const driverCols = cols.filter(c => c.toLowerCase().includes('driver') || c.toLowerCase().includes('route') || c === 'status');
          if (driverCols.length > 0) {
            const sampleRes = await pool.query(`SELECT ${driverCols.join(', ')} FROM ${table} ORDER BY created_at DESC LIMIT 5`);
            console.log('Driver/Route sample:', JSON.stringify(sampleRes.rows, null, 2));
          }
        }
      } catch(e) {
        console.log(`${table}: ERROR - ${e.message}`);
      }
    }
    
    // Specific driver-route matches
    console.log('\n🔍 ACTIVE ROUTES BY STATUS:');
    const allStatuses = await pool.query(`
      SELECT table_name, COUNT(*) as cnt, string_agg(DISTINCT status, ', ') as statuses
      FROM (
        SELECT 'delivery_routes' table_name, status FROM delivery_routes WHERE status IS NOT NULL
        UNION ALL SELECT 'route_approvals', status FROM route_approvals WHERE status IS NOT NULL
        UNION ALL SELECT 'deliveries', status FROM deliveries WHERE status IS NOT NULL
      ) t GROUP BY table_name
    `);
    console.log(JSON.stringify(allStatuses.rows, null, 2));
    
    // Driver name matches
    console.log('\n🔍 DRIVER NAME MATCHES:');
    const driverMatches = await pool.query(`
      SELECT u.full_name as user_driver, r.driver_name as route_driver
      FROM users u CROSS JOIN LATERAL (
        SELECT driver_name FROM delivery_routes WHERE driver_name IS NOT NULL
        UNION SELECT driver_name FROM route_approvals WHERE driver_name IS NOT NULL
        UNION SELECT driver_name FROM deliveries WHERE driver_name IS NOT NULL
      ) r 
      WHERE LOWER(u.role) = 'driver' AND u.full_name ILIKE '%' || r.driver_name || '%' OR r.driver_name ILIKE '%' || u.full_name || '%'
      LIMIT 10
    `);
    console.log(JSON.stringify(driverMatches.rows, null, 2));
    
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
}

fullDbScan();
