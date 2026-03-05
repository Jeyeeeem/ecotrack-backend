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

// PUBLIC BUSINESS ROUTES - Fixed column names

// Get single business full profile by ID - no auth required
app.get("/api/public/business/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const businessResult = await pool.query(
      `SELECT 
        bp.business_id,
        bp.business_name,
        bp.business_type,
        bp.registration_number,
        bp.address,
        bp.contact_email,
        bp.contact_phone,
        bp.created_at,
        COALESCE(es.current_score, 0) AS current_score,
        COALESCE(es.total_points_earned, 0) AS total_points_earned,
        COALESCE(es.level, 'Newcomer') AS level,
        COALESCE(es.rank, 0) AS rank
      FROM business_profiles bp
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id
      WHERE bp.business_id = $1`,
      [id]
    );

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Business not found" });
    }

    const row = businessResult.rows[0];
    
    let recentDeliveries = [];
    try {
      const deliveriesResult = await pool.query(
        `SELECT delivery_id, from_location, to_location, distance_km, estimated_carbon_kg, carbon_verification_status, created_at
        FROM deliveries WHERE business_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id]
      );
      recentDeliveries = deliveriesResult.rows.map(d => ({
        deliveryId: d.delivery_id,
        from: d.from_location,
        to: d.to_location,
        distanceKm: parseFloat(d.distance_km) || 0,
        carbonKg: parseFloat(d.estimated_carbon_kg) || 0,
        verificationStatus: d.carbon_verification_status,
        date: d.created_at
      }));
    } catch (deliveryErr) {
      console.log("No deliveries found");
    }

    const business = {
      businessId: row.business_id,
      businessName: row.business_name,
      businessType: row.business_type || 'General',
      registrationNumber: row.registration_number || 'N/A',
      address: row.address,
      location: row.address,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      createdAt: row.created_at,
      ecoTrustScore: row.current_score,
      totalPoints: row.total_points_earned,
      level: row.level,
      rank: row.rank,
      recentDeliveries: recentDeliveries
    };

    res.json({ success: true, business: business, message: null });
  } catch (err) {
    console.error("Public business profile error:", err);
    res.status(500).json({ success: false, business: null, message: "Database error" });
  }
});

// Get public business list - no auth required (fixed column names)
app.get("/api/public/business", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        bp.business_id,
        bp.business_name,
        bp.address,
        COALESCE(es.current_score, 0) AS current_score,
        COALESCE(es.level, 'Newcomer') AS level
      FROM business_profiles bp
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id
      ORDER BY bp.business_name ASC`
    );

    const businesses = result.rows.map(row => ({
      businessId: row.business_id,
      businessName: row.business_name,
      address: row.address,
      ecoTrustScore: row.current_score,
      level: row.level
    }));

    res.json({ success: true, businesses: businesses, message: null });
  } catch (err) {
    console.error("Public business error:", err);
    res.status(500).json({ success: false, businesses: null, message: "Database error" });
  }
});

// BUSINESS PROFILE ROUTES - For Android app public directory view profile

// Get business profile by userId - used by Android app for public directory view profile
app.get("/api/business/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    // First find the business associated with this user
    const userResult = await pool.query(
      `SELECT business_id FROM users WHERE user_id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const businessId = userResult.rows[0].business_id;
    
    if (!businessId) {
      return res.status(404).json({ success: false, message: "Business profile not found" });
    }

    // Now get the full business profile
    const businessResult = await pool.query(
      `SELECT 
        bp.business_id,
        bp.business_name,
        bp.business_type,
        bp.registration_number,
        bp.address,
        bp.contact_email,
        bp.contact_phone,
        bp.created_at,
        COALESCE(es.current_score, 0) AS current_score,
        COALESCE(es.total_points_earned, 0) AS total_points_earned,
        COALESCE(es.level, 'Newcomer') AS level,
        COALESCE(es.rank, 0) AS rank
      FROM business_profiles bp
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id
      WHERE bp.business_id = $1`,
      [businessId]
    );

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Business not found" });
    }

    const row = businessResult.rows[0];
    
    // Get recent deliveries
    let recentDeliveries = [];
    try {
      const deliveriesResult = await pool.query(
        `SELECT delivery_id, from_location, to_location, distance_km, estimated_carbon_kg, carbon_verification_status, created_at
        FROM deliveries WHERE business_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [businessId]
      );
      recentDeliveries = deliveriesResult.rows.map(d => ({
        deliveryId: d.delivery_id,
        from: d.from_location,
        to: d.to_location,
        distanceKm: parseFloat(d.distance_km) || 0,
        carbonKg: parseFloat(d.estimated_carbon_kg) || 0,
        verificationStatus: d.carbon_verification_status,
        date: d.created_at
      }));
    } catch (deliveryErr) {
      console.log("No deliveries found");
    }

    const business = {
      businessId: row.business_id,
      businessName: row.business_name,
      businessType: row.business_type || 'General',
      registrationNumber: row.registration_number || 'N/A',
      address: row.address,
      location: row.address,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      createdAt: row.created_at,
      ecoTrustScore: row.current_score,
      totalPoints: row.total_points_earned,
      level: row.level,
      rank: row.rank,
      recentDeliveries: recentDeliveries
    };

    res.json({ success: true, business: business, message: null });
  } catch (err) {
    console.error("Business profile error:", err);
    res.status(500).json({ success: false, business: null, message: "Database error" });
  }
});

