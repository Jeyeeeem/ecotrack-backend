const express = require("express");
const cors = require("cors");
const app = express();
const pool = require("./database");
const bcrypt = require("bcryptjs");

// CORS configuration
app.use(cors({
  origin: '*', // Allows all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());


// ====================== BASIC ROUTES ======================

// Test route
app.get("/", (req, res) => res.send("Server is running!"));

// Health route
app.get("/health", (req, res) => res.json({ status: "ok" }));


// ====================== AUTH ROUTES ======================

// Register user
app.post("/api/register", async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({
      success: false,
      message: "All fields required"
    });
  }

  try {

    // 🔐 HASH PASSWORD
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users 
      (name, username, email, password_hash, role) 
      VALUES ($1, $2, $3, $4, $5) 
      RETURNING user_id, name, email, role`,
      [name, name, email, hashedPassword, role]
    );

    const user = result.rows[0];

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: {
        id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Email already exists"
      });
    }

    res.status(500).json({
      success: false,
      message: "Database error"
    });
  }
});

// Login user
app.post("/api/login", async (req, res) => {

  const { email, password } = req.body;

  console.log("🔍 [LOGIN] Received request:");
  console.log("   Email:", email);
  console.log("   Password:", password);
  console.log("   Password length:", password ? password.length : 0);

  if (!email || !password) {
    console.log("🔍 [LOGIN] Missing email or password");
    return res.status(400).json({
      success: false,
      message: "Email and password required"
    });
  }

  try {

    console.log("🔍 [LOGIN] Querying database for email:", email);
    const result = await pool.query(
      `SELECT user_id, name, email, role, password_hash
       FROM users
       WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    console.log("🔍 [LOGIN] Database rows found:", result.rows.length);
    
    if (result.rows.length === 0) {
      console.log("🔍 [LOGIN] User not found in database");
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const user = result.rows[0];
    console.log("🔍 [LOGIN] User found:");
    console.log("   User ID:", user.user_id);
    console.log("   Name:", user.name);
    console.log("   Email:", user.email);
    console.log("   Role:", user.role);
    console.log("   Stored hash:", user.password_hash.substring(0, 20) + "...");

    // 🔐 Compare hashed password properly
    console.log("🔍 [LOGIN] Comparing password...");
    const isMatch = await bcrypt.compare(password, user.password_hash);
    console.log("🔍 [LOGIN] Password match result:", isMatch);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    res.json({
      success: true,
      message: "Login successful",
      user: {
        id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Database error"
    });
  }
});


// ====================== ADMIN ROUTES ======================

// Get all users
app.get("/api/admin/users", async (req, res) => {

  try {

    const result = await pool.query(
      "SELECT user_id, name, email, role FROM users"
    );

    res.json({
      success: true,
      users: result.rows
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: "Database error"
    });
  }
});

// Update user role
app.put("/api/admin/users/:email/role", async (req, res) => {
  const { email } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).json({
      success: false,
      message: "Role is required"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET role = $1 WHERE LOWER(email) = LOWER($2) RETURNING user_id, name, email, role`,
      [role, email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.json({
      success: true,
      message: "Role updated successfully",
      user: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Database error"
    });
  }
});


// ====================== BUSINESS DIRECTORY ROUTES ======================

// Get business directory
app.get("/api/business/directory", async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT 
        bp.business_id,
        bp.business_name,
        bp.address,
        COALESCE(es.current_score, 0) AS current_score,
        COALESCE(es.total_points_earned, 0) AS total_points_earned,
        COALESCE(es.level, 'Bronze') AS level,
        COALESCE(es.rank, 0) AS rank
      FROM business_profiles bp
      LEFT JOIN ecotrust_scores es 
        ON bp.business_id = es.business_id
      ORDER BY es.current_score DESC NULLS LAST
    `);

    const businesses = result.rows.map(row => ({
      businessId: row.business_id,
      businessName: row.business_name,
      location: row.address,
      currentScore: row.current_score,
      totalPoints: row.total_points_earned,
      level: row.level,
      rank: row.rank
    }));

    res.json({
      success: true,
      businesses,
      message: null
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      businesses: null,
      message: "Database error"
    });
  }
});


// ====================== LOGISTICS ROUTES ======================

// Get logistics dashboard data
app.get("/api/logistics/dashboard", async (req, res) => {
  try {
    // Get pending route approvals (logistics_manager role)
    const pendingResult = await pool.query(`
      SELECT 
        id as route_id,
        route_type,
        from_location,
        to_location,
        driver_name,
        vehicle_type,
        departure_time,
        original_distance,
        optimized_distance,
        original_time,
        optimized_time,
        original_fuel,
        optimized_fuel,
        original_co2,
        optimized_co2,
        savings_km,
        savings_fuel,
        savings_co2,
        ai_suggestion,
        status,
        submitted_by,
        submitted_at,
        approved_at,
        manager_comment
      FROM route_approvals
      WHERE status = 'PENDING'
      ORDER BY submitted_at DESC
      LIMIT 20
    `);

    // Get summary stats
    const statsResult = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'PENDING') as pending_approvals,
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'APPROVED' AND DATE(approved_at) = CURRENT_DATE) as approved_today,
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'DECLINED' AND DATE(approved_at) = CURRENT_DATE) as declined,
        COALESCE(SUM(savings_co2), 0) as total_co2_reduced,
        COALESCE(SUM(savings_km), 0) as total_km_saved
      FROM route_approvals
      WHERE status = 'APPROVED'
    `);

    const pendingRoutes = pendingResult.rows.map(row => ({
      routeId: row.route_id || `RTE-${row.route_id}`,
      routeType: row.route_type || 'STANDARD',
      from: row.from_location || 'Warehouse',
      to: row.to_location,
      stops: null,
      driver: row.driver_name || 'Unassigned',
      vehicle: row.vehicle_type || 'Van',
      departureTime: row.departure_time || new Date().toISOString(),
      originalDistance: parseFloat(row.original_distance) || 0,
      optimizedDistance: parseFloat(row.optimized_distance) || 0,
      originalTime: row.original_time || '0h 0m',
      optimizedTime: row.optimized_time || '0h 0m',
      originalFuel: parseFloat(row.original_fuel) || 0,
      optimizedFuel: parseFloat(row.optimized_fuel) || 0,
      originalCO2: parseFloat(row.original_co2) || 0,
      optimizedCO2: parseFloat(row.optimized_co2) || 0,
      totalSavingsKm: parseFloat(row.savings_km) || 0,
      totalSavingsFuel: parseFloat(row.savings_fuel) || 0,
      totalSavingsCO2: parseFloat(row.savings_co2) || 0,
      aiSuggestion: row.ai_suggestion || 'Optimize this route for better efficiency',
      originalOrder: null,
      optimizedOrder: null,
      status: row.status || 'PENDING',
      submittedBy: row.submitted_by || 'System',
      submittedTime: row.submitted_at || new Date().toISOString(),
      approvedTime: row.approved_at,
      managerComment: row.manager_comment
    }));

    const stats = statsResult.rows[0] || {
      pending_approvals: 0,
      approved_today: 0,
      declined: 0,
      total_co2_reduced: 0,
      total_km_saved: 0
    };

    res.json({
      success: true,
      summary: {
        pendingApprovals: parseInt(stats.pending_approvals) || 0,
        approvedToday: parseInt(stats.approved_today) || 0,
        declined: parseInt(stats.declined) || 0,
        totalCO2Reduced: parseFloat(stats.total_co2_reduced) || 0,
        totalKmSaved: parseFloat(stats.total_km_saved) || 0
      },
      pendingRoutes: pendingRoutes,
      message: null
    });

  } catch (err) {
    console.error("Logistics dashboard error:", err);
    res.status(500).json({
      success: false,
      message: "Database error",
      summary: { pendingApprovals: 0, approvedToday: 0, declined: 0, totalCO2Reduced: 0, totalKmSaved: 0 },
      pendingRoutes: []
    });
  }
});

// Get logistics approval history
app.get("/api/logistics/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        DATE(approved_at) as date,
        COUNT(*) as count,
        SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'DECLINED' THEN 1 ELSE 0 END) as declined
      FROM route_approvals
      WHERE approved_at IS NOT NULL
      GROUP BY DATE(approved_at)
      ORDER BY date DESC
      LIMIT 30
    `);

    const history = result.rows.map(row => ({
      date: row.date,
      routes: row.count,
      approved: parseInt(row.approved) || 0,
      declined: parseInt(row.declined) || 0
    }));

    res.json({
      success: true,
      history: history,
      message: null
    });

  } catch (err) {
    console.error("Logistics history error:", err);
    res.status(500).json({
      success: false,
      history: [],
      message: "Database error"
    });
  }
});

