const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pRAylQ9eZGI0@ep-jolly-mountain-a1hcta3p-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false }
});
(async () => {
  try {
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='manager_approvals'");
    console.log('manager_approvals columns:', columns.rows.map(r=>r.column_name));
    const mgr = await pool.query("SELECT * FROM manager_approvals LIMIT 3");
    console.log(JSON.stringify(mgr.rows, null, 2));
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
