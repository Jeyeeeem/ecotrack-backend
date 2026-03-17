// ============================================================
// FILE: server.js
// EcoTrack Backend - Complete REST AP
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

// Lightweight table existence check with memoization
const tableExistsCache = new Map();
const TABLE_EXISTS_TTL_MS = 5 * 60 * 1000;
async function tableExists(tableName) {
  const key = String(tableName || "").toLowerCase();
  const cached = tableExistsCache.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < TABLE_EXISTS_TTL_MS) return cached.exists;
  try {
    const result = await pool.query(`SELECT to_regclass($1) AS tbl`, [`public.${key}`]);
    const exists = !!result.rows[0]?.tbl;
    tableExistsCache.set(key, { exists, checkedAt: now });
    return exists;
  } catch (e) {
    tableExistsCache.set(key, { exists: false, checkedAt: now });
    return false;
  }
}

const normalizeRouteIdCandidates = (routeId, extras = []) => {
  const pushAll = (set, val) => {
    if (val === undefined || val === null) return;
    const s = String(val).trim();
    if (s) set.add(s);
  };
  const candidates = new Set();
  pushAll(candidates, routeId);
  extras.forEach((v) => pushAll(candidates, v));
  const expanded = new Set();
  candidates.forEach((c) => {
    pushAll(expanded, c);
    pushAll(expanded, c.replace(/^(route[-_#:]*|rte[-_#:]*)/i, ""));
    pushAll(expanded, c.replace(/\D+/g, ""));
  });
  return Array.from(expanded).filter(Boolean);
};

// Pull authoritative logistics data directly from core tables (no schema change)
async function getLogisticsDbSnapshot(routeIdOrCandidates) {
  const snapshot = { route: null, stops: [], cargo: [], deliveryLog: null, driverLocations: [] };
  const candidates = normalizeRouteIdCandidates(routeIdOrCandidates, []);
  if (candidates.length === 0) return snapshot;

  try {
    if (await tableExists("delivery_routes")) {
      for (const candidate of candidates) {
        const routeRes = await pool.query(
          `SELECT * FROM delivery_routes 
           WHERE route_id::text = $1 OR route_id = NULLIF($2, 0)
           LIMIT 1`,
          [candidate, Number(candidate) || 0]
        );
        if (routeRes.rows.length > 0) {
          snapshot.route = routeRes.rows[0];
          break;
        }
      }
    }
  } catch (_) {}

  try {
    if (await tableExists("route_stops")) {
      for (const candidate of candidates) {
        const stopsRes = await pool.query(
          `SELECT stop_id, stop_sequence, location, location_name, address, latitude, longitude,
                  planned_arrival_time, actual_arrival_time, planned_departure_time, actual_departure_time, notes
           FROM route_stops
           WHERE route_id::text = $1 OR route_id = NULLIF($2, 0)
           ORDER BY stop_sequence ASC`,
          [candidate, Number(candidate) || 0]
        );
        if (stopsRes.rows.length > 0) {
          snapshot.stops = stopsRes.rows;
          break;
        }
      }
    }
  } catch (_) {}

  try {
    if (await tableExists("delivery_items")) {
      for (const candidate of candidates) {
        const cargoRes = await pool.query(
          `SELECT di.delivery_item_id,
                  di.quantity_to_deliver,
                  di.inventory_id,
                  inv.unit_of_measure,
                  inv.quantity,
                  inv.product_id,
                  inv.unit_price_at_entry,
                  inv.total_value,
                  inv.batch_number,
                  inv.expected_expiry_date,
                  p.name AS product_name,
                  p.storage_category,
                  p.perishable,
                  p.image_url
           FROM delivery_items di
           LEFT JOIN inventory inv ON inv.inventory_id = di.inventory_id
           LEFT JOIN products p ON p.product_id = inv.product_id
           WHERE di.route_id::text = $1 OR di.route_id = NULLIF($2, 0)
           ORDER BY di.delivery_item_id ASC`,
          [candidate, Number(candidate) || 0]
        );
        if (cargoRes.rows.length > 0) {
          snapshot.cargo = cargoRes.rows;
          break;
        }
      }
    }
  } catch (_) {}

  try {
    if (await tableExists("delivery_logs")) {
      for (const candidate of candidates) {
        const logRes = await pool.query(
          `SELECT *
           FROM delivery_logs
           WHERE route_id::text = $1 OR route_id = NULLIF($2, 0)
           ORDER BY delivery_date DESC NULLS LAST, created_at DESC NULLS LAST
           LIMIT 1`,
          [candidate, Number(candidate) || 0]
        );
        if (logRes.rows.length > 0) {
          snapshot.deliveryLog = logRes.rows[0];
          break;
        }
      }
    }
  } catch (_) {}

  try {
    if (await tableExists("driver_locations")) {
      for (const candidate of candidates) {
        const locRes = await pool.query(
          `SELECT latitude, longitude, accuracy_m, speed_kmh, recorded_at
           FROM driver_locations
           WHERE route_id::text = $1 OR route_id = NULLIF($2, 0)
           ORDER BY recorded_at DESC
           LIMIT 50`,
          [candidate, Number(candidate) || 0]
        );
        if (locRes.rows.length > 0) {
          snapshot.driverLocations = locRes.rows;
          break;
        }
      }
    }
  } catch (_) {}

  return snapshot;
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

// ============================================================
// ECOTRACKAI PARITY: PRODUCTS / INVENTORY / ALERTS / CATALOG
// ============================================================

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize inventory rows for app/web (snake + camel + derived fields)
function mapInventoryRow(row = {}) {
  const daysUntilExpiry =
    row.expected_expiry_date != null
      ? Math.max(
          0,
          Math.ceil(
            (new Date(row.expected_expiry_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
          )
        )
      : row.days_until_expiry ?? null;

  return {
    ...row,
    productName: row.product_name,
    productType: row.product_type,
    storageCategory: row.storage_category,
    shelfLifeDays: row.shelf_life_days,
    compatibleWith: row.compatible_with,
    avoidWith: row.avoid_with,
    optimalTempMin: row.optimal_temp_min,
    optimalTempMax: row.optimal_temp_max,
    optimalHumidityMin: row.optimal_humidity_min,
    optimalHumidityMax: row.optimal_humidity_max,
    daysUntilExpiry
  };
}

app.get("/api/products", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const result = await pool.query(
      `
      SELECT *
      FROM products
      WHERE business_id = $1 OR business_id IS NULL
      ORDER BY business_id NULLS FIRST, product_name ASC
    `,
      [businessId]
    );
    res.json({ success: true, count: result.rows.length, products: result.rows, data: { products: result.rows } });
  } catch (err) {
    console.error("GET /api/products error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/products/:productId(\\d+)", authenticate, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    const businessId = req.user?.businessId || null;
    const result = await pool.query(
      `
      SELECT *
      FROM products
      WHERE product_id = $1
        AND (business_id = $2 OR business_id IS NULL)
      LIMIT 1
    `,
      [productId, businessId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, product: result.rows[0], data: { product: result.rows[0] } });
  } catch (err) {
    console.error("GET /api/products/:productId error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/products", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const body = req.body || {};
    const productName = String(body.productName || body.product_name || "").trim();
    const productType = String(body.productType || body.product_type || "fruit").trim() || "fruit";
    const storageCategory = String(body.storageCategory || body.storage_category || "ambient").trim() || "ambient";
    const shelfLifeDays = parseInt(body.shelfLifeDays ?? body.shelf_life_days, 10);
    const unitOfMeasure = String(body.unitOfMeasure || body.unit_of_measure || "kg").trim() || "kg";

    if (!productName || !Number.isFinite(shelfLifeDays) || shelfLifeDays < 1) {
      return res.status(400).json({ success: false, message: "productName and valid shelfLifeDays are required" });
    }

    const insertProduct = await pool.query(
      `
      INSERT INTO products (
        business_id, product_name, product_type, storage_category,
        shelf_life_days, unit_of_measure, image_url
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
      [businessId, productName, productType, storageCategory, shelfLifeDays, unitOfMeasure, body.imageUrl || body.image_url || null]
    );
    const product = insertProduct.rows[0];

    let batch = null;
    const quantity = numOrNull(body.quantity);
    if (quantity !== null && quantity > 0) {
      const entryDate = body.entryDate || body.entry_date || new Date().toISOString();
      const expiryDate =
        body.expectedExpiryDate ||
        body.expected_expiry_date ||
        new Date(Date.now() + shelfLifeDays * 24 * 60 * 60 * 1000).toISOString();
      const batchNumber = body.batchNumber || body.batch_number || `${productName.toUpperCase().replace(/\s+/g, "")}-${Date.now()}`;
      const inventoryInsert = await pool.query(
        `
        INSERT INTO inventory (
          business_id, product_id, quantity, entry_date, expected_expiry_date,
          batch_number, current_condition, unit_of_measure
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
        [
          businessId,
          product.product_id,
          quantity,
          entryDate,
          expiryDate,
          batchNumber,
          body.currentCondition || body.current_condition || "Good",
          unitOfMeasure
        ]
      );
      batch = inventoryInsert.rows[0];
    }

    res.status(201).json({ success: true, product, batch, data: { product, batch } });
  } catch (err) {
    console.error("POST /api/products error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.put("/api/products/:productId(\\d+)", authenticate, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    const businessId = req.user?.businessId || null;
    const body = req.body || {};
    const result = await pool.query(
      `
      UPDATE products
      SET product_name = COALESCE($1, product_name),
          product_type = COALESCE($2, product_type),
          storage_category = COALESCE($3, storage_category),
          shelf_life_days = COALESCE($4, shelf_life_days),
          unit_of_measure = COALESCE($5, unit_of_measure),
          image_url = COALESCE($6, image_url)
      WHERE product_id = $7
        AND (business_id = $8 OR business_id IS NULL)
      RETURNING *
    `,
      [
        body.productName || body.product_name || null,
        body.productType || body.product_type || null,
        body.storageCategory || body.storage_category || null,
        numOrNull(body.shelfLifeDays ?? body.shelf_life_days),
        body.unitOfMeasure || body.unit_of_measure || null,
        body.imageUrl || body.image_url || null,
        productId,
        businessId
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, product: result.rows[0], data: { product: result.rows[0] } });
  } catch (err) {
    console.error("PUT /api/products/:productId error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.delete("/api/products/:productId(\\d+)", authenticate, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    const businessId = req.user?.businessId || null;
    await pool.query(`DELETE FROM inventory WHERE product_id = $1 AND business_id = $2`, [productId, businessId]);
    const result = await pool.query(
      `DELETE FROM products WHERE product_id = $1 AND business_id = $2 RETURNING product_id`,
      [productId, businessId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found or not owned by business" });
    }
    res.json({ success: true, message: "Product deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/products/:productId error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/catalog/details", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM products WHERE business_id IS NULL ORDER BY product_name ASC`
    );
    res.json({ success: true, data: result.rows, catalog: result.rows, message: null });
  } catch (err) {
    console.error("GET /api/catalog/details error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/catalog", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT product_id AS fruit_id, product_name AS name, storage_category AS default_storage_type, shelf_life_days AS default_shelf_life_days
       FROM products
       WHERE business_id IS NULL
       ORDER BY product_name ASC`
    );
    res.json({ success: true, data: result.rows, catalog: result.rows, message: null });
  } catch (err) {
    console.error("GET /api/catalog error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/catalog/:fruitId(\\d+)", authenticate, async (req, res) => {
  try {
    const fruitId = parseInt(req.params.fruitId, 10);
    const result = await pool.query(`SELECT * FROM products WHERE product_id = $1 AND business_id IS NULL LIMIT 1`, [fruitId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Catalog fruit not found" });
    }
    res.json({ success: true, data: result.rows[0], fruit: result.rows[0], message: null });
  } catch (err) {
    console.error("GET /api/catalog/:fruitId error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/catalog", authenticate, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const storageType = String(body.default_storage_type || "ambient").trim();
    const shelf = parseInt(body.default_shelf_life_days, 10);
    if (!name || !Number.isFinite(shelf) || shelf < 1) {
      return res.status(400).json({ success: false, message: "name and default_shelf_life_days are required" });
    }
    const created = await pool.query(
      `
      INSERT INTO products (business_id, product_name, product_type, storage_category, shelf_life_days, unit_of_measure, ripeness_stages, compatible_with, avoid_with)
      VALUES (NULL, $1, 'fruit', $2, $3, 'kg', $4::jsonb, $5::jsonb, $6::jsonb)
      RETURNING *
    `,
      [
        name,
        storageType,
        shelf,
        JSON.stringify(body.ripeness_stages || {}),
        JSON.stringify(body.compatible_with || []),
        JSON.stringify(body.avoid_with || [])
      ]
    );
    res.status(201).json({ success: true, data: created.rows[0], message: "Global fruit catalog item created successfully" });
  } catch (err) {
    console.error("POST /api/catalog error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.put("/api/catalog/:fruitId(\\d+)", authenticate, async (req, res) => {
  try {
    const fruitId = parseInt(req.params.fruitId, 10);
    const body = req.body || {};
    const updated = await pool.query(
      `
      UPDATE products
      SET product_name = COALESCE($1, product_name),
          storage_category = COALESCE($2, storage_category),
          shelf_life_days = COALESCE($3, shelf_life_days),
          ripeness_stages = COALESCE($4::jsonb, ripeness_stages),
          compatible_with = COALESCE($5::jsonb, compatible_with),
          avoid_with = COALESCE($6::jsonb, avoid_with)
      WHERE product_id = $7 AND business_id IS NULL
      RETURNING *
    `,
      [
        body.name || null,
        body.default_storage_type || null,
        numOrNull(body.default_shelf_life_days),
        body.ripeness_stages ? JSON.stringify(body.ripeness_stages) : null,
        body.compatible_with ? JSON.stringify(body.compatible_with) : null,
        body.avoid_with ? JSON.stringify(body.avoid_with) : null,
        fruitId
      ]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Catalog fruit not found" });
    }
    res.json({ success: true, data: updated.rows[0], message: "Global fruit catalog item updated successfully" });
  } catch (err) {
    console.error("PUT /api/catalog/:fruitId error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.delete("/api/catalog/:fruitId(\\d+)", authenticate, async (req, res) => {
  try {
    const fruitId = parseInt(req.params.fruitId, 10);
    const inUse = await pool.query(`SELECT inventory_id FROM inventory WHERE product_id = $1 LIMIT 1`, [fruitId]);
    if (inUse.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Cannot delete fruit because it is already used in inventory/products" });
    }
    const deleted = await pool.query(`DELETE FROM products WHERE product_id = $1 AND business_id IS NULL RETURNING product_id`, [fruitId]);
    if (deleted.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Catalog fruit not found" });
    }
    res.json({ success: true, message: "Global fruit catalog item deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/catalog/:fruitId error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/inventory", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const result = await pool.query(
      `
      SELECT
        i.*,
        p.product_name,
        p.product_type,
        p.storage_category,
        p.shelf_life_days,
        p.compatible_with,
        p.avoid_with,
        p.optimal_temp_min,
        p.optimal_temp_max,
        p.optimal_humidity_min,
        p.optimal_humidity_max,
        (i.expected_expiry_date - CURRENT_DATE) AS days_until_expiry
      FROM inventory i
      LEFT JOIN products p ON p.product_id = i.product_id
      WHERE i.business_id = $1
        AND COALESCE(LOWER(i.current_condition), '') <> 'spoiled'
      ORDER BY i.expected_expiry_date ASC NULLS LAST, i.created_at DESC NULLS LAST
    `,
      [businessId]
    );
    const rows = result.rows.map(mapInventoryRow);
    res.json({ success: true, data: rows, inventory: rows, count: rows.length });
  } catch (err) {
    console.error("GET /api/inventory error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/inventory/:id(\\d+)", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const inventoryId = parseInt(req.params.id, 10);
    const result = await pool.query(
      `
      SELECT
        i.*,
        p.product_name,
        p.product_type,
        p.storage_category,
        p.shelf_life_days,
        p.compatible_with,
        p.avoid_with,
        p.optimal_temp_min,
        p.optimal_temp_max,
        p.optimal_humidity_min,
        p.optimal_humidity_max,
        (i.expected_expiry_date - CURRENT_DATE) AS days_until_expiry
      FROM inventory i
      LEFT JOIN products p ON p.product_id = i.product_id
      WHERE i.inventory_id = $1 AND i.business_id = $2
      LIMIT 1
    `,
      [inventoryId, businessId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Inventory record not found" });
    }
    const row = mapInventoryRow(result.rows[0]);
    res.json({ success: true, data: row, inventory: row });
  } catch (err) {
    console.error("GET /api/inventory/:id error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/inventory", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const body = req.body || {};
    const productId = parseInt(body.product_id ?? body.fruit_id ?? body.id, 10);
    const quantity = numOrNull(body.quantity);
    if (!Number.isFinite(productId) || quantity === null) {
      return res.status(400).json({ success: false, message: "product_id and quantity are required" });
    }
    const productCheck = await pool.query(`SELECT product_id, shelf_life_days FROM products WHERE product_id = $1 LIMIT 1`, [productId]);
    if (productCheck.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Selected fruit not found in catalog" });
    }
    const shelfLife = parseInt(body.shelf_life_days ?? productCheck.rows[0].shelf_life_days, 10) || 7;
    const entryDate = body.entry_date || body.entryDate || new Date().toISOString();
    const expectedExpiry = body.expected_expiry_date || body.expectedExpiryDate || new Date(Date.now() + shelfLife * 24 * 60 * 60 * 1000).toISOString();
    const batchNumber = body.batch_number || body.batchNumber || `BATCH-${productId}-${Date.now()}`;
    const inserted = await pool.query(
      `
      INSERT INTO inventory (
        business_id, product_id, quantity, entry_date, expected_expiry_date, batch_number,
        simulated_storage_temp, simulated_storage_humidity, current_condition, unit_of_measure, ripeness_stage
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `,
      [
        businessId,
        productId,
        quantity,
        entryDate,
        expectedExpiry,
        batchNumber,
        numOrNull(body.simulated_storage_temp),
        numOrNull(body.simulated_storage_humidity),
        body.current_condition || body.currentCondition || "Good",
        body.unit_of_measure || body.unitOfMeasure || "kg",
        body.ripeness_stage || body.ripenessStage || null
      ]
    );
    const row = mapInventoryRow(inserted.rows[0]);
    res.status(201).json({ success: true, data: row, inventory: row });
  } catch (err) {
    console.error("POST /api/inventory error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/inventory/check-compatibility", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const body = req.body || {};
    const avoidListRaw = body.avoid_with || body.avoidWith || body.avoidList || [];
    const avoidList = Array.isArray(avoidListRaw) ? avoidListRaw : [];

    // Backward compatibility for legacy payload
    if (body.productA && body.productB && avoidList.length === 0) {
      avoidList.push(body.productB);
    }

    if (!businessId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!avoidList || avoidList.length === 0) {
      return res.json({ success: true, conflicts: [], hasConflict: false, compatible: true, reason: "No avoid list provided" });
    }

    const normalizedList = avoidList.map((x) => String(x || "").trim()).filter(Boolean);
    if (normalizedList.length === 0) {
      return res.json({ success: true, conflicts: [], hasConflict: false, compatible: true, reason: "No avoid list provided" });
    }

    const conflictQuery = await pool.query(
      `
      SELECT DISTINCT p.product_name
      FROM inventory i
      JOIN products p ON p.product_id = i.product_id
      WHERE i.business_id = $1
        AND COALESCE(LOWER(i.current_condition), '') <> 'spoiled'
        AND COALESCE(i.quantity, 0) > 0
        AND LOWER(p.product_name) = ANY($2::text[])
    `,
      [businessId, normalizedList.map((n) => n.toLowerCase())]
    );

    const conflicts = conflictQuery.rows.map((r) => r.product_name);
    const hasConflict = conflicts.length > 0;
    const reason = hasConflict
      ? `Avoid co-storing with: ${conflicts.join(", ")}`
      : "No conflicts detected with current inventory";

    return res.json({ success: true, conflicts, hasConflict, compatible: !hasConflict, reason });
  } catch (err) {
    console.error("POST /api/inventory/check-compatibility error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.delete("/api/inventory/:id(\\d+)", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const inventoryId = parseInt(req.params.id, 10);
    const deleted = await pool.query(
      `DELETE FROM inventory WHERE inventory_id = $1 AND business_id = $2 RETURNING inventory_id`,
      [inventoryId, businessId]
    );
    if (deleted.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Inventory record not found" });
    }
    res.json({ success: true, message: "Inventory deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/inventory/:id error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/alerts/sync", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const rows = await pool.query(
      `
      SELECT
        i.inventory_id,
        i.product_id,
        i.quantity,
        i.expected_expiry_date,
        i.current_condition,
        p.product_name
      FROM inventory i
      LEFT JOIN products p ON p.product_id = i.product_id
      WHERE i.business_id = $1
    `,
      [businessId]
    );
    let synced = 0;
    for (const r of rows.rows) {
      const daysLeft = r.expected_expiry_date
        ? Math.max(0, Math.ceil((new Date(r.expected_expiry_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
        : 999;
      let risk = "LOW";
      if (daysLeft <= 2) risk = "HIGH";
      else if (daysLeft <= 5) risk = "MEDIUM";
      if (daysLeft > 14) continue;
      const details = `Potential spoilage risk for ${r.product_name || "product"} in ${daysLeft} day(s).`;
      await pool.query(
        `
        INSERT INTO alerts (business_id, product_id, product_name, alert_type, risk_level, details, days_left, quantity, location, status, created_at, updated_at)
        VALUES ($1,$2,$3,'spoilage_risk',$4,$5,$6,$7,$8,'active',NOW(),NOW())
      `,
        [businessId, r.product_id, r.product_name, risk, details, daysLeft, r.quantity, "Inventory Facility"]
      );
      synced++;
    }
    res.json({ success: true, syncedCount: synced, message: `Successfully synced ${synced} alerts from products` });
  } catch (err) {
    console.error("POST /api/alerts/sync error:", err);
    res.status(500).json({ success: false, message: "Failed to sync alerts" });
  }
});

app.post("/api/alerts/generate", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const rows = await pool.query(
      `
      SELECT
        i.inventory_id,
        i.product_id,
        i.quantity,
        i.expected_expiry_date,
        p.product_name
      FROM inventory i
      LEFT JOIN products p ON p.product_id = i.product_id
      WHERE i.business_id = $1
    `,
      [businessId]
    );
    let generated = 0;
    for (const r of rows.rows) {
      const daysLeft = r.expected_expiry_date
        ? Math.max(0, Math.ceil((new Date(r.expected_expiry_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
        : 999;
      if (daysLeft > 14) continue;
      let risk = "LOW";
      if (daysLeft <= 2) risk = "HIGH";
      else if (daysLeft <= 5) risk = "MEDIUM";
      const details = `Potential spoilage risk for ${r.product_name || "product"} in ${daysLeft} day(s).`;
      await pool.query(
        `
        INSERT INTO alerts (business_id, product_id, product_name, alert_type, risk_level, details, days_left, quantity, location, status, created_at, updated_at)
        VALUES ($1,$2,$3,'spoilage_risk',$4,$5,$6,$7,$8,'active',NOW(),NOW())
      `,
        [businessId, r.product_id, r.product_name, risk, details, daysLeft, r.quantity, "Inventory Facility"]
      );
      generated++;
    }
    res.json({ success: true, generatedCount: generated, message: `Generated ${generated} alerts` });
  } catch (err) {
    console.error("POST /api/alerts/generate error:", err);
    res.status(500).json({ success: false, message: "Failed to generate alerts" });
  }
});

app.get("/api/alerts", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const hasBusinessIdColumn = (await getTableColumns("alerts")).has("business_id");
    const query = hasBusinessIdColumn
      ? `SELECT * FROM alerts WHERE business_id = $1 ORDER BY created_at DESC`
      : `SELECT * FROM alerts ORDER BY created_at DESC`;
    const params = hasBusinessIdColumn ? [businessId] : [];
    const result = await pool.query(query, params);
    res.json({ success: true, alerts: result.rows, data: result.rows });
  } catch (err) {
    console.error("GET /api/alerts error:", err);
    res.status(500).json({ success: false, message: "Failed to retrieve alerts" });
  }
});

app.get("/api/alerts/stats", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const hasBusinessIdColumn = (await getTableColumns("alerts")).has("business_id");
    const where = hasBusinessIdColumn ? "WHERE business_id = $1" : "";
    const params = hasBusinessIdColumn ? [businessId] : [];
    const result = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) = 'active')::int AS active,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(risk_level,'')) = 'high')::int AS high,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(risk_level,'')) = 'medium')::int AS medium,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(risk_level,'')) = 'low')::int AS low
      FROM alerts
      ${where}
    `,
      params
    );
    res.json({ success: true, stats: result.rows[0] || { total: 0, active: 0, high: 0, medium: 0, low: 0 } });
  } catch (err) {
    console.error("GET /api/alerts/stats error:", err);
    res.status(500).json({ success: false, message: "Failed to retrieve alert stats" });
  }
});

app.post("/api/alerts/:id(\\d+)/submit", authenticate, async (req, res) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    const businessId = req.user?.businessId || null;
    const alertResult = await pool.query(`SELECT * FROM alerts WHERE id = $1 LIMIT 1`, [alertId]);
    if (alertResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }
    const alert = alertResult.rows[0];
    const managerCols = await getManagerApprovalsColumns();
    const managerPk = await getManagerApprovalsPkColumn();
    const maExistsCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasMA = !!maExistsCheck.rows[0]?.tbl;
    if (!hasMA) {
      return res.status(500).json({ success: false, message: "manager_approvals table not found" });
    }
    const dup = await pool.query(
      `SELECT ${managerPk} FROM manager_approvals
       WHERE approval_type = 'spoilage_action'
         AND COALESCE(alert_id::text,'') = $1
         AND LOWER(COALESCE(status,'')) LIKE '%pending%'
       LIMIT 1`,
      [String(alertId)]
    );
    if (dup.rows.length > 0) {
      return res.json({ success: true, message: "Alert already submitted for approval", approvalId: dup.rows[0][managerPk] });
    }
    const insertCols = [];
    const insertVals = [];
    const params = [];
    let n = 1;
    const push = (col, val) => { insertCols.push(col); insertVals.push(`$${n++}`); params.push(val); };
    if (managerCols.has("business_id")) push("business_id", businessId);
    if (managerCols.has("product_name")) push("product_name", alert.product_name || "Unknown Product");
    if (managerCols.has("quantity")) push("quantity", alert.quantity || null);
    if (managerCols.has("location")) push("location", alert.location || "Unknown");
    if (managerCols.has("days_left")) push("days_left", alert.days_left || 0);
    if (managerCols.has("risk_level")) push("risk_level", alert.risk_level || "MEDIUM");
    if (managerCols.has("required_role")) push("required_role", "inventory_manager");
    if (managerCols.has("priority")) push("priority", alert.risk_level === "HIGH" ? "HIGH" : "MEDIUM");
    if (managerCols.has("status")) push("status", "pending");
    if (managerCols.has("approval_type")) push("approval_type", "spoilage_action");
    if (managerCols.has("submitted_by")) push("submitted_by", req.user?.userId || null);
    if (managerCols.has("ai_suggestion")) push("ai_suggestion", alert.details || null);
    if (managerCols.has("alert_id")) push("alert_id", alertId);
    if (managerCols.has("created_at")) { insertCols.push("created_at"); insertVals.push("NOW()"); }

    const inserted = await pool.query(
      `INSERT INTO manager_approvals (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")}) RETURNING ${managerPk} AS approval_id`,
      params
    );
    await pool.query(`UPDATE alerts SET status = 'pending_review', updated_at = NOW() WHERE id = $1`, [alertId]);
    res.json({ success: true, message: "Alert submitted for approval", approvalId: inserted.rows[0]?.approval_id || null });
  } catch (err) {
    console.error("POST /api/alerts/:id/submit error:", err);
    res.status(500).json({ success: false, message: "Failed to submit alert for approval" });
  }
});

app.get("/api/alerts/:id(\\d+)/insights", authenticate, async (req, res) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    const result = await pool.query(`SELECT * FROM alerts WHERE id = $1 LIMIT 1`, [alertId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }
    const a = result.rows[0];
    const insight = {
      product: a.product_name,
      riskLevel: a.risk_level,
      recommendation:
        a.risk_level === "HIGH"
          ? "Immediate action recommended: prioritize dispatch or cold-chain correction."
          : a.risk_level === "MEDIUM"
          ? "Monitor closely and schedule movement within 24-48 hours."
          : "Low risk. Continue monitoring and follow FIFO."
    };
    res.json({ success: true, insight, data: insight });
  } catch (err) {
    console.error("GET /api/alerts/:id/insights error:", err);
    res.status(500).json({ success: false, message: "Failed to generate insights" });
  }
});

app.put("/api/alerts/:id(\\d+)/status", authenticate, async (req, res) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (!status) {
      return res.status(400).json({ success: false, message: "status is required" });
    }
    const result = await pool.query(`UPDATE alerts SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [status, alertId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }
    res.json({ success: true, alert: result.rows[0], data: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/alerts/:id/status error:", err);
    res.status(500).json({ success: false, message: "Failed to update alert status" });
  }
});

app.delete("/api/alerts/:id(\\d+)", authenticate, async (req, res) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    const result = await pool.query(`DELETE FROM alerts WHERE id = $1 RETURNING id`, [alertId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }
    res.json({ success: true, message: "Alert deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/alerts/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to delete alert" });
  }
});

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

// Inventory stats (business-scoped, aligned with web dashboard)
app.get("/api/inventory/stats", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;
    const result = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_batches,
        COALESCE(SUM(i.quantity), 0) AS total_quantity,
        COUNT(*) FILTER (WHERE (i.expected_expiry_date - CURRENT_DATE) <= 2)::int AS expiring_critical,
        COUNT(*) FILTER (WHERE (i.expected_expiry_date - CURRENT_DATE) BETWEEN 3 AND 5)::int AS expiring_soon,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(i.current_condition,'')) IN ('poor','spoiled'))::int AS poor_condition
      FROM inventory i
      WHERE i.business_id = $1
        AND COALESCE(LOWER(i.current_condition), '') <> 'spoiled'
    `,
      [businessId]
    );
    res.json({
      success: true,
      stats:
        result.rows[0] || {
          total_batches: 0,
          total_quantity: 0,
          expiring_critical: 0,
          expiring_soon: 0,
          poor_condition: 0
        }
    });
  } catch (err) {
    console.error("GET /api/inventory/stats error:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// AI insights for inventory dashboard (lightweight heuristic)
app.post("/api/ai/inventory-insights", authenticate, async (req, res) => {
  try {
    const businessId = req.user?.businessId || null;

    // Pending approvals (spoilage_action)
    const pendingResult = await pool.query(
      `
      SELECT COUNT(*) AS pending_count,
             COUNT(*) FILTER (WHERE LOWER(COALESCE(risk_level,'')) = 'high') AS high_risk
      FROM manager_approvals
      WHERE approval_type = 'spoilage_action'
        AND (${inventoryPendingStatusPredicate})
        ${businessId ? "AND business_id = $1" : ""}
    `,
      businessId ? [businessId] : []
    );
    const pendingApprovals = parseInt(pendingResult.rows[0]?.pending_count || 0, 10);
    const highRisk = parseInt(pendingResult.rows[0]?.high_risk || 0, 10);

    // Approved today
    const approvedResult = await pool.query(
      `
      SELECT COUNT(*) AS approved_today
      FROM manager_approvals
      WHERE approval_type = 'spoilage_action'
        AND LOWER(COALESCE(status,'')) IN ('approved','resolved')
        AND reviewed_at >= date_trunc('day', NOW())
        ${businessId ? "AND business_id = $1" : ""}
    `,
      businessId ? [businessId] : []
    );
    const approvedToday = parseInt(approvedResult.rows[0]?.approved_today || 0, 10);

    // Expiring items (inventory expiring within 3 days)
    const expiringResult = await pool.query(
      `
      SELECT COUNT(*) AS expiring
      FROM inventory i
      WHERE (i.expected_expiry_date - CURRENT_DATE) <= 3
        AND COALESCE(LOWER(i.current_condition), '') <> 'spoiled'
        ${businessId ? "AND i.business_id = $1" : ""}
    `,
      businessId ? [businessId] : []
    );
    const expiringItems = parseInt(expiringResult.rows[0]?.expiring || 0, 10);

    // Build recommendations
    const urgentRecommendations = [];
    if (highRisk > 0) {
    urgentRecommendations.push({
      priority: "HIGH",
      type: "Spoilage",
      title: "Review high‑risk spoilage alerts",
      description: `You have ${highRisk} high-risk items pending review.`,
      actionRequired: "Open Inventory Approvals and resolve high-risk items first."
    });
  }
  if (expiringItems > 0) {
    urgentRecommendations.push({
      priority: "MEDIUM",
      type: "Expiry",
      title: "Items expiring soon",
      description: `${expiringItems} batch(es) expire within 3 days.`,
      actionRequired: "Prioritize dispatch or adjust storage for these batches."
    });
  }
  if (urgentRecommendations.length === 0) {
    urgentRecommendations.push({
      priority: "LOW",
      type: "Status",
      title: "All clear",
      description: "No urgent spoilage risks detected.",
      actionRequired: "Monitor periodically."
    });
  }

    const todayOverview = {
      keyMetrics: [
        `${pendingApprovals} pending approvals`,
        `${highRisk} high-risk alerts`,
        `${expiringItems} expiring ≤3d`
      ],
      opportunities: pendingApprovals > 0 ? ["Resolve pending approvals to free up safe batches"] : [],
      warnings: highRisk > 0 ? ["High-risk items need immediate action"] : [],
      pendingApprovals,
      approvedToday,
      highPriority: highRisk,
      expiringItems
    };

    res.json({
      success: true,
      urgentRecommendations,
      todayOverview,
      message: null
    });
  } catch (err) {
    console.error("POST /api/ai/inventory-insights error:", err);
    res.status(500).json({ success: false, message: "Failed to generate inventory AI insights" });
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

const haversineKm = (a, b) => {
  if (!a || !b) return 0;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // Earth radius km
  const dLat = toRad((b.latitude || 0) - (a.latitude || 0));
  const dLon = toRad((b.longitude || 0) - (a.longitude || 0));
  const lat1 = toRad(a.latitude || 0);
  const lat2 = toRad(b.latitude || 0);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const computePathDistanceKm = (points) => {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    sum += haversineKm(points[i - 1], points[i]);
  }
  return Number.isFinite(sum) ? sum : 0;
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

const extractLatLng = (...values) => {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "object") {
      const lat = toFiniteNumber(
        value.latitude,
        value.lat,
        value.y
      );
      const lng = toFiniteNumber(
        value.longitude,
        value.lng,
        value.lon,
        value.x
      );
      if (lat !== 0 || lng !== 0) return { latitude: lat, longitude: lng };
    }
  }
  return null;
};

const normalizeRoutePoint = (point) => {
  if (!point || typeof point !== "object") return null;
  const latitude = toFiniteNumber(point.latitude, point.lat, point.y);
  const longitude = toFiniteNumber(point.longitude, point.lng, point.lon, point.x);
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
};

const buildRoadRoutePath = async (points) => {
  try {
    const normalized = (points || [])
      .map(normalizeRoutePoint)
      .filter(Boolean)
      .filter((p, idx, arr) => idx === 0 || p.latitude !== arr[idx - 1].latitude || p.longitude !== arr[idx - 1].longitude);

    if (normalized.length < 2) return normalized;
    const coordStr = normalized.map((p) => `${p.longitude},${p.latitude}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return normalized;

    const body = await response.json();
    const coordinates = body?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return normalized;

    const routed = coordinates
      .map((coord) => ({
        latitude: toFiniteNumber(coord?.[1]),
        longitude: toFiniteNumber(coord?.[0])
      }))
      .filter((p) => p.latitude !== 0 || p.longitude !== 0);

    return routed.length >= 2 ? routed : normalized;
  } catch (error) {
    return (points || []).map(normalizeRoutePoint).filter(Boolean);
  }
};

const getRouteOptimizationSnapshot = async (routeIdOrCandidates) => {
  const candidates = Array.isArray(routeIdOrCandidates)
    ? routeIdOrCandidates
        .map((c) => (c === undefined || c === null ? "" : String(c)))
        .map((c) => c.trim())
        .filter(Boolean)
    : [String(routeIdOrCandidates || "")].filter(Boolean);
  if (candidates.length === 0) return null;
  try {
    const tableCheck = await pool.query(`SELECT to_regclass('public.route_optimizations') AS tbl`);
    const hasRouteOptimizations = !!tableCheck.rows[0]?.tbl;
    if (!hasRouteOptimizations) return null;

    const columns = await getTableColumns("route_optimizations");
    if (!columns.has("route_id")) return null;

    const hasCreatedAt = columns.has("created_at");
    const hasId = columns.has("id");
    const orderExpr = hasCreatedAt
      ? "created_at DESC"
      : hasId
      ? "id DESC"
      : "route_id DESC";

    for (const candidate of candidates) {
      const result = await pool.query(
        `SELECT * FROM route_optimizations WHERE route_id::text = $1 ORDER BY ${orderExpr} LIMIT 1`,
        [candidate]
      );
      if (result.rows.length > 0) {
        return result.rows[0];
      }
    }
    return null;
  } catch (_) {
    return null;
  }
};

async function buildLogisticsRoutePayload(row, options = {}) {
  const routeIdFromParams = options.routeIdFromParams ? String(options.routeIdFromParams) : null;
  const hasRouteStops = !!options.hasRouteStops;
  let requestData = parseMaybeJsonObject(row.request_data);
  let extraData = parseMaybeJsonObject(row.extra_data);
  let routeData = parseMaybeJsonObject(extraData.route);
  let optimization = parseMaybeJsonObject(extraData.optimization);
  let optimizationData = parseMaybeJsonObject(optimization.optimization_data);
  let requestOptimization = parseMaybeJsonObject(requestData.optimization);
  let requestOptimizationData = parseMaybeJsonObject(requestOptimization.optimization_data);
  let extraOptimizationData = parseMaybeJsonObject(extraData.optimization_data);
  let requestSavings = parseMaybeJsonObject(requestData.savings);
  let optimizationSavings = parseMaybeJsonObject(optimization.savings);
  let requestOptimizationSavings = parseMaybeJsonObject(requestOptimization.savings);
  let optimizationDataSavings = parseMaybeJsonObject(optimizationData.savings);
  const baseRouteIdCandidates = [
    routeIdFromParams,
    row.route_id,
    row.route_name,
    row.related_record_id,
    row.delivery_id,
    row.id,
    row.approval_id,
    requestData.route_id,
    routeData.route_id
  ];
  const dbSnapshot = await getLogisticsDbSnapshot(baseRouteIdCandidates);
  const deliveryRoute = dbSnapshot.route || null;
  const routeStopsFromDb = Array.isArray(dbSnapshot.stops) ? dbSnapshot.stops : [];
  const cargoFromDb = Array.isArray(dbSnapshot.cargo) ? dbSnapshot.cargo : [];
  const deliveryLog = dbSnapshot.deliveryLog || null;
  const driverLocations = Array.isArray(dbSnapshot.driverLocations) ? dbSnapshot.driverLocations : [];

  const routeIdCandidates = [...baseRouteIdCandidates, deliveryRoute?.route_id]
    .map((v) => (v === undefined || v === null ? "" : String(v)))
    .filter((v) => v.trim() !== "");
  let routeId = String(routeIdCandidates.find((v) => v) || "");
  if (!routeId && row.route_name) {
    const m = String(row.route_name).match(/(\d[\d-]*)$/);
    if (m && m[1]) routeId = m[1].replace(/[^0-9]/g, "");
  }
  if (!routeId && deliveryRoute?.route_id != null) {
    routeId = String(deliveryRoute.route_id);
  }
  const routeOptimizationSnapshot = await getRouteOptimizationSnapshot(routeIdCandidates);

  // Some deployments store richer optimization data in manager_approvals.request_data/extra_data
  // while route_approvals can contain zeros. Merge manager payload as fallback source-of-truth.
  let managerFallbackRow = null;
  if (routeId) {
    try {
      const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
      const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
      if (hasManagerApprovals) {
        const managerColumns = await getManagerApprovalsColumns();
        const managerPkCol = await getManagerApprovalsPkColumn();
        const managerMatchClauses = [];
        if (managerColumns.has("route_id")) managerMatchClauses.push(`COALESCE(ma.route_id::text, '') = $1`);
        if (managerColumns.has("related_record_id")) managerMatchClauses.push(`COALESCE(ma.related_record_id::text, '') = $1`);
        if (managerColumns.has("delivery_id")) managerMatchClauses.push(`COALESCE(ma.delivery_id::text, '') = $1`);
        if (managerColumns.has(managerPkCol)) managerMatchClauses.push(`ma.${managerPkCol}::text = $1`);
        if (managerColumns.has("request_data")) managerMatchClauses.push(`COALESCE(ma.request_data->>'route_id', '') = $1`);
        if (managerColumns.has("extra_data")) managerMatchClauses.push(`COALESCE(ma.extra_data->'route'->>'route_id', '') = $1`);

        if (managerMatchClauses.length > 0) {
          const managerOrderBy = managerColumns.has("created_at")
            ? "ma.created_at DESC"
            : `ma.${managerPkCol} DESC`;
          const fallbackResult = await pool.query(
            `SELECT *
             FROM manager_approvals ma
             WHERE ma.approval_type = 'route_optimization'
               AND (${managerMatchClauses.join(" OR ")})
             ORDER BY ${managerOrderBy}
             LIMIT 1`,
            [routeId]
          );
          managerFallbackRow = fallbackResult.rows[0] || null;
        }
      }
    } catch (e) {
      managerFallbackRow = null;
    }
  }

  if (managerFallbackRow) {
    const fallbackRequestData = parseMaybeJsonObject(managerFallbackRow.request_data);
    const fallbackExtraData = parseMaybeJsonObject(managerFallbackRow.extra_data);
    const fallbackRouteData = parseMaybeJsonObject(fallbackExtraData.route);
    const fallbackOptimization = parseMaybeJsonObject(fallbackExtraData.optimization);
    const fallbackOptimizationData = parseMaybeJsonObject(fallbackOptimization.optimization_data);
    const fallbackRequestOptimization = parseMaybeJsonObject(fallbackRequestData.optimization);
    const fallbackRequestOptimizationData = parseMaybeJsonObject(fallbackRequestOptimization.optimization_data);
    const fallbackExtraOptimizationData = parseMaybeJsonObject(fallbackExtraData.optimization_data);
    const fallbackRequestSavings = parseMaybeJsonObject(fallbackRequestData.savings);
    const fallbackOptimizationSavings = parseMaybeJsonObject(fallbackOptimization.savings);
    const fallbackRequestOptimizationSavings = parseMaybeJsonObject(fallbackRequestOptimization.savings);
    const fallbackOptimizationDataSavings = parseMaybeJsonObject(fallbackOptimizationData.savings);

    requestData = { ...fallbackRequestData, ...requestData };
    extraData = { ...fallbackExtraData, ...extraData };
    routeData = { ...fallbackRouteData, ...routeData };
    optimization = { ...fallbackOptimization, ...optimization };
    optimizationData = { ...fallbackOptimizationData, ...optimizationData };
    requestOptimization = { ...fallbackRequestOptimization, ...requestOptimization };
    requestOptimizationData = { ...fallbackRequestOptimizationData, ...requestOptimizationData };
    extraOptimizationData = { ...fallbackExtraOptimizationData, ...extraOptimizationData };
    requestSavings = { ...fallbackRequestSavings, ...requestSavings };
    optimizationSavings = { ...fallbackOptimizationSavings, ...optimizationSavings };
    requestOptimizationSavings = { ...fallbackRequestOptimizationSavings, ...requestOptimizationSavings };
    optimizationDataSavings = { ...fallbackOptimizationDataSavings, ...optimizationDataSavings };
  }

  // Enrich with authoritative delivery_routes data when present
  if (deliveryRoute) {
    const dbOriginLoc = parseMaybeJsonObject(deliveryRoute.origin_location);
    const dbDestLoc = parseMaybeJsonObject(deliveryRoute.destination_location);
    routeData = { ...deliveryRoute, ...routeData };
    requestData = { ...routeData, ...requestData };
    if (dbOriginLoc) {
      requestData.origin_location = requestData.origin_location || dbOriginLoc;
      routeData.origin_location = routeData.origin_location || dbOriginLoc;
    }
    if (dbDestLoc) {
      requestData.destination_location = requestData.destination_location || dbDestLoc;
      routeData.destination_location = routeData.destination_location || dbDestLoc;
    }
  }

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

  const originPoint = extractLatLng(
    row.origin_location,
    requestData.origin_location,
    routeData.origin_location,
    requestData.origin,
    routeData.origin
  );
  const destinationPoint = extractLatLng(
    row.destination_location,
    requestData.destination_location,
    routeData.destination_location,
    requestData.destination,
    routeData.destination
  );

  let stops = [];
  if (Array.isArray(row.stops_json) && row.stops_json.length > 0) {
    stops = row.stops_json.map((stop, index) => {
      const base = normalizeLogisticsStop(stop, index);
      const point = extractLatLng(stop);
      return point ? { ...base, latitude: point.latitude, longitude: point.longitude } : base;
    });
  } else if (Array.isArray(routeStopsFromDb) && routeStopsFromDb.length > 0) {
    stops = routeStopsFromDb.map((stop, index) => {
      const base = normalizeLogisticsStop(stop, index);
      const point = extractLatLng(stop.location, stop);
      return point ? { ...base, latitude: point.latitude, longitude: point.longitude } : base;
    });
  } else if (Array.isArray(requestData.stops) && requestData.stops.length > 0) {
    stops = requestData.stops.map((stop, index) => {
      const base = normalizeLogisticsStop(stop, index);
      const point = extractLatLng(stop);
      return point ? { ...base, latitude: point.latitude, longitude: point.longitude } : base;
    });
  } else if (Array.isArray(routeData.stops) && routeData.stops.length > 0) {
    stops = routeData.stops.map((stop, index) => {
      const base = normalizeLogisticsStop(stop, index);
      const point = extractLatLng(stop);
      return point ? { ...base, latitude: point.latitude, longitude: point.longitude } : base;
    });
  } else if (hasRouteStops && routeId) {
    try {
      const stopsResult = await pool.query(
        `SELECT stop_sequence, location_name, address, latitude, longitude
         FROM route_stops
         WHERE route_id::text = $1
         ORDER BY stop_sequence ASC`,
        [routeId]
      );
      if (stopsResult.rows.length > 0) {
        stops = stopsResult.rows.map((stop, index) => {
          const base = normalizeLogisticsStop(stop, index);
          const point = extractLatLng(stop);
          return point ? { ...base, latitude: point.latitude, longitude: point.longitude } : base;
        });
      }
    } catch (e) {
      // Ignore route stop lookup failures and keep fallback stops below.
    }
  }

  if (stops.length === 0) {
    const originFallback = normalizeLogisticsStop({ stop_name: fromLocation, address: fromLocation }, 0);
    stops = [
      originPoint
        ? { ...originFallback, latitude: originPoint.latitude, longitude: originPoint.longitude }
        : originFallback
    ];
    if (toLocation) {
      const destinationFallback = normalizeLogisticsStop({ stop_name: toLocation, address: toLocation }, 1);
      stops.push(
        destinationPoint
          ? { ...destinationFallback, latitude: destinationPoint.latitude, longitude: destinationPoint.longitude }
          : destinationFallback
      );
    }
  }

  const rawPath =
    optimizationData.routePath ||
    optimizationData.route_path ||
    optimization.route_path ||
    optimization.routePath ||
    requestOptimizationData.routePath ||
    requestOptimizationData.route_path ||
    requestOptimization.route_path ||
    requestOptimization.routePath ||
    requestData.route_path ||
    requestData.routePath ||
    routeData.route_path ||
    routeData.routePath;

  const hasDetailedStoredPath = Array.isArray(rawPath) && rawPath.length > 2;
  let routePath = [];
  if (Array.isArray(rawPath)) {
    routePath = rawPath.map(normalizeRoutePoint).filter(Boolean);
  }
  if (routePath.length === 0) {
    const derivedPath = [];
    if (originPoint) derivedPath.push(originPoint);
    stops.forEach((stop) => {
      const p = extractLatLng(stop);
      if (p) derivedPath.push(p);
    });
    if (destinationPoint) derivedPath.push(destinationPoint);
    routePath = derivedPath;
  }
  if (!hasDetailedStoredPath && routePath.length >= 2) {
    routePath = await buildRoadRoutePath(routePath);
  }

  const computedDistanceKm = computePathDistanceKm(routePath);

  const originalDistance = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.original_distance_km,
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
    extraOptimizationData.original_distance_km,
    row.original_distance,
    row.total_distance_km
  );
  const optimizedDistance = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.optimized_distance_km,
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
    extraOptimizationData.optimized_distance_km,
    row.optimized_distance
  );
  const originalFuel = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.original_fuel_liters,
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
    extraOptimizationData.original_fuel_liters,
    row.original_fuel,
    row.estimated_fuel_consumption_liters
  );
  const optimizedFuel = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.optimized_fuel_liters,
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
    extraOptimizationData.optimized_fuel_liters,
    row.optimized_fuel
  );
  const originalCO2 = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.original_carbon_kg,
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
    extraOptimizationData.original_co2_kg,
    row.original_co2,
    row.estimated_carbon_kg
  );
  const optimizedCO2 = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.optimized_carbon_kg,
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
    extraOptimizationData.optimized_co2_kg,
    row.optimized_co2,
    row.optimized_carbon_kg
  );
  const aiSuggestion =
    requestData.ai_suggestion ||
    requestData.ai_recommendation ||
    requestData.aiRecommendation ||
    requestOptimization.ai_recommendation ||
    optimization.ai_recommendation ||
    requestOptimizationData.aiRecommendation ||
    optimizationData.aiRecommendation ||
    routeData.ai_suggestion ||
    routeData.ai_recommendation ||
    extraOptimizationData.aiRecommendation ||
    routeOptimizationSnapshot?.ai_recommendation ||
    managerFallbackRow?.ai_suggestion ||
    managerFallbackRow?.ai_recommendation ||
    row.ai_suggestion ||
    row.ai_recommendation ||
    "Optimize this route";
  const textSavings = extractSavingsFromText(aiSuggestion);
  const totalSavingsKm = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.savings_km,
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
    requestSavings.distance,
    optimizationSavings.distance,
    requestOptimizationSavings.distance,
    optimizationDataSavings.distance,
    textSavings.km,
    row.savings_km,
    row.distance_saved_km
  );
  const totalSavingsFuel = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.savings_fuel,
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
    requestSavings.fuel,
    optimizationSavings.fuel,
    requestOptimizationSavings.fuel,
    optimizationDataSavings.fuel,
    textSavings.fuel,
    row.savings_fuel,
    row.fuel_saved,
    row.fuel_saved_liters
  );
  const totalSavingsCO2 = toFiniteNumberPreferNonZero(
    routeOptimizationSnapshot?.savings_co2,
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
    requestSavings.emissions,
    optimizationSavings.emissions,
    requestOptimizationSavings.emissions,
    optimizationDataSavings.emissions,
    textSavings.co2,
    row.savings_co2,
    row.co2_saved,
    row.co2_saved_kg
  );

  // Fallbacks: derive metrics from path when missing/zero to avoid duplicated placeholders
  const finalOriginalDistance = originalDistance > 0 ? originalDistance : computedDistanceKm;
  const finalOptimizedDistance =
    optimizedDistance > 0
      ? optimizedDistance
      : computedDistanceKm > 0
      ? Math.max(computedDistanceKm * 0.85, computedDistanceKm * 0.7)
      : finalOriginalDistance > 0
      ? Math.max(finalOriginalDistance * 0.85, finalOriginalDistance * 0.7)
      : 0;

  const fuelPerKm = 0.08; // ~8L/100km default
  const co2PerLiter = 2.31; // kg CO2 per liter diesel baseline

  const finalOriginalFuel =
    originalFuel > 0
      ? originalFuel
      : finalOriginalDistance > 0
      ? finalOriginalDistance * fuelPerKm
      : 0;
  const finalOptimizedFuel =
    optimizedFuel > 0
      ? optimizedFuel
      : finalOptimizedDistance > 0
      ? finalOptimizedDistance * fuelPerKm
      : 0;

  const finalOriginalCO2 =
    originalCO2 > 0
      ? originalCO2
      : finalOriginalFuel > 0
      ? finalOriginalFuel * co2PerLiter
      : 0;
  const finalOptimizedCO2 =
    optimizedCO2 > 0
      ? optimizedCO2
      : finalOptimizedFuel > 0
      ? finalOptimizedFuel * co2PerLiter
      : 0;

  const finalSavingsKm =
    totalSavingsKm > 0 && finalOriginalDistance > 0
      ? totalSavingsKm
      : Math.max(finalOriginalDistance - finalOptimizedDistance, 0);
  const finalSavingsFuel =
    totalSavingsFuel > 0 && finalOriginalFuel > 0
      ? totalSavingsFuel
      : Math.max(finalOriginalFuel - finalOptimizedFuel, 0);
  const finalSavingsCO2 =
    totalSavingsCO2 > 0 && finalOriginalCO2 > 0
      ? totalSavingsCO2
      : Math.max(finalOriginalCO2 - finalOptimizedCO2, 0);

  const actualDistanceKm = toFiniteNumber(
    deliveryLog?.actual_distance_km,
    deliveryLog?.actual_distance
  );
  const actualDurationMinutes = toFiniteNumber(deliveryLog?.actual_duration_minutes);
  const actualFuelLiters = toFiniteNumber(deliveryLog?.actual_fuel_used_liters);
  const actualCarbonKg = toFiniteNumber(deliveryLog?.actual_carbon_kg);
  const deliveryDate = deliveryLog?.delivery_date || null;

  const cargoManifest = cargoFromDb.map((item) => {
    const qty = toFiniteNumber(item.quantity_to_deliver, item.quantity);
    return {
      delivery_item_id: item.delivery_item_id || null,
      inventory_id: item.inventory_id || null,
      product_id: item.product_id || null,
      product_name: item.product_name || "Unknown",
      quantity: qty,
      unit: item.unit_of_measure || "kg",
      storage_category: item.storage_category || null,
      perishable: !!item.perishable,
      image_url: item.image_url || null,
      value: toFiniteNumber(item.total_value) || null,
      unit_price: toFiniteNumber(item.unit_price_at_entry) || null,
      batch_number: item.batch_number || null,
      expected_expiry_date: item.expected_expiry_date || null
    };
  });
  const cargoTotalQty = cargoManifest.reduce(
    (sum, item) => sum + (toFiniteNumber(item.quantity) || 0),
    0
  );

  const routeName =
    routeData.route_name ||
    routeData.routeName ||
    deliveryRoute?.route_name ||
    (routeId ? `Route-${routeId}` : null);
  const displayRouteCode = routeId ? `Route-${routeId}` : routeName;

  const submittedBy = row.submitted_by || row.requested_by || row.reviewed_by || "System";
  const payload = {
    route_id: routeId,
    routeId,
    route_number: routeId,
    route_code: displayRouteCode,
    route_name: routeName,
    routeName,
    route_type: row.route_type || requestData.route_type || routeData.route_type || row.product_name || "STANDARD",
    routeType: row.route_type || requestData.route_type || routeData.route_type || row.product_name || "STANDARD",
    from_location: fromLocation,
    from: fromLocation,
    origin_latitude: originPoint?.latitude ?? null,
    origin_longitude: originPoint?.longitude ?? null,
    originLatitude: originPoint?.latitude ?? null,
    originLongitude: originPoint?.longitude ?? null,
    to_location: toLocation,
    to: toLocation,
    destination_latitude: destinationPoint?.latitude ?? null,
    destination_longitude: destinationPoint?.longitude ?? null,
    destinationLatitude: destinationPoint?.latitude ?? null,
    destinationLongitude: destinationPoint?.longitude ?? null,
    stops,
    route_path: routePath,
    routePath: routePath,
    driver_name: row.driver_name || requestData.driver_name || routeData.driver_name || "Unassigned",
    driver: row.driver_name || requestData.driver_name || routeData.driver_name || "Unassigned",
    vehicle_type: row.vehicle_type || requestData.vehicle_type || routeData.vehicle_type || "Van",
    vehicle: row.vehicle_type || requestData.vehicle_type || routeData.vehicle_type || "Van",
    departure_time: row.departure_time || routeData.created_at || row.created_at || null,
    departureTime: row.departure_time || routeData.created_at || row.created_at || null,
    original_distance: finalOriginalDistance,
    originalDistance: finalOriginalDistance,
    optimized_distance: finalOptimizedDistance,
    optimizedDistance: finalOptimizedDistance,
    total_distance_km: finalOriginalDistance,
    optimized_distance_km: finalOptimizedDistance,
    original_fuel: finalOriginalFuel,
    originalFuel: finalOriginalFuel,
    optimized_fuel: finalOptimizedFuel,
    optimizedFuel: finalOptimizedFuel,
    estimated_fuel_consumption_liters: finalOriginalFuel,
    optimized_fuel_liters: finalOptimizedFuel,
    original_co2: finalOriginalCO2,
    originalCO2: finalOriginalCO2,
    optimized_co2: finalOptimizedCO2,
    optimizedCO2: finalOptimizedCO2,
    estimated_carbon_kg: finalOriginalCO2,
    optimized_carbon_kg: finalOptimizedCO2,
    savings_km: finalSavingsKm,
    totalSavingsKm: finalSavingsKm,
    savings_fuel: finalSavingsFuel,
    totalSavingsFuel: finalSavingsFuel,
    savings_co2: finalSavingsCO2,
    totalSavingsCO2: finalSavingsCO2,
    ai_suggestion: aiSuggestion,
    ai_recommendation: aiSuggestion,
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
    original_stops: stops,
    optimized_stops: optimizationData.optimizedStops || optimization.optimizedStops || stops,
    optimized_path: routePath,
    status: row.status || deliveryRoute?.status || "PENDING",
    submitted_by: String(submittedBy),
    submittedBy: String(submittedBy),
    submitted_at: row.submitted_at || row.created_at || null,
    submittedTime: row.submitted_at || row.created_at || null,
    actual_distance_km: actualDistanceKm,
    actual_duration_minutes: actualDurationMinutes,
    actual_fuel_used_liters: actualFuelLiters,
    actual_carbon_kg: actualCarbonKg,
    delivery_date: deliveryDate,
    cargo: cargoManifest,
    cargo_total_quantity: cargoTotalQty,
    driver_locations: driverLocations
  };
  return payload;
}

// Fetch driver monitor rows (shared by dashboard + standalone endpoint)
const fetchDriverMonitorRows = async (businessId = null) => {
  let driverMonitorRows = [];
  try {
    const usersColumns = await getTableColumns("users");
    const hasBusinessColumn = usersColumns.has("business_id");
    const usersParams = [];
    const usersWhere = ["u.role = 'driver'"];
    if (businessId && hasBusinessColumn) {
      usersParams.push(businessId);
      usersWhere.push(`u.business_id = $${usersParams.length}`);
    }
    const idExpr = usersColumns.has("user_id")
      ? "u.user_id"
      : usersColumns.has("id")
      ? "u.id"
      : "NULL::int";
    const nameExpr = usersColumns.has("full_name")
      ? "NULLIF(u.full_name, '')"
      : usersColumns.has("name")
      ? "NULLIF(u.name, '')"
      : "NULL";
    const usernameExpr = usersColumns.has("username")
      ? "NULLIF(u.username, '')"
      : "NULL";
    const emailExpr = usersColumns.has("email")
      ? "NULLIF(u.email, '')"
      : "NULL";
    const usersResult = await pool.query(
      `SELECT
        ${idExpr} AS user_id,
        ${nameExpr} AS full_name,
        ${emailExpr} AS email,
        ${usernameExpr} AS username
       FROM users u
       WHERE ${usersWhere.join(" AND ")}
       ORDER BY COALESCE(${nameExpr}, ${usernameExpr}, ${emailExpr}) ASC`,
      usersParams
    );

    const busyByDriver = new Map();
    const upsertBusy = (driverName, routeName, routeStatus, routeId = null, vehicleType = null, driverUserId = null) => {
      const keyName = String(driverName || "").trim().toLowerCase();
      const keyId = driverUserId && Number.isFinite(Number(driverUserId)) ? `id:${Number(driverUserId)}` : null;
      const register = (key) => {
        if (!key) return;
        if (busyByDriver.has(key)) return;
        busyByDriver.set(key, {
          driver_name: driverName || null,
          route_name: routeName || null,
          route_status: routeStatus || null,
          route_id: routeId || null,
          vehicle_type: vehicleType || null
        });
      };
      register(keyName);
      register(keyId);
      // also register composite for redundancy
      if (keyName && keyId) register(`${keyName}|${keyId}`);
    };

    const getBusyForDriver = (name, id = null) => {
      const keyName = String(name || "").trim().toLowerCase();
      const keyId = id && Number.isFinite(Number(id)) ? `id:${Number(id)}` : null;
      return (
        busyByDriver.get(keyName) ||
        (keyId ? busyByDriver.get(keyId) : null) ||
        (keyName && keyId ? busyByDriver.get(`${keyName}|${keyId}`) : null)
      );
    };

    const setBusyForDriver = (name, id, data) => {
      const keyName = String(name || "").trim().toLowerCase();
      const keyId = id && Number.isFinite(Number(id)) ? `id:${Number(id)}` : null;
      if (keyName) busyByDriver.set(keyName, data);
      if (keyId) busyByDriver.set(keyId, data);
      if (keyName && keyId) busyByDriver.set(`${keyName}|${keyId}`, data);
    };

    const ensureBusyDefaults = () => {}; // placeholder to avoid unused warnings

    const mergeBusy = (driverName, driverUserId, data) => {
      const existing = getBusyForDriver(driverName, driverUserId);
      if (existing) {
        const merged = { ...existing, ...data };
        setBusyForDriver(driverName, driverUserId, merged);
      } else {
        setBusyForDriver(driverName, driverUserId, data);
      }
    };

    const driverBusyPayload = (routeName, routeStatus, routeId, vehicleType) => ({
      route_name: routeName || null,
      route_status: routeStatus || null,
      route_id: routeId || null,
      vehicle_type: vehicleType || null
    });

    // Active deliveries first
    try {
      const deliveriesTableCheck = await pool.query(`SELECT to_regclass('public.deliveries') AS tbl`);
      const hasDeliveries = !!deliveriesTableCheck.rows[0]?.tbl;
      if (hasDeliveries) {
        const deliveriesColumns = await getTableColumns("deliveries");
        const statusExpr = deliveriesColumns.has("status") ? "LOWER(COALESCE(d.status,''))" : "''";
        const hasDriverName = deliveriesColumns.has("driver_name");
        const hasBusinessCol = deliveriesColumns.has("business_id");
        const routeNameExpr = deliveriesColumns.has("route_name")
          ? "d.route_name"
          : deliveriesColumns.has("from_location")
          ? "d.from_location"
          : "NULL::text";
        const routeIdExpr = deliveriesColumns.has("route_id")
          ? "d.route_id"
          : deliveriesColumns.has("delivery_id")
          ? "d.delivery_id"
          : deliveriesColumns.has("id")
          ? "d.id"
          : null;
        const vehicleExpr = deliveriesColumns.has("vehicle_type") ? "d.vehicle_type" : "NULL::text";
        const driverIdExpr = deliveriesColumns.has("driver_user_id")
          ? "d.driver_user_id"
          : deliveriesColumns.has("driver_id")
          ? "d.driver_id"
          : "NULL::int";
        if (hasDriverName || deliveriesColumns.has("driver_user_id")) {
          const params = [];
          const businessClause =
            businessId && hasBusinessCol
              ? (() => {
                  params.push(businessId);
                  return `AND (d.business_id = $${params.length} OR d.business_id IS NULL)`;
                })()
              : "";
          const liveDrivers = await pool.query(
            `
            SELECT
              COALESCE(d.driver_name, u.full_name, u.username, u.email, 'Driver') AS full_name,
              COALESCE(d.driver_email, u.email, '') AS email,
              ${routeNameExpr} AS route_name,
              ${statusExpr} AS route_status,
              ${routeIdExpr || "NULL::text"} AS route_id,
              ${vehicleExpr} AS vehicle_type,
              ${driverIdExpr} AS driver_user_id,
              ${driverIdExpr} AS user_id,
              COALESCE(d.stops_completed, 0) AS stops_completed,
              COALESCE(d.stops_total, 0) AS stops_total
            FROM deliveries d
            LEFT JOIN users u ON ${driverIdExpr} = COALESCE(u.user_id, u.id)
WHERE ${statusExpr} NOT IN ('completed','cancelled','declined','rejected')
              ${businessClause}
            ORDER BY d.departure_time DESC NULLS LAST, d.created_at DESC NULLS LAST
            LIMIT 50
          `,
            params
          );
          if (liveDrivers.rows.length > 0) {
            driverMonitorRows = liveDrivers.rows;
          }
        }
      }
    } catch (liveDriverErr) {
      console.warn("Logistics driver monitor live-delivery lookup failed:", liveDriverErr.message);
    }

    // Fallback busy drivers from route approvals
    try {
        const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
        const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
        if (hasRouteApprovals) {
          const routeColumns = await getTableColumns("route_approvals");
          const hasBusinessCol = routeColumns.has("business_id");
          const params = [];
          const businessClause =
            businessId && hasBusinessCol
              ? (() => {
                  params.push(businessId);
                  return `AND (business_id = $${params.length} OR business_id IS NULL)`;
                })()
              : "";
          const driverIdExpr = routeColumns.has("driver_user_id")
            ? "driver_user_id"
            : routeColumns.has("driver_id")
            ? "driver_id"
            : "NULL::int";
    const busyRouteApprovals = await pool.query(
      `SELECT
        COALESCE(driver_name, '') AS driver_name,
        ${driverIdExpr} AS driver_user_id,
        COALESCE(from_location, '') || ' → ' || COALESCE(to_location, '') AS route_name,
        UPPER(status) AS route_status,
        COALESCE(route_id, id) AS route_id
      FROM route_approvals
      WHERE COALESCE(driver_name, '') <> ''
        AND (
          LOWER(COALESCE(status, '')) IN ('pending', 'awaiting_approval', 'submitted', 'in_review', 'for_approval', 'assigned', 'accepted', 'in_progress')
                OR LOWER(COALESCE(status, '')) LIKE '%pending%'
                OR LOWER(COALESCE(status, '')) LIKE '%await%'
                OR LOWER(COALESCE(status, '')) LIKE '%review%'
                OR LOWER(COALESCE(status, '')) LIKE '%submit%'
              )
             ${businessClause}
            ORDER BY COALESCE(submitted_at, approved_at) DESC NULLS LAST, id DESC
            LIMIT 50`,
            params
          );
        for (const row of busyRouteApprovals.rows) {
          upsertBusy(row.driver_name, row.route_name, row.route_status, row.route_id, null, row.driver_user_id);
        }
      }
    } catch (driverRouteErr) {
      console.warn("Driver monitor route_approvals lookup fallback:", driverRouteErr.message);
    }

    // Merge busy overlay into existing live-driver rows and add missing busy drivers
    if (driverMonitorRows.length > 0 && busyByDriver.size > 0) {
      const seenKeys = new Set();
      driverMonitorRows = driverMonitorRows.map((row) => {
        const busy = getBusyForDriver(row.full_name, row.user_id || row.driver_user_id);
        if (busy) {
          if (row.full_name) seenKeys.add(String(row.full_name).trim().toLowerCase());
          if (row.user_id || row.driver_user_id)
            seenKeys.add(`id:${row.user_id || row.driver_user_id}`);
          return { ...row, ...busy };
        }
        return row;
      });

      // add busy drivers not present in live list (e.g., pending assignments)
      for (const [key, busy] of busyByDriver.entries()) {
        if (seenKeys.has(key)) continue;
        const fallbackName = busy.driver_name || key.replace(/^id:/, "") || "Driver";
        driverMonitorRows.push({
          user_id: null,
          full_name: fallbackName,
          email: "",
          route_name: busy.route_name,
          route_status: busy.route_status,
          route_id: busy.route_id,
          vehicle_type: busy.vehicle_type,
          stops_completed: 0,
          stops_total: 0
        });
      }
    }

    // Base driver list mapped with busy overlay
    if (driverMonitorRows.length === 0) {
      driverMonitorRows = usersResult.rows.map((u) => {
        const fallbackName =
          String(u.full_name || "").trim() ||
          String(u.username || "").trim() ||
          String(u.email || "").split("@")[0] ||
          "Driver";
        const busy = getBusyForDriver(fallbackName, u.user_id);
        return {
          user_id: u.user_id,
          full_name: fallbackName,
          email: u.email,
          route_name: busy?.route_name || null,
          route_status: busy?.route_status || null,
          route_id: busy?.route_id || null,
          vehicle_type: busy?.vehicle_type || null,
          stops_completed: 0,
          stops_total: 2
        };
      });
    }

    return driverMonitorRows;
  } catch (err) {
    console.warn("Logistics driver monitor fallback:", err.message);
    return [];
  }
};

const fetchRouteOptimizationStats = async () => {
  try {
    const tableCheck = await pool.query(`SELECT to_regclass('public.route_optimizations') AS tbl`);
    const hasRouteOptimizations = !!tableCheck.rows[0]?.tbl;
    if (!hasRouteOptimizations) return { avg_savings_km: 0, avg_savings_fuel: 0, avg_savings_co2: 0 };
    const { rows } = await pool.query(
      `SELECT
         ROUND(AVG(savings_km)::numeric,2)   AS avg_savings_km,
         ROUND(AVG(savings_fuel)::numeric,2) AS avg_savings_fuel,
         ROUND(AVG(savings_co2)::numeric,2)  AS avg_savings_co2
       FROM route_optimizations`
    );
    return rows[0] || { avg_savings_km: 0, avg_savings_fuel: 0, avg_savings_co2: 0 };
  } catch (err) {
    console.warn("Route optimization stats fallback:", err.message);
    return { avg_savings_km: 0, avg_savings_fuel: 0, avg_savings_co2: 0 };
  }
};

app.get("/api/logistics/dashboard", optionalAuth, async (req, res) => {
  try {
    const businessId = req.user?.businessId || req.user?.business_id || null;
    const pendingDeliveryStatuses = ["pending", "awaiting_approval", "planned", "assigned_to_driver"];
    const pendingRouteStatusPredicate = `
      (
        LOWER(COALESCE(status, '')) IN ('pending', 'awaiting_approval', 'planned', 'assigned_to_driver')
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%PEND%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%AWAIT%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%REVIEW%'
        OR UPPER(REGEXP_REPLACE(COALESCE(status, ''), '[^A-Za-z0-9]+', '_', 'g')) LIKE '%SUBMIT%'
      )
    `;
    const deliveryRouteStatusPredicate = `LOWER(COALESCE(status, '')) IN ('pending', 'awaiting_approval', 'planned', 'assigned_to_driver')`;

    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const routeApprovalColumnsApprove = hasRouteApprovals ? await getTableColumns("route_approvals") : new Set();
    const routeApprovalColumns = hasRouteApprovals ? await getTableColumns("route_approvals") : new Set();
    const routeApprovalRefExpr = routeApprovalColumns.has("route_id")
      ? "COALESCE(ra.route_id, ra.id)"
      : "ra.id";
    const routeApprovalKeyExpr =
      hasRouteApprovals && routeApprovalColumns.has("route_id")
        ? "COALESCE(route_id::text, id::text)"
        : "id::text";
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const managerHasRouteKeys =
      managerColumns.has("route_id") ||
      managerColumns.has("related_record_id") ||
      managerColumns.has("delivery_id") ||
      managerColumns.has("request_data") ||
      managerColumns.has("extra_data");
    const canUseManagerRouteData =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status") &&
      managerHasRouteKeys;
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const hasDeliveryRoutes = await tableExists("delivery_routes");
    const deliveryRouteColumns = hasDeliveryRoutes ? await getTableColumns("delivery_routes") : new Set();

    let pendingResult;
    let statsResult;
    let usedDeliveryRoutes = false;

    const managerRowHasRoutePointer = (row) => {
      if (!row) return false;
      const requestData = row.request_data && typeof row.request_data === "object" ? row.request_data : {};
      const extraData = row.extra_data && typeof row.extra_data === "object" ? row.extra_data : {};
      const routeData = extraData.route && typeof extraData.route === "object" ? extraData.route : {};
      return Boolean(
        row.route_id ||
        row.related_record_id ||
        row.delivery_id ||
        requestData.route_id ||
        routeData.route_id
      );
    };

    // Prefer authoritative delivery_routes rows first to avoid generating placeholder pending ids.
    if (hasDeliveryRoutes) {
      const deliveryParams = [pendingDeliveryStatuses];
      let deliveryWhere = `LOWER(COALESCE(status, '')) = ANY($1::text[])`;
      if (businessId && deliveryRouteColumns.has("business_id")) {
        deliveryParams.push(businessId);
        deliveryWhere += ` AND business_id = $${deliveryParams.length}`;
      }
      pendingResult = await pool.query(
        `SELECT 
            route_id AS route_id,
            route_name,
            route_type,
            status,
            driver_name,
            vehicle_type,
            created_at,
            departure_time,
            from_location,
            to_location,
            origin_location,
            destination_location,
            total_distance_km,
            estimated_duration_minutes,
            estimated_fuel_consumption_liters,
            estimated_carbon_kg
         FROM delivery_routes
         WHERE ${deliveryWhere}
         ORDER BY created_at DESC
         LIMIT 20`,
        deliveryParams
      );
      if (pendingResult.rows.length > 0) {
        usedDeliveryRoutes = true;
        statsResult = await pool.query(
          `SELECT 
              COUNT(*) FILTER (WHERE ${deliveryWhere}) as pending_count,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'approved') as approved_count,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'declined') as declined_count,
              COALESCE(AVG(estimated_carbon_kg), 0) as avg_co2_saved,
              COALESCE(SUM(estimated_carbon_kg), 0) as total_co2_reduced,
              COALESCE(SUM(total_distance_km), 0) as total_km_saved
           FROM delivery_routes
           ${deliveryParams.length ? `WHERE ${deliveryWhere}` : ""}`,
          deliveryParams
        );
      }
    }

    if (!usedDeliveryRoutes && canUseManagerRouteData) {
      const pendingParams = [];
      let pendingWhere = `
         ma.approval_type = 'route_optimization'
         AND (
           LOWER(COALESCE(ma.status, '')) IN ('pending', 'awaiting_approval', 'submitted', 'in_review', 'for_approval')
           OR LOWER(COALESCE(ma.status, '')) LIKE '%pending%'
           OR LOWER(COALESCE(ma.status, '')) LIKE '%await%'
           OR LOWER(COALESCE(ma.status, '')) LIKE '%review%'
           OR LOWER(COALESCE(ma.status, '')) LIKE '%submit%'
         )
      `;
      if (businessId && managerColumns.has("business_id")) {
        pendingParams.push(businessId);
        pendingWhere += ` AND ma.business_id = $${pendingParams.length}`;
      }
      pendingResult = await pool.query(
        `SELECT *
         FROM manager_approvals ma
         WHERE ${pendingWhere}
         ORDER BY ma.created_at DESC
         LIMIT 20`,
        pendingParams
      );

      const statsParams = [];
      let statsWhere = `approval_type = 'route_optimization'`;
      if (businessId && managerColumns.has("business_id")) {
        statsParams.push(businessId);
        statsWhere += ` AND business_id = $${statsParams.length}`;
      }
      statsResult = await pool.query(
        `SELECT 
          COUNT(*) FILTER (WHERE LOWER(status) IN ('pending', 'awaiting_approval')) as pending_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'approved') as approved_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('declined', 'rejected')) as declined_count,
          0::numeric as avg_co2_saved,
          0::numeric as total_co2_reduced,
          0::numeric as total_km_saved
        FROM manager_approvals
        WHERE ${statsWhere}`,
        statsParams
      );

      // Manager rows that do not point to a specific route confuse the dashboard; drop them so we can fall back.
      if (pendingResult?.rows?.length) {
        const filteredManagerRows = pendingResult.rows.filter(managerRowHasRoutePointer);
        if (filteredManagerRows.length === 0) {
          pendingResult = { rows: [] };
        } else {
          pendingResult.rows = filteredManagerRows;
        }
      }

      // Fallback: some deployments have manager_approvals table but logistics rows only exist in route_approvals.
      if (pendingResult.rows.length === 0 && hasRouteApprovals) {
        pendingResult = await pool.query(
          `SELECT 
            ${routeApprovalKeyExpr} as route_id, 
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
    } else if (!usedDeliveryRoutes && hasRouteApprovals) {
      pendingResult = await pool.query(
        `SELECT 
          ${routeApprovalKeyExpr} as route_id, 
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

    // Final fallback to delivery_routes when no approvals are present
    if ((!pendingResult || pendingResult.rows.length === 0) && (await tableExists("delivery_routes"))) {
      pendingResult = await pool.query(
        `SELECT 
            route_id AS route_id,
            route_name,
            route_type,
            status,
            driver_name,
            vehicle_type,
            created_at,
            departure_time,
            from_location,
            to_location,
            origin_location,
            destination_location,
            total_distance_km,
            estimated_duration_minutes,
            estimated_fuel_consumption_liters,
            estimated_carbon_kg
         FROM delivery_routes
         WHERE ${deliveryRouteStatusPredicate}
         ORDER BY created_at DESC
         LIMIT 20`
      );
      statsResult = await pool.query(
        `SELECT 
          (SELECT COUNT(*) FROM delivery_routes WHERE ${deliveryRouteStatusPredicate}) as pending_count,
          (SELECT COUNT(*) FROM delivery_routes WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count,
          (SELECT COUNT(*) FROM delivery_routes WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count,
          COALESCE(AVG(estimated_carbon_kg), 0) as avg_co2_saved,
          COALESCE(SUM(estimated_carbon_kg), 0) as total_co2_reduced,
          COALESCE(SUM(total_distance_km), 0) as total_km_saved
        FROM delivery_routes`
      );
    }

    // Keep route_approvals for aggregate counters, but preserve manager_approvals
    // rows when available so dashboard cards use the same optimization payload
    // that admin submitted.
    if (hasRouteApprovals && !usedDeliveryRoutes) {
      const routePendingResult = await pool.query(
        `SELECT 
          ${routeApprovalKeyExpr} as route_id, 
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

      const routeStatsResult = await pool.query(
        `SELECT 
          (SELECT COUNT(*) FROM route_approvals WHERE ${pendingRouteStatusPredicate}) as pending_count,
          (SELECT COUNT(*) FROM route_approvals WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count,
          (SELECT COUNT(*) FROM route_approvals WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count,
          COALESCE(AVG(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as avg_co2_saved,
          COALESCE(SUM(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as total_co2_reduced,
          COALESCE(SUM(savings_km) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as total_km_saved
        FROM route_approvals`
      );

      statsResult = routeStatsResult;
      if (!canUseManagerRouteData || pendingResult.rows.length === 0) {
        pendingResult = routePendingResult;
      }
    }

    // Fallback: delivery_routes when approvals tables are empty or missing required columns
    if ((!pendingResult || pendingResult.rows.length === 0) && (await tableExists("delivery_routes"))) {
      pendingResult = await pool.query(
        `SELECT 
          route_id AS route_id,
          route_name,
          route_type,
          status,
          driver_name,
            vehicle_type,
            created_at,
            departure_time,
            from_location,
            to_location,
            origin_location,
            destination_location,
            total_distance_km,
            estimated_duration_minutes,
            estimated_fuel_consumption_liters,
            estimated_carbon_kg
         FROM delivery_routes
         WHERE ${deliveryRouteStatusPredicate}
         ORDER BY created_at DESC
         LIMIT 20`
      );
      if (!statsResult) {
        statsResult = await pool.query(
          `SELECT 
            (SELECT COUNT(*) FROM delivery_routes WHERE ${deliveryRouteStatusPredicate}) as pending_count,
            (SELECT COUNT(*) FROM delivery_routes WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count,
            (SELECT COUNT(*) FROM delivery_routes WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count,
            COALESCE(AVG(estimated_carbon_kg), 0) as avg_co2_saved,
            COALESCE(SUM(estimated_carbon_kg), 0) as total_co2_reduced,
            COALESCE(SUM(total_distance_km), 0) as total_km_saved
           FROM delivery_routes`
        );
      }
    }

    const driverMonitorRows = await fetchDriverMonitorRows(businessId);

    const stats = statsResult.rows[0] || {};
    const optStats = await fetchRouteOptimizationStats();
    let approvedCount = parseInt(stats.approved_count, 10) || 0;
    let declinedCount = parseInt(stats.declined_count, 10) || 0;

    // Fallback: count delivery assignments as approved progress for logistics dashboard.
    try {
      const deliveriesTableCheck = await pool.query(`SELECT to_regclass('public.deliveries') AS tbl`);
      const hasDeliveries = !!deliveriesTableCheck.rows[0]?.tbl;
      if (hasDeliveries) {
        const deliveriesColumns = await getTableColumns("deliveries");
        const deliveryStatusExpr = deliveriesColumns.has("status") ? "LOWER(COALESCE(status, ''))" : "''";
        const deliveryIdExpr = deliveriesColumns.has("delivery_id")
          ? "delivery_id::text"
          : deliveriesColumns.has("id")
          ? "id::text"
          : "NULL::text";
        const routeIdExpr = deliveriesColumns.has("route_id")
          ? `COALESCE(route_id::text, ${deliveryIdExpr})`
          : deliveryIdExpr;
        const deliveryStats = await pool.query(
          `SELECT
             COUNT(DISTINCT ${routeIdExpr}) FILTER (WHERE ${deliveryStatusExpr} IN ('assigned', 'accepted', 'in_progress', 'completed')) as approved_count,
             COUNT(DISTINCT ${routeIdExpr}) FILTER (WHERE ${deliveryStatusExpr} IN ('declined', 'rejected', 'cancelled')) as declined_count
           FROM deliveries`
        );
        const deliveryApproved = parseInt(deliveryStats.rows[0]?.approved_count, 10) || 0;
        const deliveryDeclined = parseInt(deliveryStats.rows[0]?.declined_count, 10) || 0;
        approvedCount = Math.max(approvedCount, deliveryApproved);
        declinedCount = Math.max(declinedCount, deliveryDeclined);
      }
    } catch (deliveryStatsErr) {
      console.warn("Logistics dashboard delivery stats fallback failed:", deliveryStatsErr.message);
    }
    const routeStopsTableCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
    const hasRouteStops = !!routeStopsTableCheck.rows[0]?.tbl;
    const mappedPendingRoutes = [];
    for (const row of pendingResult.rows) {
      try {
        const route = await buildLogisticsRoutePayload(row, { hasRouteStops });
        if (route) {
          // Ensure a usable route identifier even when source tables miss route_id.
          let rid =
            route.routeId ||
            route.route_id ||
            row.route_id ||
            row.id ||
            row.approval_id ||
            row.delivery_id ||
            null;
          if (!rid && (route.route_name || row.route_name)) {
            const m = String(route.route_name || row.route_name).match(/(\d[\d-]*)$/);
            if (m && m[1]) rid = m[1].replace(/[^0-9]/g, "");
          }
          if (rid) {
            route.routeId = rid;
            route.route_id = rid;
            route.route_number = route.route_number || rid;
            route.route_code = route.route_code || route.route_name || (rid ? `Route-${rid}` : null);
          }
          mappedPendingRoutes.push(route);
        }
      } catch (mapErr) {
        console.error("Logistics payload build error for row", row?.route_id || row?.id || "unknown", mapErr.message);
      }
    }
    // If mapping failed for all rows, provide a minimal fallback so UI still shows pending items.
    if (mappedPendingRoutes.length === 0 && pendingResult.rows.length > 0) {
      console.warn(
        "Logistics dashboard: payload mapping produced 0 routes; using minimal fallback from delivery_routes"
      );
      for (const row of pendingResult.rows) {
        let rid = row.route_id ?? row.id ?? null;
        if (!rid && row.route_name) {
          const m = String(row.route_name).match(/(\d[\d-]*)$/);
          if (m && m[1]) rid = m[1].replace(/[^0-9]/g, "");
        }
        mappedPendingRoutes.push({
          route_id: rid,
          routeId: rid,
          route_number: rid,
          route_code: row.route_name || (rid ? `Route-${rid}` : null),
          route_name: row.route_name || null,
          routeType: row.route_type || "STANDARD",
          route_type: row.route_type || "STANDARD",
          status: row.status || "pending",
          from: row.from_location || "Origin",
          to: row.to_location || null,
          driver: row.driver_name || "Unassigned",
          vehicle: row.vehicle_type || "Van",
          departureTime: row.departure_time || row.created_at || null,
          stops: [],
          route_path: [],
          routePath: []
        });
      }
    }
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
    // Second-pass dedupe by route fingerprint to eliminate duplicate pending rows
    // that may have different IDs but represent the same route submission.
    const pendingFingerprintMap = new Map();
    for (const route of pendingRouteMap.values()) {
      const fromKey = String(route.from || route.from_location || "").trim().toLowerCase();
      const toKey = String(route.to || route.to_location || "").trim().toLowerCase();
      const driverKey = String(route.driver || route.driver_name || "").trim().toLowerCase();
      const depRaw = route.departureTime || route.departure_time || route.submittedTime || route.submitted_at || "";
      const depKey = String(depRaw).trim().slice(0, 16); // keep up to minute granularity
      const fingerprint = [fromKey, toKey, driverKey, depKey].join("|");
      const existing = pendingFingerprintMap.get(fingerprint);
      if (!existing) {
        pendingFingerprintMap.set(fingerprint, route);
        continue;
      }
      const existingTs = new Date(existing.submittedTime || existing.submitted_at || 0).getTime();
      const currentTs = new Date(route.submittedTime || route.submitted_at || 0).getTime();
      if (currentTs >= existingTs) pendingFingerprintMap.set(fingerprint, route);
    }
    let pendingRoutes = Array.from(pendingFingerprintMap.values());
    if (hasRouteApprovals && pendingRoutes.length > 0) {
      try {
        const resolvedRoutesResult = await pool.query(
          `SELECT DISTINCT ${routeApprovalKeyExpr} AS route_key
           FROM route_approvals
           WHERE UPPER(COALESCE(status, '')) IN ('APPROVED', 'DECLINED', 'REJECTED', 'CANCELLED', 'COMPLETED')`
        );
        const resolvedRouteKeys = new Set(
          resolvedRoutesResult.rows
            .map((r) => String(r.route_key || "").trim())
            .filter(Boolean)
        );
        if (resolvedRouteKeys.size > 0) {
          pendingRoutes = pendingRoutes.filter((route) => {
            const key = String(route.routeId || route.route_id || "").trim();
            return !key || !resolvedRouteKeys.has(key);
          });
        }
      } catch (resolvedErr) {
        console.warn("Logistics pending resolved-route filter fallback:", resolvedErr.message);
      }
    }

    // Final guard: never return null route ids to the client.
    pendingRoutes = pendingRoutes.map((route, idx) => {
      let rid =
        route.routeId ||
        route.route_id ||
        route.route_number ||
        route.route_code ||
        (route.departureTime ? `pending-${new Date(route.departureTime).getTime()}` : null) ||
        `pending-${idx + 1}`;
      route.routeId = rid;
      route.route_id = rid;
      route.route_number = route.route_number || rid;
      route.route_code = route.route_code || route.route_name || (rid ? `Route-${rid}` : rid);
      return route;
    });

    // If we still only have generated pending-* ids, try to replace them with real delivery_routes ids.
    try {
      const hasGeneratedOnly = pendingRoutes.every((r) => String(r.route_id || "").startsWith("pending-"));
      if (hasGeneratedOnly && (await tableExists("delivery_routes"))) {
        const deliveryPending = await pool.query(
          `SELECT 
              COALESCE(route_id, id) AS route_id,
              route_name,
              route_type,
              status,
              driver_name,
              vehicle_type,
              created_at,
              departure_time,
              from_location,
              to_location,
              origin_location,
              destination_location,
              total_distance_km,
              estimated_duration_minutes,
              estimated_fuel_consumption_liters,
              estimated_carbon_kg
           FROM delivery_routes
           WHERE ${deliveryRouteStatusPredicate}
           ORDER BY created_at DESC
           LIMIT 20`
        );
        if (deliveryPending.rows.length > 0) {
          const replacements = deliveryPending.rows.map((row) => ({
            route_id: row.route_id,
            routeId: row.route_id,
            route_number: row.route_id,
            route_code: row.route_name || (row.route_id ? `Route-${row.route_id}` : null),
            route_name: row.route_name,
            routeType: row.route_type || "STANDARD",
            route_type: row.route_type || "STANDARD",
            status: row.status || "pending",
            from: row.from_location || "Origin",
            to: row.to_location || null,
            driver: row.driver_name || "Driver Not Assigned",
            vehicle: row.vehicle_type || "van",
            departureTime: row.departure_time || row.created_at || null,
            stops: [],
            route_path: [],
            routePath: []
          }));
          pendingRoutes = replacements;
        }
      }
    } catch (replaceErr) {
      console.warn("Logistics pending replace with delivery_routes failed:", replaceErr.message);
    }

    // Also merge in any pending delivery_routes that aren't already present.
    try {
      if (await tableExists("delivery_routes")) {
        const existingKeys = new Set(
          pendingRoutes.map((r) => String(r.routeId || r.route_id || "").trim()).filter(Boolean)
        );
        const deliveryPending = await pool.query(
          `SELECT 
              COALESCE(route_id, id) AS route_id,
              route_name,
              route_type,
              status,
              driver_name,
              vehicle_type,
              created_at,
              departure_time,
              from_location,
              to_location,
              origin_location,
              destination_location,
              total_distance_km,
              estimated_duration_minutes,
              estimated_fuel_consumption_liters,
              estimated_carbon_kg
           FROM delivery_routes
           WHERE ${deliveryRouteStatusPredicate}
           ORDER BY created_at DESC
           LIMIT 20`
        );
        for (const row of deliveryPending.rows) {
          const key = String(row.route_id || "").trim();
          if (!key || existingKeys.has(key)) continue;
          try {
            const route = await buildLogisticsRoutePayload(row, { hasRouteStops });
            if (route) {
              route.routeId = route.routeId || route.route_id || row.route_id;
              route.route_id = route.route_id || route.routeId;
              route.route_number = route.route_number || route.routeId;
              route.route_code = route.route_code || route.route_name || (route.routeId ? `Route-${route.routeId}` : null);
              pendingRoutes.push(route);
              existingKeys.add(route.routeId);
            }
          } catch (mergeErr) {
            console.warn("Logistics merge delivery_routes pending failed:", mergeErr.message);
          }
        }

        // As a definitive fallback, override with the most recent delivery_routes (any status).
        const recentDelivery = await pool.query(
          `SELECT 
              COALESCE(route_id, id) AS route_id,
              route_name,
              route_type,
              status,
              driver_name,
              vehicle_type,
              created_at,
              departure_time,
              from_location,
              to_location,
              origin_location,
              destination_location,
              total_distance_km,
              estimated_duration_minutes,
              estimated_fuel_consumption_liters,
              estimated_carbon_kg
           FROM delivery_routes
           ORDER BY created_at DESC
           LIMIT 20`
        );
        if (recentDelivery.rows.length > 0) {
          pendingRoutes = recentDelivery.rows.map((row) => ({
            route_id: row.route_id,
            routeId: row.route_id,
            route_number: row.route_id,
            route_code: row.route_name || (row.route_id ? `Route-${row.route_id}` : null),
            route_name: row.route_name,
            routeType: row.route_type || "STANDARD",
            route_type: row.route_type || "STANDARD",
            status: row.status || "pending",
            from: row.from_location || "Origin",
            to: row.to_location || null,
            driver: row.driver_name || "Driver Not Assigned",
            vehicle: row.vehicle_type || "van",
            departureTime: row.departure_time || row.created_at || null,
            stops: [],
            route_path: [],
            routePath: []
          }));
        }
      }
    } catch (mergeErrOuter) {
      console.warn("Logistics merge delivery_routes outer failed:", mergeErrOuter.message);
    }

    // Keep pendingRoutes strictly pending; All Routes screen already falls back to history.

    res.json({
      success: true,
      summary: {
        pendingApprovals: pendingRoutes.length,
        approvedToday: approvedCount,
        declined: declinedCount,
        avgCO2Saved: parseFloat(stats.avg_co2_saved) || 0,
        avgFuelSaved: parseFloat(optStats.avg_savings_fuel) || 0,
        avgKmSaved: parseFloat(optStats.avg_savings_km) || 0,
        totalCO2Reduced: parseFloat(stats.total_co2_reduced) || 0,
        totalKmSaved: parseFloat(stats.total_km_saved) || 0
      },
      pendingRoutes: pendingRoutes,
      driverMonitor: driverMonitorRows,
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
        avgFuelSaved: 0,
        avgKmSaved: 0,
        totalCO2Reduced: 0,
        totalKmSaved: 0
      },
      pendingRoutes: [],
      driverMonitor: [],
      message: `Logistics data temporarily unavailable: ${err.message || 'unknown error'}`
    });
  }
});

app.get("/api/logistics/driver-monitor", optionalAuth, async (req, res) => {
  try {
    const businessId = req.user?.businessId || req.user?.business_id || null;
    const driverMonitorRows = await fetchDriverMonitorRows(businessId);
    return res.json({ success: true, data: driverMonitorRows, message: null });
  } catch (err) {
    console.error("Logistics driver monitor endpoint error:", err);
    return res.status(500).json({ success: false, data: [], message: "Driver monitor unavailable" });
  }
});

app.get("/api/logistics/stats", async (_req, res) => {
  try {
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    let countsRow = { pending: 0, approved: 0, declined: 0 };

    if (hasManagerApprovals) {
      const counts = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('pending','awaiting_approval','submitted','in_review','for_approval')) AS pending,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) = 'approved') AS approved,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('declined','rejected','cancelled')) AS declined
         FROM manager_approvals
         WHERE approval_type = 'route_optimization'`
      );
      countsRow = counts.rows[0] || countsRow;
    } else if (hasRouteApprovals) {
      const counts = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('pending','awaiting_approval','submitted','in_review','for_approval')) AS pending,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) = 'approved') AS approved,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('declined','rejected','cancelled')) AS declined
         FROM route_approvals`
      );
      countsRow = counts.rows[0] || countsRow;
    }

    const optStats = await fetchRouteOptimizationStats();
    return res.json({
      success: true,
      summary: {
        pendingApprovals: parseInt(countsRow.pending, 10) || 0,
        approved: parseInt(countsRow.approved, 10) || 0,
        declined: parseInt(countsRow.declined, 10) || 0,
        avgKmSaved: parseFloat(optStats.avg_savings_km) || 0,
        avgFuelSaved: parseFloat(optStats.avg_savings_fuel) || 0,
        avgCO2Saved: parseFloat(optStats.avg_savings_co2) || 0
      }
    });
  } catch (err) {
    console.error("Logistics stats endpoint error:", err);
    return res.status(500).json({ success: false, summary: null, message: "Logistics stats unavailable" });
  }
});

app.post("/api/logistics/admin/cleanup-pending-duplicates", authenticate, authorize("admin"), async (req, res) => {
  try {
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    if (!hasManagerApprovals) {
      return res.json({ success: true, updated: 0, message: "manager_approvals table not found" });
    }

    const managerColumns = await getManagerApprovalsColumns();
    if (!managerColumns.has("approval_type") || !managerColumns.has("status")) {
      return res.json({ success: true, updated: 0, message: "Required columns missing in manager_approvals" });
    }

    const managerPkCol = await getManagerApprovalsPkColumn();
    const keyColumns = ["route_id", "related_record_id", "delivery_id"]
      .filter((column) => managerColumns.has(column));
    const routeKeyExpr = keyColumns.length > 0
      ? `COALESCE(${keyColumns.map((column) => `${column}::text`).join(", ")})`
      : `${managerPkCol}::text`;
    const orderExpr = managerColumns.has("created_at")
      ? `created_at DESC NULLS LAST, ${managerPkCol} DESC`
      : `${managerPkCol} DESC`;

    const result = await pool.query(`
      WITH ranked AS (
        SELECT ${managerPkCol} AS pk,
               ROW_NUMBER() OVER (
                 PARTITION BY ${routeKeyExpr}
                 ORDER BY ${orderExpr}
               ) AS rn
        FROM manager_approvals
        WHERE approval_type = 'route_optimization'
          AND (
            LOWER(COALESCE(status, '')) IN ('pending', 'awaiting_approval', 'submitted', 'in_review', 'for_approval')
            OR LOWER(COALESCE(status, '')) LIKE '%pending%'
            OR LOWER(COALESCE(status, '')) LIKE '%await%'
            OR LOWER(COALESCE(status, '')) LIKE '%review%'
            OR LOWER(COALESCE(status, '')) LIKE '%submit%'
          )
      )
      UPDATE manager_approvals ma
      SET status = 'superseded',
          manager_comment = COALESCE(ma.manager_comment, 'Superseded duplicate pending approval'),
          updated_at = NOW()
      FROM ranked r
      WHERE ma.${managerPkCol} = r.pk
        AND r.rn > 1
      RETURNING ma.${managerPkCol} AS approval_id
    `);

    return res.json({
      success: true,
      updated: result.rowCount || 0,
      message: `Superseded ${result.rowCount || 0} duplicate pending approvals`
    });
  } catch (err) {
    console.error("cleanup-pending-duplicates error:", err);
    return res.status(500).json({ success: false, message: err.message || "Cleanup failed" });
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
    const managerHasRouteKeys =
      managerColumns.has("route_id") ||
      managerColumns.has("related_record_id") ||
      managerColumns.has("delivery_id") ||
      managerColumns.has("request_data") ||
      managerColumns.has("extra_data");
    const canUseManagerRouteData =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status") &&
      managerHasRouteKeys;
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const routeApprovalColumns = hasRouteApprovals ? await getTableColumns("route_approvals") : new Set();
    const routeStopsTableCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
    const hasRouteStops = !!routeStopsTableCheck.rows[0]?.tbl;
    const hasDeliveryRoutes = await tableExists("delivery_routes");

    let row = null;
    if (hasDeliveryRoutes) {
      const deliveryResult = await pool.query(
        `SELECT *
         FROM delivery_routes
         WHERE route_id::text = $1 OR COALESCE(route_name::text, '') = $1
         ORDER BY created_at DESC NULLS LAST
         LIMIT 1`,
        [routeId]
      );
      row = deliveryResult.rows[0] || null;
    }

    if (!row && canUseManagerRouteData) {
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
              NOT IN ('APPROVED', 'DECLINED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'SUPERSEDED')
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
    const pendingDeliveryStatuses = ["pending", "awaiting_approval", "planned", "assigned_to_driver"];
    const hasDeliveryRoutes = await tableExists("delivery_routes");
    const deliveryRouteColumns = hasDeliveryRoutes ? await getTableColumns("delivery_routes") : new Set();
    const businessId =
      (req.user && (req.user.businessId || req.user.business_id)) || null;
    let result;
    let usedDeliveryRoutes = false;
    let usedManagerRows = false;
    if (hasDeliveryRoutes) {
      const deliveryParams = [pendingDeliveryStatuses];
      let deliveryWhere = `LOWER(COALESCE(status, '')) = ANY($1::text[])`;
      if (businessId && deliveryRouteColumns.has("business_id")) {
        deliveryParams.push(businessId);
        deliveryWhere += ` AND business_id = $${deliveryParams.length}`;
      }
      result = await pool.query(
        `SELECT 
            COALESCE(route_id, id) AS route_id,
            route_name,
            route_type,
            status,
            driver_name,
            vehicle_type,
            created_at,
            departure_time,
            from_location,
            to_location,
            origin_location,
            destination_location,
            total_distance_km,
            estimated_duration_minutes,
            estimated_fuel_consumption_liters,
            estimated_carbon_kg
         FROM delivery_routes
         WHERE ${deliveryWhere}
         ORDER BY created_at DESC
         LIMIT 30`,
        deliveryParams
      );
      usedDeliveryRoutes = result.rows.length > 0;
    }

    if (!usedDeliveryRoutes && canUseManagerRouteData) {
      const managerRowHasRoutePointer = (row) => {
        if (!row) return false;
        const requestData = row.request_data && typeof row.request_data === "object" ? row.request_data : {};
        const extraData = row.extra_data && typeof row.extra_data === "object" ? row.extra_data : {};
        const routeData = extraData.route && typeof extraData.route === "object" ? extraData.route : {};
        return Boolean(
          row.route_id ||
          row.related_record_id ||
          row.delivery_id ||
          requestData.route_id ||
          routeData.route_id
        );
      };
      // Relax business scoping to avoid missing admin-submitted routes.
      const managerParams = [];
      let managerBusinessClause = "";
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
          ${managerBusinessClause}
        ORDER BY ma.created_at DESC
      `, managerParams);
      usedManagerRows = true;

      // Manager rows must reference a route; otherwise force fallback to route_approvals.
      if (result?.rows?.length) {
        const filteredManagerRows = result.rows.filter(managerRowHasRoutePointer);
        if (filteredManagerRows.length === 0) {
          result = { rows: [] };
          usedManagerRows = false;
        } else {
          result.rows = filteredManagerRows;
        }
      }

      // Fallback to route_approvals when manager_approvals has no logistics records.
      if (result.rows.length === 0 && hasRouteApprovals) {
        const routeParams = [];
        let routeBusinessClause = "";
        result = await pool.query(`
          SELECT id, route_type as product_name, from_location as location, driver_name, vehicle_type, departure_time, 
                 original_distance as total_distance_km, optimized_distance, original_fuel as estimated_fuel_consumption_liters, 
                 optimized_fuel, original_co2 as estimated_carbon_kg, optimized_co2 as optimized_carbon_kg, 
                 savings_km, savings_fuel, savings_co2, ai_suggestion as ai_recommendation, status, 
                 submitted_by, submitted_at as created_at 
          FROM route_approvals
          WHERE ${pendingRouteStatusPredicate}
          ${routeBusinessClause}
          ORDER BY submitted_at DESC
        `, routeParams);
        usedManagerRows = false;
      }
    } else if (!usedDeliveryRoutes && hasRouteApprovals) {
      const routeParams = [];
      let routeBusinessClause = "";
      result = await pool.query(`
        SELECT id, route_type as product_name, from_location as location, driver_name, vehicle_type, departure_time, 
               original_distance as total_distance_km, optimized_distance, original_fuel as estimated_fuel_consumption_liters, 
               optimized_fuel, original_co2 as estimated_carbon_kg, optimized_co2 as optimized_carbon_kg, 
               savings_km, savings_fuel, savings_co2, ai_suggestion as ai_recommendation, status, 
               submitted_by, submitted_at as created_at 
        FROM route_approvals
        WHERE ${pendingRouteStatusPredicate}
        ${routeBusinessClause}
        ORDER BY submitted_at DESC
      `, routeParams);
    } else if (!usedDeliveryRoutes) {
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
      : usedDeliveryRoutes
      ? result.rows.map((row) => {
          const originLoc = parseMaybeJsonObject(row.origin_location) || {};
          return {
            id: row.route_id,
            product_name: row.route_type || "STANDARD",
            location: row.from_location || originLoc.address || "Origin",
            driver_name: row.driver_name || null,
            vehicle_type: row.vehicle_type || null,
            departure_time: row.departure_time || row.created_at || null,
            total_distance_km: row.total_distance_km,
            estimated_fuel_consumption_liters: row.estimated_fuel_consumption_liters,
            estimated_carbon_kg: row.estimated_carbon_kg,
            status: String(row.status || "pending").toUpperCase(),
            submitted_by: row.created_by ? String(row.created_by) : "System",
            created_at: row.created_at || null,
            route_id: row.route_id,
            route_name: row.route_name
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
              NOT IN ('APPROVED', 'DECLINED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'SUPERSEDED')
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
    let result = hasRouteApprovals
      ? await pool.query(`
          SELECT COUNT(*) FILTER (WHERE ${pendingRouteStatusPredicate}) as pending_count, 
                 COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED') as approved_count, 
                 COUNT(*) FILTER (WHERE UPPER(COALESCE(status, '')) = 'DECLINED') as declined_count, 
                 COALESCE(AVG(savings_co2) FILTER (WHERE UPPER(COALESCE(status, '')) = 'APPROVED'), 0) as avg_co2_saved 
          FROM route_approvals
        `)
      : canUseManagerStats
      ? await pool.query(`
          SELECT COUNT(*) FILTER (WHERE LOWER(status) IN ('pending', 'awaiting_approval')) as pending_count, 
                 COUNT(*) FILTER (WHERE LOWER(status) = 'approved') as approved_count, 
                 COUNT(*) FILTER (WHERE LOWER(status) IN ('declined', 'rejected')) as declined_count, 
                 0::numeric as avg_co2_saved
          FROM manager_approvals
          WHERE approval_type = 'route_optimization'
        `)
      : await pool.query(`
          SELECT COUNT(*) FILTER (WHERE status = 'pending') as pending_count, 
                 COUNT(*) FILTER (WHERE status = 'approved') as approved_count, 
                 COUNT(*) FILTER (WHERE status = 'declined') as declined_count, 
                 0::numeric as avg_co2_saved
          FROM manager_approvals
          WHERE approval_type = 'route_optimization'
        `);

    if (hasRouteApprovals && canUseManagerStats) {
      const counts = result.rows[0] || {};
      const routeTotal =
        (parseInt(counts.pending_count, 10) || 0) +
        (parseInt(counts.approved_count, 10) || 0) +
        (parseInt(counts.declined_count, 10) || 0);
      if (routeTotal === 0) {
        result = await pool.query(`
          SELECT COUNT(*) FILTER (WHERE LOWER(status) IN ('pending', 'awaiting_approval')) as pending_count, 
                 COUNT(*) FILTER (WHERE LOWER(status) = 'approved') as approved_count, 
                 COUNT(*) FILTER (WHERE LOWER(status) IN ('declined', 'rejected')) as declined_count, 
                 0::numeric as avg_co2_saved
          FROM manager_approvals
          WHERE approval_type = 'route_optimization'
        `);
      }
    }

    // Delivery fallback: assignment flow is approval completion in this app.
    try {
      const deliveriesTableCheck = await pool.query(`SELECT to_regclass('public.deliveries') AS tbl`);
      const hasDeliveries = !!deliveriesTableCheck.rows[0]?.tbl;
      if (hasDeliveries) {
        const deliveriesColumns = await getTableColumns("deliveries");
        const deliveryStatusExpr = deliveriesColumns.has("status") ? "LOWER(COALESCE(status, ''))" : "''";
        const routeIdExpr = deliveriesColumns.has("route_id")
          ? "COALESCE(route_id::text, delivery_id::text)"
          : "delivery_id::text";
        const deliveryStats = await pool.query(
          `SELECT
             COUNT(DISTINCT ${routeIdExpr}) FILTER (WHERE ${deliveryStatusExpr} IN ('assigned', 'accepted', 'in_progress', 'completed')) as approved_count,
             COUNT(DISTINCT ${routeIdExpr}) FILTER (WHERE ${deliveryStatusExpr} IN ('declined', 'rejected', 'cancelled')) as declined_count
           FROM deliveries`
        );
        const row = result.rows[0] || {};
        row.approved_count = Math.max(parseInt(row.approved_count, 10) || 0, parseInt(deliveryStats.rows[0]?.approved_count, 10) || 0);
        row.declined_count = Math.max(parseInt(row.declined_count, 10) || 0, parseInt(deliveryStats.rows[0]?.declined_count, 10) || 0);
        result.rows[0] = row;
      }
    } catch (deliveryStatsErr) {
      console.warn("Logistics stats delivery fallback failed:", deliveryStatsErr.message);
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
          // Copy route stops (with coordinates) into the delivery so geofence/arrival logic has real points.
          let stopsJson = null;
          try {
            const rsCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
            if (rsCheck.rows[0]?.tbl) {
              const rs = await pool.query(
                `SELECT stop_sequence, location_name, address, latitude, longitude
                 FROM route_stops
                 WHERE route_id = $1
                 ORDER BY stop_sequence ASC`,
                [id]
              );
              if (rs.rows.length) {
                stopsJson = rs.rows.map((s, idx) => ({
                  stopId: s.stop_sequence ?? idx + 1,
                  sequence: s.stop_sequence ?? idx + 1,
                  stopName: s.location_name || s.address || `Stop ${idx + 1}`,
                  address: s.address || s.location_name || "",
                  latitude: toFiniteNumber(s.latitude),
                  longitude: toFiniteNumber(s.longitude),
                  status: "pending"
                }));
              }
            }
          } catch (routeStopsErr) {
            console.warn("delivery insert route_stops fetch failed:", routeStopsErr.message);
          }

          // Create a new delivery record
          await pool.query(
            `INSERT INTO deliveries 
              (route_id, status, driver_name, vehicle_type, departure_time, from_location, to_location,
               distance_km, estimated_fuel_consumption_liters, estimated_carbon_kg, stops_json)
             VALUES ($1, 'assigned', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, driverName, route.vehicle_type, route.departure_time, route.from_location, 
             route.to_location, route.optimized_distance || route.original_distance,
             route.optimized_fuel || route.original_fuel, route.optimized_co2 || route.original_co2,
             stopsJson]
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
    const declineReason = String(reason || "").trim();
    if (!declineReason) {
      return res.status(400).json({
        success: false,
        message: "Decline reason is required before returning route to admin"
      });
    }
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
        [declineReason, id]
      );
      if (hasRouteApprovals) {
        if (maResult.rows.length > 0) {
          const routeRef = maResult.rows[0].route_id || maResult.rows[0].delivery_id;
          if (routeRef) {
            await pool.query(`UPDATE route_approvals SET status = 'DECLINED', manager_comment = $1, approved_at = NOW() WHERE id = $2`, [declineReason, routeRef]);
          }
        } else {
          await pool.query(`UPDATE route_approvals SET status = 'DECLINED', manager_comment = $1, approved_at = NOW() WHERE id = $2`, [declineReason, id]);
        }
      }
    } else if (hasRouteApprovals) {
      await pool.query(`UPDATE route_approvals SET status = 'DECLINED', manager_comment = $1, approved_at = NOW() WHERE id = $2`, [declineReason, id]);
    } else {
      await pool.query(
        `UPDATE manager_approvals
         SET status = 'declined', manager_comment = $1, decision_notes = $1, reviewed_at = NOW(), updated_at = NOW()
         WHERE ${managerPkCol} = $2`,
        [declineReason, id]
      );
    }
    res.json({ success: true, message: "Declined with reason and returned to admin" });
  } catch (err) { res.json({ success: false, message: "Decline failed" }); }
});

app.get("/api/logistics/history", async (req, res) => {
  try {
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const routeApprovalColumns = hasRouteApprovals ? await getTableColumns("route_approvals") : new Set();
    const routeOptimizationTableCheck = await pool.query(`SELECT to_regclass('public.route_optimizations') AS tbl`);
    const hasRouteOptimizations = !!routeOptimizationTableCheck.rows[0]?.tbl;
    const routeOptimizationColumns = hasRouteOptimizations ? await getTableColumns("route_optimizations") : new Set();
    const joinRouteOptimizations =
      hasRouteApprovals &&
      hasRouteOptimizations &&
      routeOptimizationColumns.has("route_id");
    const roSavingsKmExpr = joinRouteOptimizations && routeOptimizationColumns.has("savings_km")
      ? "COALESCE(ro.savings_km, 0)"
      : "0";
    const roSavingsCo2Expr = joinRouteOptimizations && routeOptimizationColumns.has("savings_co2")
      ? "COALESCE(ro.savings_co2, 0)"
      : "0";
    const roAiExpr = joinRouteOptimizations && routeOptimizationColumns.has("ai_recommendation")
      ? "NULLIF(ro.ai_recommendation, '')"
      : "NULL";
    const originalDistanceExpr = routeApprovalColumns.has("original_distance") ? "COALESCE(ra.original_distance, 0)" : "0";
    const optimizedDistanceExpr = routeApprovalColumns.has("optimized_distance") ? "COALESCE(ra.optimized_distance, 0)" : "0";
    const originalCo2Expr = routeApprovalColumns.has("original_co2") ? "COALESCE(ra.original_co2, 0)" : "0";
    const optimizedCo2Expr = routeApprovalColumns.has("optimized_co2") ? "COALESCE(ra.optimized_co2, 0)" : "0";
    const savingsKmExpr = routeApprovalColumns.has("savings_km")
      ? `COALESCE(NULLIF(ra.savings_km, 0), ${roSavingsKmExpr}, GREATEST(${originalDistanceExpr} - ${optimizedDistanceExpr}, 0), 0)`
      : `COALESCE(${roSavingsKmExpr}, GREATEST(${originalDistanceExpr} - ${optimizedDistanceExpr}, 0), 0)`;
    const savingsCo2Expr = routeApprovalColumns.has("savings_co2")
      ? `COALESCE(NULLIF(ra.savings_co2, 0), ${roSavingsCo2Expr}, GREATEST(${originalCo2Expr} - ${optimizedCo2Expr}, 0), 0)`
      : `COALESCE(${roSavingsCo2Expr}, GREATEST(${originalCo2Expr} - ${optimizedCo2Expr}, 0), 0)`;
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const canUseManagerRouteData =
      hasManagerApprovals &&
      managerColumns.has("request_data") &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const managerRouteRefExpr = managerColumns.has("route_id")
      ? "ma.route_id"
      : managerColumns.has("related_record_id")
      ? "ma.related_record_id"
      : managerColumns.has("delivery_id")
      ? "ma.delivery_id"
      : `ma.${managerPkCol}`;
    const managerHistoryOrderBy = managerColumns.has("updated_at")
      ? "ma.reviewed_at DESC NULLS LAST, ma.updated_at DESC"
      : "ma.reviewed_at DESC NULLS LAST, ma.created_at DESC NULLS LAST";
    let result = hasRouteApprovals
      ? await pool.query(`
          SELECT ra.id as approval_id, ${routeApprovalRefExpr} as route_id, ra.route_type as product_name, ra.from_location, ra.to_location, ra.from_location as location, ra.driver_name, 
                 ra.status, ${savingsKmExpr} as savings_km, ${savingsCo2Expr} as savings_co2, COALESCE(NULLIF(ra.ai_suggestion, ''), ${roAiExpr}, '') as ai_suggestion, ra.approved_at as reviewed_at, ra.manager_comment as review_notes 
          FROM route_approvals ra
          ${joinRouteOptimizations ? "LEFT JOIN route_optimizations ro ON ro.route_id = " + routeApprovalRefExpr : ""}
          WHERE LOWER(COALESCE(ra.status, '')) IN ('approved', 'declined', 'rejected')
          ORDER BY ra.approved_at DESC NULLS LAST, ra.submitted_at DESC NULLS LAST
          LIMIT 100
        `)
      : canUseManagerRouteData
      ? await pool.query(`
          SELECT
            ma.${managerPkCol} as approval_id,
            ${managerRouteRefExpr} as route_id,
            COALESCE(ma.request_data->>'route_type', 'STANDARD') as product_name,
            COALESCE(ma.request_data->>'from_location', 'Unknown') as from_location,
            COALESCE(ma.request_data->>'to_location', null) as to_location,
            COALESCE(ma.request_data->>'from_location', 'Unknown') as location,
            ma.request_data->>'driver_name' as driver_name,
            UPPER(ma.status) as status,
            COALESCE((ma.request_data->>'savings_km')::numeric, 0) as savings_km,
            COALESCE((ma.request_data->>'savings_co2')::numeric, 0) as savings_co2,
            COALESCE(ma.request_data->>'ai_suggestion', ma.request_data->>'ai_recommendation', '') as ai_suggestion,
            ma.reviewed_at as reviewed_at,
            COALESCE(ma.manager_comment, ma.decision_notes) as review_notes
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(ma.status) IN ('approved', 'declined', 'rejected')
          ORDER BY ${managerHistoryOrderBy}
          LIMIT 100
        `)
      : { rows: [] };

    if (canUseManagerRouteData && result.rows.length === 0) {
      result = await pool.query(`
        SELECT
          ma.${managerPkCol} as approval_id,
          ${managerRouteRefExpr} as route_id,
          COALESCE(ma.request_data->>'route_type', 'STANDARD') as product_name,
          COALESCE(ma.request_data->>'from_location', 'Unknown') as from_location,
          COALESCE(ma.request_data->>'to_location', null) as to_location,
          COALESCE(ma.request_data->>'from_location', 'Unknown') as location,
          ma.request_data->>'driver_name' as driver_name,
          UPPER(ma.status) as status,
          COALESCE((ma.request_data->>'savings_km')::numeric, 0) as savings_km,
          COALESCE((ma.request_data->>'savings_co2')::numeric, 0) as savings_co2,
          COALESCE(ma.request_data->>'ai_suggestion', ma.request_data->>'ai_recommendation', '') as ai_suggestion,
          ma.reviewed_at as reviewed_at,
          COALESCE(ma.manager_comment, ma.decision_notes) as review_notes
        FROM manager_approvals ma
        WHERE ma.approval_type = 'route_optimization'
          AND LOWER(ma.status) IN ('approved', 'declined', 'rejected')
        ORDER BY ${managerHistoryOrderBy}
        LIMIT 100
      `);
    }

    if (hasRouteApprovals && result.rows.length === 0) {
      result = await pool.query(`
        SELECT ra.id as approval_id, ${routeApprovalRefExpr} as route_id, ra.route_type as product_name, ra.from_location, ra.to_location, ra.from_location as location, ra.driver_name, 
               ra.status, ${savingsKmExpr} as savings_km, ${savingsCo2Expr} as savings_co2, COALESCE(NULLIF(ra.ai_suggestion, ''), ${roAiExpr}, '') as ai_suggestion, ra.approved_at as reviewed_at, ra.manager_comment as review_notes 
        FROM route_approvals ra
        ${joinRouteOptimizations ? "LEFT JOIN route_optimizations ro ON ro.route_id = " + routeApprovalRefExpr : ""}
        WHERE LOWER(COALESCE(ra.status, '')) IN ('approved', 'declined', 'rejected')
        ORDER BY ra.approved_at DESC NULLS LAST, ra.submitted_at DESC NULLS LAST
        LIMIT 100
      `);
    }

    // Final fallback: build history directly from deliveries so approved assignments are visible.
    if (result.rows.length === 0) {
      const deliveriesTableCheck = await pool.query(`SELECT to_regclass('public.deliveries') AS tbl`);
      const hasDeliveries = !!deliveriesTableCheck.rows[0]?.tbl;
      if (hasDeliveries) {
        const deliveriesColumns = await getTableColumns("deliveries");
        const deliveryIdExpr = deliveriesColumns.has("delivery_id")
          ? "d.delivery_id::text"
          : deliveriesColumns.has("id")
          ? "d.id::text"
          : "NULL::text";
        const routeIdExpr = deliveriesColumns.has("route_id")
          ? `COALESCE(d.route_id::text, ${deliveryIdExpr})`
          : deliveryIdExpr;
        const statusExpr = deliveriesColumns.has("status") ? "LOWER(COALESCE(d.status, ''))" : "'assigned'";
        const fromExpr = deliveriesColumns.has("from_location")
          ? "d.from_location"
          : deliveriesColumns.has("origin")
          ? "d.origin"
          : "'Unknown'::text";
        const toExpr = deliveriesColumns.has("to_location")
          ? "d.to_location"
          : deliveriesColumns.has("destination")
          ? "d.destination"
          : "NULL::text";
        const vehicleExpr = deliveriesColumns.has("vehicle_type")
          ? "d.vehicle_type"
          : "'DELIVERY'::text";
        const driverExpr = deliveriesColumns.has("driver_name")
          ? "d.driver_name"
          : deliveriesColumns.has("assigned_driver")
          ? "d.assigned_driver"
          : "NULL::text";
        const reviewedAtExpr = deliveriesColumns.has("updated_at")
          ? "d.updated_at"
          : deliveriesColumns.has("arrival_time")
          ? "d.arrival_time"
          : deliveriesColumns.has("departure_time")
          ? "d.departure_time"
          : "NULL";
        result = await pool.query(`
          SELECT
            ${deliveryIdExpr} as approval_id,
            ${routeIdExpr} as route_id,
            COALESCE(${vehicleExpr}, 'DELIVERY') as product_name,
            COALESCE(${fromExpr}, 'Unknown') as from_location,
            COALESCE(${toExpr}, null) as to_location,
            COALESCE(${fromExpr}, 'Unknown') as location,
            ${driverExpr} as driver_name,
            CASE
              WHEN ${statusExpr} IN ('declined', 'rejected', 'cancelled') THEN 'DECLINED'
              ELSE 'APPROVED'
            END as status,
            0::numeric as savings_km,
            0::numeric as savings_co2,
            ''::text as ai_suggestion,
            ${reviewedAtExpr} as reviewed_at,
            'Approved and assigned to driver'::text as review_notes
          FROM deliveries d
          WHERE ${statusExpr} IN ('assigned', 'accepted', 'in_progress', 'completed', 'declined', 'rejected', 'cancelled')
          ORDER BY ${reviewedAtExpr} DESC NULLS LAST, ${deliveryIdExpr} DESC
          LIMIT 100
        `);
      }
    }
    const historyData = (result.rows || []).map((row) => {
      const currentKm = toFiniteNumber(row.savings_km);
      const currentCo2 = toFiniteNumber(row.savings_co2);
      if (currentKm > 0 || currentCo2 > 0) return row;
      const parsed = extractSavingsFromText(row.ai_suggestion || row.review_notes || "");
      return {
        ...row,
        savings_km: currentKm > 0 ? currentKm : parsed.km,
        savings_co2: currentCo2 > 0 ? currentCo2 : parsed.co2
      };
    });
    res.json({ success: true, data: historyData, message: null });
  } catch (err) { res.json({ success: true, data: [], message: "History unavailable" }); }
});

app.post("/api/logistics/approve", async (req, res) => {
  const { routeId, decision, comment, driverName, driverUserId } = req.body;
  try {
    const statusNormalized = String(decision || "").toUpperCase();
    const status = statusNormalized === 'APPROVE' ? 'APPROVED' : statusNormalized === 'PENDING' ? 'PENDING' : 'DECLINED';
    const decisionComment = String(comment || "").trim();
    if (status === 'DECLINED' && !decisionComment) {
      return res.status(400).json({
        success: false,
        message: "Decline reason is required before returning route to admin"
      });
    }
    // Enforce driver assignment details on approve (per system design: driver must be selected)
    if (status === 'APPROVED') {
      const deliveriesColumns = await getTableColumns("deliveries");
      const requiresDriverId = deliveriesColumns.has("driver_user_id") || deliveriesColumns.has("driver_id");
      if (requiresDriverId && !driverUserId) {
        return res.status(400).json({
          success: false,
          message: "Select a driver before approval (driver_user_id missing)"
        });
      }
    }
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "id";
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const managerUpdatedAtClause = managerColumns.has("updated_at") ? ", updated_at = NOW()" : "";
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    let managerApprovalRow = null;
    let originalManagerStatus = null;
    let resolvedRouteId = routeId;
    let routeRow = null;
    const routeApprovalUpdates = new Set();

    if (hasManagerApprovals) {
      const routeIdParam = String(routeId || "");
      const managerMatchClauses = [`COALESCE(${managerPkCol}::text, '') = $1`];
      if (managerColumns.has("route_id")) managerMatchClauses.push(`COALESCE(route_id::text, '') = $1`);
      if (managerColumns.has("related_record_id")) managerMatchClauses.push(`COALESCE(related_record_id::text, '') = $1`);
      if (managerColumns.has("delivery_id")) managerMatchClauses.push(`COALESCE(delivery_id::text, '') = $1`);

      const maResult = await pool.query(
        `SELECT * FROM manager_approvals
         WHERE approval_type = 'route_optimization'
           AND (${managerMatchClauses.join(" OR ")})
         LIMIT 1`,
        [routeIdParam]
      );
      if (maResult.rows.length > 0) {
        managerApprovalRow = maResult.rows[0];
        originalManagerStatus = managerApprovalRow.status;
      }
      if (hasRouteApprovals) {
        if (managerApprovalRow) {
          const routeRef =
            managerApprovalRow.route_id ||
            managerApprovalRow.related_record_id ||
            managerApprovalRow.delivery_id;
          if (routeRef) {
            resolvedRouteId = routeRef;
            routeApprovalUpdates.add(String(routeRef));
          } else {
            routeApprovalUpdates.add(String(routeId));
          }
        } else {
          routeApprovalUpdates.add(String(routeId));
        }
      }
    } else if (hasRouteApprovals) {
      routeApprovalUpdates.add(String(routeId));
    }

    if (hasRouteApprovals) {
      const routeResult = await pool.query(`SELECT * FROM route_approvals WHERE id = $1 LIMIT 1`, [resolvedRouteId]);
      routeRow = routeResult.rows[0] || null;
    }

    if (status === 'APPROVED') {
      const requestData = parseMaybeJsonObject(managerApprovalRow?.request_data);
      const extraData = parseMaybeJsonObject(managerApprovalRow?.extra_data);
      const routeData = parseMaybeJsonObject(extraData.route);
      const optimization = parseMaybeJsonObject(extraData.optimization);
      const optimizationData = parseMaybeJsonObject(optimization.optimization_data);
      const requestedDriverName = String(driverName || "").trim();
      const requestedDriverId =
        Number.isFinite(Number(driverUserId)) && Number(driverUserId) > 0
          ? Number(driverUserId)
          : null;

      let selectedDriverName = null;
      const usersTableCheck = await pool.query(`SELECT to_regclass('public.users') AS tbl`);
      const hasUsers = !!usersTableCheck.rows[0]?.tbl;
      const usersColumns = hasUsers ? await getTableColumns("users") : new Set();

      let matchedDriver = null;
      if (hasUsers) {
        const idCol = usersColumns.has("user_id")
          ? "user_id"
          : usersColumns.has("id")
          ? "id"
          : null;
        const nameExpr = usersColumns.has("full_name")
          ? "COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), u.email)"
          : usersColumns.has("name")
          ? "COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), u.email)"
          : usersColumns.has("username")
          ? "COALESCE(NULLIF(u.username, ''), u.email)"
          : usersColumns.has("email")
          ? "u.email"
          : "NULL";
        const rolePredicate = usersColumns.has("role")
          ? "LOWER(COALESCE(u.role, '')) = 'driver'"
          : "TRUE";

        if (requestedDriverId && idCol) {
          const byId = await pool.query(
            `SELECT ${idCol}::int AS user_id, ${nameExpr} AS driver_name
             FROM users u
             WHERE ${idCol} = $1 AND ${rolePredicate}
             LIMIT 1`,
            [requestedDriverId]
          );
          matchedDriver = byId.rows[0] || null;
        }

        if (!matchedDriver && requestedDriverName) {
          const byName = await pool.query(
            `SELECT ${idCol || "NULL::int"} AS user_id, ${nameExpr} AS driver_name
             FROM users u
             WHERE ${rolePredicate}
               AND (
                 LOWER(COALESCE(${nameExpr}, '')) = LOWER($1)
                 ${usersColumns.has("email") ? "OR LOWER(COALESCE(u.email, '')) = LOWER($1)" : ""}
                 ${usersColumns.has("username") ? "OR LOWER(COALESCE(u.username, '')) = LOWER($1)" : ""}
               )
             LIMIT 1`,
            [requestedDriverName]
          );
          matchedDriver = byName.rows[0] || null;
        }

        if (matchedDriver?.driver_name) {
          selectedDriverName = String(matchedDriver.driver_name).trim();
        }
      }

      const assignedDriver =
        selectedDriverName ||
        requestedDriverName ||
        routeRow?.driver_name ||
        managerApprovalRow?.driver_name ||
        requestData.driver_name ||
        routeData.driver_name ||
        null;

      const selectedDriverId =
        matchedDriver?.user_id ||
        requestedDriverId ||
        routeRow?.driver_user_id ||
        routeRow?.driver_id ||
        managerApprovalRow?.driver_user_id ||
        managerApprovalRow?.driver_id ||
        requestData.driver_user_id ||
        requestData.driver_id ||
        routeData.driver_user_id ||
        routeData.driver_id ||
        null;

      if (!assignedDriver) {
        return res.status(400).json({
          success: false,
          message: "Please select a valid driver before approving this route"
        });
      }

      if (hasRouteApprovals && resolvedRouteId) {
        try {
          const routeApprovalColumns = await getTableColumns("route_approvals");
          if (routeApprovalColumns.has("driver_name")) {
            await pool.query(
              `UPDATE route_approvals
               SET driver_name = $1
               WHERE id::text = $2 OR COALESCE(route_id::text, '') = $2`,
              [assignedDriver, String(resolvedRouteId)]
            );
          }
        } catch (routeDriverSyncErr) {
          console.warn("Route approval driver sync fallback:", routeDriverSyncErr.message);
        }
      }

      const resolvedBusinessId =
        routeRow?.business_id ||
        managerApprovalRow?.business_id ||
        requestData.business_id ||
        routeData.business_id ||
        req.user?.businessId ||
        null;

      const deliveriesTableCheck = await pool.query(`SELECT to_regclass('public.deliveries') AS tbl`);
      const hasDeliveries = !!deliveriesTableCheck.rows[0]?.tbl;

      // Driver availability guard disabled to allow multiple concurrent assignments per driver
      // (previously returned 409). If you want to re-enable, add checks here.

      if (hasDeliveries && assignedDriver && resolvedRouteId) {
        try {
          const deliveriesColumns = await getTableColumns("deliveries");
          if (deliveriesColumns.has("route_id")) {
            const routeDistance = toFiniteNumberPreferNonZero(
              routeRow?.optimized_distance,
              routeRow?.original_distance,
              requestData.optimized_distance,
              requestData.original_distance,
              routeData.total_distance_km,
              optimization.optimized_distance,
              optimizationData.optimizedDistance
            );
            const routeFuel = toFiniteNumberPreferNonZero(
              routeRow?.optimized_fuel,
              routeRow?.original_fuel,
              requestData.optimized_fuel,
              requestData.original_fuel,
              routeData.estimated_fuel_consumption_liters,
              optimization.optimized_fuel,
              optimizationData.optimizedFuel
            );
            const routeCO2 = toFiniteNumberPreferNonZero(
              routeRow?.optimized_co2,
              routeRow?.original_co2,
              requestData.optimized_co2,
              requestData.original_co2,
              routeData.estimated_carbon_kg,
              optimization.optimized_carbon_kg,
              optimizationData.optimizedCarbon
            );

            const numericRouteId = Number(resolvedRouteId);
            if (!Number.isNaN(numericRouteId)) {
              const businessId =
                routeRow?.business_id ||
                managerApprovalRow?.business_id ||
                requestData.business_id ||
                routeData.business_id ||
                req.user?.businessId ||
                null;
              const driverUserIdPayload =
                selectedDriverId ||
                routeRow?.driver_user_id ||
                routeRow?.driver_id ||
                managerApprovalRow?.driver_user_id ||
                managerApprovalRow?.driver_id ||
                requestData.driver_user_id ||
                requestData.driver_id ||
                routeData.driver_user_id ||
                routeData.driver_id ||
                null;
              const fromLocation =
                routeRow?.from_location ||
                managerApprovalRow?.from_location ||
                requestData.from_location ||
                routeData.origin_location?.address ||
                managerApprovalRow?.location ||
                "Warehouse";
              const toLocation =
                routeRow?.to_location ||
                managerApprovalRow?.to_location ||
                requestData.to_location ||
                routeData.destination_location?.address ||
                null;
              const routeNameFallback = `${fromLocation || "Origin"} → ${toLocation || "Destination"}`;
              const deliveryPayload = {
                route_id: numericRouteId,
                business_id: businessId,
                driver_name: assignedDriver,
                driver_user_id: driverUserIdPayload,
                route_name: routeRow?.route_name || requestData.route_name || routeNameFallback,
                status: 'assigned',
                vehicle_type: routeRow?.vehicle_type || managerApprovalRow?.vehicle_type || requestData.vehicle_type || routeData.vehicle_type || "Van",
                departure_time: routeRow?.departure_time || managerApprovalRow?.departure_time || routeData.created_at || managerApprovalRow?.created_at || new Date().toISOString(),
                from_location: fromLocation,
                to_location: toLocation,
                distance_km: routeDistance || 0,
                estimated_fuel_consumption_liters: routeFuel || 0,
                estimated_carbon_kg: routeCO2 || 0
              };

              const existingDelivery = await pool.query(
                `SELECT delivery_id, status FROM deliveries WHERE route_id = $1 ORDER BY delivery_id DESC LIMIT 1`,
                [deliveryPayload.route_id]
              );

              if (existingDelivery.rows.length > 0) {
                const existing = existingDelivery.rows[0];
                const nextStatus = ['completed', 'in_progress'].includes(String(existing.status || '').toLowerCase())
                  ? existing.status
                  : 'assigned';

                const updatePairs = [];
                const updateValues = [];
                const pushUpdate = (column, value) => {
                  if (!deliveriesColumns.has(column)) return;
                  updateValues.push(value);
                  updatePairs.push(`${column} = $${updateValues.length}`);
                };

                pushUpdate("driver_name", deliveryPayload.driver_name);
                pushUpdate("driver_user_id", deliveryPayload.driver_user_id);
                pushUpdate("business_id", deliveryPayload.business_id);
                pushUpdate("route_name", deliveryPayload.route_name);
                pushUpdate("vehicle_type", deliveryPayload.vehicle_type);
                pushUpdate("departure_time", deliveryPayload.departure_time);
                pushUpdate("from_location", deliveryPayload.from_location);
                pushUpdate("to_location", deliveryPayload.to_location);
                pushUpdate("distance_km", deliveryPayload.distance_km);
                pushUpdate("estimated_fuel_consumption_liters", deliveryPayload.estimated_fuel_consumption_liters);
                pushUpdate("estimated_carbon_kg", deliveryPayload.estimated_carbon_kg);
                pushUpdate("status", nextStatus);
                if (deliveriesColumns.has("updated_at")) pushUpdate("updated_at", new Date().toISOString());

                if (updatePairs.length > 0) {
                  updateValues.push(existing.delivery_id);
                  await pool.query(
                    `UPDATE deliveries SET ${updatePairs.join(", ")} WHERE delivery_id = $${updateValues.length}`,
                    updateValues
                  );
                }
              } else {
                // Build stops_json from route_stops so deliveries always carry coordinates/status scaffolding.
                let stopsJson = null;
                try {
                  const rsCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
                  if (rsCheck.rows[0]?.tbl && deliveryPayload.route_id != null) {
                    const rs = await pool.query(
                      `SELECT stop_sequence, location_name, address, latitude, longitude
                       FROM route_stops
                       WHERE route_id = $1
                       ORDER BY stop_sequence ASC`,
                      [deliveryPayload.route_id]
                    );
                    if (rs.rows.length) {
                      stopsJson = rs.rows.map((s, idx) => ({
                        stopId: s.stop_sequence ?? idx + 1,
                        sequence: s.stop_sequence ?? idx + 1,
                        stopName: s.location_name || s.address || `Stop ${idx + 1}`,
                        address: s.address || s.location_name || "",
                        latitude: toFiniteNumber(s.latitude),
                        longitude: toFiniteNumber(s.longitude),
                        status: "pending"
                      }));
                    }
                  }
                } catch (routeStopsErr) {
                  console.warn("delivery insert route_stops fetch failed:", routeStopsErr.message);
                }

                const insertColumns = [];
                const insertValues = [];
                const pushInsert = (column, value) => {
                  if (!deliveriesColumns.has(column)) return;
                  insertColumns.push(column);
                  insertValues.push(value);
                };

                pushInsert("route_id", deliveryPayload.route_id);
                pushInsert("business_id", deliveryPayload.business_id);
                pushInsert("driver_name", deliveryPayload.driver_name);
                pushInsert("driver_user_id", deliveryPayload.driver_user_id);
                pushInsert("route_name", deliveryPayload.route_name);
                pushInsert("status", deliveryPayload.status);
                pushInsert("vehicle_type", deliveryPayload.vehicle_type);
                pushInsert("departure_time", deliveryPayload.departure_time);
                pushInsert("from_location", deliveryPayload.from_location);
                pushInsert("to_location", deliveryPayload.to_location);
                pushInsert("distance_km", deliveryPayload.distance_km);
                pushInsert("estimated_fuel_consumption_liters", deliveryPayload.estimated_fuel_consumption_liters);
                pushInsert("estimated_carbon_kg", deliveryPayload.estimated_carbon_kg);
                pushInsert("stops_json", stopsJson);

                if (insertColumns.length > 0) {
                  const placeholders = insertColumns.map((_, idx) => `$${idx + 1}`).join(", ");
                  await pool.query(
                    `INSERT INTO deliveries (${insertColumns.join(", ")}) VALUES (${placeholders})`,
                    insertValues
                  );
                }
              }
            }
          }
        } catch (assignmentErr) {
          console.error("Delivery assignment failed after route approval:", assignmentErr.message);
        }
      }
    }

    // Persist status updates only after validations succeed
    if (hasManagerApprovals && managerApprovalRow) {
      const managerMatchClauses = [`${managerPkCol}::text = $3`];
      if (managerColumns.has("route_id")) managerMatchClauses.push(`COALESCE(route_id::text, '') = $3`);
      if (managerColumns.has("related_record_id")) managerMatchClauses.push(`COALESCE(related_record_id::text, '') = $3`);
      if (managerColumns.has("delivery_id")) managerMatchClauses.push(`COALESCE(delivery_id::text, '') = $3`);

      const routeIdParam = String(routeId || "");
      await pool.query(
        `UPDATE manager_approvals
         SET status = LOWER($1), manager_comment = $2, decision_notes = $2, reviewed_at = NOW()${managerUpdatedAtClause}
         WHERE approval_type = 'route_optimization'
           AND (${managerMatchClauses.join(" OR ")})`,
        [status, decisionComment, routeIdParam]
      );
    }

    if (hasRouteApprovals && routeApprovalUpdates.size > 0) {
      const whereClause = routeApprovalColumnsApprove.has("route_id")
        ? "id::text = $3 OR COALESCE(route_id::text, '') = $3"
        : "id::text = $3";
      for (const raId of routeApprovalUpdates) {
        await pool.query(
          `UPDATE route_approvals SET status = $1, manager_comment = $2, approved_at = CASE WHEN $1 = 'APPROVED' THEN NOW() ELSE approved_at END WHERE ${whereClause}`,
          [status, decisionComment, String(raId)]
        );
      }
    } else if (!hasManagerApprovals) {
      // fallback: legacy manager_approvals table only
      await pool.query(
        `UPDATE manager_approvals
         SET status = LOWER($1), manager_comment = $2, decision_notes = $2, reviewed_at = NOW()${managerUpdatedAtClause}
         WHERE ${managerPkCol} = $3`,
        [status, decisionComment, routeId]
      );
    }

    res.json({
      success: true,
      message: status === 'DECLINED'
        ? "Declined with reason and returned to admin"
        : `Route ${status.toLowerCase()} successfully`
    });
  } catch (err) {
    console.error("Logistics approve error:", err);
    res.json({ success: false, message: `Update failed: ${err.message || 'unknown error'}` });
  }
});

// ============================================================
// INVENTORY ALERTS ROUTES (Existing)
// ============================================================

const inventoryPendingStatusPredicate = `
  (
    LOWER(COALESCE(ma.status, '')) IN ('pending', 'pending_review', 'pending_admin', 'awaiting_approval', 'submitted', 'in_review')
    OR LOWER(COALESCE(ma.status, '')) LIKE '%pending%'
    OR LOWER(COALESCE(ma.status, '')) LIKE '%review%'
    OR LOWER(COALESCE(ma.status, '')) LIKE '%await%'
  )
`;

function normalizeInventoryApprovalStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return "pending";
  if (s.includes("declin") || s.includes("reject")) return "declined";
  if (s.includes("approv") || s === "resolved" || s === "completed") return "approved";
  if (s.includes("pending") || s.includes("review") || s.includes("await") || s.includes("submit")) return "pending";
  return s;
}

function withKg(quantityValue) {
  if (quantityValue === null || quantityValue === undefined || quantityValue === "") return "0 kg";
  const raw = String(quantityValue);
  return raw.toLowerCase().includes("kg") ? raw : `${raw} kg`;
}

async function fetchInventoryApprovalsForWeb({ includeHistory = false, limit = 50 } = {}) {
  const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
  const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
  const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
  const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "approval_id";
  const canUseManagerApprovals =
    hasManagerApprovals &&
    managerColumns.has("approval_type") &&
    managerColumns.has("status");

  const alertTableCheck = await pool.query(`SELECT to_regclass('public.alerts') AS tbl`);
  const hasAlerts = !!alertTableCheck.rows[0]?.tbl;

  let managerRows = [];
  if (canUseManagerApprovals) {
    const hasAlertId = managerColumns.has("alert_id");
    const statusWhere = includeHistory
      ? `LOWER(COALESCE(ma.status, '')) IN ('approved', 'resolved', 'declined', 'rejected')`
      : inventoryPendingStatusPredicate;
    const decidedAtExpr = managerColumns.has("reviewed_at")
      ? "ma.reviewed_at"
      : managerColumns.has("decision_date")
      ? "ma.decision_date"
      : "ma.created_at";

    const query = `
      SELECT
        ma.${managerPkCol} AS approval_id,
        ma.status,
        ma.priority,
        ma.risk_level,
        ma.product_name,
        ma.location,
        ma.quantity,
        ma.ai_suggestion,
        ma.review_notes,
        ma.manager_comment,
        ma.submitted_by,
        ma.created_at,
        ma.days_left,
        ${decidedAtExpr} AS decided_at
        ${hasAlertId && hasAlerts ? ", ma.alert_id, a.alert_type, a.temperature, a.humidity, a.product_name AS alert_product_name, a.risk_level AS alert_risk_level, a.location AS alert_location, a.quantity AS alert_quantity, a.details AS alert_details, a.days_left AS alert_days_left, a.created_at AS alert_created_at, a.updated_at AS alert_updated_at" : ""}
      FROM manager_approvals ma
      ${hasAlertId && hasAlerts ? "LEFT JOIN alerts a ON a.id = ma.alert_id" : ""}
      WHERE ma.approval_type = 'spoilage_action'
        AND ${statusWhere}
      ORDER BY COALESCE(${decidedAtExpr}, ma.created_at) DESC NULLS LAST
      LIMIT $1
    `;
    const result = await pool.query(query, [limit]);
    managerRows = result.rows;
  }

  let approvals = managerRows.map((row) => ({
    approval_id: parseInt(row.approval_id, 10) || 0,
    id: parseInt(row.approval_id, 10) || 0,
    approval_type: "spoilage_action",
    status: normalizeInventoryApprovalStatus(row.status),
    raw_status: row.status,
    priority: row.priority || row.risk_level || row.alert_risk_level || "MEDIUM",
    risk_level: row.risk_level || row.alert_risk_level || "MEDIUM",
    product_name: row.product_name || row.alert_product_name || "Unknown Product",
    location: row.location || row.alert_location || "Unknown",
    quantity: withKg(row.quantity ?? row.alert_quantity),
    days_left: parseInt(row.days_left ?? row.alert_days_left, 10) || 0,
    ai_suggestion: row.ai_suggestion || row.alert_details || null,
    review_notes: row.review_notes || row.manager_comment || null,
    manager_comment: row.manager_comment || row.review_notes || null,
    submitted_by: row.submitted_by ? String(row.submitted_by) : "System",
    submitted_at: row.created_at || row.alert_created_at || null,
    decided_at: row.decided_at || row.alert_updated_at || row.created_at || null,
    alert_id: row.alert_id || null,
    alert_type: row.alert_type || null,
    temperature: row.temperature ?? null,
    humidity: row.humidity ?? null
  }));

  if (hasAlerts) {
    const linkedAlertIds = new Set(
      managerRows
        .map((r) => r.alert_id)
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v))
    );
    const alertStatusWhere = includeHistory
      ? `LOWER(COALESCE(status, '')) IN ('resolved', 'declined', 'rejected')`
      : `LOWER(COALESCE(status, '')) = 'active'`;
    const alertsResult = await pool.query(
      `
      SELECT id, product_name, risk_level, location, quantity, details, days_left, status, submitted_by, created_at, updated_at, temperature, humidity, alert_type
      FROM alerts
      WHERE ${alertStatusWhere}
      ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST
      LIMIT $1
    `,
      [limit]
    );
    const alertApprovals = alertsResult.rows
      .filter((row) => !linkedAlertIds.has(String(row.id)))
      .map((row) => ({
        approval_id: parseInt(row.id, 10) || 0,
        id: parseInt(row.id, 10) || 0,
        approval_type: "spoilage_action",
        status: includeHistory ? normalizeInventoryApprovalStatus(row.status) : "pending",
        raw_status: row.status,
        priority: row.risk_level || "MEDIUM",
        risk_level: row.risk_level || "MEDIUM",
        product_name: row.product_name || "Unknown Product",
        location: row.location || "Unknown",
        quantity: withKg(row.quantity),
        days_left: parseInt(row.days_left, 10) || 0,
        ai_suggestion: row.details || null,
        review_notes: null,
        manager_comment: null,
        submitted_by: row.submitted_by ? String(row.submitted_by) : "System",
        submitted_at: row.created_at || null,
        decided_at: row.updated_at || row.created_at || null,
        alert_id: row.id,
        alert_type: row.alert_type || null,
        temperature: row.temperature ?? null,
        humidity: row.humidity ?? null
      }));
    approvals = [...approvals, ...alertApprovals];
  }

  approvals = approvals
    .sort((a, b) => {
      const bt = new Date((includeHistory ? b.decided_at : b.submitted_at) || 0).getTime();
      const at = new Date((includeHistory ? a.decided_at : a.submitted_at) || 0).getTime();
      return bt - at;
    })
    .slice(0, limit);

  return approvals;
}

async function applyInventoryDecisionByApprovalId(approvalId, decision, reviewNotes = "") {
  const normalizedDecision = String(decision || "").trim().toLowerCase();
  const isPending = normalizedDecision === "pending";
  const isApprove = normalizedDecision === "approve" || normalizedDecision === "approved";
  const managerStatus = isPending ? "pending" : isApprove ? "approved" : "rejected";
  const alertStatus = isPending ? "active" : isApprove ? "resolved" : "declined";

  const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
  const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
  const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
  const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "approval_id";
  const canUseManagerApprovals =
    hasManagerApprovals &&
    managerColumns.has("approval_type") &&
    managerColumns.has("status");

  let matchedAlertId = null;
  let managerUpdated = false;

  if (canUseManagerApprovals) {
    const setClauses = ["status = $1"];
    const params = [managerStatus];
    let idx = 2;

    if (isPending) {
      if (managerColumns.has("reviewed_at")) setClauses.push("reviewed_at = NULL");
      if (managerColumns.has("decision_date")) setClauses.push("decision_date = NULL");
    } else {
      if (managerColumns.has("reviewed_at")) setClauses.push("reviewed_at = NOW()");
      if (managerColumns.has("decision_date")) setClauses.push("decision_date = NOW()");
    }
    if (!isPending && managerColumns.has("review_notes")) {
      setClauses.push(`review_notes = $${idx}`);
      params.push(reviewNotes || null);
      idx++;
    }
    if (!isPending && managerColumns.has("manager_comment")) {
      setClauses.push(`manager_comment = $${idx}`);
      params.push(reviewNotes || null);
      idx++;
    }
    if (!isPending && managerColumns.has("decision_notes")) {
      setClauses.push(`decision_notes = $${idx}`);
      params.push(reviewNotes || null);
      idx++;
    }
    if (!isPending && managerColumns.has("decision")) {
      setClauses.push(`decision = $${idx}`);
      params.push(managerStatus);
      idx++;
    }

    params.push(String(approvalId));
    const returningCols = [`${managerPkCol} AS approval_id`];
    if (managerColumns.has("alert_id")) returningCols.push("alert_id");
    const result = await pool.query(
      `
      UPDATE manager_approvals
      SET ${setClauses.join(", ")}
      WHERE approval_type = 'spoilage_action'
        AND ${managerPkCol}::text = $${idx}
      RETURNING ${returningCols.join(", ")}
    `,
      params
    );

    if (result.rowCount > 0) {
      managerUpdated = true;
      matchedAlertId = result.rows[0]?.alert_id || null;
    }
  }

  const alertId = matchedAlertId || approvalId;
  await pool.query(`UPDATE alerts SET status = $1, updated_at = NOW() WHERE id::text = $2`, [alertStatus, String(alertId)]);

  return { managerUpdated, managerStatus, alertStatus };
}

app.get("/api/inventory/dashboard", async (req, res) => {
  try {
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "approval_id";
    const canUseManagerApprovals =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");

    if (canUseManagerApprovals) {
      const hasAlertId = managerColumns.has("alert_id");
      const alertTableCheck = await pool.query(`SELECT to_regclass('public.alerts') AS tbl`);
      const hasAlerts = !!alertTableCheck.rows[0]?.tbl;
      const pendingResult = await pool.query(
        `
        SELECT
          ma.${managerPkCol} AS approval_id,
          ma.status,
          ma.risk_level,
          ma.product_name,
          ma.location,
          ma.quantity,
          ma.ai_suggestion,
          ma.submitted_by,
          ma.created_at,
          ma.days_left
          ${hasAlertId && hasAlerts ? ", ma.alert_id, a.product_name AS alert_product_name, a.risk_level AS alert_risk_level, a.location AS alert_location, a.quantity AS alert_quantity, a.details AS alert_details, a.days_left AS alert_days_left" : ""}
        FROM manager_approvals ma
        ${hasAlertId && hasAlerts ? "LEFT JOIN alerts a ON a.id = ma.alert_id" : ""}
        WHERE ma.approval_type = 'spoilage_action'
          AND (
            LOWER(COALESCE(ma.status, '')) IN ('pending', 'pending_review', 'awaiting_approval', 'submitted', 'in_review')
            OR LOWER(COALESCE(ma.status, '')) LIKE '%pending%'
            OR LOWER(COALESCE(ma.status, '')) LIKE '%review%'
            OR LOWER(COALESCE(ma.status, '')) LIKE '%await%'
          )
        ORDER BY ma.created_at DESC NULLS LAST
        LIMIT 20
      `
      );

      const statsResult = await pool.query(
        `
        SELECT
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(status, '')) IN ('pending', 'pending_review', 'awaiting_approval', 'submitted', 'in_review')
               OR LOWER(COALESCE(status, '')) LIKE '%pending%'
               OR LOWER(COALESCE(status, '')) LIKE '%review%'
               OR LOWER(COALESCE(status, '')) LIKE '%await%'
          ) AS pending_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('approved', 'resolved')) AS approved_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('declined', 'rejected')) AS declined_count
        FROM manager_approvals
        WHERE approval_type = 'spoilage_action'
      `
      );

      let pendingItems = pendingResult.rows.map((row) => {
        const quantityValue = row.quantity ?? row.alert_quantity;
        const quantityLabel =
          quantityValue === null || quantityValue === undefined || quantityValue === ""
            ? "0 kg"
            : `${quantityValue}${String(quantityValue).toLowerCase().includes("kg") ? "" : " kg"}`;

        return {
          id: parseInt(row.approval_id, 10) || 0,
          itemNumber: `#${row.approval_id}`,
          priority: row.risk_level || row.alert_risk_level || "MEDIUM",
          productName: row.product_name || row.alert_product_name || "Unknown Product",
          location: row.location || row.alert_location || "Unknown",
          quantity: quantityLabel,
          daysLeft: parseInt(row.days_left ?? row.alert_days_left, 10) || 0,
          aiSuggestion: row.ai_suggestion || row.alert_details || "Review this item",
          submittedBy: row.submitted_by ? String(row.submitted_by) : "System"
        };
      });

      // Include alert-backed pending items that do not yet have a pending manager_approvals row.
      if (hasAlerts) {
        const linkedAlertIds = new Set(
          pendingResult.rows
            .map((r) => r.alert_id)
            .filter((v) => v !== null && v !== undefined)
            .map((v) => String(v))
        );
        const activeAlertsResult = await pool.query(`
          SELECT id, product_name, risk_level, location, quantity, details, days_left, submitted_by
          FROM alerts
          WHERE status = 'active'
          ORDER BY created_at DESC
          LIMIT 50
        `);
        const extraAlerts = activeAlertsResult.rows
          .filter((row) => !linkedAlertIds.has(String(row.id)))
          .map((row) => {
            const quantityValue = row.quantity;
            const quantityLabel =
              quantityValue === null || quantityValue === undefined || quantityValue === ""
                ? "0 kg"
                : `${quantityValue}${String(quantityValue).toLowerCase().includes("kg") ? "" : " kg"}`;
            return {
              id: parseInt(row.id, 10) || 0,
              itemNumber: `#${row.id}`,
              priority: row.risk_level || "MEDIUM",
              productName: row.product_name || "Unknown Product",
              location: row.location || "Unknown",
              quantity: quantityLabel,
              daysLeft: parseInt(row.days_left, 10) || 0,
              aiSuggestion: row.details || "Review this item",
              submittedBy: row.submitted_by ? String(row.submitted_by) : "System"
            };
          });
        if (extraAlerts.length > 0) {
          pendingItems = [...pendingItems, ...extraAlerts];
        }
      }

      const riskStats = pendingItems.reduce(
        (acc, item) => {
          const level = String(item.priority || "").toUpperCase();
          if (level === "HIGH") acc.highRisk += 1;
          else if (level === "MEDIUM") acc.mediumRisk += 1;
          else acc.lowRisk += 1;
          return acc;
        },
        { highRisk: 0, mediumRisk: 0, lowRisk: 0 }
      );

      const stats = statsResult.rows[0] || {};
      let fallbackAlertSummary = { resolved_count: 0, declined_count: 0 };
      if (hasAlerts) {
        try {
          const alertsSummaryResult = await pool.query(`
            SELECT
              COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'resolved') AS resolved_count,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('declined', 'rejected')) AS declined_count
            FROM alerts
          `);
          fallbackAlertSummary = alertsSummaryResult.rows[0] || fallbackAlertSummary;
        } catch (_) {}
      }
      return res.json({
        success: true,
        summary: {
          pendingApprovals: pendingItems.length,
          approvedToday: Math.max(parseInt(stats.approved_count, 10) || 0, parseInt(fallbackAlertSummary.resolved_count, 10) || 0),
          declined: Math.max(parseInt(stats.declined_count, 10) || 0, parseInt(fallbackAlertSummary.declined_count, 10) || 0),
          highRisk: riskStats.highRisk,
          mediumRisk: riskStats.mediumRisk,
          lowRisk: riskStats.lowRisk
        },
        pendingItems,
        message: null
      });
    }

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
    const pendingItems = pendingResult.rows.map((row) => ({
      id: row.id,
      itemNumber: `#${row.id}`,
      priority: row.risk_level || "MEDIUM",
      productName: row.product_name || "Unknown Product",
      location: row.location || "Unknown",
      quantity: row.quantity ? `${row.quantity} kg` : "0 kg",
      daysLeft: row.days_left || 0,
      aiSuggestion: row.details || "Review this item",
      submittedBy: row.submitted_by || "System"
    }));
    const stats = statsResult.rows[0] || { total_alerts: 0, high_risk: 0, medium_risk: 0, low_risk: 0, resolved: 0, pending: 0 };
    res.json({
      success: true,
      summary: {
        pendingApprovals: parseInt(stats.pending, 10) || 0,
        approvedToday: parseInt(stats.resolved, 10) || 0,
        declined: 0,
        highRisk: parseInt(stats.high_risk, 10) || 0,
        mediumRisk: parseInt(stats.medium_risk, 10) || 0,
        lowRisk: parseInt(stats.low_risk, 10) || 0
      },
      pendingItems,
      message: null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/inventory/approve", async (req, res) => {
  const { itemId, decision, comment } = req.body;
  if (!itemId || !decision) {
    return res.status(400).json({ success: false, message: "itemId and decision are required" });
  }

  try {
    const normalizedDecision = String(decision).trim().toUpperCase();
    const isPending = normalizedDecision === "PENDING";
    const isApprove = normalizedDecision === "APPROVE" || normalizedDecision === "APPROVED";
    const managerStatus = isPending ? "pending" : isApprove ? "approved" : "rejected";
    const alertStatus = isPending ? "active" : isApprove ? "resolved" : "declined";

    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "approval_id";
    const canUseManagerApprovals =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");

    let managerUpdated = false;
    let matchedAlertId = null;

    if (canUseManagerApprovals) {
      const setClauses = ["status = $1"];
      const params = [managerStatus];
      let idx = 2;
      const cleanComment = comment ?? null;

      if (isPending) {
        if (managerColumns.has("reviewed_at")) setClauses.push("reviewed_at = NULL");
        if (managerColumns.has("decision_date")) setClauses.push("decision_date = NULL");
      } else {
        if (managerColumns.has("reviewed_at")) setClauses.push("reviewed_at = NOW()");
        if (managerColumns.has("decision_date")) setClauses.push("decision_date = NOW()");
      }
      if (!isPending && managerColumns.has("review_notes")) {
        setClauses.push(`review_notes = $${idx}`);
        params.push(cleanComment);
        idx++;
      }
      if (!isPending && managerColumns.has("manager_comment")) {
        setClauses.push(`manager_comment = $${idx}`);
        params.push(cleanComment);
        idx++;
      }
      if (!isPending && managerColumns.has("decision_notes")) {
        setClauses.push(`decision_notes = $${idx}`);
        params.push(cleanComment);
        idx++;
      }
      if (!isPending && managerColumns.has("decision")) {
        setClauses.push(`decision = $${idx}`);
        params.push(managerStatus);
        idx++;
      }

      const whereClauses = [`${managerPkCol}::text = $${idx}`];
      params.push(String(itemId));
      idx++;

      if (managerColumns.has("alert_id")) {
        whereClauses.push(`COALESCE(alert_id::text, '') = $${idx - 1}`);
      }

      const returningCols = [`${managerPkCol} AS approval_id`];
      if (managerColumns.has("alert_id")) returningCols.push("alert_id");

      const managerUpdateResult = await pool.query(
        `
        UPDATE manager_approvals
        SET ${setClauses.join(", ")}
        WHERE approval_type = 'spoilage_action'
          AND (${whereClauses.join(" OR ")})
        RETURNING ${returningCols.join(", ")}
      `,
        params
      );

      if (managerUpdateResult.rowCount > 0) {
        managerUpdated = true;
        matchedAlertId = managerUpdateResult.rows[0]?.alert_id || null;
      }
    }

    const updateAlertById = matchedAlertId || itemId;
    await pool.query(`UPDATE alerts SET status = $1, updated_at = NOW() WHERE id::text = $2`, [alertStatus, String(updateAlertById)]);

    if (!managerUpdated) {
      return res.json({ success: true, message: `Alert moved to ${alertStatus} successfully` });
    }
    return res.json({ success: true, message: `Item moved to ${managerStatus} successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get("/api/inventory/history", async (req, res) => {
  try {
    const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
    const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
    const managerColumns = hasManagerApprovals ? await getManagerApprovalsColumns() : new Set();
    const managerPkCol = hasManagerApprovals ? await getManagerApprovalsPkColumn() : "approval_id";
    const canUseManagerApprovals =
      hasManagerApprovals &&
      managerColumns.has("approval_type") &&
      managerColumns.has("status");

    if (canUseManagerApprovals) {
      const hasAlertsTable = !!(await pool.query(`SELECT to_regclass('public.alerts') AS tbl`)).rows[0]?.tbl;
      const hasAlertId = managerColumns.has("alert_id");
      const decidedAtExpr = managerColumns.has("reviewed_at")
        ? "ma.reviewed_at"
        : managerColumns.has("decision_date")
        ? "ma.decision_date"
        : "ma.created_at";

      const historyResult = await pool.query(
        `
        SELECT
          ma.${managerPkCol} AS approval_id,
          ma.status,
          ma.risk_level,
          ma.product_name,
          ma.location,
          ma.quantity,
          ma.days_left,
          ma.ai_suggestion,
          ma.submitted_by,
          ma.created_at,
          ${decidedAtExpr} AS decided_at,
          COALESCE(ma.manager_comment, ma.review_notes, ma.decision_notes) AS manager_comment
          ${hasAlertId && hasAlertsTable ? ", ma.alert_id, a.alert_type, a.temperature, a.humidity, a.product_name AS alert_product_name, a.risk_level AS alert_risk_level, a.location AS alert_location, a.quantity AS alert_quantity, a.days_left AS alert_days_left, a.details AS alert_details, inv.batch_number" : ", inv.batch_number"}
        FROM manager_approvals ma
        ${hasAlertId && hasAlertsTable ? "LEFT JOIN alerts a ON a.id = ma.alert_id LEFT JOIN inventory inv ON inv.product_id = a.product_id" : "LEFT JOIN inventory inv ON inv.product_id = ma.product_id"}
        WHERE ma.approval_type = 'spoilage_action'
          AND LOWER(COALESCE(ma.status, '')) IN ('approved', 'resolved', 'declined', 'rejected')
        ORDER BY ${decidedAtExpr} DESC NULLS LAST, ma.created_at DESC NULLS LAST
        LIMIT 50
      `
      );

      let historyItems = historyResult.rows.map((row) => {
        const quantityValue = row.quantity ?? row.alert_quantity;
        const quantityLabel =
          quantityValue === null || quantityValue === undefined || quantityValue === ""
            ? "0 kg"
            : `${quantityValue}${String(quantityValue).toLowerCase().includes("kg") ? "" : " kg"}`;
        const normalized = String(row.status || "").toLowerCase();
        const historyStatus =
          normalized === "approved" || normalized === "resolved" ? "APPROVED" : "DECLINED";
        return {
          id: parseInt(row.approval_id, 10) || 0,
          itemNumber: row.batch_number ? `Batch ${row.batch_number}` : `#${row.approval_id}`,
          priority: row.risk_level || row.alert_risk_level || "MEDIUM",
          productName: row.product_name || row.alert_product_name || "Unknown Product",
          location: row.location || row.alert_location || "Unknown",
          quantity: quantityLabel,
          daysLeft: parseInt(row.days_left ?? row.alert_days_left, 10) || 0,
          aiSuggestion: row.ai_suggestion || row.alert_details || "No details",
          status: historyStatus,
          decidedBy: "Inventory Manager",
          decidedAt: row.decided_at || row.created_at,
          submittedBy: row.submitted_by ? String(row.submitted_by) : "System",
          submittedAt: row.created_at,
          temperature: row.temperature ?? null,
          humidity: row.humidity ?? null,
          alertType: row.alert_type ?? null,
          managerComment: row.manager_comment || null
        };
      });

      // Include alert-only historical decisions that don't have matching manager_approvals records.
      if (hasAlertsTable) {
        const linkedAlertIds = new Set(
          historyResult.rows
            .map((r) => r.alert_id)
            .filter((v) => v !== null && v !== undefined)
            .map((v) => String(v))
        );
        const alertHistoryResult = await pool.query(`
          SELECT id, product_name, risk_level, location, quantity, days_left, details, status, updated_at, created_at, submitted_by, temperature, humidity, alert_type
          FROM alerts
          WHERE LOWER(COALESCE(status, '')) IN ('resolved', 'declined', 'rejected')
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT 100
        `);
        const extraHistory = alertHistoryResult.rows
          .filter((row) => !linkedAlertIds.has(String(row.id)))
          .map((row) => {
            const quantityValue = row.quantity;
            const quantityLabel =
              quantityValue === null || quantityValue === undefined || quantityValue === ""
                ? "0 kg"
                : `${quantityValue}${String(quantityValue).toLowerCase().includes("kg") ? "" : " kg"}`;
            const normalized = String(row.status || "").toLowerCase();
            return {
              id: parseInt(row.id, 10) || 0,
              itemNumber: `#${row.id}`,
              priority: row.risk_level || "MEDIUM",
              productName: row.product_name || "Unknown Product",
              location: row.location || "Unknown",
              quantity: quantityLabel,
              daysLeft: parseInt(row.days_left, 10) || 0,
              aiSuggestion: row.details || "No details",
              status: normalized === "resolved" || normalized === "approved" ? "APPROVED" : "DECLINED",
              decidedBy: "Inventory Manager",
              decidedAt: row.updated_at || row.created_at,
              submittedBy: row.submitted_by ? String(row.submitted_by) : "System",
              submittedAt: row.created_at,
              temperature: row.temperature ?? null,
              humidity: row.humidity ?? null,
              alertType: row.alert_type ?? null,
              managerComment: null
            };
          });
        if (extraHistory.length > 0) {
          historyItems = [...historyItems, ...extraHistory]
            .sort((a, b) => new Date(b.decidedAt || b.submittedAt || 0).getTime() - new Date(a.decidedAt || a.submittedAt || 0).getTime())
            .slice(0, 50);
        }
      }

      return res.json({ success: true, history: historyItems, message: null });
    }

    const result = await pool.query(`
      SELECT id, product_id, product_name, alert_type, risk_level, details, days_left, temperature, humidity,
             location, quantity, value, status, created_at, updated_at, submitted_by
      FROM alerts WHERE status IN ('resolved', 'declined') ORDER BY updated_at DESC LIMIT 50
    `);
    const historyItems = result.rows.map((row) => ({
      id: row.id,
      itemNumber: `#${row.id}`,
      priority: row.risk_level || "MEDIUM",
      productName: row.product_name || "Unknown Product",
      location: row.location || "Unknown",
      quantity: row.quantity ? `${row.quantity} kg` : "0 kg",
      daysLeft: row.days_left || 0,
      aiSuggestion: row.details || "No details",
      status: row.status === "resolved" ? "APPROVED" : "DECLINED",
      decidedBy: "Inventory Manager",
      decidedAt: row.updated_at || row.created_at,
      submittedBy: row.submitted_by || "System",
      submittedAt: row.created_at,
      temperature: row.temperature,
      humidity: row.humidity,
      alertType: row.alert_type
    }));
    res.json({ success: true, history: historyItems, message: null });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Web parity endpoints used by ecotrackai frontend approvalService/useApprovals
app.get("/api/approvals/inventory", async (req, res) => {
  try {
    const approvals = await fetchInventoryApprovalsForWeb({ includeHistory: false, limit: 100 });
    res.json({ success: true, approvals, data: { approvals }, message: null });
  } catch (err) {
    res.status(500).json({ success: false, approvals: [], message: "Database error" });
  }
});

app.get("/api/approvals/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const role = String(req.query.role || "").toLowerCase();
    let history = [];
    if (!role || role === "inventory_manager") {
      history = await fetchInventoryApprovalsForWeb({ includeHistory: true, limit });
    }
    res.json({ success: true, history, data: { history }, message: null });
  } catch (err) {
    res.status(500).json({ success: false, history: [], message: "Database error" });
  }
});

app.get("/api/approvals/pending-count", async (req, res) => {
  try {
    const role = String(req.query.role || "inventory_manager").toLowerCase();
    if (role !== "inventory_manager") {
      return res.json({ success: true, pending_count: 0, data: { pending_count: 0 }, message: null });
    }
    const approvals = await fetchInventoryApprovalsForWeb({ includeHistory: false, limit: 500 });
    const pending_count = approvals.filter((a) => a.status === "pending").length;
    res.json({ success: true, pending_count, data: { pending_count }, message: null });
  } catch (err) {
    res.status(500).json({ success: false, pending_count: 0, message: "Database error" });
  }
});

app.patch("/api/approvals/:id/decision", async (req, res) => {
  try {
    const id = req.params.id;
    const decisionRaw = String(req.body?.decision || "").trim().toLowerCase();
    const reviewNotes = req.body?.review_notes || req.body?.comment || "";
    if (!["approved", "declined", "approve", "decline", "rejected", "pending"].includes(decisionRaw)) {
      return res.status(400).json({ success: false, message: "Invalid decision" });
    }
    const decision = decisionRaw === "rejected" ? "declined" : decisionRaw;
    const result = await applyInventoryDecisionByApprovalId(id, decision, reviewNotes);
    res.json({
      success: true,
      message: `Decision ${decision} recorded`,
      data: { approval_id: id, status: result.managerUpdated ? result.managerStatus : result.alertStatus }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error" });
  }
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
             d.created_at as submitted_at, d.business_id, bp.business_name, d.carbon_verification_status 
      FROM deliveries d 
      LEFT JOIN business_profiles bp ON d.business_id = bp.business_id 
      WHERE d.carbon_verification_status = 'pending' OR d.carbon_verification_status IS NULL 
      ORDER BY d.created_at DESC LIMIT 20
    `);
    const countsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE carbon_verification_status IS NULL OR carbon_verification_status = 'pending') AS pending_count,
        COUNT(*) FILTER (WHERE carbon_verification_status = 'verified') AS verified_count,
        COUNT(*) FILTER (WHERE carbon_verification_status = 'revision_requested') AS revision_count,
        COUNT(*) FILTER (WHERE carbon_verification_status = 'verified' AND carbon_verified_at::date = CURRENT_DATE) AS verified_today,
        COALESCE(SUM(carbon_emissions) FILTER (WHERE carbon_verification_status = 'verified'), 0) AS total_co2_verified
      FROM deliveries;
    `);
    const counts = countsResult.rows[0] || {};
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
      summary: { 
        pendingVerifications: parseInt(counts.pending_count, 10) || pendingItems.length, 
        verifiedToday: parseInt(counts.verified_today, 10) || 0, 
        totalCO2Verified: parseFloat(counts.total_co2_verified) || 0 
      }, 
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
    const rows = result.rows || [];
    const totalVerified = rows.filter(r => String(r.carbon_verification_status || '').toLowerCase() === 'verified').length;
    const totalRevisions = rows.filter(r => String(r.carbon_verification_status || '').toLowerCase() === 'revision_requested').length;
    const totalCO2Verified = rows
      .filter(r => String(r.carbon_verification_status || '').toLowerCase() === 'verified')
      .reduce((sum, r) => sum + (parseFloat(r.carbon_emissions) || 0), 0);
    const summary = {
      verifiedToday: 0,
      totalVerified,
      totalRevisions,
      totalCO2Verified,
      ecoTrustPoints: totalVerified * 10
    };
    res.json({ 
      success: true, 
      history: rows.map(row => ({ 
        id: row.delivery_id, 
        route: `${row.from_location} → ${row.to_location}`, 
        driver: row.driver_name, 
        date: row.carbon_verified_at, 
        estimatedCO2: parseFloat(row.estimated_carbon_kg) || 0, 
        actualCO2: parseFloat(row.carbon_emissions) || 0, 
        status: row.carbon_verification_status 
      })), 
      summary,
      message: null 
    });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ============================================================
// DRIVER ROUTES (Existing)
// ============================================================

async function resolveDriverFilterAliases({ queryDriverName, user }) {
  const aliases = [];
  const pushAlias = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return;
    if (!aliases.includes(normalized)) aliases.push(normalized);
  };

  if (queryDriverName) pushAlias(queryDriverName);

  const userId = Number(user?.userId || user?.id);
  if (userId && Number.isFinite(userId)) {
    try {
      const userColumns = await getTableColumns("users");
      const idCol = userColumns.has("user_id")
        ? "user_id"
        : userColumns.has("id")
        ? "id"
        : null;
      if (idCol) {
        const nameExpr = userColumns.has("full_name")
          ? "NULLIF(full_name, '')"
          : "NULL";
        const usernameExpr = userColumns.has("username")
          ? "NULLIF(username, '')"
          : "NULL";
        const nameFallbackExpr = userColumns.has("name")
          ? "NULLIF(name, '')"
          : "NULL";
        const emailExpr = userColumns.has("email")
          ? "NULLIF(email, '')"
          : "NULL";

        const userResult = await pool.query(
          `SELECT ${nameExpr} AS full_name, ${nameFallbackExpr} AS name, ${usernameExpr} AS username, ${emailExpr} AS email
           FROM users
           WHERE ${idCol} = $1
           LIMIT 1`,
          [userId]
        );
        const row = userResult.rows[0];
        if (row) {
          pushAlias(row.full_name);
          pushAlias(row.name);
          pushAlias(row.username);
          pushAlias(row.email);
          if (row.email) pushAlias(String(row.email).split("@")[0]);
        }
      }
    } catch (driverLookupErr) {
      console.warn("Driver alias resolution fallback:", driverLookupErr.message);
    }
  }

  return aliases;
}

app.get("/api/driver/dashboard", authenticate, async (req, res) => {
  try {
    const { driver_name } = req.query;
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: driver_name, user: req.user });
    const driverId = Number(req.user?.userId || req.user?.id || 0) || null;
    const hasDriverFilter = driverAliases.length > 0;
    // Allow fallbacks to show something even if name/id missing, to avoid empty dashboards.
    const args = [];
    const filters = [];
    if (hasDriverFilter) {
      args.push(driverAliases);
      filters.push(`LOWER(COALESCE(d.driver_name, '')) = ANY($${args.length})`);
    }
    const deliveriesColumns = await getTableColumns("deliveries");
    const idCol =
      deliveriesColumns.has("driver_user_id") ? "driver_user_id" :
      deliveriesColumns.has("driver_id") ? "driver_id" :
      null;
    if (driverId && idCol) {
      args.push(driverId);
      filters.push(`COALESCE(d.${idCol}, 0) = $${args.length}`);
    }
    let clause = filters.length ? `AND (${filters.join(" OR ")})` : ``;
    const col = (name, fallbackSql) => deliveriesColumns.has(name) ? `d.${name}` : `${fallbackSql} as ${name}`;
    const orderByCreated = deliveriesColumns.has("created_at")
      ? "d.created_at DESC"
      : "COALESCE(d.departure_time, d.arrival_time) DESC NULLS LAST";
    const orderByCompleted = deliveriesColumns.has("completed_at")
      ? "d.completed_at DESC NULLS LAST, " + orderByCreated
      : orderByCreated;
    const stopsJsonSelect = deliveriesColumns.has("stops_json") ? "d.stops_json" : "NULL::jsonb as stops_json";
    const itemsJsonSelect = deliveriesColumns.has("delivery_items_json") ? "d.delivery_items_json" : "NULL::jsonb as delivery_items_json";

    const statsResult = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE LOWER(COALESCE(d.status, '')) = 'completed') as total_completed, 
             COALESCE(SUM(${deliveriesColumns.has("distance_km") ? "d.distance_km" : "0"}) FILTER (WHERE LOWER(COALESCE(d.status, '')) = 'completed'), 0) as total_km, 
             COALESCE(SUM(${deliveriesColumns.has("fuel_consumption") ? "d.fuel_consumption" : deliveriesColumns.has("estimated_fuel_consumption_liters") ? "d.estimated_fuel_consumption_liters" : "0"}) FILTER (WHERE LOWER(COALESCE(d.status, '')) = 'completed'), 0) as total_fuel, 
             COALESCE(SUM(${deliveriesColumns.has("carbon_emissions") ? "d.carbon_emissions" : deliveriesColumns.has("estimated_carbon_kg") ? "d.estimated_carbon_kg" : "0"}) FILTER (WHERE LOWER(COALESCE(d.status, '')) = 'completed'), 0) as total_carbon,
             COUNT(*) FILTER (WHERE d.status IN ('assigned', 'accepted', 'in_progress')) as active_deliveries
      FROM deliveries d
      WHERE d.driver_name IS NOT NULL ${clause}
    `, args);

    const pendingAcceptanceResult = await pool.query(`
      SELECT ${col("delivery_id", "NULL")}, ${col("route_id", "NULL")}, ${col("status", "NULL")}, ${col("driver_name", "NULL")}, ${col("vehicle_type", "NULL")}, ${col("departure_time", "NULL")}, ${col("arrival_time", "NULL")},
             ${col("from_location", "NULL")}, ${col("to_location", "NULL")}, ${col("distance_km", "0")}, ${col("estimated_fuel_consumption_liters", "0")}, ${col("fuel_consumption", "0")},
             ${col("estimated_carbon_kg", "0")}, ${col("carbon_emissions", "0")}, ${stopsJsonSelect}, ${itemsJsonSelect}
      FROM deliveries d
      WHERE d.status = 'assigned' ${clause}
      ORDER BY ${orderByCreated}
      LIMIT 20
    `, args);

    const activeResult = await pool.query(`
      SELECT ${col("delivery_id", "NULL")}, ${col("route_id", "NULL")}, ${col("status", "NULL")}, ${col("driver_name", "NULL")}, ${col("vehicle_type", "NULL")}, ${col("departure_time", "NULL")}, ${col("arrival_time", "NULL")},
             ${col("from_location", "NULL")}, ${col("to_location", "NULL")}, ${col("distance_km", "0")}, ${col("estimated_fuel_consumption_liters", "0")}, ${col("fuel_consumption", "0")},
             ${col("estimated_carbon_kg", "0")}, ${col("carbon_emissions", "0")}, ${stopsJsonSelect}, ${itemsJsonSelect}
      FROM deliveries d
      WHERE d.status IN ('accepted', 'in_progress') ${clause}
      ORDER BY ${orderByCreated}
      LIMIT 20
    `, args);

    const completedResult = await pool.query(`
      SELECT ${col("delivery_id", "NULL")}, ${col("route_id", "NULL")}, ${col("status", "NULL")}, ${col("driver_name", "NULL")}, ${col("vehicle_type", "NULL")}, ${col("departure_time", "NULL")}, ${col("arrival_time", "NULL")},
             ${col("from_location", "NULL")}, ${col("to_location", "NULL")}, ${col("distance_km", "0")}, ${col("estimated_fuel_consumption_liters", "0")}, ${col("fuel_consumption", "0")},
             ${col("estimated_carbon_kg", "0")}, ${col("carbon_emissions", "0")}, ${stopsJsonSelect}, ${itemsJsonSelect}, ${col("completed_at", "NULL")}
      FROM deliveries d
      WHERE d.status = 'completed' ${clause}
      ORDER BY ${orderByCompleted}
      LIMIT 20
    `, args);


    const parseStops = (raw) => {
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch (_) { return []; }
      }
      return [];
    };

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
      stops: parseStops(row.stops_json).map((stop, idx) => ({
        stopName: stop.stopName || stop.location_name || stop.location || `Stop ${idx + 1}`,
        address: stop.address || stop.location || "",
        status: stop.status || "pending",
        latitude: stop.latitude ?? null,
        longitude: stop.longitude ?? null
      })),
      items: Array.isArray(row.delivery_items_json)
        ? row.delivery_items_json.map(item => ({
            productName: item.productName || item.product_name || "Item",
            quantity: String(item.quantity ?? ""),
            status: item.status || null
          }))
        : []
    });

    let pendingAcceptance = pendingAcceptanceResult.rows.map(mapDelivery);
    let activeDeliveries = activeResult.rows.map(mapDelivery);
    const recentCompletions = completedResult.rows.map(mapDelivery);
    // If nothing matched due to name/ID mismatch, relax filters and retry once (low risk data).
    if (!pendingAcceptance.length && !activeDeliveries.length && filters.length) {
      const relaxed = await pool.query(`
        SELECT ${col("delivery_id", "NULL")}, ${col("route_id", "NULL")}, ${col("status", "NULL")}, ${col("driver_name", "NULL")}, ${col("vehicle_type", "NULL")}, ${col("departure_time", "NULL")}, ${col("arrival_time", "NULL")},
               ${col("from_location", "NULL")}, ${col("to_location", "NULL")}, ${col("distance_km", "0")}, ${col("estimated_fuel_consumption_liters", "0")}, ${col("fuel_consumption", "0")},
               ${col("estimated_carbon_kg", "0")}, ${col("carbon_emissions", "0")}, ${stopsJsonSelect}, ${itemsJsonSelect}
        FROM deliveries d
        WHERE d.status IN ('assigned','accepted','in_progress')
        ORDER BY ${orderByCreated}
        LIMIT 20
      `);
      const relaxedMapped = relaxed.rows.map(mapDelivery);
      // Split by status
      pendingAcceptance = relaxedMapped.filter(d => d.status === 'assigned');
      activeDeliveries = relaxedMapped.filter(d => d.status === 'accepted' || d.status === 'in_progress');
    }
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

app.post("/api/driver/respond-delivery", authenticate, async (req, res) => {
  const { deliveryId, decision, notes } = req.body;
  try {
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: null, user: req.user });
    if (!driverAliases.length) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }
    const ownerResult = await pool.query(
      `SELECT delivery_id
       FROM deliveries
       WHERE delivery_id = $1
         AND LOWER(COALESCE(driver_name, '')) = ANY($2)
       LIMIT 1`,
      [deliveryId, driverAliases]
    );
    if (!ownerResult.rows.length) {
      return res.status(403).json({ success: false, message: "Delivery not assigned to this driver" });
    }
    const status = decision.toUpperCase() === 'ACCEPT' ? 'accepted' : 'declined';
    const updated = await pool.query(
      `UPDATE deliveries
       SET status = $1, driver_response = $2, driver_notes = $3, driver_responded_at = NOW()
       WHERE delivery_id = $4
       RETURNING *`,
      [status, decision, notes, deliveryId]
    );
    res.json({
      success: true,
      message: "Response recorded",
      delivery: updated.rows[0] || null
    });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get("/api/driver/routes", authenticate, async (req, res) => {
  try {
    const { driver_name } = req.query;
    const deliveriesColumns = await getTableColumns("deliveries");
    const driverRoutesOrderBy = deliveriesColumns.has("created_at")
      ? "d.created_at DESC"
      : "COALESCE(d.departure_time, d.arrival_time) DESC NULLS LAST";
    let query = `
      SELECT d.*, ra.route_type
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name IS NOT NULL
    `;
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: driver_name, user: req.user });
    if (driverAliases.length === 0) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }
    const params = [];
    params.push(driverAliases);
    query += ` AND LOWER(COALESCE(d.driver_name, '')) = ANY($1)`;
    query += ` ORDER BY ${driverRoutesOrderBy} LIMIT 50`;
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
    if (routes.length === 0 && driverAliases.length > 0) {
      const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
      const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
      if (hasManagerApprovals) {
        const managerRows = await pool.query(`
          SELECT *
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(COALESCE(ma.driver_name, ma.extra_data->'route'->>'driver_name', '')) = ANY($1)
          ORDER BY ma.created_at DESC
          LIMIT 50
        `, [driverAliases]);

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
            driver: row.driver_name || route.driver_name || driverAliases[0] || null,
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

app.get("/api/driver/delivery/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { driver_name } = req.query;
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: driver_name, user: req.user });
    const deliveriesColumns = await getTableColumns("deliveries");
    const deliveryIdCol = deliveriesColumns.has("delivery_id")
      ? "delivery_id"
      : deliveriesColumns.has("id")
      ? "id"
      : null;
    const hasRouteIdCol = deliveriesColumns.has("route_id");
    if (!deliveryIdCol) {
      return res.status(500).json({ success: false, message: "Database error" });
    }
    const routeTableCheck = await pool.query(`SELECT to_regclass('public.route_approvals') AS tbl`);
    const hasRouteApprovals = !!routeTableCheck.rows[0]?.tbl;
    const joinRouteApprovals = hasRouteApprovals && hasRouteIdCol;
    const params = [String(id)];
    const driverGuard = driverAliases.length > 0
      ? ` AND LOWER(COALESCE(d.driver_name, '')) = ANY($2)`
      : ``;
    if (driverAliases.length === 0) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }
    if (driverAliases.length > 0) params.push(driverAliases);
    const result = await pool.query(
      `SELECT d.*${joinRouteApprovals ? ", ra.route_type" : ""}
       FROM deliveries d
       ${joinRouteApprovals ? "LEFT JOIN route_approvals ra ON d.route_id = ra.id" : ""}
       WHERE d.${deliveryIdCol}::text = $1${driverGuard}
       LIMIT 1`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    const row = result.rows[0];

    let stops = [];
    let stopsRows = [];
    let routeStopsHasStatusColumn = false;
    const normalizeStopAddress = (value) => {
      if (value == null) return "";
      if (typeof value === "string") return value;
      if (typeof value === "object") {
        return String(
          value.address ||
          value.full_address ||
          value.location ||
          value.name ||
          ""
        );
      }
      return String(value);
    };
    const normalizeStopLatLng = (stop) => {
      const lat = toFiniteNumber(
        stop?.latitude,
        stop?.lat,
        stop?.address?.latitude,
        stop?.address?.lat,
        stop?.location?.latitude,
        stop?.location?.lat
      );
      const lng = toFiniteNumber(
        stop?.longitude,
        stop?.lng,
        stop?.lon,
        stop?.address?.longitude,
        stop?.address?.lng,
        stop?.address?.lon,
        stop?.location?.longitude,
        stop?.location?.lng,
        stop?.location?.lon
      );
      return {
        latitude: lat !== 0 ? lat : null,
        longitude: lng !== 0 ? lng : null
      };
    };

    try {
      const routeStopsTableCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
      const hasRouteStops = !!routeStopsTableCheck.rows[0]?.tbl;
      if (hasRouteStops && row.route_id !== null && row.route_id !== undefined) {
        const stopsColumns = await getTableColumns("route_stops");
        const seqExpr = stopsColumns.has("stop_sequence") ? "stop_sequence" : "ROW_NUMBER() OVER (ORDER BY 1)";
        const nameExpr = stopsColumns.has("location_name")
          ? "location_name"
          : stopsColumns.has("stop_name")
          ? "stop_name"
          : "NULL";
        const addressExpr = stopsColumns.has("address")
          ? "address"
          : stopsColumns.has("location")
          ? "location"
          : "NULL";
        const latExpr = stopsColumns.has("latitude") ? "latitude" : "NULL";
        const lngExpr = stopsColumns.has("longitude") ? "longitude" : "NULL";
        const statusExpr = stopsColumns.has("status") ? "status" : "'pending'";
        routeStopsHasStatusColumn = stopsColumns.has("status");
        const whereRouteCol = stopsColumns.has("route_id");
        if (whereRouteCol) {
          const stopsResult = await pool.query(
            `SELECT ${seqExpr} as stop_sequence,
                    ${nameExpr} as location_name,
                    ${addressExpr} as address,
                    ${latExpr} as latitude,
                    ${lngExpr} as longitude,
                    ${statusExpr} as status
             FROM route_stops
             WHERE route_id = $1
             ORDER BY stop_sequence ASC`,
            [row.route_id]
          );
          stopsRows = stopsResult.rows || [];
        }
      }
    } catch (stopsErr) {
      console.warn("Driver delivery stops query fallback:", stopsErr.message);
    }

    const stopsJsonArray = Array.isArray(row.stops_json) ? row.stops_json : null;
    const shouldPreferStopsJson =
      stopsJsonArray && stopsJsonArray.length >= stopsRows.length && stopsJsonArray.length > 0;

    if (shouldPreferStopsJson) {
      stops = stopsJsonArray.map((stop, idx) => ({
        ...normalizeStopLatLng(stop),
        stopId: idx + 1,
        sequence: idx + 1,
        stopName: stop.stopName || stop.location_name || stop.location || `Stop ${idx + 1}`,
        address: normalizeStopAddress(stop.address || stop.location),
        status: (stop.status || "").toString().trim() || "pending"
      }));
    } else if (stopsRows.length > 0) {
      const stopsJsonStatuses = stopsJsonArray
        ? stopsJsonArray.map((s) => String(s?.status || "").trim())
        : [];
      stops = stopsRows.map(stop => {
        const idx = Math.max(0, Number(stop.stop_sequence || 1) - 1);
        const statusFromDelivery = stopsJsonStatuses[idx];
        const statusFromRouteStops = String(stop.status || "").trim();
        const resolvedStatus =
          statusFromDelivery || (routeStopsHasStatusColumn ? statusFromRouteStops : "") || "pending";
        return ({
          ...normalizeStopLatLng(stop),
          stopId: stop.stop_sequence,
          sequence: stop.stop_sequence,
          stopName: stop.location_name || `Stop ${stop.stop_sequence}`,
          address: normalizeStopAddress(stop.address || stop.location_name),
          status: resolvedStatus
        });
      });
    } else {
      stops = [
        { stopId: 1, sequence: 1, stopName: row.from_location || "Warehouse", address: row.from_location || "", status: "completed" },
        { stopId: 2, sequence: 2, stopName: row.to_location || "Destination", address: row.to_location || "", status: row.status === "completed" ? "completed" : "pending" }
      ];
    }

    // Overlay statuses from stops_json onto any source, so latest confirmations always win.
    if (Array.isArray(stopsJsonArray) && stopsJsonArray.length) {
      stops = stops.map((s, idx) => {
        const overrideStatus = stopsJsonArray[idx]?.status;
        if (overrideStatus) {
          return { ...s, status: String(overrideStatus).trim() || s.status };
        }
        return s;
      });
    }

    // Enrich missing lat/lng using origin/destination and route_path if available.
    const originLat = toFiniteNumber(row.origin_latitude, row.originLatitude, row.origin_lat, row.originLat);
    const originLng = toFiniteNumber(row.origin_longitude, row.originLongitude, row.origin_lng, row.originLon);
    const destLat = toFiniteNumber(row.destination_latitude, row.destinationLatitude, row.dest_latitude, row.destinationLat);
    const destLng = toFiniteNumber(row.destination_longitude, row.destinationLongitude, row.dest_longitude, row.destinationLon);
    const rawPath = Array.isArray(row.route_path) ? row.route_path : Array.isArray(row.routePath) ? row.routePath : [];
    const routePathPoints = Array.isArray(rawPath) ? rawPath.map(normalizeStopLatLng) : [];

    const setIfMissing = (stopObj, latVal, lngVal) => {
      if (!stopObj) return;
      const latBad = stopObj.latitude == null || Number.isNaN(stopObj.latitude) || stopObj.latitude === 0;
      const lngBad = stopObj.longitude == null || Number.isNaN(stopObj.longitude) || stopObj.longitude === 0;
      if (latBad && latVal != null && latVal !== 0) stopObj.latitude = latVal;
      if (lngBad && lngVal != null && lngVal !== 0) stopObj.longitude = lngVal;
    };
    if (stops.length > 0) setIfMissing(stops[0], originLat, originLng);
    if (stops.length > 1) setIfMissing(stops[stops.length - 1], destLat, destLng);
    // Fill intermediates from route path if missing.
    stops.forEach((s, idx) => {
      const fallback = routePathPoints[Math.min(idx, Math.max(routePathPoints.length - 1, 0))];
      if (fallback) setIfMissing(s, fallback.latitude, fallback.longitude);
    });

    // If stops still have missing coordinates, fetch from route_approvals directly
    const stillMissingCoords = stops.some(s => !s.latitude || !s.longitude || s.latitude === 0 || s.longitude === 0);
    if (stillMissingCoords && row.route_id) {
      try {
        const raResult = await pool.query(
          `SELECT origin_latitude, origin_longitude, destination_latitude, destination_longitude, stops
           FROM route_approvals WHERE id = $1 LIMIT 1`,
          [row.route_id]
        );
        if (raResult.rows.length > 0) {
          const ra = raResult.rows[0];
          const raOriginLat = toFiniteNumber(ra.origin_latitude);
          const raOriginLng = toFiniteNumber(ra.origin_longitude);
          const raDestLat = toFiniteNumber(ra.destination_latitude);
          const raDestLng = toFiniteNumber(ra.destination_longitude);

          // Try to get intermediate stop coords from route_approvals.stops JSON
          let raStops = [];
          try {
            raStops = typeof ra.stops === 'string' ? JSON.parse(ra.stops) : (Array.isArray(ra.stops) ? ra.stops : []);
          } catch (_) {}

          if (stops.length > 0) setIfMissing(stops[0], raOriginLat, raOriginLng);
          if (stops.length > 1) setIfMissing(stops[stops.length - 1], raDestLat, raDestLng);

          // Fill ALL stops from raStops — force overwrite zeros
          stops.forEach((s, idx) => {
            const raStop = raStops[idx];
            if (raStop) {
              const { latitude: rLat, longitude: rLng } = normalizeStopLatLng(raStop);
              if (rLat && rLat !== 0) s.latitude = rLat;
              if (rLng && rLng !== 0) s.longitude = rLng;
            }
          });

          // Final fallback: use origin for first stop, dest for last if still zero
          if (stops.length > 0) setIfMissing(stops[0], raOriginLat, raOriginLng);
          if (stops.length > 1) setIfMissing(stops[stops.length - 1], raDestLat, raDestLng);
        }
      } catch (raErr) {
        console.warn("route_approvals coordinate enrichment fallback:", raErr.message);
      }
    }

    res.json({
      success: true,
      delivery: {
        deliveryId: row.delivery_id ?? row.id ?? id,
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

app.post("/api/driver/start-delivery", authenticate, async (req, res) => {
  const { deliveryId } = req.body;
  try {
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: null, user: req.user });
    if (!driverAliases.length) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }
    const updated = await pool.query(
      `UPDATE deliveries
       SET status = 'in_progress', departure_time = NOW()
       WHERE delivery_id = $1
         AND LOWER(COALESCE(driver_name, '')) = ANY($2)
       RETURNING delivery_id`,
      [deliveryId, driverAliases]
    );
    if (!updated.rows.length) {
      return res.status(403).json({ success: false, message: "Delivery not assigned to this driver" });
    }
    res.json({ success: true, message: "Started" });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/driver/complete-delivery", authenticate, async (req, res) => {
  const { deliveryId, actualFuel, actualDistance, actualCO2, notes } = req.body;
  try {
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: null, user: req.user });
    if (!driverAliases.length) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }
    const updated = await pool.query(
      `UPDATE deliveries
       SET status = 'completed', arrival_time = NOW(), completed_at = NOW(),
           fuel_consumption = $1, distance_km = $2, carbon_emissions = $3, delivery_notes = $4,
           carbon_verification_status = 'pending'
       WHERE delivery_id = $5
         AND LOWER(COALESCE(driver_name, '')) = ANY($6)
       RETURNING delivery_id`,
      [actualFuel, actualDistance, actualCO2, notes, deliveryId, driverAliases]
    );
    if (!updated.rows.length) {
      return res.status(403).json({ success: false, message: "Delivery not assigned to this driver" });
    }
    res.json({ success: true, message: "Completed" });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post("/api/driver/confirm-stop", authenticate, async (req, res) => {
  const { deliveryId, stopIndex, confirmationType } = req.body;
  try {
    const normalizedDeliveryId = Number(deliveryId);
    const normalizedStopIndex = Number(stopIndex);
    if (!Number.isFinite(normalizedDeliveryId) || normalizedDeliveryId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid deliveryId" });
    }
    if (!Number.isFinite(normalizedStopIndex) || normalizedStopIndex < 0) {
      return res.status(400).json({ success: false, message: "Invalid stopIndex" });
    }

    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: null, user: req.user });
    if (!driverAliases.length) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }
    const deliveryResult = await pool.query(
      `SELECT route_id, stops_json, status
       FROM deliveries
       WHERE delivery_id = $1
         AND LOWER(COALESCE(driver_name, '')) = ANY($2)`,
      [normalizedDeliveryId, driverAliases]
    );
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    const delivery = deliveryResult.rows[0];
    const routeId = delivery.route_id;
    const stopSequence = normalizedStopIndex + 1;
    const isArrival = String(confirmationType || "").toLowerCase() === "arrival";
    const isAcceptedNotStarted = String(delivery.status || "").toLowerCase() === "accepted";
    let routeStopsUpdated = false;

    const stopsFromDbPre = Array.isArray(delivery.stops_json)
      ? delivery.stops_json
      : typeof delivery.stops_json === "string"
        ? JSON.parse(delivery.stops_json || "[]")
        : [];
    const totalStopsPre = Array.isArray(stopsFromDbPre) ? stopsFromDbPre.length : 0;
    const projectedTotalStops = Math.max(totalStopsPre, normalizedStopIndex + 1);
    const projectedIsLastStop = normalizedStopIndex >= projectedTotalStops - 1;

    // Idempotency: if this stop is already marked arrived/completed, short-circuit.
    const existingStatus = Array.isArray(stopsFromDbPre) && stopsFromDbPre[normalizedStopIndex]
      ? String(stopsFromDbPre[normalizedStopIndex].status || "").toLowerCase()
      : "";
    const isAlreadyConfirmed = existingStatus === "arrived" || existingStatus === "completed";
    if (isArrival && isAlreadyConfirmed) {
      return res.json({
        success: true,
        message: "Stop already confirmed",
        routeStopsUpdated: false,
        stopsJsonUpdated: false
      });
    }

    try {
      const routeStopsTableCheck = await pool.query(`SELECT to_regclass('public.route_stops') AS tbl`);
      const hasRouteStops = !!routeStopsTableCheck.rows[0]?.tbl;
      if (hasRouteStops && routeId !== null && routeId !== undefined) {
        const routeStopsColumns = await getTableColumns("route_stops");
        const canMatchRouteStop = routeStopsColumns.has("route_id") && routeStopsColumns.has("stop_sequence");
        if (canMatchRouteStop) {
          const setClauses = [];
          const routeStopStatus = isArrival ? (projectedIsLastStop ? "completed" : "arrived") : "completed";
          if (isArrival) {
            if (routeStopsColumns.has("actual_arrival_time")) setClauses.push("actual_arrival_time = NOW()");
            if (routeStopsColumns.has("status")) {
              setClauses.push(`status = '${routeStopStatus}'`);
            }
          } else {
            if (routeStopsColumns.has("actual_departure_time")) setClauses.push("actual_departure_time = NOW()");
            if (routeStopsColumns.has("status")) setClauses.push(`status = 'completed'`);
          }
          if (routeStopsColumns.has("updated_at")) setClauses.push("updated_at = NOW()");

          if (setClauses.length > 0) {
            const routeStopUpdate = await pool.query(
              `UPDATE route_stops
               SET ${setClauses.join(", ")}
               WHERE route_id = $1 AND stop_sequence = $2`,
              [routeId, stopSequence]
            );
            routeStopsUpdated = routeStopUpdate.rowCount > 0;
          }
        }
      }
    } catch (routeStopsErr) {
      console.warn("confirm-stop route_stops fallback:", routeStopsErr.message);
    }

    let stopsJsonUpdated = false;
    const stopsFromDb = stopsFromDbPre;

    // Ensure we can always write a status even if stops_json was null/short.
    const updatedStops = Array.isArray(stopsFromDb) ? [...stopsFromDb] : [];
    while (updatedStops.length <= normalizedStopIndex) {
      updatedStops.push({
        stopName: `Stop ${updatedStops.length + 1}`,
        address: "",
        status: "pending"
      });
    }
    const totalStopsAfter = updatedStops.length;
    const isLastStop = normalizedStopIndex >= totalStopsAfter - 1;
    const stopStatus = isArrival ? (isLastStop ? "completed" : "arrived") : "completed";
    updatedStops[normalizedStopIndex] = {
      ...updatedStops[normalizedStopIndex],
      status: stopStatus
    };
    await pool.query(`UPDATE deliveries SET stops_json = $1 WHERE delivery_id = $2`, [JSON.stringify(updatedStops), normalizedDeliveryId]);
    stopsJsonUpdated = true;

    // Ensure delivery transitions from accepted -> in_progress upon first arrival confirmation.
    if (isArrival && String(delivery.status || "").toLowerCase() === "accepted") {
      await pool.query(
        `UPDATE deliveries SET status = 'in_progress' WHERE delivery_id = $1`,
        [normalizedDeliveryId]
      );
    }

    res.json({
      success: true,
      message: isArrival ? "Stop arrival confirmed" : "Stop departure confirmed",
      routeStopsUpdated,
      stopsJsonUpdated
    });
  } catch (err) {
    console.error("confirm-stop error:", err);
    res.status(500).json({ success: false, message: err.message || "Database error" });
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
app.get("/api/driver/assigned-routes", authenticate, async (req, res) => {
  try {
    const { driver_name } = req.query;
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: driver_name, user: req.user });
    if (driverAliases.length === 0) {
      return res.status(400).json({ success: false, message: "Driver name is required" });
    }
    
    // Get deliveries assigned to this driver
    let result = await pool.query(`
      SELECT d.*, ra.route_type, ra.original_distance, ra.optimized_distance, 
             ra.original_fuel, ra.optimized_fuel, ra.original_co2, ra.optimized_co2,
             ra.savings_km, ra.savings_fuel, ra.savings_co2
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE LOWER(COALESCE(d.driver_name, '')) = ANY($1) AND d.status IN ('assigned', 'accepted', 'in_progress')
      ORDER BY d.departure_time ASC
    `, [driverAliases]);

    if (result.rows.length === 0) {
      const managerTableCheck = await pool.query(`SELECT to_regclass('public.manager_approvals') AS tbl`);
      const hasManagerApprovals = !!managerTableCheck.rows[0]?.tbl;
      if (hasManagerApprovals) {
        result = await pool.query(`
          SELECT *
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            AND LOWER(COALESCE(ma.driver_name, ma.extra_data->'route'->>'driver_name', '')) = ANY($1)
            AND LOWER(COALESCE(ma.status, '')) IN ('pending', 'approved', 'accepted', 'in_progress', 'awaiting_approval')
          ORDER BY ma.created_at ASC
        `, [driverAliases]);
      }
    }
    
    res.json({ success: true, routes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get pending deliveries for a driver (new assignments)
app.get("/api/driver/pending-deliveries", authenticate, async (req, res) => {
  try {
    const { driver_name } = req.query;
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: driver_name, user: req.user });
    const deliveriesColumns = await getTableColumns("deliveries");
    const idCol = deliveriesColumns.has("driver_user_id")
      ? "driver_user_id"
      : deliveriesColumns.has("driver_id")
      ? "driver_id"
      : null;
    const filters = [];
    const params = [];
    if (driverAliases.length > 0) {
      params.push(driverAliases);
      filters.push(`LOWER(COALESCE(d.driver_name, '')) = ANY($${params.length})`);
    }
    const userId = Number(req.user?.userId || req.user?.id || 0) || null;
    if (idCol && userId) {
      params.push(userId);
      filters.push(`COALESCE(d.${idCol}, 0) = $${params.length}`);
    }
    if (filters.length === 0) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }

    const whereClause = filters.length ? `(${filters.join(" OR ")})` : "FALSE";
    let result = await pool.query(`
      SELECT d.*, ra.route_type, ra.from_location, ra.to_location, 
             ra.original_distance, ra.optimized_distance, ra.original_fuel, ra.optimized_fuel,
             ra.original_co2, ra.optimized_co2, ra.savings_km, ra.savings_fuel, ra.savings_co2,
             ra.ai_suggestion
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE ${whereClause} AND d.status = 'assigned'
      ORDER BY COALESCE(d.departure_time, d.created_at) ASC
    `, params);

    // Relaxed fallback: if nothing found, show latest assigned deliveries regardless of driver (low risk read)
    if (result.rows.length === 0) {
      const relaxed = await pool.query(`
        SELECT d.*, ra.route_type, ra.from_location, ra.to_location, 
               ra.original_distance, ra.optimized_distance, ra.original_fuel, ra.optimized_fuel,
               ra.original_co2, ra.optimized_co2, ra.savings_km, ra.savings_fuel, ra.savings_co2,
               ra.ai_suggestion
        FROM deliveries d
        LEFT JOIN route_approvals ra ON d.route_id = ra.id
        WHERE d.status = 'assigned'
        ORDER BY COALESCE(d.departure_time, d.created_at) ASC
        LIMIT 10
      `);
      result = relaxed;
    }

    res.json({ success: true, deliveries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Driver history endpoint for Delivery > History screen.
app.get("/api/driver/history", authenticate, async (req, res) => {
  try {
    const { driver_name } = req.query;
    const driverAliases = await resolveDriverFilterAliases({ queryDriverName: driver_name, user: req.user });
    const hasDriverFilter = driverAliases.length > 0;
    if (!hasDriverFilter) {
      return res.status(400).json({ success: false, message: "Driver context missing" });
    }
    const historyParams = hasDriverFilter ? [driverAliases] : [];
    const historyDriverClause = hasDriverFilter
      ? `AND LOWER(COALESCE(d.driver_name, '')) = ANY($1)`
      : ``;

    const deliveriesHistory = await pool.query(`
      SELECT d.*, ra.route_type
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE 1=1
        ${historyDriverClause}
        AND d.status IN ('completed', 'declined', 'cancelled')
      ORDER BY d.completed_at DESC NULLS LAST, d.arrival_time DESC NULLS LAST, d.created_at DESC
      LIMIT 100
    `, historyParams);

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
        const managerParams = hasDriverFilter ? [driverAliases] : [];
        const managerDriverClause = hasDriverFilter
          ? `AND LOWER(COALESCE(ma.driver_name, ma.extra_data->'route'->>'driver_name', '')) = ANY($1)`
          : ``;
        const managerHistory = await pool.query(`
          SELECT *
          FROM manager_approvals ma
          WHERE ma.approval_type = 'route_optimization'
            ${managerDriverClause}
            AND LOWER(COALESCE(ma.status, '')) IN ('approved', 'rejected', 'declined')
          ORDER BY ma.reviewed_at DESC NULLS LAST, ma.decision_date DESC NULLS LAST, ma.created_at DESC
          LIMIT 100
        `, managerParams);

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
            driver: row.driver_name || route.driver_name || driverAliases[0] || null,
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
// SUPER ADMIN PARITY (system health, audit logs, EcoTrust config, catalog)
// ============================================================

app.get("/api/superadmin/system-health", authenticate, authorize("admin", "super_admin"), async (req, res) => {
  try {
    const [userCount, businessCount, routeCount] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM users"),
      pool.query("SELECT COUNT(*)::int AS count FROM business_profiles"),
      pool.query("SELECT COUNT(*)::int AS count FROM route_approvals")
    ]);
    res.json({
      success: true,
      data: {
        users: userCount.rows[0]?.count || 0,
        businesses: businessCount.rows[0]?.count || 0,
        routes: routeCount.rows[0]?.count || 0,
        uptimeSeconds: Math.floor(process.uptime())
      },
      message: null
    });
  } catch (err) {
    console.error("GET /api/superadmin/system-health error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch system health" });
  }
});

app.get("/api/superadmin/audit-logs", authenticate, authorize("admin", "super_admin"), async (req, res) => {
  try {
    const auditCheck = await pool.query("SELECT to_regclass('public.audit_logs') AS tbl");
    const useAudit = !!auditCheck.rows[0]?.tbl;
    const query = useAudit
      ? "SELECT * FROM audit_logs ORDER BY event_time DESC NULLS LAST LIMIT 200"
      : "SELECT * FROM approval_history ORDER BY created_at DESC NULLS LAST LIMIT 200";
    const rows = await pool.query(query);
    res.json({ success: true, data: rows.rows, message: null });
  } catch (err) {
    console.error("GET /api/superadmin/audit-logs error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch audit logs" });
  }
});

app.get("/api/superadmin/ecotrust/actions", authenticate, authorize("admin", "super_admin"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sustainable_actions ORDER BY action_category, id");
    res.json({ success: true, data: result.rows, message: null });
  } catch (err) {
    console.error("GET /api/superadmin/ecotrust/actions error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch EcoTrust actions" });
  }
});

app.patch("/api/superadmin/ecotrust/actions/:id", authenticate, authorize("admin", "super_admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { points_value, action_name, action_category, description } = req.body || {};
    if (points_value === undefined) {
      return res.status(400).json({ success: false, message: "points_value is required" });
    }
    const result = await pool.query(
      `
      UPDATE sustainable_actions
      SET points_value    = $1,
          action_name     = COALESCE($2, action_name),
          action_category = COALESCE($3, action_category),
          description     = COALESCE($4, description),
          updated_at      = NOW()
      WHERE id = $5
      RETURNING *
    `,
      [points_value, action_name || null, action_category || null, description || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Action not found" });
    }
    res.json({ success: true, data: result.rows[0], message: "Action updated" });
  } catch (err) {
    console.error("PATCH /api/superadmin/ecotrust/actions/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to update action" });
  }
});

app.get("/api/superadmin/catalog", authenticate, authorize("admin", "super_admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM products ORDER BY business_id NULLS FIRST, product_name ASC`
    );
    res.json({ success: true, data: result.rows, message: null });
  } catch (err) {
    console.error("GET /api/superadmin/catalog error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch catalog" });
  }
});

// Lightweight version endpoint to verify deployed build
const deployedCommit =
  process.env.RENDER_GIT_COMMIT ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT ||
  null;
app.get("/api/version", (_req, res) => {
  res.json({
    success: true,
    commit: deployedCommit,
    deployedAt: process.env.RENDER_GIT_COMMIT_CREATED_AT || null
  });
});


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
