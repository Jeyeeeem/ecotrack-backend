-- Migration: Create manager_approvals and related tables
-- For integrated workflow: Inventory Manager, Logistics Manager, Sustainability Manager, Driver

-- 1. Manager Approvals (consolidated table for all approval types)
CREATE TABLE IF NOT EXISTS manager_approvals (
    id SERIAL PRIMARY KEY,
    approval_type VARCHAR(50) NOT NULL, -- 'spoilage_action', 'route_optimization'
    related_table VARCHAR(50), -- 'alerts', 'delivery_routes', 'deliveries'
    related_record_id INTEGER,
    alert_id INTEGER, -- FK to alerts table
    delivery_id INTEGER, -- FK to deliveries table
    route_id INTEGER, -- FK to delivery_routes table
    inventory_id INTEGER, -- FK to inventory_items table
    
    -- Request details
    required_role VARCHAR(50) NOT NULL, -- 'inventory_manager', 'logistics_manager'
    requested_by INTEGER, -- user_id who submitted
    request_notes TEXT,
    
    -- Decision
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'approved', 'declined'
    decision_by INTEGER, -- user_id who decided
    decision_notes TEXT,
    manager_comment TEXT,
    
    -- Timestamps
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Business context
    business_id INTEGER,
    
    -- Additional data (JSON for flexible fields)
    request_data JSONB,
    decision_data JSONB
);

-- 2. Approval History (audit log for all decisions)
CREATE TABLE IF NOT EXISTS approval_history (
    id SERIAL PRIMARY KEY,
    approval_id INTEGER REFERENCES manager_approvals(id),
    approval_type VARCHAR(50),
    related_record_id INTEGER,
    related_table VARCHAR(50),
    
    -- Actor info
    actor_user_id INTEGER,
    actor_role VARCHAR(50),
    actor_name VARCHAR(255),
    
    -- Action details
    action VARCHAR(50), -- 'submitted', 'approved', 'declined', 're_evaluated'
    previous_status VARCHAR(50),
    new_status VARCHAR(50),
    
    -- Notes
    notes TEXT,
    comment TEXT,
    
    -- Timestamps
    action_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Business context
    business_id INTEGER
);

-- 3. Carbon Footprint Records (with is_actual distinction)
CREATE TABLE IF NOT EXISTS carbon_footprint_records (
    id SERIAL PRIMARY KEY,
    record_type VARCHAR(50) NOT NULL, -- 'delivery', 'storage', 'redistribution'
    delivery_id INTEGER,
    route_id INTEGER,
    inventory_id INTEGER,
    business_id INTEGER,
    
    -- Calculation method
    calculation_method VARCHAR(50), -- 'estimated', 'actual', 'verified'
    
    -- Date
    record_date DATE,
    delivery_date TIMESTAMP,
    
    -- Carbon values
    transportation_carbon_kg DECIMAL(10,2) DEFAULT 0,
    storage_carbon_kg DECIMAL(10,2) DEFAULT 0,
    total_carbon_kg DECIMAL(10,2) DEFAULT 0,
    
    -- Factors used
    distance_km DECIMAL(10,2),
    fuel_liters DECIMAL(10,2),
    vehicle_type VARCHAR(50),
    load_factor DECIMAL(5,2),
    
    -- Verification status
    verification_status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'verified', 'rejected', 'revision_requested'
    verified_by INTEGER,
    verified_at TIMESTAMP,
    verification_comment TEXT,
    
    -- Is actual vs estimated flag
    is_actual BOOLEAN DEFAULT FALSE,
    is_verified BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- EcoTrust integration
    ecotrust_points_awarded DECIMAL(10,2) DEFAULT 0,
    ecotrust_transaction_id INTEGER
);

-- 4. EcoTrust Transactions (point awards)
CREATE TABLE IF NOT EXISTS ecotrust_transactions (
    id SERIAL PRIMARY KEY,
    business_id INTEGER,
    action_id INTEGER, -- FK to sustainable_actions
    
    -- Transaction details
    action_type VARCHAR(100), -- 'spoilage_prevention', 'route_optimization', 'carbon_verification'
    points_earned DECIMAL(10,2) NOT NULL,
    
    -- Related record
    related_record_type VARCHAR(50), -- 'delivery', 'inventory', 'alert'
    related_record_id INTEGER,
    
    -- Verification
    verification_status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'verified'
    verified_by INTEGER,
    verified_at TIMESTAMP,
    
    -- Description
    description TEXT,
    
    -- Timestamps
    transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Sustainable Actions (definitions of what earns points)
CREATE TABLE IF NOT EXISTS sustainable_actions (
    id SERIAL PRIMARY KEY,
    action_type VARCHAR(100) NOT NULL UNIQUE,
    action_name VARCHAR(255) NOT NULL,
    description TEXT,
    points_value DECIMAL(10,2) NOT NULL DEFAULT 0,
    
    -- Category
    category VARCHAR(50), -- 'spoilage', 'logistics', 'carbon', 'delivery'
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Add driver_user_id to delivery_routes if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'delivery_routes' AND column_name = 'driver_user_id') THEN
        ALTER TABLE delivery_routes ADD COLUMN driver_user_id INTEGER;
    END IF;
    
    -- Add is_actual to deliveries if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deliveries' AND column_name = 'is_actual') THEN
        ALTER TABLE deliveries ADD COLUMN is_actual BOOLEAN DEFAULT FALSE;
    END IF;
    
    -- Add current_condition to inventory_items if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'current_condition') THEN
        ALTER TABLE inventory_items ADD COLUMN current_condition VARCHAR(100);
    END IF;
END $$;

-- Insert default sustainable actions
INSERT INTO sustainable_actions (action_type, action_name, description, points_value, category) VALUES
    ('spoilage_prevention', 'Spoilage Prevention', 'Prevented food from spoiling by redistributing to another market', 50, 'spoilage'),
    ('route_optimization_approved', 'Route Optimization Approved', 'Approved AI-optimized delivery route', 25, 'logistics'),
    ('carbon_verified', 'Carbon Verified', 'Verified actual carbon footprint for delivery', 15, 'carbon'),
    ('delivery_completed', 'Delivery Completed', 'Driver completed delivery with accurate logging', 20, 'delivery'),
    ('eco_delivery', 'Eco-Friendly Delivery', 'Completed delivery with less than estimated carbon', 30, 'delivery')
ON CONFLICT (action_type) DO NOTHING;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_manager_approvals_type_status ON manager_approvals(approval_type, status);
CREATE INDEX IF NOT EXISTS idx_manager_approvals_role ON manager_approvals(required_role, status);
CREATE INDEX IF NOT EXISTS idx_approval_history_approval ON approval_history(approval_id);
CREATE INDEX IF NOT EXISTS idx_carbon_records_delivery ON carbon_footprint_records(delivery_id, is_actual);
CREATE INDEX IF NOT EXISTS idx_carbon_records_verification ON carbon_footprint_records(verification_status);
CREATE INDEX IF NOT EXISTS idx_ecotrust_transactions_business ON ecotrust_transactions(business_id);

-- Grant permissions
-- Note: Adjust based on your database setup

