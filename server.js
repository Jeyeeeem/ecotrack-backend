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

const normalizeEcoTrustLevel = (score, level) => {
  if (level) {
    const lvl = String(level).toLowerCase();
    if (lvl.includes("leader")) return 5;
    if (lvl.includes("champion")) return 4;
    if (lvl.includes("warrior")) return 3;
    if (lvl.includes("newcomer")) return 1;
  }
  const numeric = Number(score) || 0;
  if (numeric >= 1000) return 5;
  if (numeric >= 500) return 4;
  if (numeric >= 200) return 3;
  if (numeric >= 50) return 2;
  return 1;
};

const normalizeBadge = (level, ecoLevel) => {
  if (level) return String(level);
  if (ecoLevel >= 5) return "Eco Leader";
  if (ecoLevel >= 4) return "Eco Champion";
  if (ecoLevel >= 3) return "Eco Warrior";
  if (ecoLevel >= 2) return "Eco Starter";
  return "Newcomer";
};

let managerApprovalsPkCache = { value: "id", loadedAt: 0 };
let managerApprovalsColumnsCache = { value: new Set(), loadedAt: 0 };
const MANAGER_PK_CACHE_TTL_MS = 5 * 60 * 1000;

async function getManagerApprovalsColumns() {
  const now = Date.now();
  if (now - managerApprovalsColumnsCache.loadedAt < MANAGER_PK_CACHE_TTL_MS) {
    return managerApprovalsColumnsCache.value;
  }

  try {
    const columnsResult = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'manager_approvals'`
    );
    const columnSet = new Set(columnsResult.rows.map((row) => row.column_name));
    managerApprovalsColumnsCache = { value: columnSet, loadedAt: now };
    return columnSet;
  } catch (error) {
    return new Set();
  }
}

async function getTableColumns(tableName) {
  try {
    const columnsResult = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [tableName]
    );
    return new Set(columnsResult.rows.map((row) => row.column_name));
  } catch (error) {
    return new Set();
  }
}

async function getManagerApprovalsPkColumn() {
  const now = Date.now();
  if (now - managerApprovalsPkCache.loadedAt < MANAGER_PK_CACHE_TTL_MS) {
    return managerApprovalsPkCache.value;
  }

  try {
    const columnSet = await getManagerApprovalsColumns();
    const resolved = columnSet.has("id")
      ? "id"
      : columnSet.has("approval_id")
      ? "approval_id"
      : "id";
    managerApprovalsPkCache = { value: resolved, loadedAt: now };
    return resolved;
  } catch (error) {
    return "id";
  }
}

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
    const fullName = user.name || "";
    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.user_id,
        userId: user.user_id,
        name: user.name,
        fullName,
        email: user.email,
        role: user.role,
        businessId: user.business_id
      }
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
        address: row.address,
        contactEmail: row.contact_email,
        contactPhone: row.contact_phone,
        currentScore: normalizeEcoTrustLevel(row.current_score, row.level),
        points: Number(row.total_points_earned || 0),
        badge: normalizeBadge(row.level, normalizeEcoTrustLevel(row.current_score, row.level)),
        carbonImpact: 0
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

const toFiniteNumber = (...values) => {
  for (const value of values) {
    const n = Number(value);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return 0;
};

const toFiniteNumberPreferNonZero = (...values) => {
  let fallback = null;
  for (const value of values) {
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isFinite(n)) continue;
    if (n !== 0) return n;
    if (fallback === null) fallback = n;
  }
  return fallback === null ? 0 : fallback;
};

const normalizeLogisticsStop = (stop, index) => {
  const name = stop?.stop_name || stop?.stopName || stop?.location_name || stop?.location || stop?.name || `Stop ${index + 1}`;
  const address = stop?.address || stop?.location || stop?.full_address || "";
  return {
    stop_name: String(name),
    stopName: String(name),
    address: String(address)
  };
};

const parseMaybeJsonObject = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
};

const extractSavingsFromText = (text) => {
  const source = String(text || "");
  if (!source) return { km: 0, fuel: 0, co2: 0 };
  const kmMatch = source.match(/saves?\s+([0-9]+(?:\.[0-9]+)?)\s*km/i);
  const fuelMatch = source.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:l|liters?)\b/i);
  const co2Match = source.match(/([0-9]+(?:\.[0-9]+)?)\s*kg\s*co[2₂]/i);
  return {
    km: kmMatch ? Number(kmMatch[1]) : 0,
    fuel: fuelMatch ? Number(fuelMatch[1]) : 0,
    co2: co2Match ? Number(co2Match[1]) : 0
  };
};

async function buildLogisticsRoutePayload(row, options = {}) {
  const routeIdFromParams = options.routeIdFromParams ? String(options.routeIdFromParams) : null;
  const hasRouteStops = !!options.hasRouteStops;
  const requestData = parseMaybeJsonObject(row.request_data);
  const extraData = parseMaybeJsonObject(row.extra_data);
  const routeData = parseMaybeJsonObject(extraData.route);
  const optimization = parseMaybeJsonObject(extraData.optimization);
  const optimizationData = parseMaybeJsonObject(optimization.optimization_data);
  const requestOptimization = parseMaybeJsonObject(requestData.optimization);
  const requestOptimizationData = parseMaybeJsonObject(requestOptimization.optimization_data);
  const extraOptimizationData = parseMaybeJsonObject(extraData.optimization_data);
  const routeIdRaw =
    routeIdFromParams ||
    row.route_id ||
    row.related_record_id ||
    row.delivery_id ||
    row.id ||
    row.approval_id ||
    requestData.route_id ||
    routeData.route_id;
  const routeId = String(routeIdRaw || "");
  const fromLocation =
    row.from_location ||
    requestData.from_location ||
    routeData.origin_location?.address ||
    row.location ||
    "Warehouse";
  const toLocation =
    row.to_location ||
    requestData.to_location ||
    routeData.destination_location?.address ||
    null;

  let stops = [];
  if (Array.isArray(row.stops_json) && row.stops_json.length > 0) {
    stops = row.stops_json.map(normalizeLogisticsStop);
  } else if (Array.isArray(requestData.stops) && requestData.stops.length > 0) {
    stops = requestData.stops.map(normalizeLogisticsStop);
  } else if (Array.isArray(routeData.stops) && routeData.stops.length > 0) {
    stops = routeData.stops.map(normalizeLogisticsStop);
  } else if (hasRouteStops && routeId) {
    try {
      const stopsResult = await pool.query(
        `SELECT stop_sequence, location_name, address
         FROM route_stops
         WHERE route_id::text = $1
         ORDER BY stop_sequence ASC`,
        [routeId]
      );
      if (stopsResult.rows.length > 0) {
        stops = stopsResult.rows.map(normalizeLogisticsStop);
      }
    } catch (e) {
      // Ignore route stop lookup failures and keep fallback stops below.
    }
  }

  if (stops.length === 0) {
    stops = [normalizeLogisticsStop({ stop_name: fromLocation, address: fromLocation }, 0)];
    if (toLocation) stops.push(normalizeLogisticsStop({ stop_name: toLocation, address: toLocation }, 1));
  }

  const originalDistance = toFiniteNumberPreferNonZero(
    row.original_distance,
    row.total_distance_km,
    requestData.original_distance,
    requestData.original_distance_km,
    routeData.total_distance_km,
    routeData.original_distance,
    routeData.original_distance_km,
    optimization.original_distance,
    optimization.original_distance_km,
    optimizationData.originalDistance,
    optimizationData.original_distance,
    optimizationData.original_distance_km,
    requestOptimization.original_distance,
    requestOptimization.original_distance_km,
    requestOptimizationData.originalDistance,
    requestOptimizationData.original_distance,
    requestOptimizationData.original_distance_km,
    extraOptimizationData.originalDistance,
    extraOptimizationData.original_distance,
    extraOptimizationData.original_distance_km
  );
  const optimizedDistance = toFiniteNumberPreferNonZero(
    row.optimized_distance,
    requestData.optimized_distance,
    requestData.optimized_distance_km,
    routeData.optimized_distance,
    routeData.optimized_distance_km,
    optimization.optimized_distance,
    optimization.optimized_distance_km,
    optimizationData.optimizedDistance,
    optimizationData.optimized_distance,
    optimizationData.optimized_distance_km,
    requestOptimization.optimized_distance,
    requestOptimization.optimized_distance_km,
    requestOptimizationData.optimizedDistance,
    requestOptimizationData.optimized_distance,
    requestOptimizationData.optimized_distance_km,
    extraOptimizationData.optimizedDistance,
    extraOptimizationData.optimized_distance,
    extraOptimizationData.optimized_distance_km
  );
  const originalFuel = toFiniteNumberPreferNonZero(
    row.original_fuel,
    row.estimated_fuel_consumption_liters,
    requestData.original_fuel,
    requestData.original_fuel_liters,
    routeData.estimated_fuel_consumption_liters,
    routeData.original_fuel,
    routeData.original_fuel_liters,
    optimization.original_fuel,
    optimization.original_fuel_liters,
    optimizationData.originalFuel,
    optimizationData.original_fuel,
    optimizationData.original_fuel_liters,
    requestOptimization.original_fuel,
    requestOptimization.original_fuel_liters,
    requestOptimizationData.originalFuel,
    requestOptimizationData.original_fuel,
    requestOptimizationData.original_fuel_liters,
    extraOptimizationData.originalFuel,
    extraOptimizationData.original_fuel,
    extraOptimizationData.original_fuel_liters
  );
  const optimizedFuel = toFiniteNumberPreferNonZero(
    row.optimized_fuel,
    requestData.optimized_fuel,
    requestData.optimized_fuel_liters,
    routeData.optimized_fuel,
    routeData.optimized_fuel_liters,
    optimization.optimized_fuel,
    optimization.optimized_fuel_liters,
    optimizationData.optimizedFuel,
    optimizationData.optimized_fuel,
    optimizationData.optimized_fuel_liters,
    requestOptimization.optimized_fuel,
    requestOptimization.optimized_fuel_liters,
    requestOptimizationData.optimizedFuel,
    requestOptimizationData.optimized_fuel,
    requestOptimizationData.optimized_fuel_liters,
    extraOptimizationData.optimizedFuel,
    extraOptimizationData.optimized_fuel,
    extraOptimizationData.optimized_fuel_liters
  );
  const originalCO2 = toFiniteNumberPreferNonZero(
    row.original_co2,
    row.estimated_carbon_kg,
    requestData.original_co2,
    requestData.original_co2_kg,
    routeData.estimated_carbon_kg,
    routeData.original_co2,
    routeData.original_co2_kg,
    optimization.original_carbon_kg,
    optimization.original_co2,
    optimization.original_co2_kg,
    optimizationData.originalCarbon,
    optimizationData.original_co2,
    optimizationData.original_co2_kg,
    requestOptimization.original_co2,
    requestOptimization.original_co2_kg,
    requestOptimizationData.originalCarbon,
    requestOptimizationData.original_co2,
    requestOptimizationData.original_co2_kg,
    extraOptimizationData.originalCarbon,
    extraOptimizationData.original_co2,
    extraOptimizationData.original_co2_kg
  );
  const optimizedCO2 = toFiniteNumberPreferNonZero(
    row.optimized_co2,
    row.optimized_carbon_kg,
    requestData.optimized_co2,
    requestData.optimized_co2_kg,
    routeData.optimized_co2,
    routeData.optimized_co2_kg,
    optimization.optimized_carbon_kg,
    optimization.optimized_co2,
    optimization.optimized_co2_kg,
    optimizationData.optimizedCarbon,
    optimizationData.optimized_co2,
    optimizationData.optimized_co2_kg,
    requestOptimization.optimized_co2,
    requestOptimization.optimized_co2_kg,
    requestOptimizationData.optimizedCarbon,
    requestOptimizationData.optimized_co2,
    requestOptimizationData.optimized_co2_kg,
    extraOptimizationData.optimizedCarbon,
    extraOptimizationData.optimized_co2,
    extraOptimizationData.optimized_co2_kg
  );
  const aiSuggestion =
    row.ai_suggestion ||
    row.ai_recommendation ||
    requestData.ai_suggestion ||
    requestOptimization.ai_recommendation ||
    optimization.ai_recommendation ||
    requestOptimizationData.aiRecommendation ||
    optimizationData.aiRecommendation ||
    "Optimize this route";
  const textSavings = extractSavingsFromText(aiSuggestion);
  const totalSavingsKm = toFiniteNumberPreferNonZero(
    row.savings_km,
    row.distance_saved_km,
    requestData.savings_km,
    requestData.distance_saved_km,
    routeData.savings_km,
    routeData.distance_saved_km,
    optimization.savings_km,
    optimization.distance_saved_km,
    optimizationData.savingsKm,
    optimizationData.savings_km,
    optimizationData.distance_saved_km,
    requestOptimization.savings_km,
    requestOptimization.distance_saved_km,
    requestOptimizationData.savingsKm,
    requestOptimizationData.savings_km,
    requestOptimizationData.distance_saved_km,
    extraOptimizationData.savingsKm,
    extraOptimizationData.savings_km,
    extraOptimizationData.distance_saved_km,
    textSavings.km
  );
  const totalSavingsFuel = toFiniteNumberPreferNonZero(
    row.savings_fuel,
    row.fuel_saved,
    row.fuel_saved_liters,
    requestData.savings_fuel,
    requestData.fuel_saved,
    requestData.fuel_saved_liters,
    routeData.savings_fuel,
    routeData.fuel_saved,
    routeData.fuel_saved_liters,
    optimization.savings_fuel,
    optimization.fuel_saved,
    optimization.fuel_saved_liters,
    optimizationData.savingsFuel,
    optimizationData.savings_fuel,
    optimizationData.fuel_saved,
    optimizationData.fuel_saved_liters,
    requestOptimization.savings_fuel,
    requestOptimization.fuel_saved,
    requestOptimization.fuel_saved_liters,
    requestOptimizationData.savingsFuel,
    requestOptimizationData.savings_fuel,
    requestOptimizationData.fuel_saved,
    requestOptimizationData.fuel_saved_liters,
    extraOptimizationData.savingsFuel,
    extraOptimizationData.savings_fuel,
    extraOptimizationData.fuel_saved,
    extraOptimizationData.fuel_saved_liters,
    textSavings.fuel
  );
  const totalSavingsCO2 = toFiniteNumberPreferNonZero(
    row.savings_co2,
    row.co2_saved,
    row.co2_saved_kg,
    requestData.savings_co2,
    requestData.co2_saved,
    requestData.co2_saved_kg,
    routeData.savings_co2,
    routeData.co2_saved,
    routeData.co2_saved_kg,
    optimization.savings_co2,
    optimization.co2_saved,
    optimization.co2_saved_kg,
    optimizationData.savingsCo2,
    optimizationData.savings_co2,
    optimizationData.co2_saved,
    optimizationData.co2_saved_kg,
    requestOptimization.savings_co2,
    requestOptimization.co2_saved,
    requestOptimization.co2_saved_kg,
    requestOptimizationData.savingsCo2,
    requestOptimizationData.savings_co2,
    requestOptimizationData.co2_saved,
    requestOptimizationData.co2_saved_kg,
    extraOptimizationData.savingsCo2,
    extraOptimizationData.savings_co2,
    extraOptimizationData.co2_saved,
    extraOptimizationData.co2_saved_kg,
    textSavings.co2
  );

  const submittedBy = row.submitted_by || row.requested_by || row.reviewed_by || "System";
  const payload = {
    route_id: routeId,
    routeId,
    route_type: row.route_type || requestData.route_type || routeData.route_type || row.product_name || "STANDARD",
    routeType: row.route_type || requestData.route_type || routeData.route_type || row.product_name || "STANDARD",
    from_location: fromLocation,
    from: fromLocation,
    to_location: toLocation,
    to: toLocation,
    stops,
    driver_name: row.driver_name || requestData.driver_name || routeData.driver_name || "Unassigned",
    driver: row.driver_name || requestData.driver_name || routeData.driver_name || "Unassigned",
    vehicle_type: row.vehicle_type || requestData.vehicle_type || routeData.vehicle_type || "Van",
    vehicle: row.vehicle_type || requestData.vehicle_type || routeData.vehicle_type || "Van",
    departure_time: row.departure_time || routeData.created_at || row.created_at || null,
    departureTime: row.departure_time || routeData.created_at || row.created_at || null,
    original_distance: originalDistance,
    originalDistance,
    optimized_distance: optimizedDistance,
    optimizedDistance,
    original_fuel: originalFuel,
    originalFuel,
    optimized_fuel: optimizedFuel,
    optimizedFuel,
    original_co2: originalCO2,
    originalCO2,
    optimized_co2: optimizedCO2,
    optimizedCO2,
    savings_km: totalSavingsKm,
    totalSavingsKm,
    savings_fuel: totalSavingsFuel,
    totalSavingsFuel,
    savings_co2: totalSavingsCO2,
    totalSavingsCO2,
    ai_suggestion: aiSuggestion,
    aiSuggestion,
    aiOptimization: {
      originalDistance,
      optimizedDistance,
      originalFuel,
      optimizedFuel,
      originalCO2,
      optimizedCO2
    },
    aiSavings: {
      kmSaved: totalSavingsKm,
      fuelSaved: totalSavingsFuel,
      co2Saved: totalSavingsCO2
    },
    status: row.status || "PENDING",
    submitted_by: String(submittedBy),
    submittedBy: String(submittedBy),
    submitted_at: row.submitted_at || row.created_at || null,
    submittedTime: row.submitted_at || row.created_at || null
  };
  return payload;
}

app.get("/api/logistics/dashboard", async (req, res) => {
  try {
    const pendingRouteStatusPredicate = `
      (
        UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%PEND%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%AWAIT%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%REVIEW%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%SUBMIT%'
        OR (
          approved_at IS NULL
          AND UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g'))
              NOT IN ('APPROVED', 'DECLINED', 'REJECTED', 'CANCELLED', 'COMPLETED')
        )
      )
    `;

    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const canUseManagerRouteData =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";

    let pendingResult;
    let statsResult;

    if (canUseManagerRouteData) {
      pendingResult = await pool.query(
        `SELECT *
         FROM manager_approvals ma
         WHERE ma.approval_type = 'route_optimization'
           AND (
             LOWER(COALESCE(ma.status, '')) IN ('pending', 'awaiting_approval', 'submitted', 'in_review', 'for_approval')
             OR LOWER(COALESCE(ma.status, '')) LIKE '%pending%'
             OR LOWER(COALESCE(ma.status, '')) LIKE '%await%'
             OR LOWER(COALESCE(ma.status, '')) LIKE '%review%'
             OR LOWER(COALESCE(ma.status, '')) LIKE '%submit%'
           )
         ORDER BY ma.created_at DESC
         LIMIT 20`
      );

      statsResult = await pool.query(
        `SELECT 
          COUNT(*) FILTER (WHERE LOWER(status) IN ('pending', 'awaiting_approval')) as pending_count,
          COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
          COUNT(*) FILTER (WHERE status IN ('declined', 'rejected')) as declined_count,
          0::numeric as avg_co2_saved,
          0::numeric as total_co2_reduced,
          0::numeric as total_km_saved
        FROM manager_approvals
        WHERE approval_type = 'route_optimization'`
      );

      // Fallback: some deployments have manager_approvals table but logistics rows only exist in route_approvals.
      if (pendingResult.rows.length === 0 && hasRouteApprovals) {
        pendingResult = await pool.query(
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
          WHERE ${pendingRouteStatusPredicate}
          ORDER BY submitted_at DESC 
          LIMIT 20`
        );

        statsResult = await pool.query(
          `SELECT 
            (SELECT COUNT(*) FROM route_approvals WHERE ${pendingRouteStatusPredicate}) as pending_count,
            (SELECT COUNT(*) FROM route_approvals WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count,
            (SELECT COUNT(*) FROM route_approvals WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count,
            COALESCE(AVG(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as avg_co2_saved,
            COALESCE(SUM(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as total_co2_reduced,
            COALESCE(SUM(savings_km) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as total_km_saved
          FROM route_approvals`
        );
      }
    } else if (hasRouteApprovals) {
      pendingResult = await pool.query(
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
        WHERE ${pendingRouteStatusPredicate}
        ORDER BY submitted_at DESC 
        LIMIT 20`
      );

      statsResult = await pool.query(
        `SELECT 
          (SELECT COUNT(*) FROM route_approvals WHERE ${pendingRouteStatusPredicate}) as pending_count,
          (SELECT COUNT(*) FROM route_approvals WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count,
          (SELECT COUNT(*) FROM route_approvals WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count,
          COALESCE(AVG(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as avg_co2_saved,
          COALESCE(SUM(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as total_co2_reduced,
          COALESCE(SUM(savings_km) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as total_km_saved
        FROM route_approvals`
      );
    } else {
      pendingResult = { rows: [] };
      statsResult = {
        rows: [
          {
            pending_count: 0,
            approved_count: 0,
            declined_count: 0,
            avg_co2_saved: 0,
            total_co2_reduced: 0,
            total_km_saved: 0
          }
        ]
      };
    }

    let driversResult = { rows: [] };
    try {
      driversResult = await pool.query(
        `SELECT 
          u.user_id,
          COALESCE(NULLIF(u.full_name, ''), u.name, u.email) as full_name,
          u.email,
          d.from_location || ' → ' || d.to_location as route_name,
          d.status as route_status, 0 as stops_completed, 2 as stops_total
        FROM users u
        LEFT JOIN deliveries d ON d.driver_name = COALESCE(NULLIF(u.full_name, ''), u.name) AND d.status IN ('assigned', 'accepted', 'in_progress')
        WHERE u.role = 'driver'
        ORDER BY COALESCE(NULLIF(u.full_name, ''), u.name, u.email) ASC`
      );
    } catch (driverErr) {
      console.warn("Logistics driver monitor fallback:", driverErr.message);
    }

    const stats = statsResult.rows[0] || {};
    const routeStopsTableCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
    const hasRouteStops = !!routeStopsTableCheck.rows[0]?.tbl;
    const mappedPendingRoutes = await Promise.all(
      pendingResult.rows.map((row) => buildLogisticsRoutePayload(row, { hasRouteStops }))
    );
    const pendingRouteMap = new Map();
    for (const route of mappedPendingRoutes) {
      const key = `${route.routeId || route.route_id}`;
      const existing = pendingRouteMap.get(key);
      if (!existing) {
        pendingRouteMap.set(key, route);
        continue;
      }
      const existingTs = new Date(existing.submittedTime || existing.submitted_at || 0).getTime();
      const currentTs = new Date(route.submittedTime || route.submitted_at || 0).getTime();
      if (currentTs >= existingTs) pendingRouteMap.set(key, route);
    }
    const pendingRoutes = Array.from(pendingRouteMap.values());

    res.json({
      success: true,
      summary: {
        pendingApprovals: pendingRoutes.length,
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
    res.json({
      success: true,
      summary: {
        pendingApprovals: 0,
        approvedToday: 0,
        declined: 0,
        avgCO2Saved: 0,
        totalCO2Reduced: 0,
        totalKmSaved: 0
      },
      pendingRoutes: [],
      driverMonitor: [],
      message: `Logistics data temporarily unavailable: ${err.message || 'unknown error'}`
    });
  }
});

app.get("/api/logistics/route/:routeId", async (req, res) => {
  try {
    const { routeId } = req.params;
    if (!routeId) {
      return res.status(400).json({ success: false, message: "Route ID is required" });
    }

    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const canUseManagerRouteData =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const routeApprovalColumns = hasRouteApprovals ? await getTableColumns("route_approvals") : new Set();
    const routeStopsTableCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
    const hasRouteStops = !!routeStopsTableCheck.rows[0]?.tbl;

    let row = null;
    if (canUseManagerRouteData) {
      const managerConditions = [`ma.${managerPkCol}::text = $1`];
      if (managerColumns.has("route_id")) managerConditions.push(`COALESCE(ma.route_id::text, '') = $1`);
      if (managerColumns.has("related_record_id")) managerConditions.push(`COALESCE(ma.related_record_id::text, '') = $1`);
      if (managerColumns.has("delivery_id")) managerConditions.push(`COALESCE(ma.delivery_id::text, '') = $1`);
      if (managerColumns.has("request_data")) managerConditions.push(`COALESCE(ma.request_data->>'route_id', '') = $1`);
      if (managerColumns.has("extra_data")) managerConditions.push(`COALESCE(ma.extra_data->'route'->>'route_id', '') = $1`);

    const managerOrderBy = managerColumns.has("created_at")
      ? "ma.created_at DESC"
      : managerColumns.has(managerPkCol)
      ? `ma.${managerPkCol} DESC`
      : "1";
    const managerResult = await pool.query(
        `SELECT *
         FROM manager_approvals ma
         WHERE ma.approval_type = 'route_optimization'
           AND (
             ${managerConditions.join("\n             OR ")}
           )
         ORDER BY ${managerOrderBy}
         LIMIT 1`,
        [routeId]
      );
      row = managerResult.rows[0] || null;
    }

    if (!row && hasRouteApprovals) {
      const routeConditions = [`ra.id::text = $1`];
      if (routeApprovalColumns.has("route_id")) routeConditions.push(`COALESCE(ra.route_id::text, '') = $1`);

      const routeResult = await pool.query(
        `SELECT *
         FROM route_approvals ra
         WHERE ${routeConditions.join("\n            OR ")}
         ORDER BY ra.id DESC
         LIMIT 1`,
        [routeId]
      );
      row = routeResult.rows[0] || null;
    }

    if (!row) {
      return res.status(404).json({ success: false, message: "Route not found" });
    }

    const route = await buildLogisticsRoutePayload(row, { routeIdFromParams: routeId, hasRouteStops });
    return res.json({ success: true, route, message: null });
  } catch (err) {
    console.error("Logistics route details error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to fetch route details" });
  }
});

app.get("/api/logistics/pending", async (req, res) => {
  try {
    const pendingRouteStatusPredicate = `
      (
        UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%PEND%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%AWAIT%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%REVIEW%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%SUBMIT%'
        OR (
          approved_at IS NULL
          AND UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g'))
              NOT IN ('APPROVED', 'DECLINED', 'REJECTED', 'CANCELLED', 'COMPLETED')
        )
      )
    `;

    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const canUseManagerRouteData =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    let result;
    let usedManagerRows = false;
    if (canUseManagerRouteData) {
      result = await pool.query(`
        SELECT *
        FROM manager_approvals ma
        WHERE ma.approval_type = 'route_optimization'
          AND (
            LOWER(COALESCE(ma.status, '')) IN ('pending', 'awaiting_approval', 'submitted', 'in_review', 'for_approval')
            OR LOWER(COALESCE(ma.status, '')) LIKE '%pending%'
            OR LOWER(COALESCE(ma.status, '')) LIKE '%await%'
            OR LOWER(COALESCE(ma.status, '')) LIKE '%review%'
            OR LOWER(COALESCE(ma.status, '')) LIKE '%submit%'
          )
        ORDER BY ma.created_at DESC
      `);
      usedManagerRows = true;

      // Fallback to route_approvals when manager_approvals has no logistics records.
      if (result.rows.length === 0 && hasRouteApprovals) {
        result = await pool.query(`
          SELECT id, route_type as product_name, from_location as location, driver_name, vehicle_type, departure_time, 
                 original_distance as total_distance_km, optimized_distance, original_fuel as estimated_fuel_consumption_liters, 
                 optimized_fuel, original_co2 as estimated_carbon_kg, optimized_co2 as optimized_carbon_kg, 
                 savings_km, savings_fuel, savings_co2, ai_suggestion as ai_recommendation, status, 
                 submitted_by, submitted_at as created_at 
          FROM route_approvals
          WHERE ${pendingRouteStatusPredicate}
          ORDER BY submitted_at DESC
        `);
        usedManagerRows = false;
      }
    } else if (hasRouteApprovals) {
      result = await pool.query(`
        SELECT id, route_type as product_name, from_location as location, driver_name, vehicle_type, departure_time, 
               original_distance as total_distance_km, optimized_distance, original_fuel as estimated_fuel_consumption_liters, 
               optimized_fuel, original_co2 as estimated_carbon_kg, optimized_co2 as optimized_carbon_kg, 
               savings_km, savings_fuel, savings_co2, ai_suggestion as ai_recommendation, status, 
               submitted_by, submitted_at as created_at 
        FROM route_approvals
        WHERE ${pendingRouteStatusPredicate}
        ORDER BY submitted_at DESC
      `);
    } else {
      result = { rows: [] };
    }
    const getNum = (...vals) => {
      for (const v of vals) {
        const n = Number(v);
        if (!Number.isNaN(n) && Number.isFinite(n)) return n;
      }
      return 0;
    };

    const data = usedManagerRows
      ? result.rows.map((row) => {
          const requestData = row.request_data && typeof row.request_data === "object" ? row.request_data : {};
          const extraData = row.extra_data && typeof row.extra_data === "object" ? row.extra_data : {};
          const routeData = extraData.route && typeof extraData.route === "object" ? extraData.route : {};
          const optimization = extraData.optimization && typeof extraData.optimization === "object" ? extraData.optimization : {};
          const optimizationData = optimization.optimization_data && typeof optimization.optimization_data === "object"
            ? optimization.optimization_data
            : {};

          return {
            id: row[managerPkCol] || row.approval_id || row.id || row.delivery_id || routeData.route_id || null,
            product_name: row.product_name || requestData.route_type || routeData.route_type || "STANDARD",
            location: row.location || requestData.from_location || routeData.origin_location?.address || "Unknown",
            driver_name: row.driver_name || requestData.driver_name || routeData.driver_name || null,
            vehicle_type: row.vehicle_type || requestData.vehicle_type || routeData.vehicle_type || null,
            departure_time: row.departure_time || routeData.created_at || row.created_at || null,
            total_distance_km: getNum(row.total_distance_km, requestData.original_distance, optimization.original_distance, optimizationData.originalDistance),
            optimized_distance: getNum(row.optimized_distance, requestData.optimized_distance, optimization.optimized_distance, optimizationData.optimizedDistance),
            estimated_fuel_consumption_liters: getNum(row.estimated_fuel_consumption_liters, requestData.original_fuel, optimization.original_fuel, optimizationData.originalFuel),
            optimized_fuel: getNum(row.optimized_fuel, requestData.optimized_fuel, optimization.optimized_fuel, optimizationData.optimizedFuel),
            estimated_carbon_kg: getNum(row.estimated_carbon_kg, requestData.original_co2, optimization.original_carbon_kg, optimizationData.originalCarbon),
            optimized_carbon_kg: getNum(row.optimized_carbon_kg, requestData.optimized_co2, optimization.optimized_carbon_kg, optimizationData.optimizedCarbon),
            savings_km: getNum(row.savings_km, requestData.savings_km, optimization.savings_km, optimizationData.savingsKm),
            savings_fuel: getNum(row.savings_fuel, requestData.savings_fuel, optimization.savings_fuel, optimizationData.savingsFuel),
            savings_co2: getNum(row.savings_co2, requestData.savings_co2, optimization.savings_co2, optimizationData.savingsCo2),
            ai_recommendation: row.ai_recommendation || row.ai_suggestion || requestData.ai_suggestion || optimization.ai_recommendation || optimizationData.aiRecommendation || "Optimize route",
            status: String(row.status || "pending").toUpperCase(),
            submitted_by: row.submitted_by ? String(row.submitted_by) : row.requested_by ? String(row.requested_by) : "System",
            created_at: row.created_at || null
          };
        })
      : result.rows;

    res.json({ success: true, data, message: null });
  } catch (err) { res.json({ success: true, data: [], message: "Logistics pending unavailable" }); }
});

app.get("/api/logistics/stats", async (req, res) => {
  try {
    const pendingRouteStatusPredicate = `
      (
        UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%PEND%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%AWAIT%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%REVIEW%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%SUBMIT%'
        OR (
          approved_at IS NULL
          AND UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g'))
              NOT IN ('APPROVED', 'DECLINED', 'REJECTED', 'CANCELLED', 'COMPLETED')
        )
      )
    `;

    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const canUseManagerStats =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");
    let result = canUseManagerStats
      ? await pool.query(`
          SELECT COUNT(*) FILTER (WHERE LOWER(status) IN ('pending', 'awaiting_approval')) as pending_count, 
                 COUNT(*) FILTER (WHERE LOWER(status) = 'approved') as approved_count, 
                 COUNT(*) FILTER (WHERE LOWER(status) IN ('declined', 'rejected')) as declined_count, 
                 0::numeric as avg_co2_saved
          FROM manager_approvals
          WHERE approval_type = 'route_optimization'
        `)
      : hasRouteApprovals
      ? await pool.query(`
          SELECT COUNT(*) FILTER (WHERE ${pendingRouteStatusPredicate}) as pending_count, 
                 COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count, 
                 COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count, 
                 COALESCE(AVG(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as avg_co2_saved 
          FROM route_approvals
        `)
      : await pool.query(`
          SELECT COUNT(*) FILTER (WHERE status = 'pending') as pending_count, 
                 COUNT(*) FILTER (WHERE status = 'approved') as approved_count, 
                 COUNT(*) FILTER (WHERE status = 'declined') as declined_count, 
                 0::numeric as avg_co2_saved
          FROM manager_approvals
          WHERE approval_type = 'route_optimization'
        `);

    if (canUseManagerStats && hasRouteApprovals) {
      const counts = result.rows[0] || {};
      const managerTotal =
        (parseInt(counts.pending_count, 10) || 0) +
        (parseInt(counts.approved_count, 10) || 0) +
        (parseInt(counts.declined_count, 10) || 0);
      if (managerTotal === 0) {
        result = await pool.query(`
          SELECT COUNT(*) FILTER (WHERE ${pendingRouteStatusPredicate}) as pending_count, 
                 COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count, 
                 COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count, 
                 COALESCE(AVG(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as avg_co2_saved 
          FROM route_approvals
        `);
      }
    }
    res.json({ success: true, data: result.rows[0], message: null });
  } catch (err) { res.json({ success: true, data: { pending_count: 0, approved_count: 0, declined_count: 0, avg_co2_saved: 0 }, message: "Logistics stats unavailable" }); }
});

app.get("/api/logistics/driver-monitor", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.user_id, COALESCE(NULLIF(u.full_name, ''), u.name, u.email) as full_name, u.email, d.from_location || ' → ' || d.to_location as route_name, 
             d.status as route_status, 0 as stops_completed, 2 as stops_total 
      FROM users u 
      LEFT JOIN deliveries d ON d.driver_name = COALESCE(NULLIF(u.full_name, ''), u.name) AND d.status IN ('assigned', 'accepted', 'in_progress') 
      WHERE u.role = 'driver' ORDER BY COALESCE(NULLIF(u.full_name, ''), u.name, u.email) ASC
    `);
    res.json({ success: true, data: result.rows, message: null });
  } catch (err) { res.json({ success: true, data: [], message: "Driver monitor unavailable" }); }
});

app.patch("/api/logistics/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { comment, driver_id } = req.body;
  try {
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    if (hasManagerApprovals) {
      const maResult = await pool.query(
        `UPDATE manager_approvals 
         SET status = 'approved', manager_comment = $1, decision_notes = $1, reviewed_at = NOW(), updated_at = NOW()
         WHERE ${managerPkCol} = $2 AND approval_type = 'route_optimization'
         RETURNING *`,
        [comment || '', id]
      );
      if (hasRouteApprovals) {
        if (maResult.rows.length > 0) {
          const routeRef = maResult.rows[0].route_id || maResult.rows[0].delivery_id;
          if (routeRef) {
            await pool.query(
              `UPDATE route_approvals 
               SET status = 'APPROVED', manager_comment = $1, approved_at = NOW()
               WHERE id = $2`,
              [comment || '', routeRef]
            );
          }
        } else {
          // Fallback when client passes a route_approvals id instead of manager_approvals id
          await pool.query(
            `UPDATE route_approvals 
             SET status = 'APPROVED', manager_comment = $1, approved_at = NOW()
             WHERE id = $2`,
            [comment || '', id]
          );
        }
      }
      return res.json({ success: true, message: "Approved" });
    }

    if (!hasRouteApprovals) {
      await pool.query(
        `UPDATE manager_approvals 
         SET status = 'approved', manager_comment = $1, decision_notes = $1, reviewed_at = NOW(), updated_at = NOW()
         WHERE ${managerPkCol} = $2`,
        [comment || '', id]
      );
      return res.json({ success: true, message: "Approved" });
    }

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
  } catch (err) { res.json({ success: false, message: "Approval failed" }); }
});

app.patch("/api/logistics/:id/decline", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  try {
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    if (hasManagerApprovals) {
      const maResult = await pool.query(
        `UPDATE manager_approvals
         SET status = 'declined', manager_comment = $1, decision_notes = $1, reviewed_at = NOW(), updated_at = NOW()
         WHERE ${managerPkCol} = $2 AND approval_type = 'route_optimization'
         RETURNING *`,
        [reason || '', id]
      );
      if (hasRouteApprovals) {
        if (maResult.rows.length > 0) {
          const routeRef = maResult.rows[0].route_id || maResult.rows[0].delivery_id;
          if (routeRef) {
            await pool.query(`UPDATE route_approvals SET status = 'DECLINED', manager_comment = $1, approved_at = NOW() WHERE id = $2`, [reason || '', routeRef]);
          }
        } else {
          await pool.query(`UPDATE route_approvals SET status = 'DECLINED', manager_comment = $1, approved_at = NOW() WHERE id = $2`, [reason || '', id]);
        }
      }
    } else if (hasRouteApprovals) {
      await pool.query(`UPDATE route_approvals SET status = 'DECLINED', manager_comment = $1, approved_at = NOW() WHERE id = $2`, [reason || '', id]);
    } else {
      await pool.query(
        `UPDATE manager_approvals
         SET status = 'declined', manager_comment = $1, decision_notes = $1, reviewed_at = NOW(), updated_at = NOW()
         WHERE ${managerPkCol} = $2`,
        [reason || '', id]
      );
    }
    res.json({ success: true, message: "Declined" });
  } catch (err) { res.json({ success: false, message: "Decline failed" }); }
});

app.get("/api/logistics/history", async (req, res) => {
  try {
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const canUseManagerRouteData =
      hasManagerApprovals &&
      managerColumns.has("request_data") &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    let result = canUseManagerRouteData
      ? await pool.query(`
          SELECT
            ma.${managerPkCol} as approval_id,
            ma.${managerPkCol} as route_id,
            COALESCE(ma.request_data->>'route_type', 'STANDARD') as product_name,
            COALESCE(ma.request_data->>'from_location', 'Unknown') as location,
            ma.request_data->>'driver_name' as driver_name,
            UPPER(ma.status) as status,
            COALESCE((ma.request_data->>'savings_km')::numeric, 0) as savings_km,
            COALESCE((ma.request_data->>'savings_co2')::numeric, 0) as savings_co2,
            ma.reviewed_at as reviewed_at,
            COALESCE(ma.manager_comment, ma.decision_notes) as review_notes
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(ma.status) IN ('approved', 'declined', 'rejected')
          ORDER BY ma.reviewed_at DESC NULLS LAST, ma.updated_at DESC
          LIMIT 100
        `)
      : hasRouteApprovals
      ? await pool.query(`
          SELECT id as approval_id, id as route_id, route_type as product_name, from_location as location, driver_name, 
                 status, savings_km, savings_co2, approved_at as reviewed_at, manager_comment as review_notes 
          FROM route_approvals WHERE status IN ('APPROVED', 'DECLINED', 'REJECTED') ORDER BY approved_at DESC LIMIT 100
        `)
      : { rows: [] };

    if (hasRouteApprovals && result.rows.length === 0) {
      result = await pool.query(`
        SELECT id as approval_id, id as route_id, route_type as product_name, from_location as location, driver_name, 
               status, savings_km, savings_co2, approved_at as reviewed_at, manager_comment as review_notes 
        FROM route_approvals WHERE status IN ('APPROVED', 'DECLINED', 'REJECTED') ORDER BY approved_at DESC LIMIT 100
      `);
    }
    res.json({ success: true, data: result.rows, message: null });
  } catch (err) { res.json({ success: true, data: [], message: "History unavailable" }); }
});

app.post("/api/logistics/approve", async (req, res) => {
  const { routeId, decision, comment } = req.body;
  try {
    const statusNormalized = String(decision || "").toUpperCase();
    const status = statusNormalized === 'APPROVE' ? 'APPROVED' : statusNormalized === 'PENDING' ? 'PENDING' : 'DECLINED';
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;

    if (hasManagerApprovals) {
      const maResult = await pool.query(
        `UPDATE manager_approvals
         SET status = LOWER($1), manager_comment = $2, decision_notes = $2, reviewed_at = NOW(), updated_at = NOW()
         WHERE ${managerPkCol} = $3 AND approval_type = 'route_optimization'
         RETURNING *`,
        [status, comment || '', routeId]
      );
      if (hasRouteApprovals) {
        if (maResult.rows.length > 0) {
          const routeRef = maResult.rows[0].route_id || maResult.rows[0].delivery_id;
          if (routeRef) {
            await pool.query(`UPDATE route_approvals SET status = $1, manager_comment = $2, approved_at = NOW() WHERE id = $3`, [status, comment || '', routeRef]);
          }
        } else {
          await pool.query(`UPDATE route_approvals SET status = $1, manager_comment = $2, approved_at = NOW() WHERE id = $3`, [status, comment || '', routeId]);
        }
      }
    } else if (hasRouteApprovals) {
      await pool.query(`UPDATE route_approvals SET status = $1, manager_comment = $2, approved_at = NOW() WHERE id = $3`, [status, comment || '', routeId]);
    } else {
      await pool.query(
        `UPDATE manager_approvals
         SET status = LOWER($1), manager_comment = $2, decision_notes = $2, reviewed_at = NOW(), updated_at = NOW()
         WHERE ${managerPkCol} = $3`,
        [status, comment || '', routeId]
      );
    }
    res.json({ success: true, message: `Route ${status.toLowerCase()} successfully` });
  } catch (err) { res.json({ success: false, message: "Update failed" }); }
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
    const normalizedDecision = String(decision || "").toUpperCase();
    const isVerify = ["VERIFY", "VERIFIED", "APPROVE", "APPROVED"].includes(normalizedDecision);
    const carbonStatus = isVerify ? 'verified' : 'revision_requested';
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
    const { driver_name } = req.query;
    const hasDriverFilter = !!driver_name;
    const args = hasDriverFilter ? [driver_name] : [];
    const clause = hasDriverFilter ? `AND d.driver_name = $1` : ``;

    const statsResult = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE d.status = 'completed') as total_completed, 
             COALESCE(SUM(d.distance_km) FILTER (WHERE d.status = 'completed'), 0) as total_km, 
             COALESCE(SUM(d.fuel_consumption) FILTER (WHERE d.status = 'completed'), 0) as total_fuel, 
             COALESCE(SUM(d.carbon_emissions) FILTER (WHERE d.status = 'completed'), 0) as total_carbon,
             COUNT(*) FILTER (WHERE d.status IN ('assigned', 'accepted', 'in_progress')) as active_deliveries
      FROM deliveries d
      WHERE d.driver_name IS NOT NULL ${clause}
    `, args);

    const pendingAcceptanceResult = await pool.query(`
      SELECT d.delivery_id, d.route_id, d.status, d.driver_name, d.vehicle_type, d.departure_time, d.arrival_time,
             d.from_location, d.to_location, d.distance_km, d.estimated_fuel_consumption_liters, d.fuel_consumption,
             d.estimated_carbon_kg, d.carbon_emissions, d.stops_json, d.delivery_items_json
      FROM deliveries d
      WHERE d.status = 'assigned' ${clause}
      ORDER BY d.created_at DESC
      LIMIT 20
    `, args);

    const activeResult = await pool.query(`
      SELECT d.delivery_id, d.route_id, d.status, d.driver_name, d.vehicle_type, d.departure_time, d.arrival_time,
             d.from_location, d.to_location, d.distance_km, d.estimated_fuel_consumption_liters, d.fuel_consumption,
             d.estimated_carbon_kg, d.carbon_emissions, d.stops_json, d.delivery_items_json
      FROM deliveries d
      WHERE d.status IN ('accepted', 'in_progress') ${clause}
      ORDER BY d.created_at DESC
      LIMIT 20
    `, args);

    const completedResult = await pool.query(`
      SELECT d.delivery_id, d.route_id, d.status, d.driver_name, d.vehicle_type, d.departure_time, d.arrival_time,
             d.from_location, d.to_location, d.distance_km, d.estimated_fuel_consumption_liters, d.fuel_consumption,
             d.estimated_carbon_kg, d.carbon_emissions, d.stops_json, d.delivery_items_json, d.completed_at
      FROM deliveries d
      WHERE d.status = 'completed' ${clause}
      ORDER BY d.completed_at DESC NULLS LAST, d.created_at DESC
      LIMIT 20
    `, args);


    const mapDelivery = (row) => ({
      deliveryId: row.delivery_id,
      routeId: row.route_id,
      status: row.status,
      driver: row.driver_name,
      vehicle: row.vehicle_type,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      from: row.from_location,
      to: row.to_location,
      distance: parseFloat(row.distance_km) || 0,
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
      actualFuel: parseFloat(row.fuel_consumption) || 0,
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
      actualCO2: parseFloat(row.carbon_emissions) || 0,
      stops: Array.isArray(row.stops_json)
        ? row.stops_json.map((stop, idx) => ({
            stopName: stop.stopName || stop.location_name || stop.location || `Stop ${idx + 1}`,
            address: stop.address || stop.location || "",
            status: stop.status || "pending",
            latitude: stop.latitude ?? null,
            longitude: stop.longitude ?? null
          }))
        : [],
      items: Array.isArray(row.delivery_items_json)
        ? row.delivery_items_json.map(item => ({
            productName: item.productName || item.product_name || "Item",
            quantity: String(item.quantity ?? ""),
            status: item.status || null
          }))
        : []
    });

    const pendingAcceptance = pendingAcceptanceResult.rows.map(mapDelivery);
    const activeDeliveries = activeResult.rows.map(mapDelivery);
    const recentCompletions = completedResult.rows.map(mapDelivery);
    const activeDelivery = activeDeliveries[0] || null;

    const stats = statsResult.rows[0] || {};
    res.json({ 
      success: true, 
      pendingAcceptance,
      activeDelivery,
      activeDeliveries,
      upcomingAssignments: pendingAcceptance,
      recentCompletions,
      alerts: [],
      summary: { 
        totalCompleted: parseInt(stats.total_completed) || 0, 
        activeDeliveries: parseInt(stats.active_deliveries) || 0, 
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
    const { driver_name } = req.query;
    let query = `
      SELECT d.*, ra.route_type
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name IS NOT NULL
    `;
    const params = [];
    if (driver_name) {
      params.push(driver_name);
      query += ` AND d.driver_name = $1`;
    }
    query += ` ORDER BY d.created_at DESC LIMIT 50`;
    let result = await pool.query(query, params);
    let routes = result.rows.map(row => ({
      deliveryId: row.delivery_id,
      routeId: row.route_id,
      status: row.status,
      driver: row.driver_name,
      vehicle: row.vehicle_type,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      from: row.from_location,
      to: row.to_location,
      distance: parseFloat(row.distance_km) || 0,
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
      actualFuel: parseFloat(row.fuel_consumption) || 0,
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
      actualCO2: parseFloat(row.carbon_emissions) || 0
    }));

    // Fallback for deployments where driver routes are stored in manager_approvals.extra_data
    // and deliveries rows are not yet created.
    if (routes.length === 0 && driver_name) {
      const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
      const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
      if (hasManagerApprovals) {
        const managerRows = await pool.query(`
          SELECT *
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(COALESCE(ma.driver_name, ma.extra_data->'route'->>'driver_name', '')) = LOWER($1)
          ORDER BY ma.created_at DESC
          LIMIT 50
        `, [driver_name]);

        const mapStatus = (status) => {
          const s = String(status || "").toLowerCase();
          if (s.includes("reject") || s.includes("declin")) return "declined";
          if (s.includes("complete")) return "completed";
          if (s.includes("progress")) return "in_progress";
          if (s.includes("approve") || s.includes("accept")) return "accepted";
          return "assigned";
        };

        routes = managerRows.rows.map(row => {
          const extra = row.extra_data && typeof row.extra_data === "object" ? row.extra_data : {};
          const route = extra.route && typeof extra.route === "object" ? extra.route : {};
          const opt = extra.optimization && typeof extra.optimization === "object" ? extra.optimization : {};
          const optData = opt.optimization_data && typeof opt.optimization_data === "object" ? opt.optimization_data : {};
          const num = (...vals) => {
            for (const v of vals) {
              const n = Number(v);
              if (!Number.isNaN(n) && Number.isFinite(n)) return n;
            }
            return 0;
          };

          return {
            deliveryId: row.delivery_id || row.approval_id,
            routeId: route.route_id || row.delivery_id || row.approval_id,
            status: mapStatus(row.status || row.decision),
            driver: row.driver_name || route.driver_name || driver_name,
            vehicle: row.vehicle_type || route.vehicle_type || "Van",
            departureTime: route.created_at || row.created_at || null,
            arrivalTime: row.reviewed_at || row.decision_date || null,
            from: route.origin_location?.address || row.location || "",
            to: route.destination_location?.address || "",
            distance: num(row.total_distance_km, route.total_distance_km, opt.optimized_distance, optData.optimizedDistance),
            estimatedFuel: num(row.estimated_fuel_consumption_liters, route.estimated_fuel_consumption_liters, opt.original_fuel, optData.originalFuel),
            actualFuel: num(row.optimized_fuel, opt.optimized_fuel, optData.optimizedFuel),
            estimatedCO2: num(row.estimated_carbon_kg, route.estimated_carbon_kg, opt.original_carbon_kg, optData.originalCarbon),
            actualCO2: num(row.optimized_carbon_kg, opt.optimized_carbon_kg, optData.optimizedCarbon)
          };
        });
      }
    }
    res.json({ success: true, routes });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/driver/delivery/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT d.*, ra.route_type
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.delivery_id = $1
      LIMIT 1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    const row = result.rows[0];

    let stops = [];
    const stopsResult = await pool.query(`
      SELECT stop_sequence, location_name, address, latitude, longitude, status
      FROM route_stops
      WHERE route_id = $1
      ORDER BY stop_sequence ASC
    `, [row.route_id]);

    if (stopsResult.rows.length > 0) {
      stops = stopsResult.rows.map(stop => ({
        stopId: stop.stop_sequence,
        sequence: stop.stop_sequence,
        stopName: stop.location_name || `Stop ${stop.stop_sequence}`,
        address: stop.address || "",
        latitude: stop.latitude !== null ? parseFloat(stop.latitude) : null,
        longitude: stop.longitude !== null ? parseFloat(stop.longitude) : null,
        status: stop.status || "pending"
      }));
    } else if (Array.isArray(row.stops_json)) {
      stops = row.stops_json.map((stop, idx) => ({
        stopId: idx + 1,
        sequence: idx + 1,
        stopName: stop.stopName || stop.location_name || stop.location || `Stop ${idx + 1}`,
        address: stop.address || stop.location || "",
        latitude: stop.latitude ?? null,
        longitude: stop.longitude ?? null,
        status: stop.status || "pending"
      }));
    } else {
      stops = [
        { stopId: 1, sequence: 1, stopName: row.from_location || "Warehouse", address: row.from_location || "", status: "completed" },
        { stopId: 2, sequence: 2, stopName: row.to_location || "Destination", address: row.to_location || "", status: row.status === "completed" ? "completed" : "pending" }
      ];
    }

    res.json({
      success: true,
      delivery: {
        deliveryId: row.delivery_id,
        routeId: row.route_id,
        status: row.status,
        driver: row.driver_name,
        vehicle: row.vehicle_type,
        departureTime: row.departure_time,
        arrivalTime: row.arrival_time,
        from: row.from_location,
        to: row.to_location,
        distance: parseFloat(row.distance_km) || 0,
        estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
        actualFuel: parseFloat(row.fuel_consumption) || 0,
        estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
        actualCO2: parseFloat(row.carbon_emissions) || 0,
        stops
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error" });
  }
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

app.post("/api/driver/confirm-stop", async (req, res) => {
  const { deliveryId, stopIndex, confirmationType } = req.body;
  try {
    const deliveryResult = await pool.query(`SELECT route_id, stops_json FROM deliveries WHERE delivery_id = $1`, [deliveryId]);
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    const delivery = deliveryResult.rows[0];
    const routeId = delivery.route_id;
    const stopSequence = Number(stopIndex) + 1;
    const isArrival = String(confirmationType || "").toLowerCase() === "arrival";

    await pool.query(`
      UPDATE route_stops
      SET
        actual_arrival_time = CASE WHEN $1 THEN NOW() ELSE actual_arrival_time END,
        actual_departure_time = CASE WHEN $1 THEN actual_departure_time ELSE NOW() END,
        status = CASE WHEN $1 THEN 'arrived' ELSE 'completed' END,
        updated_at = NOW()
      WHERE route_id = $2 AND stop_sequence = $3
    `, [isArrival, routeId, stopSequence]);

    if (Array.isArray(delivery.stops_json) && delivery.stops_json[stopIndex]) {
      const updatedStops = [...delivery.stops_json];
      updatedStops[stopIndex] = {
        ...updatedStops[stopIndex],
        status: isArrival ? "arrived" : "completed"
      };
      await pool.query(`UPDATE deliveries SET stops_json = $1 WHERE delivery_id = $2`, [JSON.stringify(updatedStops), deliveryId]);
    }

    res.json({ success: true, message: isArrival ? "Stop arrival confirmed" : "Stop departure confirmed" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error" });
  }
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
    let result = await pool.query(`
      SELECT d.*, ra.route_type, ra.original_distance, ra.optimized_distance, 
             ra.original_fuel, ra.optimized_fuel, ra.original_co2, ra.optimized_co2,
             ra.savings_km, ra.savings_fuel, ra.savings_co2
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name = $1 AND d.status IN ('assigned', 'accepted', 'in_progress')
      ORDER BY d.departure_time ASC
    `, [driver_name]);

    if (result.rows.length === 0) {
      const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
      const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
      if (hasManagerApprovals) {
        result = await pool.query(`
          SELECT *
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(COALESCE(ma.driver_name, ma.extra_data->'route'->>'driver_name', '')) = LOWER($1)
            AND LOWER(COALESCE(ma.status, '')) IN ('pending', 'approved', 'accepted', 'in_progress', 'awaiting_approval')
          ORDER BY ma.created_at ASC
        `, [driver_name]);
      }
    }
    
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
    
    let result = await pool.query(`
      SELECT d.*, ra.route_type, ra.from_location, ra.to_location, 
             ra.original_distance, ra.optimized_distance, ra.original_fuel, ra.optimized_fuel,
             ra.original_co2, ra.optimized_co2, ra.savings_km, ra.savings_fuel, ra.savings_co2,
             ra.ai_suggestion
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name = $1 AND d.status = 'assigned'
      ORDER BY d.departure_time ASC
    `, [driver_name]);

    if (result.rows.length === 0) {
      const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
      const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
      if (hasManagerApprovals) {
        result = await pool.query(`
          SELECT *
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(COALESCE(ma.driver_name, ma.extra_data->'route'->>'driver_name', '')) = LOWER($1)
            AND (
              LOWER(COALESCE(ma.status, '')) IN ('pending', 'awaiting_approval', 'submitted', 'assigned')
              OR LOWER(COALESCE(ma.status, '')) LIKE '%pending%'
              OR LOWER(COALESCE(ma.status, '')) LIKE '%await%'
            )
          ORDER BY ma.created_at ASC
        `, [driver_name]);
      }
    }
    
    res.json({ success: true, deliveries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Driver history endpoint for Delivery > History screen.
app.get("/api/driver/history", async (req, res) => {
  try {
    const { driver_name } = req.query;
    if (!driver_name) {
      return res.status(400).json({ success: false, message: "Driver name is required" });
    }

    const deliveriesHistory = await pool.query(`
      SELECT d.*, ra.route_type
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE LOWER(COALESCE(d.driver_name, '')) = LOWER($1)
        AND d.status IN ('completed', 'declined', 'cancelled')
      ORDER BY d.completed_at DESC NULLS LAST, d.arrival_time DESC NULLS LAST, d.created_at DESC
      LIMIT 100
    `, [driver_name]);

    let history = deliveriesHistory.rows.map(row => ({
      deliveryId: row.delivery_id,
      routeId: row.route_id,
      routeType: row.route_type || null,
      status: row.status,
      driver: row.driver_name,
      vehicle: row.vehicle_type,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      completedAt: row.completed_at || row.arrival_time || null,
      from: row.from_location,
      to: row.to_location,
      distance: parseFloat(row.distance_km) || 0,
      estimatedFuel: parseFloat(row.estimated_fuel_consumption_liters) || 0,
      actualFuel: parseFloat(row.fuel_consumption) || 0,
      estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0,
      actualCO2: parseFloat(row.carbon_emissions) || 0
    }));

    // Fallback history from manager approvals if delivery history table is empty.
    if (history.length === 0) {
      const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
      const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
      if (hasManagerApprovals) {
        const managerHistory = await pool.query(`
          SELECT *
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(COALESCE(ma.driver_name, ma.extra_data->'route'->>'driver_name', '')) = LOWER($1)
            AND LOWER(COALESCE(ma.status, '')) IN ('approved', 'rejected', 'declined')
          ORDER BY ma.reviewed_at DESC NULLS LAST, ma.decision_date DESC NULLS LAST, ma.created_at DESC
          LIMIT 100
        `, [driver_name]);

        const num = (...vals) => {
          for (const v of vals) {
            const n = Number(v);
            if (!Number.isNaN(n) && Number.isFinite(n)) return n;
          }
          return 0;
        };

        history = managerHistory.rows.map(row => {
          const extra = row.extra_data && typeof row.extra_data === "object" ? row.extra_data : {};
          const route = extra.route && typeof extra.route === "object" ? extra.route : {};
          const opt = extra.optimization && typeof extra.optimization === "object" ? extra.optimization : {};
          const optData = opt.optimization_data && typeof opt.optimization_data === "object" ? opt.optimization_data : {};
          return {
            deliveryId: row.delivery_id || row.approval_id,
            routeId: route.route_id || row.delivery_id || row.approval_id,
            routeType: route.route_type || null,
            status: row.status,
            driver: row.driver_name || route.driver_name || driver_name,
            vehicle: row.vehicle_type || route.vehicle_type || "Van",
            departureTime: route.created_at || row.created_at || null,
            arrivalTime: row.reviewed_at || row.decision_date || null,
            completedAt: row.reviewed_at || row.decision_date || row.created_at || null,
            from: route.origin_location?.address || row.location || "",
            to: route.destination_location?.address || "",
            distance: num(row.total_distance_km, route.total_distance_km, opt.optimized_distance, optData.optimizedDistance),
            estimatedFuel: num(row.estimated_fuel_consumption_liters, route.estimated_fuel_consumption_liters, opt.original_fuel, optData.originalFuel),
            actualFuel: num(row.optimized_fuel, opt.optimized_fuel, optData.optimizedFuel),
            estimatedCO2: num(row.estimated_carbon_kg, route.estimated_carbon_kg, opt.original_carbon_kg, optData.originalCarbon),
            actualCO2: num(row.optimized_carbon_kg, opt.optimized_carbon_kg, optData.optimizedCarbon)
          };
        });
      }
    }

    res.json({ success: true, history, message: null });
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
const workflowRoutes = require('./routes/workflow.routes');
app.use('/api/workflow', workflowRoutes);


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

