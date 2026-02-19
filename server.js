const express = require("express");
const app = express();
const pool = require("./database");

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
    const result = await pool.query(
      `INSERT INTO users 
      (name, username, email, password_hash, role) 
      VALUES ($1, $2, $3, $4, $5) 
      RETURNING user_id, name, email, role`,
      [name, name, email, password, role]
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


// Login user (case-insensitive email, safer version)
app.post("/login", async (req, res) => {

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password required"
    });
  }

  try {

    const result = await pool.query(
      `SELECT user_id, name, email, role, password_hash
       FROM users
       WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const user = result.rows[0];

    if (user.password_hash !== password) {
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
        u.user_id,
        u.name as business_name,
        COALESCE(bp.address, 'Location not provided') as location,
        COALESCE(bp.ecotrust_level, 1) as ecotrust_level,
        COALESCE(bp.badge, 'New Partner') as badge,
        COALESCE(bp.points, 0) as points,
        COALESCE(bp.carbon_this_month, 0) as carbon_impact
      FROM users u
      LEFT JOIN business_profiles bp ON u.user_id = bp.user_id
      WHERE u.role = 'business'
      ORDER BY bp.ecotrust_level DESC, bp.points DESC
    `);

    const businesses = result.rows.map(row => ({
      userId: row.user_id,
      businessName: row.business_name,
      location: row.location,
      ecoTrustLevel: row.ecotrust_level,
      badge: row.badge,
      points: row.points,
      carbonImpact: parseFloat(row.carbon_impact)
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


// Get business profile
app.get("/business/profile/:userId", async (req, res) => {

  const { userId } = req.params;

  try {

    const userResult = await pool.query(
      "SELECT user_id, name, email FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
        profile: null
      });
    }

    const user = userResult.rows[0];

    const profileResult = await pool.query(
      `SELECT 
        ecotrust_level,
        points,
        badge,
        address,
        contact,
        carbon_this_month,
        carbon_reduced,
        carbon_total_reduced,
        ai_deliveries,
        distance_saved,
        ai_suggestions
      FROM business_profiles
      WHERE user_id = $1`,
      [userId]
    );

    let profile;

    if (profileResult.rows.length > 0) {

      const data = profileResult.rows[0];

      profile = {
        userId: user.user_id,
        businessName: user.name,
        ecoTrustLevel: data.ecotrust_level || 1,
        points: data.points || 0,
        badge: data.badge || "New Partner",
        address: data.address || "Address not provided",
        contact: data.contact || "Contact not provided",
        email: user.email,
        carbonThisMonth: parseFloat(data.carbon_this_month) || 0,
        carbonReduced: parseFloat(data.carbon_reduced) || 0,
        carbonTotalReduced: parseFloat(data.carbon_total_reduced) || 0,
        aiDeliveries: data.ai_deliveries || 0,
        distanceSaved: data.distance_saved || 0,
        aiSuggestions: data.ai_suggestions || 0
      };

    } else {

      profile = {
        userId: user.user_id,
        businessName: user.name,
        ecoTrustLevel: 1,
        points: 0,
        badge: "New Partner",
        address: "Address not provided",
        contact: "Contact not provided",
        email: user.email,
        carbonThisMonth: 0,
        carbonReduced: 0,
        carbonTotalReduced: 0,
        aiDeliveries: 0,
        distanceSaved: 0,
        aiSuggestions: 0
      };
    }

    res.json({
      success: true,
      profile,
      message: null
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: "Database error",
      profile: null
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
