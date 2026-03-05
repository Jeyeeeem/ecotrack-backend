-- ============================================================
-- Database Migration: Create driver_locations table
-- For Real-Time Driver GPS Tracking
-- Run this in your Neon PostgreSQL console
-- ============================================================

-- Create driver_locations table for GPS tracking
CREATE TABLE IF NOT EXISTS driver_locations (
    id SERIAL PRIMARY KEY,
    route_id INTEGER REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
    driver_user_id INTEGER REFERENCES users(user_id),
    business_id INTEGER,
    latitude DECIMAL(10, 7) NOT NULL,
    longitude DECIMAL(10, 7) NOT NULL,
    accuracy_m DECIMAL(10, 2),
    speed_kmh DECIMAL(10, 2),
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- Create index for fast lookups by route
CREATE INDEX IF NOT EXISTS idx_driver_locations_route
ON driver_locations (route_id, recorded_at DESC);

-- Create index for business queries
CREATE INDEX IF NOT EXISTS idx_driver_locations_business
ON driver_locations (business_id, recorded_at DESC);

-- Create index for driver queries
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver
ON driver_locations (driver_user_id, recorded_at DESC);

-- ============================================================
-- Add additional columns to deliveries table if not exists
-- ============================================================

-- Add tracking columns if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deliveries' AND column_name = 'driver_user_id') THEN
        ALTER TABLE deliveries ADD COLUMN driver_user_id INTEGER REFERENCES users(user_id);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deliveries' AND column_name = 'current_latitude') THEN
        ALTER TABLE deliveries ADD COLUMN current_latitude DECIMAL(10, 7);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deliveries' AND column_name = 'current_longitude') THEN
        ALTER TABLE deliveries ADD COLUMN current_longitude DECIMAL(10, 7);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deliveries' AND column_name = 'last_location_update') THEN
        ALTER TABLE deliveries ADD COLUMN last_location_update TIMESTAMP;
    END IF;
END $$;

-- ============================================================
-- Create inventory_items table for real-time shelf life tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_items (
    id SERIAL PRIMARY KEY,
    product_id INTEGER,
    product_name VARCHAR(255) NOT NULL,
    sku VARCHAR(100),
    category VARCHAR(100),
    quantity DECIMAL(10, 2) DEFAULT 0,
    unit VARCHAR(50) DEFAULT 'kg',
    location VARCHAR(255),
    warehouse_section VARCHAR(100),
    expiry_date DATE,
    manufacturing_date DATE,
    days_until_expiry INTEGER,
    temperature_min DECIMAL(10, 2),
    temperature_max DECIMAL(10, 2),
    current_temperature DECIMAL(10, 2),
    humidity_level DECIMAL(10, 2),
    status VARCHAR(50) DEFAULT 'active',
    risk_level VARCHAR(20) DEFAULT 'LOW',
    alert_triggered BOOLEAN DEFAULT FALSE,
    last_inspection_date TIMESTAMP,
    next_inspection_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    business_id INTEGER
);

-- Index for inventory queries
CREATE INDEX IF NOT EXISTS idx_inventory_items_expiry
ON inventory_items (expiry_date, status);

CREATE INDEX IF NOT EXISTS idx_inventory_items_risk
ON inventory_items (risk_level, status);

CREATE INDEX IF NOT EXISTS idx_inventory_items_business
ON inventory_items (business_id, status);

-- ============================================================
-- Create route_stops table for multi-stop delivery tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS route_stops (
    id SERIAL PRIMARY KEY,
    route_id INTEGER REFERENCES delivery_routes(route_id) ON DELETE CASCADE,
    stop_sequence INTEGER NOT NULL,
    location_name VARCHAR(255),
    address TEXT,
    latitude DECIMAL(10, 7),
    longitude DECIMAL(10, 7),
    stop_type VARCHAR(50) DEFAULT 'delivery',
    planned_arrival_time TIMESTAMP,
    actual_arrival_time TIMESTAMP,
    planned_departure_time TIMESTAMP,
    actual_departure_time TIMESTAMP,
    status VARCHAR(50) DEFAULT 'pending',
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_stops_route
ON route_stops (route_id, stop_sequence);

-- ============================================================
-- Create delivery_routes table if not exists
-- ============================================================

CREATE TABLE IF NOT EXISTS delivery_routes (
    route_id SERIAL PRIMARY KEY,
    business_id INTEGER,
    route_name VARCHAR(255),
    route_type VARCHAR(100) DEFAULT 'single',
    origin_location JSONB,
    destination_location JSONB,
    vehicle_type VARCHAR(100),
    driver_user_id INTEGER REFERENCES users(user_id),
    total_distance_km DECIMAL(10, 2) DEFAULT 0,
    estimated_duration_minutes INTEGER DEFAULT 0,
    estimated_fuel_consumption_liters DECIMAL(10, 2) DEFAULT 0,
    estimated_carbon_kg DECIMAL(10, 2) DEFAULT 0,
    status VARCHAR(50) DEFAULT 'planned',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- ============================================================
-- Create delivery_logs table for completed delivery records
-- ============================================================

CREATE TABLE IF NOT EXISTS delivery_logs (
    id SERIAL PRIMARY KEY,
    route_id INTEGER REFERENCES delivery_routes(route_id) ON DELETE CASCADE,
    business_id INTEGER,
    driver_user_id INTEGER REFERENCES users(user_id),
    actual_distance_km DECIMAL(10, 2),
    actual_duration_minutes INTEGER,
    actual_fuel_used_liters DECIMAL(10, 2),
    actual_carbon_kg DECIMAL(10, 2),
    delivery_date DATE,
    driver_name VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_logs_route
ON delivery_logs (route_id);

CREATE INDEX IF NOT EXISTS idx_delivery_logs_date
ON delivery_logs (delivery_date);

-- ============================================================
-- Create route_optimizations table for AI-optimized routes
-- ============================================================

CREATE TABLE IF NOT EXISTS route_optimizations (
    id SERIAL PRIMARY KEY,
    route_id INTEGER REFERENCES delivery_routes(route_id) ON DELETE CASCADE,
    business_id INTEGER,
    original_distance_km DECIMAL(10, 2),
    optimized_distance_km DECIMAL(10, 2),
    original_duration_minutes INTEGER,
    optimized_duration_minutes INTEGER,
    original_fuel_liters DECIMAL(10, 2),
    optimized_fuel_liters DECIMAL(10, 2),
    original_carbon_kg DECIMAL(10, 2),
    optimized_carbon_kg DECIMAL(10, 2),
    savings_km DECIMAL(10, 2),
    savings_fuel DECIMAL(10, 2),
    savings_co2 DECIMAL(10, 2),
    ai_recommendation TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_optimizations_route
ON route_optimizations (route_id);

-- ============================================================
-- Grant necessary permissions (adjust as needed for your setup)
-- ============================================================

-- Grant SELECT on all tables to public (adjust in production)
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO public;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO public;

console.log("✅ Database migration completed successfully!");

