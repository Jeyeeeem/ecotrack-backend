// ============================================================
// FILE: server.js
// EcoTrack Backend - Complete REST API
// ============================================================

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const pool = require("./database");
const bcrypt = require("bcryptjs");

// Import middleware
const { authenticate, authorize, optionalAuth, generateToken, validateInput } = require("./middleware/auth");

// ============================================================
// MIDDLEWARE SETUP
// ============================================================

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false // Disable for development
}));

// CORS configuration
app.use(cors({
  origin: '*', 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { success: false, message: "Too many requests, please try again later" }
});
app.use("/api", limiter);

// Parse JSON
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Basic Routes
app.get("/", (req, res) => res.send("Server is running!"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ============================================================
// AUTH ROUTES
// ============================================================

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
    const token = generateToken(user);
    res.status(201).json({
      success: true,
      message: "User registered successfully",
      token,
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
      `SELECT user_id, name, email, role, password_hash, business_id FROM users WHERE LOWER(email) = LOWER($1)`,
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
    const token = generateToken(user);
    res.json({
      success: true,
      message: "Login successful",
      token,
      user: { id: user.user_id, name: user.name, email: user.email, role: user.role, businessId: user.business_id }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// ADMIN ROUTES
// ============================================================

app.get("/api/admin/users", authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await pool.query("SELECT user_id, name, email, role, business_id FROM users");
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.put("/api/admin/users/:email/role", authenticate, authorize('admin'), async (req, res) => {
  const { email } = req.params;
  const { role } = req.body;
  if (!role) {
    return res.status(400).json({ success: false, message: "Role is required" });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2) RETURNING user_id, name, email, role`,
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

// ============================================================
// BUSINESS PROFILE ROUTES
// ============================================================

// Get all businesses (public)
app.get("/api/public/business", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT bp.business_id, bp.business_name, bp.address, 
             COALESCE(es.current_score, 0) AS current_score, COALESCE(es.level, 'Newcomer') AS level 
      FROM business_profiles bp 
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id 
      ORDER BY bp.business_name ASC
    `);
    res.json({ success: true, businesses: result.rows.map(row => ({ 
      businessId: row.business_id, 
      businessName: row.business_name, 
      address: row.address, 
      ecoTrustScore: row.current_score, 
      level: row.level 
    })) });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" }); 
  }
});

// Get single business (public)
app.get("/api/public/business/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const businessResult = await pool.query(`
      SELECT bp.business_id, bp.business_name, bp.business_type, bp.registration_number, 
             bp.address, bp.contact_email, bp.contact_phone, bp.created_at,
             COALESCE(es.current_score, 0) AS current_score, COALESCE(es.total_points_earned, 0) AS total_points_earned, 
             COALESCE(es.level, 'Newcomer') AS level, COALESCE(es.rank, 0) AS rank
      FROM business_profiles bp 
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id 
      WHERE bp.business_id = $1`, 
      [id]
    );
    if (businessResult.rows.length === 0) return res.status(404).json({ success: false, message: "Business not found" });
    const row = businessResult.rows[0];
    res.json({ 
      success: true, 
      business: { 
        businessId: row.business_id, 
        businessName: row.business_name, 
        businessType: row.business_type, 
        address: row.address, 
        ecoTrustScore: row.current_score, 
        totalPoints: row.total_points_earned, 
        level: row.level, 
        rank: row.rank 
      } 
    });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" }); 
  }
});

// Create business profile
app.post("/api/business", authenticate, async (req, res) => {
  const { business_name, business_type, registration_number, address, contact_email, contact_phone } = req.body;
  
  if (!business_name) {
    return res.status(400).json({ success: false, message: "Business name is required" });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO business_profiles (business_name, business_type, registration_number, address, contact_email, contact_phone, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [business_name, business_type, registration_number, address, contact_email, contact_phone, req.user.userId]
    );
    
    // Create default ecotrust score
    await pool.query(
      `INSERT INTO ecotrust_scores (business_id) VALUES ($1)`,
      [result.rows[0].business_id]
    );
    
    res.status(201).json({ success: true, business: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get user's business profile
app.get("/api/business/profile/:userId", authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const userResult = await pool.query(`SELECT business_id FROM users WHERE user_id = $1`, [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    const businessId = userResult.rows[0].business_id;
    if (!businessId) return res.status(404).json({ success: false, message: "Business profile not found" });
    const businessResult = await pool.query(`
      SELECT bp.*, COALESCE(es.current_score, 0) AS current_score, 
             COALESCE(es.total_points_earned, 0) AS total_points_earned, COALESCE(es.level, 'Newcomer') AS level 
      FROM business_profiles bp 
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id 
      WHERE bp.business_id = $1`, 
      [businessId]
    );
    if (businessResult.rows.length === 0) return res.status(404).json({ success: false, message: "Business not found" });
    const row = businessResult.rows[0];
    res.json({ 
      success: true, 
      business: { 
        businessId: row.business_id, 
        businessName: row.business_name, 
        address: row.address, 
        ecoTrustScore: row.current_score, 
        totalPoints: row.total_points_earned, 
        level: row.level 
      } 
    });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" }); 
  }
});

// Update business profile
app.put("/api/business/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { business_name, business_type, registration_number, address, contact_email, contact_phone } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE business_profiles SET 
        business_name = COALESCE($1, business_name),
        business_type = COALESCE($2, business_type),
        registration_number = COALESCE($3, registration_number),
        address = COALESCE($4, address),
        contact_email = COALESCE($5, contact_email),
        contact_phone = COALESCE($6, contact_phone),
        updated_at = NOW()
       WHERE business_id = $7 RETURNING *`,
      [business_name, business_type, registration_number, address, contact_email, contact_phone, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Business not found" });
    }
    
    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Business directory with scores
app.get("/api/business/directory", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT bp.business_id, bp.business_name, bp.address, bp.contact_email, bp.contact_phone, 
             COALESCE(es.current_score, 0) AS current_score, COALESCE(es.total_points_earned, 0) AS total_points_earned, 
             COALESCE(es.level, 'Newcomer') AS level 
      FROM business_profiles bp 
      LEFT JOIN ecotrust_scores es ON bp.business_id = es.business_id 
      ORDER BY es.current_score DESC NULLS LAST
    `);
    res.json({ 
      success: true, 
      businesses: result.rows.map(row => ({ 
        businessId: row.business_id, 
        businessName: row.business_name, 
        location: row.address, 
        currentScore: row.current_score, 
        totalPoints: row.total_points_earned, 
        level: row.level 
      })) 
    });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" }); 
  }
});

// ============================================================
// INVENTORY ITEMS ROUTES
// ============================================================

// Get all inventory items
app.get("/api/inventory/items", authenticate, async (req, res) => {
  try {
    const { status, risk_level, location } = req.query;
    let query = `SELECT * FROM inventory_items WHERE 1=1`;
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (risk_level) {
      params.push(risk_level);
      query += ` AND risk_level = $${params.length}`;
    }
    if (location) {
      params.push(`%${location}%`);
      query += ` AND location ILIKE $${params.length}`;
    }
    
    query += ` ORDER BY days_until_expiry ASC NULLS LAST, risk_level DESC`;
    
    const result = await pool.query(query, params);
    res.json({ success: true, items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get single inventory item
app.get("/api/inventory/items/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM inventory_items WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Create inventory item
app.post("/api/inventory/items", authenticate, async (req, res) => {
  const { product_name, sku, category, quantity, unit, location, warehouse_section, expiry_date, days_until_expiry, temperature_min, temperature_max, current_temperature, humidity_level, risk_level } = req.body;
  
  if (!product_name) {
    return res.status(400).json({ success: false, message: "Product name is required" });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO inventory_items 
        (product_name, sku, category, quantity, unit, location, warehouse_section, expiry_date, days_until_expiry, temperature_min, temperature_max, current_temperature, humidity_level, risk_level, business_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [product_name, sku, category, quantity || 0, unit || 'kg', location, warehouse_section, expiry_date, days_until_expiry, temperature_min, temperature_max, current_temperature, humidity_level, risk_level || 'LOW', req.user.businessId]
    );
    res.status(201).json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Update inventory item
app.put("/api/inventory/items/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { product_name, sku, category, quantity, unit, location, warehouse_section, expiry_date, days_until_expiry, temperature_min, temperature_max, current_temperature, humidity_level, status, risk_level } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE inventory_items SET 
        product_name = COALESCE($1, product_name),
        sku = COALESCE($2, sku),
        category = COALESCE($3, category),
        quantity = COALESCE($4, quantity),
        unit = COALESCE($5, unit),
        location = COALESCE($6, location),
        warehouse_section = COALESCE($7, warehouse_section),
        expiry_date = COALESCE($8, expiry_date),
        days_until_expiry = COALESCE($9, days_until_expiry),
        temperature_min = COALESCE($10, temperature_min),
        temperature_max = COALESCE($11, temperature_max),
        current_temperature = COALESCE($12, current_temperature),
        humidity_level = COALESCE($13, humidity_level),
        status = COALESCE($14, status),
        risk_level = COALESCE($15, risk_level),
        updated_at = NOW()
       WHERE id = $16 RETURNING *`,
      [product_name, sku, category, quantity, unit, location, warehouse_section, expiry_date, days_until_expiry, temperature_min, temperature_max, current_temperature, humidity_level, status, risk_level, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }
    
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Delete inventory item
app.delete("/api/inventory/items/:id", authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM inventory_items WHERE id = $1 RETURNING *`, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }
    
    res.json({ success: true, message: "Item deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Inventory stats
app.get("/api/inventory/stats", authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_items,
        COUNT(*) FILTER (WHERE status = 'active') as active_items,
        COUNT(*) FILTER (WHERE risk_level = 'HIGH') as high_risk,
        COUNT(*) FILTER (WHERE risk_level = 'MEDIUM') as medium_risk,
        COUNT(*) FILTER (WHERE risk_level = 'LOW') as low_risk,
        SUM(quantity) as total_quantity,
        COUNT(*) FILTER (WHERE days_until_expiry <= 7) as expiring_soon
      FROM inventory_items
    `);
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// DELIVERY ROUTES ROUTES
// ============================================================

// Get all delivery routes
app.get("/api/routes", authenticate, async (req, res) => {
  try {
    const { status, route_type } = req.query;
    let query = `SELECT * FROM delivery_routes WHERE 1=1`;
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (route_type) {
      params.push(route_type);
      query += ` AND route_type = $${params.length}`;
    }
    
    query += ` ORDER BY created_at DESC`;
    
    const result = await pool.query(query, params);
    res.json({ success: true, routes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get single delivery route
app.get("/api/routes/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM delivery_routes WHERE route_id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Route not found" });
    }
    res.json({ success: true, route: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Create delivery route
app.post("/api/routes", authenticate, async (req, res) => {
  const { route_name, route_type, origin_location, destination_location, vehicle_type, total_distance_km, estimated_duration_minutes, estimated_fuel_consumption_liters, estimated_carbon_kg } = req.body;
  
  if (!route_name) {
    return res.status(400).json({ success: false, message: "Route name is required" });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO delivery_routes 
        (route_name, route_type, origin_location, destination_location, vehicle_type, total_distance_km, estimated_duration_minutes, estimated_fuel_consumption_liters, estimated_carbon_kg, business_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [route_name, route_type || 'single', origin_location, destination_location, vehicle_type, total_distance_km || 0, estimated_duration_minutes || 0, estimated_fuel_consumption_liters || 0, estimated_carbon_kg || 0, req.user.businessId]
    );
    res.status(201).json({ success: true, route: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Update delivery route
app.put("/api/routes/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { route_name, route_type, origin_location, destination_location, vehicle_type, total_distance_km, estimated_duration_minutes, estimated_fuel_consumption_liters, estimated_carbon_kg, status } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE delivery_routes SET 
        route_name = COALESCE($1, route_name),
        route_type = COALESCE($2, route_type),
        origin_location = COALESCE($3, origin_location),
        destination_location = COALESCE($4, destination_location),
        vehicle_type = COALESCE($5, vehicle_type),
        total_distance_km = COALESCE($6, total_distance_km),
        estimated_duration_minutes = COALESCE($7, estimated_duration_minutes),
        estimated_fuel_consumption_liters = COALESCE($8, estimated_fuel_consumption_liters),
        estimated_carbon_kg = COALESCE($9, estimated_carbon_kg),
        status = COALESCE($10, status),
        updated_at = NOW()
       WHERE route_id = $11 RETURNING *`,
      [route_name, route_type, origin_location, destination_location, vehicle_type, total_distance_km, estimated_duration_minutes, estimated_fuel_consumption_liters, estimated_carbon_kg, status, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Route not found" });
    }
    
    res.json({ success: true, route: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Delete delivery route
app.delete("/api/routes/:id", authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM delivery_routes WHERE route_id = $1 RETURNING *`, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Route not found" });
    }
    
    res.json({ success: true, message: "Route deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// ROUTE STOPS ROUTES
// ============================================================

// Get stops for a route
app.get("/api/routes/:routeId/stops", authenticate, async (req, res) => {
  try {
    const { routeId } = req.params;
    const result = await pool.query(
      `SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_sequence`,
      [routeId]
    );
    res.json({ success: true, stops: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Add stop to route
app.post("/api/routes/:routeId/stops", authenticate, async (req, res) => {
  const { routeId } = req.params;
  const { stop_sequence, location_name, address, latitude, longitude, stop_type } = req.body;
  
  if (!stop_sequence || !location_name) {
    return res.status(400).json({ success: false, message: "Stop sequence and location name are required" });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO route_stops (route_id, stop_sequence, location_name, address, latitude, longitude, stop_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [routeId, stop_sequence, location_name, address, latitude, longitude, stop_type || 'delivery']
    );
    res.status(201).json({ success: true, stop: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Update stop
app.put("/api/stops/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { stop_sequence, location_name, address, latitude, longitude, stop_type, status, planned_arrival_time, actual_arrival_time, planned_departure_time, actual_departure_time, notes } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE route_stops SET 
        stop_sequence = COALESCE($1, stop_sequence),
        location_name = COALESCE($2, location_name),
        address = COALESCE($3, address),
        latitude = COALESCE($4, latitude),
        longitude = COALESCE($5, longitude),
        stop_type = COALESCE($6, stop_type),
        status = COALESCE($7, status),
        planned_arrival_time = COALESCE($8, planned_arrival_time),
        actual_arrival_time = COALESCE($9, actual_arrival_time),
        planned_departure_time = COALESCE($10, planned_departure_time),
        actual_departure_time = COALESCE($11, actual_departure_time),
        notes = COALESCE($12, notes),
        updated_at = NOW()
       WHERE id = $13 RETURNING *`,
      [stop_sequence, location_name, address, latitude, longitude, stop_type, status, planned_arrival_time, actual_arrival_time, planned_departure_time, actual_departure_time, notes, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Stop not found" });
    }
    
    res.json({ success: true, stop: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Delete stop
app.delete("/api/stops/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM route_stops WHERE id = $1 RETURNING *`, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Stop not found" });
    }
    
    res.json({ success: true, message: "Stop deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// DELIVERY LOGS ROUTES
// ============================================================

// Get delivery logs
app.get("/api/delivery-logs", authenticate, async (req, res) => {
  try {
    const { driver_name, start_date, end_date, limit = 50 } = req.query;
    let query = `SELECT dl.*, dr.route_name FROM delivery_logs dl LEFT JOIN delivery_routes dr ON dl.route_id = dr.route_id WHERE 1=1`;
    const params = [];
    
    if (driver_name) {
      params.push(`%${driver_name}%`);
      query += ` AND dl.driver_name ILIKE $${params.length}`;
    }
    if (start_date) {
      params.push(start_date);
      query += ` AND dl.delivery_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      query += ` AND dl.delivery_date <= $${params.length}`;
    }
    
    params.push(limit);
    query += ` ORDER BY dl.created_at DESC LIMIT $${params.length}`;
    
    const result = await pool.query(query, params);
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Create delivery log
app.post("/api/delivery-logs", authenticate, async (req, res) => {
  const { route_id, actual_distance_km, actual_duration_minutes, actual_fuel_used_liters, actual_carbon_kg, delivery_date, driver_name, notes } = req.body;
  
  if (!route_id) {
    return res.status(400).json({ success: false, message: "Route ID is required" });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO delivery_logs 
        (route_id, business_id, driver_user_id, actual_distance_km, actual_duration_minutes, actual_fuel_used_liters, actual_carbon_kg, delivery_date, driver_name, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [route_id, req.user.businessId, req.user.userId, actual_distance_km, actual_duration_minutes, actual_fuel_used_liters, actual_carbon_kg, delivery_date || new Date().toISOString().split('T')[0], driver_name, notes]
    );
    res.status(201).json({ success: true, log: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Delivery logs stats
app.get("/api/delivery-logs/stats", authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_deliveries,
        COALESCE(SUM(actual_distance_km), 0) as total_distance,
        COALESCE(SUM(actual_fuel_used_liters), 0) as total_fuel,
        COALESCE(SUM(actual_carbon_kg), 0) as total_carbon,
        COALESCE(AVG(actual_carbon_kg), 0) as avg_carbon
      FROM delivery_logs
    `);
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// ECOTRUST SCORE ROUTES
// ============================================================

// Get ecotrust score for business
app.get("/api/ecotrust/:businessId", authenticate, async (req, res) => {
  try {
    const { businessId } = req.params;
    const result = await pool.query(`SELECT * FROM ecotrust_scores WHERE business_id = $1`, [businessId]);
    
    if (result.rows.length === 0) {
      // Create default score if not exists
      const newScore = await pool.query(
        `INSERT INTO ecotrust_scores (business_id) VALUES ($1) RETURNING *`,
        [businessId]
      );
      return res.json({ success: true, score: newScore.rows[0] });
    }
    
    res.json({ success: true, score: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Update ecotrust score
app.put("/api/ecotrust/:businessId", authenticate, authorize('admin', 'manager'), async (req, res) => {
  const { businessId } = req.params;
  const { current_score, total_points_earned, total_deliveries, total_carbon_saved, level, rank } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE ecotrust_scores SET 
        current_score = COALESCE($1, current_score),
        total_points_earned = COALESCE($2, total_points_earned),
        total_deliveries = COALESCE($3, total_deliveries),
        total_carbon_saved = COALESCE($4, total_carbon_saved),
        level = COALESCE($5, level),
        rank = COALESCE($6, rank),
        last_updated = NOW()
       WHERE business_id = $7 RETURNING *`,
      [current_score, total_points_earned, total_deliveries, total_carbon_saved, level, rank, businessId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Score not found" });
    }
    
    res.json({ success: true, score: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get leaderboard
app.get("/api/ecotrust/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT es.*, bp.business_name 
      FROM ecotrust_scores es 
      LEFT JOIN business_profiles bp ON es.business_id = bp.business_id 
      ORDER BY es.current_score DESC NULLS LAST, es.rank ASC
      LIMIT 20
    `);
    res.json({ success: true, leaderboard: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// LOGISTICS ROUTES (Existing)
// ============================================================

app.get("/api/logistics/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(
      `SELECT 
        ra.id as route_id, 
        ra.route_type, 
        ra.from_location, 
        ra.to_location, 
        ra.driver_name, 
        ra.vehicle_type,
        ra.departure_time, 
        ra.original_distance, 
        ra.optimized_distance, 
        ra.original_fuel, 
        ra.optimized_fuel, 
        ra.original_co2, 
        ra.optimized_co2, 
        ra.savings_km, 
        ra.savings_fuel, 
        ra.savings_co2,
        ra.ai_suggestion, 
        ra.status, 
        ra.submitted_by, 
        ra.submitted_at
      FROM route_approvals ra 
      WHERE status = 'PENDING' 
      ORDER BY submitted_at DESC 
      LIMIT 20`
    );

    const statsResult = await pool.query(
      `SELECT 
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'PENDING') as pending_count,
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'APPROVED') as approved_count,
        (SELECT COUNT(*) FROM route_approvals WHERE status = 'DECLINED') as declined_count,
        COALESCE(AVG(savings_co2), 0) FILTER (WHERE status = 'APPROVED') as avg_co2_saved,
        COALESCE(SUM(savings_co2), 0) FILTER (WHERE status = 'APPROVED') as total_co2_reduced,
        COALESCE(SUM(savings_km), 0) FILTER (WHERE status = 'APPROVED') as total_km_saved
      FROM route_approvals`
    );

    const driversResult = await pool.query(
      `SELECT u.user_id, u.name as full_name, u.email,
        d.from_location || ' → ' || d.to_location as route_name,
        d.status as route_status, 0 as stops_completed, 2 as stops_total
      FROM users u
      LEFT JOIN deliveries d ON d.driver_name = u.name AND d.status IN ('assigned', 'accepted', 'in_progress')
      WHERE u.role = 'driver' ORDER BY u.name ASC`
    );

    const stats = statsResult.rows[0] || {};
    const pendingRoutes = pendingResult.rows.map(row => ({
      routeId: row.id.toString(),
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

app.get("/api/logistics/pending", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, route_type as product_name, from_location as location, driver_name, vehicle_type, departure_time, 
             original_distance as total_distance_km, optimized_distance, original_fuel as estimated_fuel_consumption_liters, 
             optimized_fuel, original_co2 as estimated_carbon_kg, optimized_co2 as optimized_carbon_kg, 
             savings_km, savings_fuel, savings_co2, ai_suggestion as ai_recommendation, status, 
             submitted_by, submitted_at as created_at 
      FROM route_approvals WHERE status = 'PENDING' ORDER BY submitted_at DESC
    `);
    res.json({ success: true, data: result.rows, message: null });
  } catch (err) { res.status(500).json({ success: false, data: [] }); }
});

app.get("/api/logistics/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'PENDING') as pending_count, 
             COUNT(*) FILTER (WHERE status = 'APPROVED') as approved_count, 
             COUNT(*) FILTER (WHERE status = 'DECLINED') as declined_count, 
             COALESCE(AVG(savings_co2), 0) FILTER (WHERE status = 'APPROVED') as avg_co2_saved 
      FROM route_approvals
    `);
    res.json({ success: true, data: result.rows[0], message: null });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/logistics/driver-monitor", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.user_id, u.name as full_name, u.email, d.from_location || ' → ' || d.to_location as route_name, 
             d.status as route_status, 0 as stops_completed, 2 as stops_total 
      FROM users u 
      LEFT JOIN deliveries d ON d.driver_name = u.name AND d.status IN ('assigned', 'accepted', 'in_progress') 
      WHERE u.role = 'driver' ORDER BY u.name ASC
    `);
    res.json({ success: true, data: result.rows, message: null });
  } catch (err) { res.status(500).json({ success: false, data: [] }); }
});

app.patch("/api/logistics/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { comment, driver_id } = req.body;
  try {
    // First, get the route details to know the driver_name if driver_id is provided
    let driverName = null;
    if (driver_id) {
      const driverResult = await pool.query(
        `SELECT name FROM users WHERE user_id = $1 AND role = 'driver'`,
        [driver_id]
      );
      if (driverResult.rows.length > 0) {
        driverName = driverResult.rows[0].name;
      }
    }
    
    // Update route_approvals with driver assignment
    await pool.query(
      `UPDATE route_approvals 
       SET status = 'APPROVED', 
           manager_comment = $1, 
           approved_at = NOW(),
           driver_name = COALESCE($2, driver_name)
       WHERE id = $3`, 
      [comment || '', driverName, id]
    );
    
    // Also create/update a delivery record with the assigned driver
    if (driver_id && driverName) {
      const routeResult = await pool.query(`SELECT * FROM route_approvals WHERE id = $1`, [id]);
      if (routeResult.rows.length > 0) {
        const route = routeResult.rows[0];
        
        // Check if delivery already exists for this route approval
        const existingDelivery = await pool.query(
          `SELECT delivery_id FROM deliveries WHERE route_id = $1 AND driver_name = $2`,
          [id, driverName]
        );
        
        if (existingDelivery.rows.length === 0) {
          // Create a new delivery record
          await pool.query(
            `INSERT INTO deliveries 
              (route_id, status, driver_name, vehicle_type, departure_time, from_location, to_location,
               distance_km, estimated_fuel_consumption_liters, estimated_carbon_kg)
             VALUES ($1, 'assigned', $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, driverName, route.vehicle_type, route.departure_time, route.from_location, 
             route.to_location, route.optimized_distance || route.original_distance,
             route.optimized_fuel || route.original_fuel, route.optimized_co2 || route.original_co2]
          );
        }
      }
    }
    
    res.json({ success: true, message: "Approved" });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.patch("/api/logistics/:id/decline", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  try {
    await pool.query(`UPDATE route_approvals SET status = 'DECLINED', manager_comment = $1, approved_at = NOW() WHERE id = $2`, [reason || '', id]);
    res.json({ success: true, message: "Declined" });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/logistics/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id as approval_id, id as route_id, route_type as product_name, from_location as location, driver_name, 
             status, savings_km, savings_co2, approved_at as reviewed_at, manager_comment as review_notes 
      FROM route_approvals WHERE status IN ('APPROVED', 'DECLINED', 'REJECTED') ORDER BY approved_at DESC LIMIT 100
    `);
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

// ============================================================
// INVENTORY ALERTS ROUTES (Existing)
// ============================================================

app.get("/api/inventory/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(`
      SELECT id, product_id, product_name, alert_type, risk_level, details, days_left, temperature, humidity, 
             location, quantity, value, status, created_at, submitted_by 
      FROM alerts WHERE status = 'active' 
      ORDER BY CASE risk_level WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 END, days_left ASC LIMIT 20
    `);
    const statsResult = await pool.query(`
      SELECT COUNT(*) as total_alerts, 
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
      aiSuggestion: row.details || 'Review this item', 
      submittedBy: row.submitted_by || 'System' 
    }));
    const stats = statsResult.rows[0] || { total_alerts: 0, high_risk: 0, medium_risk: 0, low_risk: 0, resolved: 0, pending: 0 };
    res.json({ 
      success: true, 
      summary: { 
        pendingApprovals: parseInt(stats.pending) || 0, 
        approvedToday: parseInt(stats.resolved) || 0, 
        declined: 0, 
        highRisk: parseInt(stats.high_risk) || 0, 
        mediumRisk: parseInt(stats.medium_risk) || 0, 
        lowRisk: parseInt(stats.low_risk) || 0 
      }, 
      pendingItems: pendingItems, 
      message: null 
    });
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
    const result = await pool.query(`
      SELECT id, product_id, product_name, alert_type, risk_level, details, days_left, temperature, humidity, 
             location, quantity, value, status, created_at, updated_at, submitted_by 
      FROM alerts WHERE status IN ('resolved', 'declined') ORDER BY updated_at DESC LIMIT 50
    `);
    const historyItems = result.rows.map(row => ({ 
      id: row.id, 
      itemNumber: `#${row.id}`, 
      priority: row.risk_level || 'MEDIUM', 
      productName: row.product_name || 'Unknown Product', 
      location: row.location || 'Unknown', 
      quantity: row.quantity ? `${row.quantity} kg` : '0 kg', 
      daysLeft: row.days_left || 0, 
      aiSuggestion: row.details || 'No details', 
      status: row.status === 'resolved' ? 'APPROVED' : 'DECLINED', 
      decidedBy: 'Inventory Manager', 
      decidedAt: row.updated_at || row.created_at, 
      submittedBy: row.submitted_by || 'System', 
      submittedAt: row.created_at, 
      temperature: row.temperature, 
      humidity: row.humidity, 
      alertType: row.alert_type 
    }));
    res.json({ success: true, history: historyItems, message: null });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ============================================================
// SUSTAINABILITY MANAGER ROUTES (Existing)
// ============================================================

app.get("/api/sustainability/dashboard", async (req, res) => {
  try {
    const pendingResult = await pool.query(`
      SELECT d.delivery_id, d.route_id, d.status as delivery_status, d.driver_name, d.vehicle_type, d.departure_time, 
             d.arrival_time, d.from_location, d.to_location, d.distance_km, d.fuel_consumption, 
             d.estimated_fuel_consumption_liters, d.carbon_emissions, d.estimated_carbon_kg, 
             d.created_at as submitted_at, d.business_id, bp.business_name 
      FROM deliveries d 
      LEFT JOIN business_profiles bp ON d.business_id = bp.business_id 
      WHERE d.carbon_verification_status = 'pending' OR d.carbon_verification_status IS NULL 
      ORDER BY d.created_at DESC LIMIT 20
    `);
    const pendingItems = pendingResult.rows.map(row => ({ 
      id: row.delivery_id, 
      deliveryId: `DEL-${row.delivery_id}`, 
      type: 'delivery', 
      date: row.departure_time || row.created_at, 
      route: `${row.from_location} → ${row.to_location}`, 
      driver: row.driver_name, 
      vehicle: row.vehicle_type, 
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0, 
      actualFuel: parseFloat(row.fuel_consumption) || 0, 
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0, 
      actualCO2: parseFloat(row.carbon_emissions) || 0, 
      distance: parseFloat(row.distance_km) || 0, 
      businessName: row.business_name, 
      submittedAt: row.submitted_at, 
      status: row.carbon_verification_status || 'pending' 
    }));
    res.json({ 
      success: true, 
      summary: { pendingVerifications: pendingItems.length, verifiedToday: 0, totalCO2Verified: 0 }, 
      pendingVerifications: pendingItems, 
      message: null 
    });
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
    const result = await pool.query(`
      SELECT d.*, bp.business_name 
      FROM deliveries d 
      LEFT JOIN business_profiles bp ON d.business_id = bp.business_id 
      WHERE d.carbon_verification_status IN ('verified', 'revision_requested') 
      ORDER BY d.carbon_verified_at DESC LIMIT 50
    `);
    res.json({ 
      success: true, 
      history: result.rows.map(row => ({ 
        id: row.delivery_id, 
        route: `${row.from_location} → ${row.to_location}`, 
        driver: row.driver_name, 
        date: row.carbon_verified_at, 
        estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0, 
        actualCO2: parseFloat(row.carbon_emissions) || 0, 
        status: row.carbon_verification_status 
      })), 
      message: null 
    });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ============================================================
// DRIVER ROUTES (Existing)
// ============================================================

app.get("/api/driver/dashboard", async (req, res) => {
  try {
    const statsResult = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'completed') as total_completed, 
             COALESCE(SUM(distance_km), 0) FILTER (WHERE status = 'completed') as total_km, 
             COALESCE(SUM(fuel_consumption), 0) FILTER (WHERE status = 'completed') as total_fuel, 
             COALESCE(SUM(estimated_carbon_kg), 0) FILTER (WHERE status = 'completed') as total_carbon 
      FROM deliveries WHERE driver_name IS NOT NULL
    `);
    const stats = statsResult.rows[0];
    res.json({ 
      success: true, 
      summary: { 
        totalCompleted: parseInt(stats.total_completed) || 0, 
        activeDeliveries: 0, 
        totalKm: parseFloat(stats.total_km) || 0, 
        totalFuel: parseFloat(stats.total_fuel) || 0, 
        totalCarbon: parseFloat(stats.total_carbon) || 0 
      } 
    });
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

// ============================================================
// NEW: DRIVER MANAGEMENT ENDPOINTS
// ============================================================

// Get all drivers (for logistics manager to select when approving routes)
app.get("/api/drivers", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT user_id, name, email, role, business_id, full_name, phone, created_at
      FROM users 
      WHERE role = 'driver' 
      ORDER BY name ASC
    `);
    res.json({ success: true, drivers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get assigned routes for a driver (for driver's dashboard)
app.get("/api/driver/assigned-routes", async (req, res) => {
  try {
    const { driver_name } = req.query;
    if (!driver_name) {
      return res.status(400).json({ success: false, message: "Driver name is required" });
    }
    
    // Get deliveries assigned to this driver
    const result = await pool.query(`
      SELECT d.*, ra.route_type, ra.original_distance, ra.optimized_distance, 
             ra.original_fuel, ra.optimized_fuel, ra.original_co2, ra.optimized_co2,
             ra.savings_km, ra.savings_fuel, ra.savings_co2
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name = $1 AND d.status IN ('assigned', 'accepted', 'in_progress')
      ORDER BY d.departure_time ASC
    `, [driver_name]);
    
    res.json({ success: true, routes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get pending deliveries for a driver (new assignments)
app.get("/api/driver/pending-deliveries", async (req, res) => {
  try {
    const { driver_name } = req.query;
    if (!driver_name) {
      return res.status(400).json({ success: false, message: "Driver name is required" });
    }
    
    const result = await pool.query(`
      SELECT d.*, ra.route_type, ra.from_location, ra.to_location, 
             ra.original_distance, ra.optimized_distance, ra.original_fuel, ra.optimized_fuel,
             ra.original_co2, ra.optimized_co2, ra.savings_km, ra.savings_fuel, ra.savings_co2,
             ra.ai_suggestion
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name = $1 AND d.status = 'assigned'
      ORDER BY d.departure_time ASC
    `, [driver_name]);
    
    res.json({ success: true, deliveries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// AI & TRACKING ROUTES
// ============================================================

const aiRoutes = require('./routes/ai.routes');
app.use('/api/ai', aiRoutes);

const trackingRoutes = require('./routes/tracking.routes');
app.use('/api/tracking', trackingRoutes);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: `Route ${req.method} ${req.originalUrl} not found` 
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ 
    success: false, 
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message 
  });
});

// ============================================================
// START SERVER
// ============================================================

const port = process.env.PORT || 3000;
app.listen(port, () => { 
  console.log(`🚀 Server running on port ${port}`); 
});

// KEEP ALIVE
setInterval(() => { console.log("🟢 Server ping"); }, 60000);

