// ============================================================
// FILE: routes/tracking.routes.js
// Real-Time Driver Tracking Routes
// ============================================================

const express = require('express');
const router = express.Router();
const pool = require('../database');

// Middleware for authentication (simple JWT verification)
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized - No token provided' });
  }
  
  try {
    // For now, we'll decode a simple token or skip verification for demo
    // In production, use proper JWT verification
    req.user = { userId: 1, businessId: 1 }; // Default for demo
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ============================================================
// Driver posts GPS ping (called from Android app every 5 seconds)
// ============================================================
router.post('/:routeId', authenticate, async (req, res) => {
  const { routeId } = req.params;
  const { latitude, longitude, accuracy, speed } = req.body;
  const { userId, businessId } = req.user;

  // Validate required fields
  if (!latitude || !longitude) {
    return res.status(400).json({ success: false, message: 'Latitude and longitude are required' });
  }

  try {
    // First, get the driver_user_id from the route
    const routeResult = await pool.query(
      `SELECT driver_name FROM deliveries WHERE delivery_id = $1`,
      [routeId]
    );
    
    // Get user_id from users table based on driver name or use default
    let driverUserId = userId;
    if (routeResult.rows.length > 0 && routeResult.rows[0].driver_name) {
      const userResult = await pool.query(
        `SELECT user_id FROM users WHERE full_name ILIKE $1 LIMIT 1`,
        [routeResult.rows[0].driver_name]
      );
      if (userResult.rows.length > 0) {
        driverUserId = userResult.rows[0].user_id;
      }
    }

    await pool.query(`
      INSERT INTO driver_locations
        (route_id, driver_user_id, business_id, latitude, longitude, accuracy_m, speed_kmh, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [routeId, driverUserId, businessId, latitude, longitude, accuracy ?? null, speed ?? null]);

    res.json({ success: true, message: 'Location recorded' });
  } catch (e) {
    console.error('Tracking error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// Logistics Manager polls latest location of a route's driver
// ============================================================
router.get('/:routeId/live', authenticate, async (req, res) => {
  const { routeId } = req.params;
  const { businessId } = req.user;

  try {
    const { rows } = await pool.query(`
      SELECT dl.latitude, dl.longitude, dl.speed_kmh, dl.accuracy_m, dl.recorded_at,
             u.full_name AS driver_name,
             d.from_location, d.to_location, d.status as delivery_status
      FROM driver_locations dl
      LEFT JOIN users u ON u.user_id = dl.driver_user_id
      LEFT JOIN deliveries d ON d.delivery_id = dl.route_id
      WHERE dl.route_id = $1
        AND dl.business_id = $2
      ORDER BY dl.recorded_at DESC
      LIMIT 1
    `, [routeId, businessId]);

    if (rows.length === 0) {
      return res.json({ success: true, data: null, message: 'No location data available yet' });
    }

    const location = rows[0];
    res.json({ 
      success: true, 
      data: {
        latitude: parseFloat(location.latitude),
        longitude: parseFloat(location.longitude),
        speed_kmh: location.speed_kmh ? parseFloat(location.speed_kmh) : null,
        accuracy_m: location.accuracy_m ? parseFloat(location.accuracy_m) : null,
        recorded_at: location.recorded_at,
        driver_name: location.driver_name,
        from: location.from_location,
        to: location.to_location,
        status: location.delivery_status
      }
    });
  } catch (e) {
    console.error('Live tracking error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// Get location history for a route (last N points)
// ============================================================
router.get('/:routeId/history', authenticate, async (req, res) => {
  const { routeId } = req.params;
  const { businessId } = req.user;
  const { limit = 50 } = req.query;

  try {
    const { rows } = await pool.query(`
      SELECT dl.latitude, dl.longitude, dl.speed_kmh, dl.accuracy_m, dl.recorded_at,
             u.full_name AS driver_name
      FROM driver_locations dl
      LEFT JOIN users u ON u.user_id = dl.driver_user_id
      WHERE dl.route_id = $1
        AND dl.business_id = $2
      ORDER BY dl.recorded_at DESC
      LIMIT $3
    `, [routeId, businessId, limit]);

    const history = rows.map(row => ({
      latitude: parseFloat(row.latitude),
      longitude: parseFloat(row.longitude),
      speed_kmh: row.speed_kmh ? parseFloat(row.speed_kmh) : null,
      accuracy_m: row.accuracy_m ? parseFloat(row.accuracy_m) : null,
      recorded_at: row.recorded_at,
      driver_name: row.driver_name
    })).reverse(); // Return in chronological order

    res.json({ success: true, history });
  } catch (e) {
    console.error('History tracking error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// Get all active drivers locations for a business
// ============================================================
router.get('/active', authenticate, async (req, res) => {
  const { businessId } = req.user;

  try {
    // Get drivers with in_progress deliveries and their latest locations
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (dl.driver_user_id)
        dl.route_id,
        dl.driver_user_id,
        dl.latitude,
        dl.longitude,
        dl.speed_kmh,
        dl.recorded_at,
        u.full_name AS driver_name,
        d.from_location,
        d.to_location,
        d.status AS delivery_status
      FROM driver_locations dl
      INNER JOIN users u ON u.user_id = dl.driver_user_id
      INNER JOIN deliveries d ON d.delivery_id = dl.route_id
      WHERE dl.business_id = $1
        AND d.status = 'in_progress'
      ORDER BY dl.driver_user_id, dl.recorded_at DESC
    `, [businessId]);

    const activeDrivers = rows.map(row => ({
      route_id: row.route_id,
      driver_user_id: row.driver_user_id,
      driver_name: row.driver_name,
      latitude: parseFloat(row.latitude),
      longitude: parseFloat(row.longitude),
      speed_kmh: row.speed_kmh ? parseFloat(row.speed_kmh) : null,
      from: row.from_location,
      to: row.to_location,
      status: row.delivery_status,
      last_update: row.recorded_at
    }));

    res.json({ success: true, activeDrivers });
  } catch (e) {
    console.error('Active drivers error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;