// BUSINESS DIRECTORY ROUTES
app.get("/api/business/directory", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        bp.business_id,
        bp.business_name,
        bp.address,
        bp.contact_email,
        bp.contact_phone,
        COALESCE(es.current_score, 0) AS current_score,
        COALESCE(es.total_points_earned, 0) AS total_points_earned,
        COALESCE(es.level, 'Newcomer') AS level,
        COALESCE(es.rank, 0) AS rank
      FROM business_profiles bp
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id
      ORDER BY es.current_score DESC NULLS LAST`
    );

    const businesses = result.rows.map(row => ({
      businessId: row.business_id,
      businessName: row.business_name,
      location: row.address,
      address: row.address,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      currentScore: row.current_score,
      totalPoints: row.total_points_earned,
      level: row.level,
      rank: row.rank
    }));

    res.json({ success: true, businesses, message: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, businesses: null, message: "Database error" });
  }
});

// LOGISTICS ROUTES
app.get("/api/logistics/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(
      `SELECT id as route_id, route_type, from_location, to_location, driver_name, vehicle_type,
        departure_time, original_distance, optimized_distance, original_time, optimized_time,
        original_fuel, optimized_fuel, original_co2, optimized_co2, savings_km, savings_fuel, savings_co2,
        ai_suggestion, status, submitted_by, submitted_at, approved_at, manager_comment
      FROM route_approvals WHERE status = 'PENDING' ORDER BY submitted_at DESC LIMIT 20`
    );

    const statsResult = await pool.query(
      `SELECT 
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'PENDING') as pending_approvals,
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'APPROVED' AND DATE(approved_at) = CURRENT_DATE) as approved_today,
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'DECLINED' AND DATE(approved_at) = CURRENT_DATE) as declined,
        COALESCE(SUM(savings_co2), 0) as total_co2_reduced,
        COALESCE(SUM(savings_km), 0) as total_km_saved
      FROM route_approvals WHERE status = 'APPROVED'`
    );

    const pendingRoutes = pendingResult.rows.map(row => ({
      routeId: row.route_id || `RTE-${row.route_id}`,
      routeType: row.route_type || 'STANDARD',
      from: row.from_location || 'Warehouse',
      to: row.to_location,
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
      status: row.status || 'PENDING',
      submittedBy: row.submitted_by || 'System',
      submittedTime: row.submitted_at || new Date().toISOString(),
      approvedTime: row.approved_at,
      managerComment: row.manager_comment
    }));

    const stats = statsResult.rows[0] || { pending_approvals: 0, approved_today: 0, declined: 0, total_co2_reduced: 0, total_km_saved: 0 };

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
    res.status(500).json({ success: false, message: "Database error", summary: { pendingApprovals: 0, approvedToday: 0, declined: 0, totalCO2Reduced: 0, totalKmSaved: 0 }, pendingRoutes: [] });
  }
});

app.get("/api/logistics/history", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DATE(approved_at) as date, COUNT(*) as count,
        SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'DECLINED' THEN 1 ELSE 0 END) as declined
      FROM route_approvals WHERE approved_at IS NOT NULL
      GROUP BY DATE(approved_at) ORDER BY date DESC LIMIT 30`
    );
    const history = result.rows.map(row => ({ date: row.date, routes: row.count, approved: parseInt(row.approved) || 0, declined: parseInt(row.declined) || 0 }));
    res.json({ success: true, history: history, message: null });
  } catch (err) {
    console.error("Logistics history error:", err);
    res.status(500).json({ success: false, history: [], message: "Database error" });
  }
});

