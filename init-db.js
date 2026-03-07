const pool = require('./database');

async function initDatabase() {
  try {
    console.log('🔄 Initializing database...');
    
    // Create users table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          user_id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          username VARCHAR(255) UNIQUE,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'user',
          business_id INTEGER,
          full_name VARCHAR(255),
          phone VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ users table checked/created');
    } catch (error) {
      console.log('⚠️  users table error:', error.message);
    }
    
    // Create business_profiles table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS business_profiles (
          business_id SERIAL PRIMARY KEY,
          business_name VARCHAR(255) NOT NULL,
          business_type VARCHAR(100),
          registration_number VARCHAR(100),
          address TEXT,
          contact_email VARCHAR(255),
          contact_phone VARCHAR(50),
          owner_user_id INTEGER REFERENCES users(user_id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ business_profiles table checked/created');
    } catch (error) {
      console.log('⚠️  business_profiles table error:', error.message);
    }
    
    // Create ecotrust_scores table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ecotrust_scores (
          id SERIAL PRIMARY KEY,
          business_id INTEGER REFERENCES business_profiles(business_id) ON DELETE CASCADE,
          current_score DECIMAL(10,2) DEFAULT 0,
          total_points_earned DECIMAL(10,2) DEFAULT 0,
          total_deliveries INTEGER DEFAULT 0,
          total_carbon_saved DECIMAL(10,2) DEFAULT 0,
          level VARCHAR(50) DEFAULT 'Newcomer',
          rank INTEGER DEFAULT 0,
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ ecotrust_scores table checked/created');
    } catch (error) {
      console.log('⚠️  ecotrust_scores table error:', error.message);
    }
    
    // Create driver_locations table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS driver_locations (
          id SERIAL PRIMARY KEY,
          route_id INTEGER,
          driver_user_id INTEGER,
          business_id INTEGER,
          latitude DECIMAL(10,7) NOT NULL,
          longitude DECIMAL(10,7) NOT NULL,
          accuracy_m DECIMAL(10,2),
          speed_kmh DECIMAL(10,2),
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ driver_locations table checked/created');
    } catch (error) {
      console.log('⚠️  driver_locations table error:', error.message);
    }
    
    // Create inventory_items table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS inventory_items (
          id SERIAL PRIMARY KEY,
          product_id INTEGER,
          product_name VARCHAR(255) NOT NULL,
          sku VARCHAR(100),
          category VARCHAR(100),
          quantity DECIMAL(10,2) DEFAULT 0,
          unit VARCHAR(50) DEFAULT 'kg',
          location VARCHAR(255),
          warehouse_section VARCHAR(100),
          expiry_date DATE,
          manufacturing_date DATE,
          days_until_expiry INTEGER,
          temperature_min DECIMAL(10,2),
          temperature_max DECIMAL(10,2),
          current_temperature DECIMAL(10,2),
          humidity_level DECIMAL(10,2),
          status VARCHAR(50) DEFAULT 'active',
          risk_level VARCHAR(20) DEFAULT 'LOW',
          alert_triggered BOOLEAN DEFAULT FALSE,
          last_inspection_date TIMESTAMP,
          next_inspection_date TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          business_id INTEGER
        )
      `);
      console.log('✅ inventory_items table checked/created');
    } catch (error) {
      console.log('⚠️  inventory_items table error:', error.message);
    }
    
    // Create delivery_routes table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS delivery_routes (
          route_id SERIAL PRIMARY KEY,
          business_id INTEGER,
          route_name VARCHAR(255),
          route_type VARCHAR(100) DEFAULT 'single',
          origin_location JSONB,
          destination_location JSONB,
          vehicle_type VARCHAR(100),
          driver_user_id INTEGER,
          total_distance_km DECIMAL(10,2) DEFAULT 0,
          estimated_duration_minutes INTEGER DEFAULT 0,
          estimated_fuel_consumption_liters DECIMAL(10,2) DEFAULT 0,
          estimated_carbon_kg DECIMAL(10,2) DEFAULT 0,
          status VARCHAR(50) DEFAULT 'planned',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP
        )
      `);
      console.log('✅ delivery_routes table checked/created');
    } catch (error) {
      console.log('⚠️  delivery_routes table error:', error.message);
    }
    
    // Create route_stops table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS route_stops (
          id SERIAL PRIMARY KEY,
          route_id INTEGER,
          stop_sequence INTEGER NOT NULL,
          location_name VARCHAR(255),
          address TEXT,
          latitude DECIMAL(10,7),
          longitude DECIMAL(10,7),
          stop_type VARCHAR(50) DEFAULT 'delivery',
          planned_arrival_time TIMESTAMP,
          actual_arrival_time TIMESTAMP,
          planned_departure_time TIMESTAMP,
          actual_departure_time TIMESTAMP,
          status VARCHAR(50) DEFAULT 'pending',
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ route_stops table checked/created');
    } catch (error) {
      console.log('⚠️  route_stops table error:', error.message);
    }
    
    // Create delivery_logs table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS delivery_logs (
          id SERIAL PRIMARY KEY,
          route_id INTEGER,
          business_id INTEGER,
          driver_user_id INTEGER,
          actual_distance_km DECIMAL(10,2),
          actual_duration_minutes INTEGER,
          actual_fuel_used_liters DECIMAL(10,2),
          actual_carbon_kg DECIMAL(10,2),
          delivery_date DATE,
          driver_name VARCHAR(255),
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ delivery_logs table checked/created');
    } catch (error) {
      console.log('⚠️  delivery_logs table error:', error.message);
    }
    
    // Create route_optimizations table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS route_optimizations (
          id SERIAL PRIMARY KEY,
          route_id INTEGER,
          business_id INTEGER,
          original_distance_km DECIMAL(10,2),
          optimized_distance_km DECIMAL(10,2),
          original_duration_minutes INTEGER,
          optimized_duration_minutes INTEGER,
          original_fuel_liters DECIMAL(10,2),
          optimized_fuel_liters DECIMAL(10,2),
          original_carbon_kg DECIMAL(10,2),
          optimized_carbon_kg DECIMAL(10,2),
          savings_km DECIMAL(10,2),
          savings_fuel DECIMAL(10,2),
          savings_co2 DECIMAL(10,2),
          ai_recommendation TEXT,
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ route_optimizations table checked/created');
    } catch (error) {
      console.log('⚠️  route_optimizations table error:', error.message);
    }
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
    
    // Insert sample business profiles if table is empty
    try {
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM business_profiles');
      if (parseInt(rows[0].count) === 0) {
        console.log('Inserting sample business profiles...');
        
        const sampleBusinesses = [
          {
            business_name: 'GreenLeaf Distribution',
            business_type: 'Food Distribution',
            registration_number: 'REG-2024-001',
            address: '123 Warehouse Ave, Manila',
            contact_email: 'contact@greenleaf.com',
            contact_phone: '+63 912 345 6789'
          },
          {
            business_name: 'EcoFresh Logistics',
            business_type: 'Cold Chain Logistics',
            registration_number: 'REG-2024-002',
            address: '456 Industrial Blvd, Cebu',
            contact_email: 'info@ecofresh.logistics',
            contact_phone: '+63 922 345 6789'
          },
          {
            business_name: 'Sustainable Foods Co.',
            business_type: 'Organic Products',
            registration_number: 'REG-2024-003',
            address: '789 Commerce St, Davao',
            contact_email: 'hello@sustainablefoods.ph',
            contact_phone: '+63 932 345 6789'
          }
        ];

        for (const business of sampleBusinesses) {
          const result = await pool.query(
            `INSERT INTO business_profiles 
              (business_name, business_type, registration_number, address, contact_email, contact_phone)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING business_id`,
            [business.business_name, business.business_type, business.registration_number, 
             business.address, business.contact_email, business.contact_phone]
          );
          
          // Create ecotrust score for each business
          await pool.query(
            `INSERT INTO ecotrust_scores 
              (business_id, current_score, total_points_earned, total_deliveries, total_carbon_saved, level, rank)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [result.rows[0].business_id, Math.floor(Math.random() * 50) + 50, Math.floor(Math.random() * 500) + 100, 
             Math.floor(Math.random() * 50) + 10, Math.floor(Math.random() * 100) + 20, 
             ['Bronze', 'Silver', 'Gold', 'Platinum'][Math.floor(Math.random() * 4)], Math.floor(Math.random() * 10) + 1]
          );
        }
        console.log('✅ Sample business profiles and ecotrust scores inserted');
      }
    } catch (error) {
      console.log('⚠️  Error inserting business profiles:', error.message);
    }
    
    // Insert sample inventory items if table is empty
    try {
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM inventory_items');
      if (parseInt(rows[0].count) === 0) {
        console.log('Inserting sample inventory items...');
        
        const sampleItems = [
          {
            product_name: 'Organic Tomatoes',
            sku: 'TOM-ORG-001',
            category: 'Vegetables',
            quantity: 150.0,
            unit: 'kg',
            location: 'Warehouse A',
            warehouse_section: 'Section A1',
            expiry_date: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
            days_until_expiry: 7,
            temperature_min: 12.0,
            temperature_max: 18.0,
            current_temperature: 15.0,
            humidity_level: 80.0,
            risk_level: 'LOW'
          },
          {
            product_name: 'Fresh Milk',
            sku: 'MLK-FRESH-001',
            category: 'Dairy',
            quantity: 200.0,
            unit: 'liters',
            location: 'Cold Room 1',
            warehouse_section: 'Section C1',
            expiry_date: new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
            days_until_expiry: 14,
            temperature_min: 2.0,
            temperature_max: 6.0,
            current_temperature: 4.5,
            humidity_level: 70.0,
            risk_level: 'LOW'
          },
          {
            product_name: 'Bananas',
            sku: 'BAN-001',
            category: 'Fruits',
            quantity: 300.0,
            unit: 'kg',
            location: 'Warehouse B',
            warehouse_section: 'Section B2',
            expiry_date: new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0],
            days_until_expiry: 10,
            temperature_min: 13.0,
            temperature_max: 20.0,
            current_temperature: 16.0,
            humidity_level: 85.0,
            risk_level: 'MEDIUM'
          },
          {
            product_name: 'Chicken Meat',
            sku: 'CHK-001',
            category: 'Meat',
            quantity: 100.0,
            unit: 'kg',
            location: 'Freezer 1',
            warehouse_section: 'Section F1',
            expiry_date: new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0],
            days_until_expiry: 5,
            temperature_min: -18.0,
            temperature_max: -12.0,
            current_temperature: -15.0,
            humidity_level: 75.0,
            risk_level: 'HIGH'
          },
          {
            product_name: 'Iceberg Lettuce',
            sku: 'LET-ICE-001',
            category: 'Vegetables',
            quantity: 80.0,
            unit: 'kg',
            location: 'Cold Room 2',
            warehouse_section: 'Section C2',
            expiry_date: new Date(Date.now() + 8 * 86400000).toISOString().split('T')[0],
            days_until_expiry: 8,
            temperature_min: 1.0,
            temperature_max: 5.0,
            current_temperature: 3.0,
            humidity_level: 90.0,
            risk_level: 'LOW'
          }
        ];

        for (const item of sampleItems) {
          await pool.query(
            `INSERT INTO inventory_items 
              (product_name, sku, category, quantity, unit, location, warehouse_section, expiry_date, 
               days_until_expiry, temperature_min, temperature_max, current_temperature, humidity_level, risk_level)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [item.product_name, item.sku, item.category, item.quantity, item.unit, 
             item.location, item.warehouse_section, item.expiry_date, item.days_until_expiry,
             item.temperature_min, item.temperature_max, item.current_temperature, item.humidity_level, item.risk_level]
          );
        }
        console.log('✅ Sample inventory items inserted');
      }
    } catch (error) {
      console.log('⚠️  Error inserting inventory items:', error.message);
    }
    
    // Insert sample delivery routes if table is empty
    try {
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM delivery_routes');
      if (parseInt(rows[0].count) === 0) {
        console.log('Inserting sample delivery routes...');
        
        const sampleRoutes = [
          {
            route_name: 'Metro Manila Express',
            route_type: 'multi-stop',
            origin_location: JSON.stringify({ name: 'Warehouse A', address: '123 Warehouse Ave, Manila' }),
            destination_location: JSON.stringify({ name: 'Metro Manila', address: 'Various locations in Metro Manila' }),
            vehicle_type: 'Van',
            total_distance_km: 45.0,
            estimated_duration_minutes: 180,
            estimated_fuel_consumption_liters: 12.0,
            estimated_carbon_kg: 5.4,
            status: 'planned'
          },
          {
            route_name: 'Cebu City Delivery',
            route_type: 'single',
            origin_location: JSON.stringify({ name: 'Warehouse B', address: '456 Industrial Blvd, Cebu' }),
            destination_location: JSON.stringify({ name: 'Cebu City', address: 'Downtown Cebu City' }),
            vehicle_type: 'Truck',
            total_distance_km: 120.0,
            estimated_duration_minutes: 180,
            estimated_fuel_consumption_liters: 25.0,
            estimated_carbon_kg: 11.25,
            status: 'planned'
          }
        ];

        for (const route of sampleRoutes) {
          await pool.query(
            `INSERT INTO delivery_routes 
              (route_name, route_type, origin_location, destination_location, vehicle_type, 
               total_distance_km, estimated_duration_minutes, estimated_fuel_consumption_liters, 
               estimated_carbon_kg, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [route.route_name, route.route_type, route.origin_location, route.destination_location,
             route.vehicle_type, route.total_distance_km, route.estimated_duration_minutes,
             route.estimated_fuel_consumption_liters, route.estimated_carbon_kg, route.status]
          );
        }
        console.log('✅ Sample delivery routes inserted');
      }
    } catch (error) {
      console.log('⚠️  Error inserting delivery routes:', error.message);
    }
    
    // Insert sample route stops if table is empty
    try {
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM route_stops');
      if (parseInt(rows[0].count) === 0) {
        console.log('Inserting sample route stops...');
        
        const sampleStops = [
          { route_id: 1, stop_sequence: 1, location_name: 'Market A', address: '123 Market St, QC', stop_type: 'delivery' },
          { route_id: 1, stop_sequence: 2, location_name: 'Store B', address: '456 Store Ave, Manila', stop_type: 'delivery' },
          { route_id: 1, stop_sequence: 3, location_name: 'Restaurant C', address: '789 Food St, Makati', stop_type: 'delivery' },
          { route_id: 2, stop_sequence: 1, location_name: 'Hotel D', address: '100 Hotel Rd, Cebu City', stop_type: 'delivery' }
        ];

        for (const stop of sampleStops) {
          await pool.query(
            `INSERT INTO route_stops 
              (route_id, stop_sequence, location_name, address, stop_type)
             VALUES ($1, $2, $3, $4, $5)`,
            [stop.route_id, stop.stop_sequence, stop.location_name, stop.address, stop.stop_type]
          );
        }
        console.log('✅ Sample route stops inserted');
      }
    } catch (error) {
      console.log('⚠️  Error inserting route stops:', error.message);
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
