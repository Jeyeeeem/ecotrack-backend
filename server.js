const express = require("express");
const app = express();
const pool = require("./database");

app.use(express.json());

// Test route
app.get("/", (req, res) => res.send("Server is running!"));

// Health route
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ====================== AUTH ROUTES ======================

// Register user
app.post("/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role)
    return res.status(400).json({ success: false, message: "All fields required" });

  try {
    const result = await pool.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING user_id, name, email, role",
      [name, email, password, role]
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
      return res.status(400).json({ success: false, message: "Email already exists" });
    }
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Login user
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: "Email and password required" });

  try {
    const result = await pool.query(
      "SELECT user_id, name, email, role FROM users WHERE email=$1 AND password_hash=$2",
      [email, password]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ success: false, message: "Invalid email or password" });

    const user = result.rows[0];
    res.json({
      success: true,
      message: "Login successful",
      user: {
        id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ====================== ADMIN ROUTES ======================

app.get("/admin/users", async (req, res) => {
  try {
    const result = await pool.query("SELECT user_id, name, email, role FROM users");
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ====================== START SERVER ======================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

// ====================== OPTIONAL KEEP-ALIVE ======================
setInterval(() => console.log("🟢 Server is alive ping"), 60000);