app.post("/api/logistics/approve", async (req, res) => {
  const { routeId, decision, comment } = req.body;
  if (!routeId || !decision) {
    return res.status(400).json({ success: false, message: "Route ID and decision are required" });
  }
  try {
    const status = decision.toUpperCase() === 'APPROVE' ? 'APPROVED' : 'DECLINED';
    const result = await pool.query(
      `UPDATE route_approvals SET status = $1, manager_comment = $2, approved_at = NOW() WHERE id = $3 RETURNING id, status`,
      [status, comment, routeId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Route not found" });
    }
    res.json({ success: true, message: `Route ${status.toLowerCase()} successfully` });
  } catch (err) {
    console.error("Approve route error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// INVENTORY ROUTES
app.get("/api/inventory/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(
      `SELECT id, product_id, product_name, alert_type, risk_level, details, days_left, temperature, humidity,
        location, quantity, value, status, created_at, submitted_by FROM alerts
      WHERE status = 'active' ORDER BY CASE risk_level WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 END, days_left ASC LIMIT 20`
    );

    const statsResult = await pool.query(
      `SELECT COUNT(*) as total_alerts,
        COUNT(*) FILTER (WHERE risk_level = 'HIGH') as high_risk,
        COUNT(*) FILTER (WHERE risk_level = 'MEDIUM') as medium_risk,
        COUNT(*) FILTER (WHERE risk_level = 'LOW') as low_risk,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
        COUNT(*) FILTER (WHERE status = 'active') as pending
      FROM alerts`
    );

    const pendingItems = pendingResult.rows.map(row => ({
      id: row.id, itemNumber: `#${row.id}`, priority: row.risk_level || 'MEDIUM',
      productName: row.product_name || 'Unknown Product', location: row.location || 'Unknown',
      quantity: row.quantity ? `${row.quantity} kg` : '0 kg', daysLeft: row.days_left || 0,
      aiSuggestion: row.details || 'Review this item for spoilage risk', submittedBy: row.submitted_by || 'System'
    }));

    const stats = statsResult.rows[0] || { total_alerts: 0, high_risk: 0, medium_risk: 0, low_risk: 0, resolved: 0, pending: 0 };

    res.json({
      success: true,
      summary: { pendingApprovals: parseInt(stats.pending) || 0, approvedToday: parseInt(stats.resolved) || 0, declined: 0, highRisk: parseInt(stats.high_risk) || 0, mediumRisk: parseInt(stats.medium_risk) || 0, lowRisk: parseInt(stats.low_risk) || 0 },
      pendingItems: pendingItems, message: null
    });
  } catch (err) {
    console.error("Inventory dashboard error:", err);
    res.status(500).json({ success: false, message: "Database error", summary: { pendingApprovals: 0, approvedToday: 0, declined: 0, highRisk: 0, mediumRisk: 0, lowRisk: 0 }, pendingItems: [] });
  }
});

app.post("/api/inventory/approve", async (req, res) => {
  const { itemId, decision, comment } = req.body;
  if (!itemId || !decision) {
    return res.status(400).json({ success: false, message: "Item ID and decision are required" });
  }
  try {
    const status = decision.toUpperCase() === 'APPROVE' ? 'resolved' : 'declined';
    const result = await pool.query(`UPDATE alerts SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`, [status, itemId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }
    res.json({ success: true, message: `Item ${status} successfully` });
  } catch (err) {
    console.error("Approve inventory error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/inventory/history", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, product_id, product_name, alert_type, risk_level, details, days_left, temperature, humidity,
        location, quantity, value, status, created_at, updated_at, submitted_by FROM alerts
      WHERE status IN ('resolved', 'declined') ORDER BY updated_at DESC LIMIT 50`
    );

    const statsResult = await pool.query(
      `SELECT COUNT(*) as total_decisions,
        COUNT(*) FILTER (WHERE status = 'resolved') as total_resolved,
        COUNT(*) FILTER (WHERE status = 'declined') as total_declined FROM alerts WHERE status IN ('resolved', 'declined')`
    );

    const historyItems = result.rows.map(row => ({
      id: row.id, itemNumber: `#${row.id}`, priority: row.risk_level || 'MEDIUM',
      productName: row.product_name || 'Unknown Product', location: row.location || 'Unknown',
      quantity: row.quantity ? `${row.quantity} kg` : '0 kg', daysLeft: row.days_left || 0,
      aiSuggestion: row.details || 'No details available',
      status: row.status === 'resolved' ? 'APPROVED' : 'DECLINED',
      decidedBy: 'Inventory Manager', decidedAt: row.updated_at || row.created_at,
      submittedBy: row.submitted_by || 'System', submittedAt: row.created_at,
      temperature: row.temperature, humidity: row.humidity, alertType: row.alert_type
    }));

    const stats = statsResult.rows[0] || { total_decisions: 0, total_resolved: 0, total_declined: 0 };

    res.json({
      success: true, history: historyItems,
      summary: { totalDecisions: parseInt(stats.total_decisions) || 0, totalResolved: parseInt(stats.total_resolved) || 0, totalDeclined: parseInt(stats.total_declined) || 0, approvalRate: stats.total_decisions > 0 ? Math.round((stats.total_resolved / stats.total_decisions) * 100) : 0 },
      message: null
    });
  } catch (err) {
    console.error("Inventory history error:", err);
    res.status(500).json({ success: false, message: "Database error", history: [], summary: { totalDecisions: 0, totalResolved: 0, totalDeclined: 0, approvalRate: 0 } });
  }
});

// SUSTAINABILITY MANAGER ROUTES
app.get("/api/sustainability/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(
      `SELECT d.delivery_id, d.route_id, d.status as delivery_status, d.driver_name, d.vehicle_type, d.departure_time, d.arrival_time,
        d.from_location, d.to_location, d.distance_km, d.fuel_consumption, d.estimated_fuel_consumption_liters, d.carbon_emissions,
        d.estimated_carbon_kg, d.created_at as submitted_at, d.business_id, bp.business_name
      FROM deliveries d LEFT JOIN business_profiles bp ON d.business_id = bp.business_id
      WHERE d.carbon_verification_status = 'pending' OR d.carbon_verification_status IS NULL ORDER BY d.created_at DESC LIMIT 20`
    );

    const pendingFromRoutes = await pool.query(
      `SELECT ra.id as route_id, ra.route_type, ra.from_location, ra.to_location, ra.driver_name, ra.vehicle_type, ra.departure_time,
        ra.original_distance, ra.original_fuel, ra.original_co2, ra.optimized_fuel, ra.optimized_co2, ra.savings_km, ra.savings_fuel, ra.savings_co2,
        ra.status as approval_status, ra.submitted_at, 'route_approval' as source_type
      FROM route_approvals ra
      WHERE ra.carbon_verification_status = 'pending' OR ra.carbon_verification_status IS NULL ORDER BY ra.submitted_at DESC LIMIT 20`
    );

    const statsResult = await pool.query(
      `SELECT (SELECT COUNT(*) FROM deliveries WHERE carbon_verification_status = 'pending' OR carbon_verification_status IS NULL) as pending_deliveries,
        (SELECT COUNT(*) FROM deliveries WHERE carbon_verification_status = 'verified') as verified_deliveries,
        (SELECT COUNT(*) FROM deliveries WHERE carbon_verification_status = 'revision_requested') as revision_requested,
        COALESCE(SUM(estimated_carbon_kg), 0) FILTER (WHERE carbon_verification_status = 'verified') as total_co2_verified,
        COALESCE(SUM(estimated_fuel_consumption_liters), 0) FILTER (WHERE carbon_verification_status = 'verified') as total_fuel_verified
      FROM deliveries`
    );

    const pendingItems = pendingResult.rows.map(row => ({
      id: row.delivery_id, deliveryId: `DEL-${row.delivery_id}`, type: 'delivery', routeId: row.route_id,
      date: row.departure_time || row.created_at,
      route: `${row.from_location || 'Warehouse'} → ${row.to_location || 'Destination'}`,
      driver: row.driver_name || 'Unassigned', vehicle: row.vehicle_type || 'Van',
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
      actualFuel: parseFloat(row.fuel_consumption) || parseFloat(row.estimated_fuel_consumption_liters) || 0,
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
      actualCO2: parseFloat(row.carbon_emissions) || parseFloat(row.estimated_carbon_kg) || 0,
      distance: parseFloat(row.distance_km) || 0, businessName: row.business_name || 'N/A',
      submittedAt: row.submitted_at || row.created_at, status: row.carbon_verification_status || 'pending'
    }));

    const routeItems = pendingFromRoutes.rows.map(row => ({
      id: row.route_id, deliveryId: `DEL-${row.route_id}`, type: 'route_approval', routeId: row.route_id,
      date: row.departure_time || row.submitted_at,
      route: `${row.from_location || 'Warehouse'} → ${row.to_location || 'Destination'}`,
      driver: row.driver_name || 'Unassigned', vehicle: row.vehicle_type || 'Van',
      estimatedFuel: parseFloat(row.original_fuel) || 0,
      actualFuel: parseFloat(row.optimized_fuel) || parseFloat(row.original_fuel) || 0,
      estimatedCO2: parseFloat(row.original_co2) || 0,
      actualCO2: parseFloat(row.optimized_co2) || parseFloat(row.original_co2) || 0,
      distance: parseFloat(row.original_distance) || 0,
      savingsCO2: parseFloat(row.savings_co2) || 0, savingsFuel: parseFloat(row.savings_fuel) || 0,
      businessName: 'N/A', submittedAt: row.submitted_at, status: row.carbon_verification_status || 'pending'
    }));

    const allPending = [...pendingItems, ...routeItems];
    const stats = statsResult.rows[0] || { pending_deliveries: 0, verified_deliveries: 0, revision_requested: 0, total_co2_verified: 0, total_fuel_verified: 0 };

    res.json({
      success: true,
      summary: {
        pendingVerifications: allPending.length || parseInt(stats.pending_deliveries) || 0,
        verifiedToday: parseInt(stats.verified_deliveries) || 0,
        revisionRequested: parseInt(stats.revision_requested) || 0,
        totalCO2Verified: parseFloat(stats.total_co2_verified) || 0,
        totalFuelVerified: parseFloat(stats.total_fuel_verified) || 0,
        pendingFromDeliveries: pendingItems.length, pendingFromRoutes: routeItems.length
      },
      pendingVerifications: allPending, message: null
    });
  } catch (err) {
    console.error("Sustainability dashboard error:", err);
    res.status(500).json({ success: false, message: "Database error", summary: { pendingVerifications: 0, verifiedToday: 0, revisionRequested: 0, totalCO2Verified: 0, totalFuelVerified: 0 }, pendingVerifications: [] });
  }
});

