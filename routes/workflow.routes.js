// ============================================================
// FILE: workflow.routes.js
// Integrated Workflow API Routes
// Connects: Admin -> Inventory Manager -> Logistics Manager -> Sustainability Manager -> Driver
// ============================================================

const express = require("express");
const router = express.Router();
const pool = require("../database");
const { authenticate, authorize } = require("../middleware/auth");

// ============================================================
// INVENTORY MANAGER WORKFLOW - Spoilage Action Approvals
// ============================================================

// Get pending spoilage actions for Inventory Manager
router.get("/inventory-manager/pending", authenticate, authorize('inventory_manager', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        ma.*,
        a.product_name, a.risk_level, a.days_left, a.location as facility_location,
        a.quantity, a.temperature, a.humidity, a.details as ai_recommendation
      FROM manager_approvals ma
      LEFT JOIN alerts a ON ma.alert_id = a.id
      WHERE ma.approval_type = 'spoilage_action' 
        AND ma.status = 'pending' 
        AND ma.required_role = 'inventory_manager'
      ORDER BY ma.created_at DESC
    `);
    res.json({ success: true, approvals: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Submit spoilage action for approval (Admin creates this)
router.post("/inventory-manager/submit", authenticate, authorize('admin'), async (req, res) => {
  const { alert_id, notes } = req.body;
  
  try {
    // Get alert details
    const alertResult = await pool.query(`SELECT * FROM alerts WHERE id = $1`, [alert_id]);
    if (alertResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }
    
    const alert = alertResult.rows[0];
    
    // Create manager_approvals record
    const result = await pool.query(`
      INSERT INTO manager_approvals 
        (approval_type, related_table, related_record_id, alert_id, required_role, requested_by, request_notes, status, business_id, request_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      'spoilage_action', 'alerts', alert_id, alert_id, 'inventory_manager', 
      req.user.userId, notes || alert.details, 'pending', req.user.businessId,
      JSON.stringify({ product_name: alert.product_name, risk_level: alert.risk_level, days_left: alert.days_left })
    ]);
    
    // Update alert status
    await pool.query(`UPDATE alerts SET status = 'pending_review' WHERE id = $1`, [alert_id]);
    
    // Log to approval_history
    await pool.query(`
      INSERT INTO approval_history 
        (approval_id, approval_type, related_record_id, related_table, actor_user_id, actor_role, actor_name, action, new_status, business_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [result.rows[0].id, 'spoilage_action', alert_id, 'alerts', req.user.userId, req.user.role, req.user.name, 'submitted', 'pending', req.user.businessId]);
    
    res.json({ success: true, message: "Submitted for inventory manager approval", approval: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Approve/Deline spoilage action (Inventory Manager decision)
router.post("/inventory-manager/decide", authenticate, authorize('inventory_manager', 'admin'), async (req, res) => {
  const { approval_id, decision, comment } = req.body;
  const newStatus = decision.toUpperCase() === 'APPROVE' ? 'approved' : 'declined';
  
  try {
    // Get current approval
    const approvalResult = await pool.query(`SELECT * FROM manager_approvals WHERE id = $1`, [approval_id]);
    if (approvalResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Approval not found" });
    }
    
    const approval = approvalResult.rows[0];
    
    // Update approval
    await pool.query(`
      UPDATE manager_approvals 
      SET status = $1, decision_by = $2, decision_notes = $3, manager_comment = $4, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $5
    `, [newStatus, req.user.userId, comment, comment, approval_id]);
    
    // Update alert status
    const alertStatus = newStatus === 'approved' ? 'approved' : 'declined';
    await pool.query(`UPDATE alerts SET status = $1, updated_at = NOW() WHERE id = $2`, [alertStatus, approval.alert_id]);
    
    // Log to approval_history
    await pool.query(`
      INSERT INTO approval_history 
        (approval_id, approval_type, related_record_id, related_table, actor_user_id, actor_role, actor_name, action, previous_status, new_status, comment, business_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [approval_id, 'spoilage_action', approval.alert_id, 'alerts', req.user.userId, req.user.role || 'inventory_manager', req.user.name, newStatus, 'pending', newStatus, comment, req.user.businessId]);
    
    // If approved, create EcoTrust transaction for spoilage prevention
    if (newStatus === 'approved') {
      await pool.query(`
        INSERT INTO ecotrust_transactions 
          (business_id, action_id, action_type, points_earned, related_record_type, related_record_id, verification_status, description)
        SELECT $1, id, 'spoilage_prevention', points_value, 'alert', $2, 'pending', action_name
        FROM sustainable_actions WHERE action_type = 'spoilage_prevention'
      `, [req.user.businessId, approval.alert_id]);
    }
    
    res.json({ success: true, message: `Spoilage action ${newStatus}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// LOGISTICS MANAGER WORKFLOW - Route Optimization Approvals
// ============================================================

// Get pending route optimizations for Logistics Manager
router.get("/logistics-manager/pending", authenticate, authorize('logistics_manager', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        ma.*,
        ra.route_type, ra.from_location, ra.to_location, ra.driver_name, ra.vehicle_type,
        ra.original_distance, ra.optimized_distance, ra.original_fuel, ra.optimized_fuel,
        ra.original_co2, ra.optimized_co2, ra.savings_km, ra.savings_fuel, ra.savings_co2,
        ra.ai_suggestion
      FROM manager_approvals ma
      LEFT JOIN route_approvals ra ON ma.related_record_id = ra.id
      WHERE ma.approval_type = 'route_optimization' 
        AND ma.status = 'pending' 
        AND ma.required_role = 'logistics_manager'
      ORDER BY ma.created_at DESC
    `);
    res.json({ success: true, approvals: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Submit route optimization for approval (Admin creates this)
router.post("/logistics-manager/submit", authenticate, authorize('admin'), async (req, res) => {
  const { route_approval_id, notes } = req.body;
  
  try {
    const routeResult = await pool.query(`SELECT * FROM route_approvals WHERE id = $1`, [route_approval_id]);
    if (routeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Route approval not found" });
    }
    
    const route = routeResult.rows[0];
    
    const result = await pool.query(`
      INSERT INTO manager_approvals 
        (approval_type, related_table, related_record_id, route_id, required_role, requested_by, request_notes, status, business_id, request_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      'route_optimization', 'route_approvals', route_approval_id, route_approval_id, 'logistics_manager',
      req.user.userId, notes, 'pending', req.user.businessId,
      JSON.stringify({ from_location: route.from_location, to_location: route.to_location, savings_co2: route.savings_co2 })
    ]);
    
    await pool.query(`UPDATE route_approvals SET status = 'awaiting_approval' WHERE id = $1`, [route_approval_id]);
    
    res.json({ success: true, message: "Submitted for logistics manager approval", approval: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Approve/Decline route optimization (Logistics Manager decision)
router.post("/logistics-manager/decide", authenticate, authorize('logistics_manager', 'admin'), async (req, res) => {
  const { approval_id, decision, comment } = req.body;
  const newStatus = decision.toUpperCase() === 'APPROVE' ? 'approved' : 'declined';
  
  try {
    const approvalResult = await pool.query(`SELECT * FROM manager_approvals WHERE id = $1`, [approval_id]);
    if (approvalResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Approval not found" });
    }
    
    const approval = approvalResult.rows[0];
    
    await pool.query(`
      UPDATE manager_approvals 
      SET status = $1, decision_by = $2, decision_notes = $3, manager_comment = $4, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $5
    `, [newStatus, req.user.userId, comment, comment, approval_id]);
    
    // Update route_approvals status
    await pool.query(`UPDATE route_approvals SET status = $1, manager_comment = $2, approved_at = NOW() WHERE id = $3`, 
      [newStatus === 'approved' ? 'APPROVED' : 'DECLINED', comment, approval.related_record_id]);
    
    // Log to approval_history
    await pool.query(`
      INSERT INTO approval_history 
        (approval_id, approval_type, related_record_id, related_table, actor_user_id, actor_role, actor_name, action, previous_status, new_status, comment, business_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [approval_id, 'route_optimization', approval.related_record_id, 'route_approvals', req.user.userId, req.user.role || 'logistics_manager', req.user.name, newStatus, 'pending', newStatus, comment, req.user.businessId]);
    
    // If approved, create EcoTrust transaction
    if (newStatus === 'approved') {
      await pool.query(`
        INSERT INTO ecotrust_transactions 
          (business_id, action_id, action_type, points_earned, related_record_type, related_record_id, verification_status, description)
        SELECT $1, id, 'route_optimization_approved', points_value, 'route_approval', $2, 'pending', action_name
        FROM sustainable_actions WHERE action_type = 'route_optimization_approved'
      `, [req.user.businessId, approval.related_record_id]);
    }
    
    res.json({ success: true, message: `Route optimization ${newStatus}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// SUSTAINABILITY MANAGER WORKFLOW - Carbon Verification
// ============================================================

// Get pending carbon verifications
router.get("/sustainability/pending", authenticate, authorize('sustainability_manager', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM carbon_footprint_records 
      WHERE verification_status = 'pending'
      ORDER BY created_at DESC
    `);
    res.json({ success: true, records: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Verify carbon record (Sustainability Manager)
router.post("/sustainability/verify", authenticate, authorize('sustainability_manager', 'admin'), async (req, res) => {
  const { record_id, decision, comment } = req.body;
  const newStatus = decision.toUpperCase() === 'VERIFY' ? 'verified' : 'revision_requested';
  
  try {
    await pool.query(`
      UPDATE carbon_footprint_records 
      SET verification_status = $1, verified_by = $2, verified_at = NOW(), verification_comment = $3, is_verified = $4, updated_at = NOW()
      WHERE id = $5
    `, [newStatus, req.user.userId, comment, decision.toUpperCase() === 'VERIFY', record_id]);
    
    // Log to approval_history
    await pool.query(`
      INSERT INTO approval_history 
        (approval_type, related_record_id, related_table, actor_user_id, actor_role, actor_name, action, new_status, comment, business_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, ['carbon_verification', record_id, 'carbon_footprint_records', req.user.userId, req.user.role || 'sustainability_manager', req.user.name, newStatus, newStatus, comment, req.user.businessId]);
    
    // If verified, create EcoTrust transaction
    if (newStatus === 'verified') {
      await pool.query(`
        INSERT INTO ecotrust_transactions 
          (business_id, action_id, action_type, points_earned, related_record_type, related_record_id, verification_status, description)
        SELECT $1, id, 'carbon_verified', points_value, 'carbon_record', $2, 'pending', action_name
        FROM sustainable_actions WHERE action_type = 'carbon_verified'
      `, [req.user.businessId, record_id]);
    }
    
    res.json({ success: true, message: `Carbon record ${newStatus}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Create estimated carbon record (when delivery is created)
router.post("/carbon/create-estimated", authenticate, async (req, res) => {
  const { delivery_id, route_id, distance_km, fuel_liters, vehicle_type, carbon_kg } = req.body;
  
  try {
    const result = await pool.query(`
      INSERT INTO carbon_footprint_records 
        (record_type, delivery_id, route_id, business_id, calculation_method, distance_km, fuel_liters, vehicle_type, transportation_carbon_kg, total_carbon_kg, verification_status, is_actual)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, ['delivery', delivery_id, route_id, req.user.businessId, 'estimated', distance_km, fuel_liters, vehicle_type, carbon_kg, carbon_kg, 'pending', false]);
    
    res.json({ success: true, record: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Create actual carbon record (when driver completes delivery)
router.post("/carbon/create-actual", authenticate, async (req, res) => {
  const { delivery_id, route_id, actual_distance_km, actual_fuel_liters, actual_carbon_kg } = req.body;
  
  try {
    const result = await pool.query(`
      INSERT INTO carbon_footprint_records 
        (record_type, delivery_id, route_id, business_id, calculation_method, distance_km, fuel_liters, vehicle_type, transportation_carbon_kg, total_carbon_kg, verification_status, is_actual)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, ['delivery', delivery_id, route_id, req.user.businessId, 'actual', actual_distance_km, actual_fuel_liters, null, actual_carbon_kg, actual_carbon_kg, 'pending', true]);
    
    res.json({ success: true, record: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// DRIVER WORKFLOW - Delivery Management
// ============================================================

// Get assigned routes for driver
router.get("/driver/assigned-routes", authenticate, authorize('driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, ra.from_location, ra.to_location, ra.optimized_distance, ra.optimized_fuel, ra.savings_co2
      FROM deliveries d
      LEFT JOIN route_approvals ra ON d.route_id = ra.id
      WHERE d.driver_name = $1 AND d.status IN ('assigned', 'accepted', 'in_progress')
      ORDER BY d.departure_time ASC
    `, [req.user.name]);
    res.json({ success: true, routes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Driver starts delivery
router.post("/driver/start-delivery", authenticate, authorize('driver'), async (req, res) => {
  const { delivery_id } = req.body;
  
  try {
    await pool.query(`
      UPDATE deliveries SET status = 'in_progress', departure_time = NOW() WHERE delivery_id = $1
    `, [delivery_id]);
    
    res.json({ success: true, message: "Delivery started" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Driver completes delivery with actual metrics
router.post("/driver/complete-delivery", authenticate, authorize('driver'), async (req, res) => {
  const { delivery_id, actual_distance_km, actual_fuel_used_liters, actual_carbon_kg, notes } = req.body;
  
  try {
    // Update delivery
    await pool.query(`
      UPDATE deliveries 
      SET status = 'completed', arrival_time = NOW(), completed_at = NOW(), 
          distance_km = $1, fuel_consumption = $2, carbon_emissions = $3, delivery_notes = $4
      WHERE delivery_id = $5
    `, [actual_distance_km, actual_fuel_used_liters, actual_carbon_kg, notes, delivery_id]);
    
    // Create actual carbon record
    await pool.query(`
      INSERT INTO carbon_footprint_records 
        (record_type, delivery_id, business_id, calculation_method, distance_km, fuel_liters, transportation_carbon_kg, total_carbon_kg, verification_status, is_actual, record_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    `, ['delivery', delivery_id, req.user.businessId, 'actual', actual_distance_km, actual_fuel_used_liters, actual_carbon_kg, actual_carbon_kg, 'pending', true]);
    
    // Create EcoTrust transaction for delivery completion
    await pool.query(`
      INSERT INTO ecotrust_transactions 
        (business_id, action_id, action_type, points_earned, related_record_type, related_record_id, verification_status, description)
      SELECT $1, id, 'delivery_completed', points_value, 'delivery', $2, 'pending', action_name
      FROM sustainable_actions WHERE action_type = 'delivery_completed'
    `, [req.user.businessId, delivery_id]);
    
    res.json({ success: true, message: "Delivery completed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// ECOTRUST SCORE MANAGEMENT
// ============================================================

// Recalculate and update EcoTrust score
router.post("/ecotrust/recalculate", authenticate, authorize('admin'), async (req, res) => {
  const { business_id } = req.body;
  
  try {
    // Sum all verified transactions
    const result = await pool.query(`
      SELECT COALESCE(SUM(points_earned), 0) as total_points
      FROM ecotrust_transactions 
      WHERE business_id = $1 AND verification_status = 'verified'
    `, [business_id]);
    
    const totalPoints = parseFloat(result.rows[0].total_points);
    
    // Determine level
    let level = 'Newcomer';
    if (totalPoints >= 1000) level = 'Eco Leader';
    else if (totalPoints >= 500) level = 'Eco Champion';
    else if (totalPoints >= 200) level = 'Eco Warrior';
    
    // Update score
    await pool.query(`
      UPDATE ecotrust_scores 
      SET current_score = $1, total_points_earned = $1, level = $2, last_updated = NOW()
      WHERE business_id = $3
    `, [totalPoints, level, business_id]);
    
    res.json({ success: true, message: "EcoTrust score updated", points: totalPoints, level });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Get EcoTrust transactions for audit
router.get("/ecotrust/transactions", authenticate, authorize('sustainability_manager', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT et.*, bp.business_name, sa.action_name
      FROM ecotrust_transactions et
      LEFT JOIN business_profiles bp ON et.business_id = bp.business_id
      LEFT JOIN sustainable_actions sa ON et.action_id = sa.id
      ORDER BY et.transaction_date DESC
      LIMIT 100
    `);
    res.json({ success: true, transactions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ============================================================
// APPROVAL HISTORY
// ============================================================

// Get approval history
router.get("/history", authenticate, async (req, res) => {
  try {
    const { approval_type, start_date, end_date } = req.query;
    let query = `SELECT * FROM approval_history WHERE 1=1`;
    const params = [];
    
    if (approval_type) {
      params.push(approval_type);
      query += ` AND approval_type = $${params.length}`;
    }
    if (start_date) {
      params.push(start_date);
      query += ` AND action_at >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      query += ` AND action_at <= $${params.length}`;
    }
    
    query += ` ORDER BY action_at DESC LIMIT 100`;
    
    const result = await pool.query(query, params);
    res.json({ success: true, history: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

module.exports = router;
</parameter>
</create_file>
