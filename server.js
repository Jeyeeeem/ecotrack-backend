const express = require("express");
const app = express();
const pool = require("./database"); // persistent DB pool

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
    return res.status(400).json({ error: "All fields required" });

  try {
    const result = await pool.query(
      "INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, email, password, role]
    );
    res.status(201).json({ message: "User registered", user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Login user
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1 AND password=$2",
      [email, password]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    res.json({
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// ====================== ADMIN ROUTES ======================

app.get("/admin/users", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, email, role FROM users");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// ====================== START SERVER ======================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

// ====================== OPTIONAL KEEP-ALIVE ======================
// Helps Render detect that server is alive
setInterval(() => console.log("🟢 Server is alive ping"), 60000);