app.post("/api/sustainability/verify", async (req, res) => {
  const { verificationId, decision, comment, sourceType } = req.body;
  if (!verificationId || !decision) {
    return res.status(400).json({ success: false, message: "Verification ID and decision are required" });
  }
  try {
    const carbonStatus = decision.toUpperCase() === 'VERIFY' ? 'verified' : 'revision_requested';
    let result;
    if (sourceType === 'route_approval' || sourceType === 'route') {
      result = await pool.query(
        `UPDATE route_approvals SET carbon_verification_status = $1, carbon_verification_comment = $2, carbon_verified_at = NOW(), carbon_verified_by = 'sustainability_manager' WHERE id = $3 RETURNING id, carbon_verification_status`,
        [carbonStatus, comment, verificationId]
      );
    } else {
      result = await pool.query(
        `UPDATE deliveries SET carbon_verification_status = $1, carbon_verification_comment = $2, carbon_verified_at = NOW(), carbon_verified_by = 'sustainability_manager' WHERE delivery_id = $3 RETURNING delivery_id, carbon_verification_status`,
        [carbonStatus, comment, verificationId]
      );
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Verification record not found" });
    }
    res.json({ success: true, message: `Carbon footprint ${carbonStatus.replace('_', ' ')} successfully` });
  } catch (err) {
    console.error("Verify carbon error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/sustainability/history", async (req, res) => {
  try {
    const deliveryHistory = await pool.query(
      `SELECT d.delivery_id as id, d.delivery_id as verification_id, 'delivery' as source_type, d.from_location, d.to_location, d.driver_name,
        d.distance_km, d.estimated_carbon_kg as carbon_emissions, d.carbon_emissions as actual_carbon, d.estimated_fuel_consumption_liters as estimated_fuel,
        d.fuel_consumption as actual_fuel, d.carbon_verification_status as status, d.carbon_verification_comment as verification_comment,
        d.carbon_verified_at as verified_at, d.created_at as submitted_at, bp.business_name
      FROM deliveries d LEFT JOIN business_profiles bp ON d.business_id = bp.business_id
      WHERE d.carbon_verification_status IN ('verified', 'revision_requested') ORDER BY d.carbon_verified_at DESC LIMIT 50`
    );

    const routeHistory = await pool.query(
      `SELECT ra.id as id, ra.id as verification_id, 'route_approval' as source_type, ra.from_location, ra.to_location, ra.driver_name,
        ra.original_distance as distance_km, ra.original_co2 as carbon_emissions, ra.optimized_co2 as actual_carbon, ra.original_fuel as estimated_fuel,
        ra.optimized_fuel as actual_fuel, ra.carbon_verification_status as status, ra.carbon_verification_comment as verification_comment,
        ra.carbon_verified_at as verified_at, ra.submitted_at, 'N/A' as business_name
      FROM route_approvals ra
      WHERE ra.carbon_verification_status IN ('verified', 'revision_requested') ORDER BY ra.carbon_verified_at DESC LIMIT 50`
    );

    const formatHistoryItem = (row) => ({
      id: row.id, verificationId: row.verification_id, type: row.source_type,
      route: `${row.from_location || 'Warehouse'} → ${row.to_location || 'Destination'}`,
      driver: row.driver_name || 'Unassigned', date: row.verified_at || row.submitted_at,
      estimatedCO2: parseFloat(row.carbon_emissions) || 0,
      actualCO2: parseFloat(row.actual_carbon) || parseFloat(row.carbon_emissions) || 0,
      estimatedFuel: parseFloat(row.estimated_fuel) || 0,
      actualFuel: parseFloat(row.actual_fuel) || parseFloat(row.estimated_fuel) || 0,
      distance: parseFloat(row.distance_km) || 0, status: row.status, comment: row.verification_comment,
      businessName: row.business_name || 'N/A'
    });

    const allHistory = [...deliveryHistory.rows.map(formatHistoryItem), ...routeHistory.rows.map(formatHistoryItem)].sort((a, b) => new Date(b.date) - new Date(a.date));

    const statsResult = await pool.query(
      `SELECT (SELECT COUNT(*) FROM deliveries WHERE carbon_verification_status = 'verified' AND DATE(carbon_verified_at) = CURRENT_DATE) as verified_today_deliveries,
        (SELECT COUNT(*) FROM route_approvals WHERE carbon_verification_status = 'verified' AND DATE(carbon_verified_at) = CURRENT_DATE) as verified_today_routes,
        (SELECT COUNT(*) FROM deliveries WHERE carbon_verification_status = 'verified') as total_verified_deliveries,
        (SELECT COUNT(*) FROM route_approvals WHERE carbon_verification_status = 'verified') as total_verified_routes,
        (SELECT COUNT(*) FROM deliveries WHERE carbon_verification_status = 'revision_requested') as total_revisions_deliveries,
        (SELECT COUNT(*) FROM route_approvals WHERE carbon_verification_status = 'revision_requested') as total_revisions_routes,
        COALESCE(SUM(estimated_carbon_kg), 0) FILTER (WHERE carbon_verification_status = 'verified') as total_co2_deliveries FROM deliveries`
    );

    const stats = statsResult.rows[0] || { verified_today_deliveries: 0, verified_today_routes: 0, total_verified_deliveries: 0, total_verified_routes: 0, total_revisions_deliveries: 0, total_revisions_routes: 0, total_co2_deliveries: 0 };
    const verifiedToday = (parseInt(stats.verified_today_deliveries) || 0) + (parseInt(stats.verified_today_routes) || 0);
    const totalVerified = (parseInt(stats.total_verified_deliveries) || 0) + (parseInt(stats.total_verified_routes) || 0);
    const totalRevisions = (parseInt(stats.total_revisions_deliveries) || 0) + (parseInt(stats.total_revisions_routes) || 0);

    res.json({
      success: true, history: allHistory,
      summary: { verifiedToday, totalVerified, totalRevisions, totalCO2Verified: parseFloat(stats.total_co2_deliveries) || 0, ecoTrustPoints: totalVerified * 10 },
      message: null
    });
  } catch (err) {
    console.error("Sustainability history error:", err);
    res.status(500).json({ success: false, message: "Database error", history: [], summary: { verifiedToday: 0, totalVerified: 0, totalRevisions: 0, totalCO2Verified: 0, ecoTrustPoints: 0 } });
  }
});

// Start Server
const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`🚀 Server running on port ${port}`); });

