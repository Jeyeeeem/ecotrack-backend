const express = require("express");
const cors = require("cors");
const app = express();
const pool = require("./database");
const bcrypt = require("bcryptjs");

// CORS configuration
app.use(cors({
  origin: '*', 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Basic Routes
app.get("/", (req, res) => res.send("Server is running!"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Auth Routes
app.post("/api/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ success: false, message: "All fields required" });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, username, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING user_id, name, email, role`,
      [name, name, email, hashedPassword, role]
    );
    const user = result.rows[0];
    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: { id: user.user_id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res.status(400).json({ success: false, message: "Email already exists" });
    }
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }
  try {
    const result = await pool.query(
      `SELECT user_id, name, email, role, password_hash FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }
    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }
    res.json({
      success: true,
      message: "Login successful",
      user: { id: user.user_id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Admin Routes
app.get("/api/admin/users", async (req, res) => {
  try {
    const result = await pool.query("SELECT user_id, name, email, role FROM users");
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.put("/api/admin/users/:email/role", async (req, res) => {
  const { email } = req.params;
  const { role } = req.body;
  if (!role) {
    return res.status(400).json({ success: false, message: "Role is required" });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET role = $1 WHERE LOWER(email) = LOWER($2) RETURNING user_id, name, email, role`,
      [role, email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    res.json({ success: true, message: "Role updated successfully", user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// PUBLIC BUSINESS ROUTES
app.get("/api/public/business/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const businessResult = await pool.query(
      `SELECT bp.business_id, bp.business_name, bp.business_type, bp.registration_number, bp.address, bp.contact_email, bp.contact_phone, bp.created_at,
        COALESCE(es.current_score, 0) AS current_score, COALESCE(es.total_points_earned, 0) AS total_points_earned, COALESCE(es.level, 'Newcomer') AS level, COALESCE(es.rank, 0) AS rank
      FROM business_profiles bp LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id WHERE bp.business_id = $1`, [id]
    );
    if (businessResult.rows.length === 0) return res.status(404).json({ success: false, message: "Business not found" });
    const row = businessResult.rows[0];
    res.json({ success: true, business: { businessId: row.business_id, businessName: row.business_name, businessType: row.business_type, address: row.address, ecoTrustScore: row.current_score, totalPoints: row.total_points_earned, level: row.level, rank: row.rank } });
  } catch (err) { res.status(500).json({ success: false, message: "Database error" }); }
});

app.get("/api/public/business", async (req, res) => {
  try {
    const result = await pool.query(`SELECT bp.business_id, bp.business_name, bp.address, COALESCE(es.current_score, 0) AS current_score, COALESCE(es.level, 'Newcomer') AS level FROM business_profiles bp LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id ORDER BY bp.business_name ASC`);
    res.json({ success: true, businesses: result.rows.map(row => ({ businessId: row.business_id, businessName: row.business_name, address: row.address, ecoTrustScore: row.current_score, level: row.level })) });
  } catch (err) { res.status(500).json({ success: false, message: "Database error" }); }
});

// BUSINESS PROFILE ROUTES
app.get("/api/business/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const userResult = await pool.query(`SELECT business_id FROM users WHERE user_id = $1`, [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    const businessId = userResult.rows[0].business_id;
    if (!businessId) return res.status(404).json({ success: false, message: "Business profile not found" });
    const businessResult = await pool.query(`SELECT bp.*, COALESCE(es.current_score, 0) AS current_score, COALESCE(es.total_points_earned, 0) AS total_points_earned, COALESCE(es.level, 'Newcomer') AS level FROM business_profiles bp LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id WHERE bp.business_id = $1`, [businessId]);
    if (businessResult.rows.length === 0) return res.status(404).json({ success: false, message: "Business not found" });
    const row = businessResult.rows[0];
    res.json({ success: true, business: { businessId: row.business_id, businessName: row.business_name, address: row.address, ecoTrustScore: row.current_score, totalPoints: row.total_points_earned, level: row.level } });
  } catch (err) { res.status(500).json({ success: false, message: "Database error" }); }
});

app.get("/api/business/directory", async (req, res) => {
  try {
    const result = await pool.query(`SELECT bp.business_id, bp.business_name, bp.address, bp.contact_email, bp.contact_phone, COALESCE(es.current_score, 0) AS current_score, COALESCE(es.total_points_earned, 0) AS total_points_earned, COALESCE(es.level, 'Newcomer') AS level FROM business_profiles bp LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id ORDER BY es.current_score DESC NULLS LAST`);
    res.json({ success: true, businesses: result.rows.map(row => ({ businessId: row.business_id, businessName: row.business_name, location: row.address, currentScore: row.current_score, totalPoints: row.total_points_earned, level: row.level })) });
  } catch (err) { res.status(500).json({ success: false, message: "Database error" }); }
});

// LOGISTICS ROUTES (Integrated Web functionality)
app.get("/api/logistics/dashboard", async (req, res) => {
  try {
    // 1. Pending Approvals - Explicit columns to avoid SQL conflict
    const pendingQuery = `
      SELECT 
        ra.id as route_id, ra.route_type, ra.from_location, ra.to_location, ra.driver_name, ra.vehicle_type,
        ra.departure_time, ra.original_distance, ra.optimized_distance, ra.original_fuel, ra.optimized_fuel, 
        ra.original_co2, ra.optimized_co2, ra.savings_km, ra.savings_fuel, ra.savings_co2,
        ra.ai_suggestion, ra.status, ra.submitted_by, ra.submitted_at
      FROM route_approvals ra 
      WHERE status = 'PENDING' 
      ORDER BY submitted_at DESC 
      LIMIT 20`;
    
    const pendingResult = await pool.query(pendingQuery);

    // 2. Stats matching Web's count boxes
    const statsResult = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'PENDING') as pending_count,
        COUNT(*) FILTER (WHERE status = 'APPROVED') as approved_count,
        COUNT(*) FILTER (WHERE status = 'DECLINED') as declined_count,
        COALESCE(AVG(savings_co2), 0) FILTER (WHERE status = 'APPROVED') as avg_co2_saved,
        COALESCE(SUM(savings_co2), 0) FILTER (WHERE status = 'APPROVED') as total_co2_reduced,
        COALESCE(SUM(savings_km), 0) FILTER (WHERE status = 'APPROVED') as total_km_saved
      FROM route_approvals`
    );

    // 3. Driver Monitor matching Web's progress bars
    const driversResult = await pool.query(
      `SELECT u.user_id, u.name as full_name, u.email,
        d.from_location || ' → ' || d.to_location as route_name,
        d.status as route_status,
        0 as stops_completed,
        2 as stops_total
      FROM users u
      LEFT JOIN deliveries d ON d.driver_name = u.name AND d.status IN ('assigned', 'accepted', 'in_progress')
      WHERE u.role = 'driver'
      ORDER BY u.name ASC`);

    const pendingRoutes = pendingResult.rows.map(row => ({
      routeId: row.route_id.toString(),
      routeType: row.route_type || 'STANDARD',
      from: row.from_location || 'Warehouse',
      to: row.to_location,
      driver: row.driver_name || 'Unassigned',
      vehicle: row.vehicle_type || 'Van',
      departureTime: row.departure_time,
      originalDistance: parseFloat(row.original_distance) || 0,
      optimizedDistance: parseFloat(row.optimized_distance) || 0,
      originalFuel: parseFloat(row.original_fuel) || 0,
      optimizedFuel: parseFloat(row.optimized_fuel) || 0,
      originalCO2: parseFloat(row.original_co2) || 0,
      optimizedCO2: parseFloat(row.optimized_co2) || 0,
      totalSavingsKm: parseFloat(row.savings_km) || 0,
      totalSavingsFuel: parseFloat(row.savings_fuel) || 0,
      totalSavingsCO2: parseFloat(row.savings_co2) || 0,
      aiSuggestion: row.ai_suggestion || 'Optimize this route',
      status: row.status || 'PENDING',
      submittedBy: row.submitted_by || 'System',
      submittedTime: row.submitted_at
    }));

    const stats = statsResult.rows[0] || {};

    res.json({
      success: true,
      summary: {
        pendingApprovals: parseInt(stats.pending_count) || 0,
        approvedToday: parseInt(stats.approved_count) || 0,
        declined: parseInt(stats.declined_count) || 0,
        avgCO2Saved: parseFloat(stats.avg_co2_saved) || 0,
        totalCO2Reduced: parseFloat(stats.total_co2_reduced) || 0,
        totalKmSaved: parseFloat(stats.total_km_saved) || 0
      },
      pendingRoutes: pendingRoutes,
      driverMonitor: driversResult.rows,
      message: null
    });
  } catch (err) {
    console.error("Logistics dashboard error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/logistics/history", async (req, res) => {
  try {
    const result = await pool.query(`SELECT id as approval_id, id as route_id, route_type as product_name, from_location as location, driver_name, status, savings_km, savings_co2, approved_at as reviewed_at, manager_comment as review_notes FROM route_approvals WHERE status IN ('APPROVED', 'DECLINED', 'REJECTED') ORDER BY approved_at DESC LIMIT 100`);
    res.json({ success: true, data: result.rows, message: null });
  } catch (err) { res.status(500).json({ success: false, data: [] }); }
});

app.post("/api/logistics/approve", async (req, res) => {
  const { routeId, decision, comment } = req.body;
  try {
    const status = decision.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'DECLINED';
    await pool.query(`UPDATE route_approvals SET status = $1, manager_comment = $2, approved_at = NOW() WHERE id = $3`, [status, comment, routeId]);
    res.json({ success: true, message: `Route ${status.toLowerCase()} successfully` });
  } catch (err) { res.status(500).json({ success: false }); }
});

// INVENTORY ROUTES
app.get("/api/inventory/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(`SELECT id, product_id, product_name, alert_type, risk_level, details, days_left, temperature, humidity, location, quantity, value, status, created_at, submitted_by FROM alerts WHERE status = 'active' ORDER BY CASE risk_level WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 END, days_left ASC LIMIT 20`);
    const statsResult = await pool.query(`SELECT COUNT(*) as total_alerts, COUNT(*) FILTER (WHERE risk_level = 'HIGH') as high_risk, COUNT(*) FILTER (WHERE risk_level = 'MEDIUM') as medium_risk, COUNT(*) FILTER (WHERE risk_level = 'LOW') as low_risk, COUNT(*) FILTER (WHERE status = 'resolved') as resolved, COUNT(*) FILTER (WHERE status = 'active') as pending FROM alerts`);
    const pendingItems = pendingResult.rows.map(row => ({ id: row.id, itemNumber: `#${row.id}`, priority: row.risk_level || 'MEDIUM', productName: row.product_name || 'Unknown Product', location: row.location || 'Unknown', quantity: row.quantity ? `${row.quantity} kg` : '0 kg', daysLeft: row.days_left || 0, aiSuggestion: row.details || 'Review this item', submittedBy: row.submitted_by || 'System' }));
    const stats = statsResult.rows[0] || { total_alerts: 0, high_risk: 0, medium_risk: 0, low_risk: 0, resolved: 0, pending: 0 };
    res.json({ success: true, summary: { pendingApprovals: parseInt(stats.pending) || 0, approvedToday: parseInt(stats.resolved) || 0, declined: 0, highRisk: parseInt(stats.high_risk) || 0, mediumRisk: parseInt(stats.medium_risk) || 0, lowRisk: parseInt(stats.low_risk) || 0 }, pendingItems: pendingItems, message: null });
  } catch (err) { res.status(500).json({ success: false, message: "Database error" }); }
});

app.post("/api/inventory/approve", async (req, res) => {
  const { itemId, decision, comment } = req.body;
  try {
    const status = decision.toUpperCase() === 'APPROVE' ? 'resolved' : 'declined';
    await pool.query(`UPDATE alerts SET status = $1, updated_at = NOW() WHERE id = $2`, [status, itemId]);
    res.json({ success: true, message: `Item ${status} successfully` });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/inventory/history", async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, product_id, product_name, alert_type, risk_level, details, days_left, temperature, humidity, location, quantity, value, status, created_at, updated_at, submitted_by FROM alerts WHERE status IN ('resolved', 'declined') ORDER BY updated_at DESC LIMIT 50`);
    const historyItems = result.rows.map(row => ({ id: row.id, itemNumber: `#${row.id}`, priority: row.risk_level || 'MEDIUM', productName: row.product_name || 'Unknown Product', location: row.location || 'Unknown', quantity: row.quantity ? `${row.quantity} kg` : '0 kg', daysLeft: row.days_left || 0, aiSuggestion: row.details || 'No details', status: row.status === 'resolved' ? 'APPROVED' : 'DECLINED', decidedBy: 'Inventory Manager', decidedAt: row.updated_at || row.created_at, submittedBy: row.submitted_by || 'System', submittedAt: row.created_at, temperature: row.temperature, humidity: row.humidity, alertType: row.alert_type }));
    res.json({ success: true, history: historyItems, message: null });
  } catch (err) { res.status(500).json({ success: false }); }
});

// SUSTAINABILITY MANAGER ROUTES
app.get("/api/sustainability/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(`SELECT d.delivery_id, d.route_id, d.status as delivery_status, d.driver_name, d.vehicle_type, d.departure_time, d.arrival_time, d.from_location, d.to_location, d.distance_km, d.fuel_consumption, d.estimated_fuel_consumption_liters, d.carbon_emissions, d.estimated_carbon_kg, d.created_at as submitted_at, d.business_id, bp.business_name FROM deliveries d LEFT JOIN business_profiles bp ON d.business_id = bp.business_id WHERE d.carbon_verification_status = 'pending' OR d.carbon_verification_status IS NULL ORDER BY d.created_at DESC LIMIT 20`);
    const pendingItems = pendingResult.rows.map(row => ({ id: row.delivery_id, deliveryId: `DEL-${row.delivery_id}`, type: 'delivery', date: row.departure_time || row.created_at, route: `${row.from_location} → ${row.to_location}`, driver: row.driver_name, vehicle: row.vehicle_type, estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0, actualFuel: parseFloat(row.fuel_consumption) || 0, estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0, actualCO2: parseFloat(row.carbon_emissions) || 0, distance: parseFloat(row.distance_km) || 0, businessName: row.business_name, submittedAt: row.submitted_at, status: row.carbon_verification_status || 'pending' }));
    res.json({ success: true, summary: { pendingVerifications: pendingItems.length, verifiedToday: 0, totalCO2Verified: 0 }, pendingVerifications: pendingItems, message: null });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/sustainability/verify", async (req, res) => {
  const { verificationId, decision, comment, sourceType } = req.body;
  try {
    const carbonStatus = decision.toUpperCase() === 'VERIFY' ? 'verified' : 'revision_requested';
    if (sourceType === 'route_approval' || sourceType === 'route') {
      await pool.query(`UPDATE route_approvals SET carbon_verification_status = $1, carbon_verification_comment = $2, carbon_verified_at = NOW() WHERE id = $3`, [carbonStatus, comment, verificationId]);
    } else {
      await pool.query(`UPDATE deliveries SET carbon_verification_status = $1, carbon_verification_comment = $2, carbon_verified_at = NOW() WHERE delivery_id = $3`, [carbonStatus, comment, verificationId]);
    }
    res.json({ success: true, message: `Carbon footprint verified successfully` });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/sustainability/history", async (req, res) => {
  try {
    const result = await pool.query(`SELECT d.*, bp.business_name FROM deliveries d LEFT JOIN business_profiles bp ON d.business_id = bp.business_id WHERE d.carbon_verification_status IN ('verified', 'revision_requested') ORDER BY d.carbon_verified_at DESC LIMIT 50`);
    res.json({ success: true, history: result.rows.map(row => ({ id: row.delivery_id, route: `${row.from_location} → ${row.to_location}`, driver: row.driver_name, date: row.carbon_verified_at, estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0, actualCO2: parseFloat(row.carbon_emissions) || 0, status: row.carbon_verification_status })), message: null });
  } catch (err) { res.status(500).json({ success: false }); }
});

// DRIVER ROUTES
app.get("/api/driver/dashboard", async (req, res) => {
  try {
    const statsResult = await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'completed') as total_completed, COALESCE(SUM(distance_km) FILTER (WHERE status = 'completed'), 0) as total_km, COALESCE(SUM(fuel_consumption) FILTER (WHERE status = 'completed'), 0) as total_fuel, COALESCE(SUM(estimated_carbon_kg) FILTER (WHERE status = 'completed'), 0) as total_carbon FROM deliveries WHERE driver_name IS NOT NULL`);
    const stats = statsResult.rows[0];
    res.json({ success: true, summary: { totalCompleted: parseInt(stats.total_completed) || 0, activeDeliveries: 0, totalKm: parseFloat(stats.total_km) || 0, totalFuel: parseFloat(stats.total_fuel) || 0, totalCarbon: parseFloat(stats.total_carbon) || 0 } });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/driver/respond-delivery", async (req, res) => {
  const { deliveryId, decision, notes } = req.body;
  try {
    const status = decision.toUpperCase() === 'ACCEPT' ? 'accepted' : 'declined';
    await pool.query(`UPDATE deliveries SET status = $1, driver_response = $2, driver_notes = $3, driver_responded_at = NOW() WHERE delivery_id = $4`, [status, decision, notes, deliveryId]);
    res.json({ success: true, message: "Response recorded" });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/driver/routes", async (req, res) => {
  try {
    const result = await pool.query(`SELECT d.*, ra.route_type FROM deliveries d LEFT JOIN route_approvals ra ON d.route_id = ra.id WHERE d.driver_name IS NOT NULL LIMIT 50`);
    res.json({ success: true, routes: result.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/driver/start-delivery", async (req, res) => {
  const { deliveryId } = req.body;
  try {
    await pool.query(`UPDATE deliveries SET status = 'in_progress', departure_time = NOW() WHERE delivery_id = $1`, [deliveryId]);
    res.json({ success: true, message: "Started" });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/driver/complete-delivery", async (req, res) => {
  const { deliveryId, actualFuel, actualDistance, actualCO2, notes } = req.body;
  try {
    await pool.query(`UPDATE deliveries SET status = 'completed', arrival_time = NOW(), completed_at = NOW(), fuel_consumption = $1, distance_km = $2, carbon_emissions = $3, delivery_notes = $4 WHERE delivery_id = $5`, [actualFuel, actualDistance, actualCO2, notes, deliveryId]);
    res.json({ success: true, message: "Completed" });
  } catch (err) { res.status(500).json({ success: false }); }
});

// START SERVER
const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`🚀 Server running on port ${port}`); });

// KEEP ALIVE
setInterval(() => { console.log("🟢 Server ping"); }, 60000);

// AI & TRACKING
const aiRoutes = require('./routes/ai.routes');
app.use('/api/ai', aiRoutes);
const trackingRoutes = require('./routes/tracking.routes');
app.use('/api/tracking', trackingRoutes);
