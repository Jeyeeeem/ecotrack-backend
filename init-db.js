const pool = require('./database');

async function initDatabase() {
  try {
    console.log('🔄 Initializing database...');
    
    // Create deliveries table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id SERIAL PRIMARY KEY,
          route_id INTEGER,
          business_id INTEGER,
          status VARCHAR(50) DEFAULT 'pending',
          driver_name VARCHAR(255),
          vehicle_type VARCHAR(100),
          departure_time TIMESTAMP,
          arrival_time TIMESTAMP,
          completed_at TIMESTAMP,
          from_location VARCHAR(255),
          to_location VARCHAR(255),
          distance_km DECIMAL(10,2),
          fuel_consumption DECIMAL(10,2),
          estimated_fuel_consumption_liters DECIMAL(10,2),
          carbon_emissions DECIMAL(10,2),
          estimated_carbon_kg DECIMAL(10,2),
          stops_json JSONB,
          delivery_items_json JSONB,
          carbon_verification_status VARCHAR(50),
          carbon_verification_comment TEXT,
          carbon_verified_at TIMESTAMP,
          carbon_verified_by VARCHAR(255),
          delivery_notes TEXT,
          driver_response VARCHAR(50),
          driver_notes TEXT,
          driver_responded_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ deliveries table checked/created');
    } catch (error) {
      console.log('⚠️  deliveries table error:', error.message);
    }
    
    // Create route_approvals table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS route_approvals (
          id SERIAL PRIMARY KEY,
          route_type VARCHAR(100) DEFAULT 'STANDARD',
          from_location VARCHAR(255),
          to_location VARCHAR(255),
          driver_name VARCHAR(255),
          vehicle_type VARCHAR(100),
          departure_time TIMESTAMP,
          original_distance DECIMAL(10,2),
          optimized_distance DECIMAL(10,2),
          original_time VARCHAR(50),
          optimized_time VARCHAR(50),
          original_fuel DECIMAL(10,2),
          optimized_fuel DECIMAL(10,2),
          original_co2 DECIMAL(10,2),
          optimized_co2 DECIMAL(10,2),
          savings_km DECIMAL(10,2),
          savings_fuel DECIMAL(10,2),
          savings_co2 DECIMAL(10,2),
          ai_suggestion TEXT,
          status VARCHAR(50) DEFAULT 'PENDING',
          submitted_by VARCHAR(255),
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          approved_at TIMESTAMP,
          manager_comment TEXT
        )
      `);
      console.log('✅ route_approvals table checked/created');
    } catch (error) {
      console.log('⚠️  route_approvals table error:', error.message);
    }
    
    // Create alerts table
    try {
      // First check if table exists, if not create it
      const tableExists = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public'
          AND table_name = 'alerts'
        )
      `);
      
      if (!tableExists.rows[0].exists) {
        await pool.query(`
          CREATE TABLE alerts (
            id SERIAL PRIMARY KEY,
            product_id INTEGER,
            product_name VARCHAR(255),
            alert_type VARCHAR(100),
            risk_level VARCHAR(50),
            details TEXT,
            days_left INTEGER,
            temperature DECIMAL(10,2),
            humidity DECIMAL(10,2),
            location VARCHAR(255),
            quantity DECIMAL(10,2),
            value DECIMAL(10,2),
            status VARCHAR(50) DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP,
            submitted_by VARCHAR(255)
          )
        `);
        console.log('✅ alerts table created');
      } else {
        // Table exists, add missing columns if they don't exist
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_type VARCHAR(100)`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS risk_level VARCHAR(50)`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS product_id INTEGER`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS product_name VARCHAR(255)`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS days_left INTEGER`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS temperature DECIMAL(10,2)`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS humidity DECIMAL(10,2)`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS location VARCHAR(255)`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS quantity DECIMAL(10,2)`);
        } catch (e) { /* column may already exist */ }
        try {
          await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS value DECIMAL(10,2)`);
        } catch (e) { /* column may already exist */ }
        console.log('✅ alerts table updated with new columns');
      }
    } catch (error) {
      console.log('⚠️  alerts table error:', error.message);
    }
    
    // Insert sample route approvals if table is empty
    try {
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM route_approvals');
      if (parseInt(rows[0].count) === 0) {
        console.log('Inserting sample route approvals...');
        
        const sampleRoutes = [
          {
            route_type: 'MULTI-STOP',
            from_location: 'Warehouse A',
            to_location: 'Metro Manila',
            driver_name: 'Carlos Reyes',
            vehicle_type: 'Van-001',
            departure_time: new Date(Date.now() + 86400000).toISOString(),
            original_distance: 45.0,
            optimized_distance: 38.5,
            original_time: '2h 30m',
            optimized_time: '2h 00m',
            original_fuel: 15.0,
            optimized_fuel: 12.0,
            original_co2: 6.75,
            optimized_co2: 5.4,
            savings_km: 6.5,
            savings_fuel: 3.0,
            savings_co2: 1.35,
            ai_suggestion: 'Optimize route by avoiding peak hours (7-9AM, 5-7PM). Group deliveries in QC area together.',
            status: 'PENDING',
            submitted_by: 'System'
          },
          {
            route_type: 'SINGLE STOP',
            from_location: 'Warehouse B',
            to_location: 'Cebu City',
            driver_name: 'Juan dela Cruz',
            vehicle_type: 'Truck-002',
            departure_time: new Date(Date.now() + 172800000).toISOString(),
            original_distance: 120.0,
            optimized_distance: 105.0,
            original_time: '3h 00m',
            optimized_time: '2h 30m',
            original_fuel: 25.0,
            optimized_fuel: 21.0,
            original_co2: 11.25,
            optimized_co2: 9.45,
            savings_km: 15.0,
            savings_fuel: 4.0,
            savings_co2: 1.8,
            ai_suggestion: 'Take southern bypass route to avoid city traffic during peak hours.',
            status: 'PENDING',
            submitted_by: 'System'
          },
          {
            route_type: 'MULTI-STOP',
            from_location: 'Warehouse A',
            to_location: 'Davao City',
            driver_name: 'Maria Santos',
            vehicle_type: 'Van-003',
            departure_time: new Date(Date.now() + 259200000).toISOString(),
            original_distance: 85.0,
            optimized_distance: 72.0,
            original_time: '2h 45m',
            optimized_time: '2h 15m',
            original_fuel: 18.0,
            optimized_fuel: 15.0,
            original_co2: 8.1,
            optimized_co2: 6.75,
            savings_km: 13.0,
            savings_fuel: 3.0,
            savings_co2: 1.35,
            ai_suggestion: 'Consolidate stops in downtown area for efficiency.',
            status: 'PENDING',
            submitted_by: 'System'
          }
        ];

        for (const route of sampleRoutes) {
          await pool.query(
            `INSERT INTO route_approvals 
              (route_type, from_location, to_location, driver_name, vehicle_type, departure_time,
               original_distance, optimized_distance, original_time, optimized_time,
               original_fuel, optimized_fuel, original_co2, optimized_co2,
               savings_km, savings_fuel, savings_co2, ai_suggestion, status, submitted_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
            [route.route_type, route.from_location, route.to_location, route.driver_name, 
             route.vehicle_type, route.departure_time, route.original_distance, route.optimized_distance,
             route.original_time, route.optimized_time, route.original_fuel, route.optimized_fuel,
             route.original_co2, route.optimized_co2, route.savings_km, route.savings_fuel,
             route.savings_co2, route.ai_suggestion, route.status, route.submitted_by]
          );
        }
        console.log('✅ Sample route approvals inserted');
      }
    } catch (error) {
      console.log('⚠️  Error inserting route approvals:', error.message);
    }
    
    // Insert sample alerts if table is empty
    try {
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM alerts');
      if (parseInt(rows[0].count) === 0) {
        console.log('Inserting sample alerts...');
        
        const sampleAlerts = [
          {
            product_id: 1,
            product_name: 'Organic Tomatoes',
            alert_type: 'spoilage',
            risk_level: 'HIGH',
            details: 'Visible mold growth detected - immediate action required',
            days_left: 1,
            temperature: 25.5,
            humidity: 85.0,
            location: 'Warehouse A',
            quantity: 50.0,
            value: 500.0,
            status: 'active',
            submitted_by: 'System'
          },
          {
            product_id: 2,
            product_name: 'Fresh Milk',
            alert_type: 'temperature',
            risk_level: 'MEDIUM',
            details: 'Temperature approaching upper limit - monitor closely',
            days_left: 3,
            temperature: 8.5,
            humidity: 70.0,
            location: 'Cold Room 3',
            quantity: 100.0,
            value: 1200.0,
            status: 'active',
            submitted_by: 'System'
          },
          {
            product_id: 3,
            product_name: 'Bananas',
            alert_type: 'expiry',
            risk_level: 'LOW',
            details: 'Approaching expiry date - schedule for priority delivery',
            days_left: 5,
            temperature: 18.0,
            humidity: 65.0,
            location: 'Room B',
            quantity: 75.0,
            value: 300.0,
            status: 'active',
            submitted_by: 'System'
          },
          {
            product_id: 4,
            product_name: 'Chicken Meat',
            alert_type: 'temperature',
            risk_level: 'HIGH',
            details: 'Temperature exceeded safe limit - immediate inspection needed',
            days_left: 0,
            temperature: 12.0,
            humidity: 80.0,
            location: 'Freezer 1',
            quantity: 200.0,
            value: 4000.0,
            status: 'active',
            submitted_by: 'System'
          },
          {
            product_id: 5,
            product_name: 'Iceberg Lettuce',
            alert_type: 'spoilage',
            risk_level: 'MEDIUM',
            details: 'Wilting detected - reduce storage time',
            days_left: 2,
            temperature: 6.0,
            humidity: 90.0,
            location: 'Cold Storage A',
            quantity: 30.0,
            value: 450.0,
            status: 'active',
            submitted_by: 'System'
          }
        ];

        for (const alert of sampleAlerts) {
          await pool.query(
            `INSERT INTO alerts 
              (product_id, product_name, alert_type, risk_level, details, days_left,
               temperature, humidity, location, quantity, value, status, submitted_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [alert.product_id, alert.product_name, alert.alert_type, alert.risk_level,
             alert.details, alert.days_left, alert.temperature, alert.humidity,
             alert.location, alert.quantity, alert.value, alert.status, alert.submitted_by]
          );
        }
        console.log('✅ Sample alerts inserted');
      }
    } catch (error) {
      console.log('⚠️  Error inserting alerts:', error.message);
    }
    
    // Insert sample deliveries if table is empty
    try {
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM deliveries');
      if (parseInt(rows[0].count) === 0) {
        console.log('Inserting sample deliveries...');
        
        const sampleDeliveries = [
          {
            route_id: 1,
            status: 'accepted',
            driver_name: 'Carlos Reyes',
            vehicle_type: 'Van-001',
            departure_time: new Date(Date.now() + 3600000).toISOString(),
            from_location: 'Warehouse A',
            to_location: 'Metro Manila',
            distance_km: 38.5,
            estimated_fuel_consumption_liters: 12.0,
            estimated_carbon_kg: 5.4,
            stops_json: JSON.stringify([
              { stopName: 'Market A', address: '123 Market St', sequence: 1 },
              { stopName: 'Store B', address: '456 Store Ave', sequence: 2 },
              { stopName: 'Restaurant C', address: '789 Food St', sequence: 3 }
            ]),
            delivery_items_json: JSON.stringify([
              { item: 'Organic Tomatoes', quantity: '50kg' },
              { item: 'Fresh Milk', quantity: '100kg' }
            ])
          },
          {
            route_id: 2,
            status: 'assigned',
            driver_name: 'Juan dela Cruz',
            vehicle_type: 'Truck-002',
            departure_time: new Date(Date.now() + 86400000).toISOString(),
            from_location: 'Warehouse B',
            to_location: 'Cebu City',
            distance_km: 105.0,
            estimated_fuel_consumption_liters: 21.0,
            estimated_carbon_kg: 9.45,
            stops_json: JSON.stringify([
              { stopName: 'Hotel D', address: '100 Hotel Rd', sequence: 1 },
              { stopName: 'Resort E', address: '200 Beach Rd', sequence: 2 }
            ]),
            delivery_items_json: JSON.stringify([
              { item: 'Bananas', quantity: '75kg' }
            ])
          },
          {
            route_id: 3,
            status: 'pending',
            driver_name: 'Maria Santos',
            vehicle_type: 'Van-003',
            departure_time: new Date(Date.now() + 172800000).toISOString(),
            from_location: 'Warehouse A',
            to_location: 'Davao City',
            distance_km: 72.0,
            estimated_fuel_consumption_liters: 15.0,
            estimated_carbon_kg: 6.75,
            stops_json: JSON.stringify([
              { stopName: 'Supermarket F', address: '300 Mall Ave', sequence: 1 }
            ]),
            delivery_items_json: JSON.stringify([
              { item: 'Iceberg Lettuce', quantity: '30kg' }
            ])
          }
        ];

        for (const delivery of sampleDeliveries) {
          await pool.query(
            `INSERT INTO deliveries 
              (route_id, status, driver_name, vehicle_type, departure_time, from_location, to_location,
               distance_km, estimated_fuel_consumption_liters, estimated_carbon_kg, stops_json, delivery_items_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [delivery.route_id, delivery.status, delivery.driver_name, delivery.vehicle_type, 
             delivery.departure_time, delivery.from_location, delivery.to_location, delivery.distance_km,
             delivery.estimated_fuel_consumption_liters, delivery.estimated_carbon_kg, 
             delivery.stops_json, delivery.delivery_items_json]
          );
        }
        console.log('✅ Sample deliveries inserted');
      }
    } catch (error) {
      console.log('⚠️  Error inserting deliveries:', error.message);
    }
    
    console.log('🎉 Database initialization complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    console.error('Full error:', error.stack);
    process.exit(1);
  }
}

initDatabase();