// Keep alive
setInterval(() => { console.log("🟢 Server is alive ping"); }, 60000);

// ============================================================
// NEW: AI Routes (Route Optimization & Insights)
// ============================================================
const aiRoutes = require('./routes/ai.routes');
app.use('/api/ai', aiRoutes);
console.log('   /api/ai');

// ============================================================
// NEW: Driver Tracking Routes (Real-time GPS)
// ============================================================
const trackingRoutes = require('./routes/tracking.routes');
app.use('/api/tracking', trackingRoutes);
console.log('   /api/tracking');

// ================= DRIVER ROUTES =================

// Get driver dashboard data - assigned routes and deliveries
app.get("/api/driver/dashboard", async (req, res) => {
  try {
    // Get pending acceptance deliveries (assigned but not yet accepted by driver)
    const pendingAcceptanceResult = await pool.query(
      `SELECT d.delivery_id, d.route_id, d.status as delivery_status, d.driver_name, d.vehicle_type, 
        d.departure_time, d.arrival_time, d.from_location, d.to_location, d.distance_km, 
        d.fuel_consumption, d.estimated_fuel_consumption_liters, d.carbon_emissions,
        d.estimated_carbon_kg, d.stops_json, d.delivery_items_json, d.created_at as submitted_at,
        ra.route_type, ra.optimized_route
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name IS NOT NULL 
      AND (d.status = 'assigned' OR d.status = 'pending_acceptance')
      ORDER BY d.departure_time ASC NULLS LAST LIMIT 20`
    );

    // Get active/accepted deliveries (driver accepted, in progress)
    const activeDeliveriesResult = await pool.query(
      `SELECT d.delivery_id, d.route_id, d.status as delivery_status, d.driver_name, d.vehicle_type, 
        d.departure_time, d.arrival_time, d.from_location, d.to_location, d.distance_km, 
        d.fuel_consumption, d.estimated_fuel_consumption_liters, d.carbon_emissions,
        d.estimated_carbon_kg, d.stops_json, d.delivery_items_json, d.created_at as submitted_at,
        ra.route_type, ra.optimized_route
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name IS NOT NULL 
      AND (d.status = 'accepted' OR d.status = 'in_progress')
      ORDER BY d.departure_time ASC NULLS LAST LIMIT 10`
    );

    // Get upcoming assignments (future deliveries)
    const upcomingResult = await pool.query(
      `SELECT d.delivery_id, d.route_id, d.status as delivery_status, d.driver_name, d.vehicle_type,
        d.departure_time, d.from_location, d.to_location, d.distance_km, d.stops_json,
        ra.route_type
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name IS NOT NULL 
      AND d.status IN ('assigned', 'pending_acceptance', 'accepted')
      AND d.departure_time > NOW()
      ORDER BY d.departure_time ASC LIMIT 10`
    );

    // Get recent completed deliveries
    const recentResult = await pool.query(
      `SELECT d.delivery_id, d.from_location, d.to_location, d.distance_km, 
        d.fuel_consumption, d.carbon_emissions, d.completed_at, d.status
      FROM deliveries d
      WHERE d.driver_name IS NOT NULL 
      AND d.status = 'completed'
      ORDER BY d.completed_at DESC LIMIT 10`
    );

    // Get alerts for driver (items about to expire, priority deliveries)
    const alertsResult = await pool.query(
      `SELECT a.id, a.product_name, a.alert_type, a.risk_level, a.days_left, a.location, a.quantity
      FROM alerts a
      WHERE a.status = 'active' AND a.risk_level = 'HIGH'
      ORDER BY a.days_left ASC LIMIT 10`
    );

    // Get driver stats
    const statsResult = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'completed') as total_completed,
        COUNT(*) FILTER (WHERE status = 'accepted' OR status = 'in_progress') as active_deliveries,
        COUNT(*) FILTER (WHERE status = 'declined') as declined_deliveries,
        COALESCE(SUM(distance_km), 0) FILTER (WHERE status = 'completed') as total_km,
        COALESCE(SUM(fuel_consumption), 0) FILTER (WHERE status = 'completed') as total_fuel,
        COALESCE(SUM(estimated_carbon_kg), 0) FILTER (WHERE status = 'completed') as total_carbon
      FROM deliveries WHERE driver_name IS NOT NULL`
    );

    const formatDelivery = (row) => ({
      deliveryId: row.delivery_id,
      routeId: row.route_id,
      routeType: row.route_type || 'STANDARD',
      status: row.delivery_status,
      driver: row.driver_name,
      vehicle: row.vehicle_type,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      from: row.from_location,
      to: row.to_location,
      stops: row.stops_json ? JSON.parse(row.stops_json) : [],
      items: row.delivery_items_json ? JSON.parse(row.delivery_items_json) : [],
      distance: parseFloat(row.distance_km) || 0,
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
      actualFuel: parseFloat(row.fuel_consumption) || 0,
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
      actualCO2: parseFloat(row.carbon_emissions) || 0,
      optimizedRoute: row.optimized_route
    });

    const pendingAcceptance = pendingAcceptanceResult.rows.map(formatDelivery);
    const activeDeliveries = activeDeliveriesResult.rows.map(formatDelivery);
    const upcomingAssignments = upcomingResult.rows.map(formatDelivery);

    const recentCompletions = recentResult.rows.map(row => ({
      deliveryId: row.delivery_id,
      from: row.from_location,
      to: row.to_location,
      distance: parseFloat(row.distance_km) || 0,
      fuel: parseFloat(row.fuel_consumption) || 0,
      carbon: parseFloat(row.carbon_emissions) || 0,
      completedAt: row.completed_at,
      date: row.completed_at
    }));

    const alerts = alertsResult.rows.map(row => ({
      id: row.id,
      productName: row.product_name,
      alertType: row.alert_type,
      riskLevel: row.risk_level,
      daysLeft: row.days_left,
      location: row.location,
      quantity: row.quantity
    }));

    const stats = statsResult.rows[0] || { 
      total_completed: 0, 
      active_deliveries: 0,
      declined_deliveries: 0,
      total_km: 0, 
      total_fuel: 0, 
      total_carbon: 0 
    };

    res.json({
      success: true,
      pendingAcceptance: pendingAcceptance,
      activeDelivery: activeDeliveries.length > 0 ? activeDeliveries[0] : null,
      activeDeliveries: activeDeliveries,
      upcomingAssignments: upcomingAssignments,
      recentCompletions: recentCompletions,
      alerts: alerts,
      summary: {
        pendingCount: pendingAcceptance.length,
        totalCompleted: parseInt(stats.total_completed) || 0,
        activeDeliveries: parseInt(stats.active_deliveries) || 0,
        declinedDeliveries: parseInt(stats.declined_deliveries) || 0,
        totalKm: parseFloat(stats.total_km) || 0,
        totalFuel: parseFloat(stats.total_fuel) || 0,
        totalCarbon: parseFloat(stats.total_carbon) || 0
      },
      message: null
    });
  } catch (err) {
    console.error("Driver dashboard error:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      pendingAcceptance: [],
      activeDelivery: null,
      activeDeliveries: [],
      upcomingAssignments: [],
      recentCompletions: [],
      alerts: [],
      summary: { pendingCount: 0, totalCompleted: 0, activeDeliveries: 0, declinedDeliveries: 0, totalKm: 0, totalFuel: 0, totalCarbon: 0 }
    });
  }
});

// Accept or Decline a delivery assignment
app.post("/api/driver/respond-delivery", async (req, res) => {
  const { deliveryId, decision, notes } = req.body;
  if (!deliveryId || !decision) {
    return res.status(400).json({ success: false, message: "Delivery ID and decision are required" });
  }
  
  const acceptedDecision = decision.toUpperCase();
  if (acceptedDecision !== 'ACCEPT' && acceptedDecision !== 'DECLINE') {
    return res.status(400).json({ success: false, message: "Decision must be ACCEPT or DECLINE" });
  }
  
  try {
    let newStatus;
    if (acceptedDecision === 'ACCEPT') {
      newStatus = 'accepted';
    } else {
      newStatus = 'declined';
    }
    
    const result = await pool.query(
      `UPDATE deliveries SET 
        status = $1, 
        driver_response = $2,
        driver_notes = $3,
        driver_responded_at = NOW()
      WHERE delivery_id = $4 
      RETURNING delivery_id, status`,
      [newStatus, acceptedDecision, notes, deliveryId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }
    
    res.json({ 
      success: true, 
      message: acceptedDecision === 'ACCEPT' ? "Delivery accepted successfully! You can now start the delivery." : "Delivery declined successfully.",
      delivery: result.rows[0] 
    });
  } catch (err) {
    console.error("Respond to delivery error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get all driver routes/deliveries
app.get("/api/driver/routes", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.delivery_id, d.route_id, d.status as delivery_status, d.driver_name, d.vehicle_type,
        d.departure_time, d.arrival_time, d.completed_at, d.from_location, d.to_location, 
        d.distance_km, d.fuel_consumption, d.estimated_fuel_consumption_liters, 
        d.carbon_emissions, d.estimated_carbon_kg, d.stops_json, d.delivery_items_json,
        ra.route_type, ra.optimized_route
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name IS NOT NULL
      ORDER BY d.departure_time DESC NULLS LAST LIMIT 50`
    );

    const routes = result.rows.map(row => ({
      deliveryId: row.delivery_id,
      routeId: row.route_id,
      routeType: row.route_type || 'STANDARD',
      status: row.delivery_status,
      driver: row.driver_name,
      vehicle: row.vehicle_type,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      completedAt: row.completed_at,
      from: row.from_location,
      to: row.to_location,
      stops: row.stops_json ? JSON.parse(row.stops_json) : [],
      items: row.delivery_items_json ? JSON.parse(row.delivery_items_json) : [],
      distance: parseFloat(row.distance_km) || 0,
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
      actualFuel: parseFloat(row.fuel_consumption) || 0,
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
      actualCO2: parseFloat(row.carbon_emissions) || 0,
      optimizedRoute: row.optimized_route
    }));

    res.json({ success: true, routes: routes, message: null });
  } catch (err) {
    console.error("Driver routes error:", err);
    res.status(500).json({ success: false, routes: [], message: "Database error" });
  }
});

