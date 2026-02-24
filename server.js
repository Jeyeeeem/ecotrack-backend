const express = require("express");
const app = express();
const pool = require("./database");
const bcrypt = require("bcryptjs");

app.use(express.json());


// ====================== BASIC ROUTES ======================

// Test route
app.get("/", (req, res) => res.send("Server is running!"));

// Health route
app.get("/health", (req, res) => res.json({ status: "ok" }));


// ====================== AUTH ROUTES ======================

// Register user
app.post("/register", async (req, res) => {
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
app.post("/login", async (req, res) => {

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
app.get("/admin/users", async (req, res) => {

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


// ====================== BUSINESS DIRECTORY ROUTES ======================

// Get business directory
app.get("/business/directory", async (req, res) => {

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


// ====================== START SERVER ======================

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});


// ====================== KEEP ALIVE ======================

setInterval(() => {
  console.log("🟢 Server is alive ping");
}, 60000);
