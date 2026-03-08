const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://neondb_owner:npg_pRAylQ9eZGI0@ep-jolly-mountain-a1hcta3p-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  ssl: { rejectUnauthorized: false },
});

async function safeQuery(client, title, sql) {
  try {
    const result = await client.query(sql);
    console.log(`\n--- ${title} ---`);
    console.log(JSON.stringify(result.rows, null, 2));
  } catch (error) {
    console.log(`\n--- ${title} (error) ---`);
    console.log(error.message);
  }
}

async function check() {
  const client = await pool.connect();
  try {
    await safeQuery(
      client,
      "manager_approvals columns",
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'manager_approvals'
       ORDER BY ordinal_position`
    );

    await safeQuery(
      client,
      "route_approvals columns",
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'route_approvals'
       ORDER BY ordinal_position`
    );

    await safeQuery(
      client,
      "manager_approvals status counts",
      `SELECT COALESCE(status, '<NULL>') AS status, COUNT(*)::int AS count
       FROM manager_approvals
       GROUP BY COALESCE(status, '<NULL>')
       ORDER BY count DESC`
    );

    await safeQuery(
      client,
      "route_approvals status counts",
      `SELECT COALESCE(status, '<NULL>') AS status, COUNT(*)::int AS count
       FROM route_approvals
       GROUP BY COALESCE(status, '<NULL>')
       ORDER BY count DESC`
    );

    await safeQuery(
      client,
      "route_approvals unresolved sample",
      `SELECT id, status, submitted_at, approved_at, route_type, from_location, to_location
       FROM route_approvals
       WHERE approved_at IS NULL
       ORDER BY submitted_at DESC NULLS LAST, id DESC
       LIMIT 20`
    );

    await safeQuery(
      client,
      "manager_approvals route_optimization sample",
      `SELECT *
       FROM manager_approvals
       WHERE approval_type = 'route_optimization'
       ORDER BY created_at DESC NULLS LAST
       LIMIT 10`
    );
  } finally {
    client.release();
    await pool.end();
  }
}

check().catch((e) => {
  console.error("CHECK_PENDING_ERROR:", e);
  process.exit(1);
});