// Get delivery details for review
app.get("/api/driver/delivery/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      `SELECT d.*, ra.route_type, ra.optimized_route, ra.original_distance, ra.optimized_distance,
        ra.original_fuel, ra.optimized_fuel, ra.original_co2, ra.optimized_co2, ra.ai_suggestion,
        ra.submitted_by as route_submitted_by
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.delivery_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    const row = result.rows[0];
    const delivery = {
      deliveryId: row.delivery_id,
      routeId: row.route_id,
      routeType: row.route_type || 'STANDARD',
      status: row.status,
      driver: row.driver_name,
      vehicle: row.vehicle_type,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      from: row.from_location,
      to: row.to_location,
      stops: row.stops_json ? JSON.parse(row.stops_json) : [],
      items: row.delivery_items_json ? JSON.parse(row.delivery_items_json) : [],
      distance: parseFloat(row.distance_km) || 0,
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
      actualFuel: parseFloat(row.fuel_consumption) || 0,
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
      actualCO2: parseFloat(row.carbon_emissions) || 0,
      optimizedRoute: row.optimized_route,
      originalDistance: parseFloat(row.original_distance) || 0,
      optimizedDistance: parseFloat(row.optimized_distance) || 0,
      originalFuel: parseFloat(row.original_fuel) || 0,
      optimizedFuel: parseFloat(row.optimized_fuel) || 0,
      aiSuggestion: row.ai_suggestion,
      routeSubmittedBy: row.route_submitted_by,
      notes: row.delivery_notes,
      driverResponse: row.driver_response,
      driverNotes: row.driver_notes
    };

    res.json({ success: true, delivery: delivery, message: null });
  } catch (err) {
    console.error("Get delivery details error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Start delivery - update status to in_progress (only after acceptance)
app.post("/api/driver/start-delivery", async (req, res) => {
  const { deliveryId } = req.body;
  if (!deliveryId) {
    return res.status(400).json({ success: false, message: "Delivery ID is required" });
  }
  try {
    // First check if delivery exists
    const checkResult = await pool.query(
      `SELECT status FROM deliveries WHERE delivery_id = $1`,
      [deliveryId]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found. Please refresh your dashboard." });
    }
    
    const currentStatus = checkResult.rows[0].status;
    
    // Accept multiple status values and auto-transition to accepted
    const acceptedStatuses = ['accepted', 'in_progress', 'ready', 'not_started', 'pending', 'assigned'];
    const lowerStatus = currentStatus ? currentStatus.toLowerCase() : '';
    
    if (!acceptedStatuses.includes(lowerStatus) && currentStatus !== 'accepted' && currentStatus !== 'in_progress') {
      return res.status(400).json({ success: false, message: "You must accept the delivery before starting. Please accept the delivery first." });
    }

    // If status is not accepted or in_progress, auto-transition to accepted first
    let newStatus = 'in_progress';
    if (lowerStatus !== 'accepted' && lowerStatus !== 'in_progress') {
      // First update to accepted, then start
      await pool.query(
        `UPDATE deliveries SET status = 'accepted', driver_responded_at = NOW() WHERE delivery_id = $1`,
        [deliveryId]
      );
    }

    const result = await pool.query(
      `UPDATE deliveries SET status = 'in_progress', departure_time = NOW() 
      WHERE delivery_id = $1 RETURNING delivery_id, status`,
      [deliveryId]
    );
    
    res.json({ success: true, message: "Delivery started! GPS tracking enabled.", delivery: result.rows[0] });
  } catch (err) {
    console.error("Start delivery error:", err);
    res.status(500).json({ success: false, message: "Database error. Please try again." });
  }
});

// Complete delivery - log actual data
app.post("/api/driver/complete-delivery", async (req, res) => {
  const { deliveryId, actualFuel, actualDistance, actualCO2, notes } = req.body;
  if (!deliveryId) {
    return res.status(400).json({ success: false, message: "Delivery ID is required" });
  }
  try {
    const result = await pool.query(
      `UPDATE deliveries SET 
        status = 'completed', 
        arrival_time = NOW(),
        completed_at = NOW(),
        fuel_consumption = COALESCE($1, fuel_consumption),
        distance_km = COALESCE($2, distance_km),
        carbon_emissions = COALESCE($3, carbon_emissions),
        delivery_notes = $4
      WHERE delivery_id = $5 
      RETURNING delivery_id, status, fuel_consumption, distance_km, carbon_emissions`,
      [actualFuel, actualDistance, actualCO2, notes, deliveryId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }
    res.json({ 
      success: true, 
      message: "Delivery completed successfully", 
      delivery: result.rows[0] 
    });
  } catch (err) {
    console.error("Complete delivery error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Confirm arrival at stop
app.post("/api/driver/confirm-stop", async (req, res) => {
  const { deliveryId, stopIndex, arrivalTime, confirmationType } = req.body;
  if (!deliveryId || stopIndex === undefined) {
    return res.status(400).json({ success: false, message: "Delivery ID and stop index are required" });
  }
  try {
    // For now, just acknowledge the confirmation
    // In production, would update stops_json with arrival times
    res.json({ 
      success: true, 
      message: `Stop ${stopIndex} confirmed: ${confirmationType || 'arrival'}` 
    });
  } catch (err) {
    console.error("Confirm stop error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});