// Approve or decline a route
app.post("/api/logistics/approve", async (req, res) => {
  const { routeId, decision, comment } = req.body;

  if (!routeId || !decision) {
    return res.status(400).json({
      success: false,
      message: "Route ID and decision are required"
    });
  }

  try {
    const status = decision.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'DECLINED';
    
    const result = await pool.query(`
      UPDATE route_approvals 
      SET status = $1, 
          manager_comment = $2,
          approved_at = NOW()
      WHERE id = $3
      RETURNING id, status
    `, [status, comment, routeId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Route not found"
      });
    }

    res.json({
      success: true,
      message: `Route ${status.toLowerCase()} successfully`
    });

  } catch (err) {
    console.error("Approve route error:", err);
    res.status(500).json({
      success: false,
      message: "Database error"
    });
  }
});


// ====================== INVENTORY ROUTES ======================

// Get inventory dashboard data
app.get("/api/inventory/dashboard", async (req, res) => {
  try {
    // Get pending inventory/spoilage alerts (inventory_manager role)
    const pendingResult = await pool.query(`
      SELECT 
        id,
        product_id,
        product_name,
        alert_type,
        risk_level,
        details,
        days_left,
        temperature,
        humidity,
        location,
        quantity,
        value,
        status,
        created_at,
        submitted_by
      FROM alerts
      WHERE status = 'active'
      ORDER BY 
        CASE risk_level
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          WHEN 'LOW' THEN 3
        END,
        days_left ASC
      LIMIT 20
    `);

    // Get summary stats
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_alerts,
        COUNT(*) FILTER (WHERE risk_level = 'HIGH') as high_risk,
        COUNT(*) FILTER (WHERE risk_level = 'MEDIUM') as medium_risk,
        COUNT(*) FILTER (WHERE risk_level = 'LOW') as low_risk,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
        COUNT(*) FILTER (WHERE status = 'active') as pending
      FROM alerts
    `);

    const pendingItems = pendingResult.rows.map(row => ({
      id: row.id,
      itemNumber: `#${row.id}`,
      priority: row.risk_level || 'MEDIUM',
      productName: row.product_name || 'Unknown Product',
      location: row.location || 'Unknown',
      quantity: row.quantity ? `${row.quantity} kg` : '0 kg',
      daysLeft: row.days_left || 0,
      aiSuggestion: row.details || 'Review this item for spoilage risk',
      submittedBy: row.submitted_by || 'System'
    }));

    const stats = statsResult.rows[0] || {
      total_alerts: 0,
      high_risk: 0,
      medium_risk: 0,
      low_risk: 0,
      resolved: 0,
      pending: 0
    };

    res.json({
      success: true,
      summary: {
        pendingApprovals: parseInt(stats.pending) || 0,
        approvedToday: parseInt(stats.resolved) || 0,
        declined: 0,
        totalCO2Reduced: 0,
        totalKmSaved: 0,
        highRisk: parseInt(stats.high_risk) || 0,
        mediumRisk: parseInt(stats.medium_risk) || 0,
        lowRisk: parseInt(stats.low_risk) || 0
      },
      pendingItems: pendingItems,
      message: null
    });

  } catch (err) {
    console.error("Inventory dashboard error:", err);
    res.status(500).json({
      success: false,
      message: "Database error",
      summary: { pendingApprovals: 0, approvedToday: 0, declined: 0, highRisk: 0, mediumRisk: 0, lowRisk: 0 },
      pendingItems: []
    });
  }
});

// Approve or decline inventory item
app.post("/api/inventory/approve", async (req, res) => {
  const { itemId, decision, comment } = req.body;

  if (!itemId || !decision) {
    return res.status(400).json({
      success: false,
      message: "Item ID and decision are required"
    });
  }

  try {
    const status = decision.toUpperCase() === 'APPROVE' ? 'resolved' : 'declined';
    
    const result = await pool.query(`
      UPDATE alerts 
      SET status = $1, 
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, status
    `, [status, itemId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Item not found"
      });
    }

    res.json({
      success: true,
      message: `Item ${status} successfully`
    });

  } catch (err) {
    console.error("Approve inventory error:", err);
    res.status(500).json({
      success: false,
      message: "Database error"
    });
  }
});


// ====================== START SERVER ======================

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});


// ====================== KEEP ALIVE ======================

setInterval(() => {
  console.log("🟢 Server is alive ping");
}, 60000);
