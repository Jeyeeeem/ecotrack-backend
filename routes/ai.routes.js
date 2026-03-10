// ============================================================
// FILE: routes/ai.routes.js
// AI-Powered Route Optimization and Insights
// ============================================================

const express = require('express');
const router = express.Router();
const axios = require('axios');

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 15000;

// Middleware for authentication
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    // For demo, use default user - in production, decode JWT
    req.user = { userId: 1, businessId: 1 };
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Helper: Safe number conversion
const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// Helper: Safe string
const safeString = (value, fallback = '') => {
  return String(value || fallback).replace(/[<>`]/g, '').trim() || fallback;
};

// Helper: Strict JSON parse
const strictJsonParse = (text) => {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (error) {
    return null;
  }
};

// Helper: Call Groq API
async function callGroq(prompt) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const response = await axios.post(
    GROQ_API_URL,
    {
      model: GROQ_MODEL,
      messages: [
        { 
          role: 'system', 
          content: 'You are an expert supply chain and logistics analyst for Philippine food distribution. Respond with STRICT JSON only. No markdown. No explanation.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 1000
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: REQUEST_TIMEOUT_MS
    }
  );

  return response?.data?.choices?.[0]?.message?.content || '';
}

// Deterministic fallback for route optimization
function deterministicRouteFallback(delivery) {
  const totalDistance = safeNumber(delivery.totalDistance || delivery.distance || 50);
  const estimatedDuration = safeNumber(delivery.estimatedDuration || 120);
  const fuelConsumption = safeNumber(delivery.fuelConsumption || 10);
  const carbonEmissions = safeNumber(delivery.carbonEmissions || 25);
  const stopsCount = Array.isArray(delivery.stops) ? delivery.stops.length : 2;
  
  const improvementFactor = Math.min(0.18, 0.12 + (Math.max(0, stopsCount - 2) * 0.01));
  const optimizedDistance = totalDistance * (1 - improvementFactor);
  const optimizedDuration = estimatedDuration * (1 - improvementFactor);
  const optimizedFuel = fuelConsumption * (1 - improvementFactor * 0.9);
  const optimizedEmissions = carbonEmissions * (1 - improvementFactor * 0.85);
  const fuelSaved = fuelConsumption - optimizedFuel;

  return {
    optimizedDistance: parseFloat(optimizedDistance.toFixed(2)),
    optimizedDuration: Math.round(optimizedDuration),
    optimizedFuel: parseFloat(optimizedFuel.toFixed(2)),
    optimizedEmissions: parseFloat(optimizedEmissions.toFixed(2)),
    savings: {
      distance: (totalDistance - optimizedDistance).toFixed(1),
      time: Math.round(estimatedDuration - optimizedDuration).toString(),
      fuel: fuelSaved.toFixed(1),
      emissions: (carbonEmissions - optimizedEmissions).toFixed(1),
      cost: (fuelSaved * 55.5).toFixed(2)
    },
    aiRecommendations: [
      'Reorder stops to minimize backtracking',
      'Avoid known peak-hour congestion windows',
      'Cluster nearby drop points before final dispatch',
      'Review vehicle utilization for current load'
    ],
    usedFallback: true
  };
}

// Deterministic fallback for dashboard insights
function deterministicDashboardFallback(stats) {
  const totalProducts = safeNumber(stats.totalProducts, 0);
  const totalDeliveries = safeNumber(stats.totalDeliveries, 0);
  const totalAlerts = safeNumber(stats.totalAlerts, 0);
  const ecoScore = safeNumber(stats.ecoScore, 0);

  const urgentRecommendations = [];

  if (totalAlerts >= 5) {
    urgentRecommendations.push({
      priority: 'HIGH',
      type: 'SPOILAGE',
      title: 'High active alert volume',
      description: `${totalAlerts} active alerts require prioritization.`,
      estimatedImpact: {
        financial: `PHP ${(totalAlerts * 5000).toLocaleString()}`,
        timeframe: 'Within 24-48 hours'
      },
      actionRequired: 'Prioritize HIGH and MEDIUM risk batches for dispatch.'
    });
  }

  if (ecoScore < 70) {
    urgentRecommendations.push({
      priority: 'MEDIUM',
      type: 'ENERGY',
      title: 'Eco score below target',
      description: `Current eco score is ${ecoScore}/100.`,
      estimatedImpact: {
        financial: 'PHP 8,500 monthly potential savings',
        timeframe: 'This week'
      },
      actionRequired: 'Apply optimized delivery routes consistently.'
    });
  }

  if (totalDeliveries > 0) {
    urgentRecommendations.push({
      priority: 'LOW',
      type: 'ROUTE',
      title: 'Route optimization available',
      description: `${totalDeliveries} active deliveries can be reviewed for optimization.`,
      estimatedImpact: {
        financial: 'PHP 5,200 fuel savings estimate',
        timeframe: 'Next delivery cycle'
      },
      actionRequired: 'Run route optimization before manager approval.'
    });
  }

  return {
    urgentRecommendations,
    todayOverview: {
      keyMetrics: [
        `${totalProducts} products in managed inventory.`,
        `${totalDeliveries} active deliveries in current cycle.`,
        `${totalAlerts} active alerts across all risk levels.`
      ],
      opportunities: [
        'Consolidate nearby stops to reduce fuel consumption.',
        'Move nearing-expiry stock into earlier dispatch windows.'
      ],
      warnings: totalAlerts > 3 ? [`${totalAlerts} alerts require close monitoring.`] : []
    },
    usedFallback: true
  };
}

// ============================================================
// POST /api/ai/optimize-route - Optimize a delivery route
// ============================================================
router.post('/optimize-route', authenticate, async (req, res) => {
  const { deliveryId, totalDistance, estimatedDuration, fuelConsumption, carbonEmissions, stops } = req.body;

  if (!deliveryId) {
    return res.status(400).json({ success: false, message: 'Delivery ID is required' });
  }

  const delivery = {
    deliveryCode: `DEL-${deliveryId}`,
    totalDistance: totalDistance || 50,
    estimatedDuration: estimatedDuration || 120,
    fuelConsumption: fuelConsumption || 10,
    carbonEmissions: carbonEmissions || 25,
    stops: stops || []
  };

  try {
    // Build prompt for route optimization
    const stopsList = Array.isArray(delivery.stops) && delivery.stops.length > 0
      ? delivery.stops.map((stop, index) => `${index + 1}. ${safeString(stop.location || stop.address)}`).join('\n')
      : '1. Origin\n2. Destination';

    const prompt = `You are a route optimization analyst for urban Philippine logistics.

CURRENT DELIVERY:
- Delivery Code: ${delivery.deliveryCode}
- Total Distance: ${delivery.totalDistance} km
- Estimated Duration: ${delivery.estimatedDuration} minutes
- Fuel Consumption: ${delivery.fuelConsumption} liters
- CO2 Emissions: ${delivery.carbonEmissions} kg

STOPS:
${stopsList}

Return STRICT JSON with this exact structure:
{
  "optimizedDistance": 0,
  "optimizedDuration": 0,
  "optimizedFuel": 0,
  "optimizedEmissions": 0,
  "savings": {
    "distance": "0",
    "time": "0",
    "fuel": "0",
    "emissions": "0",
    "cost": "0"
  },
  "aiRecommendations": ["...", "...", "..."]
}`;

    const responseText = await callGroq(prompt);
    const parsed = strictJsonParse(responseText);

    if (!parsed || !parsed.optimizedDistance) {
      // Use deterministic fallback
      const fallback = deterministicRouteFallback(delivery);
      return res.json({
        success: true,
        data: fallback,
        message: 'Optimization completed with fallback (AI service unavailable)'
      });
    }

    const result = {
      optimizedDistance: safeNumber(parsed.optimizedDistance, delivery.totalDistance),
      optimizedDuration: Math.round(safeNumber(parsed.optimizedDuration, delivery.estimatedDuration)),
      optimizedFuel: safeNumber(parsed.optimizedFuel, delivery.fuelConsumption),
      optimizedEmissions: safeNumber(parsed.optimizedEmissions, delivery.carbonEmissions),
      savings: {
        distance: String(safeNumber(parsed.savings?.distance, delivery.totalDistance - safeNumber(parsed.optimizedDistance, delivery.totalDistance)).toFixed(1)),
        time: String(safeNumber(parsed.savings?.time, delivery.estimatedDuration - Math.round(safeNumber(parsed.optimizedDuration, delivery.estimatedDuration)))),
        fuel: String(safeNumber(parsed.savings?.fuel, delivery.fuelConsumption - safeNumber(parsed.optimizedFuel, delivery.fuelConsumption))).toFixed(1),
        emissions: String(safeNumber(parsed.savings?.emissions, delivery.carbonEmissions - safeNumber(parsed.optimizedEmissions, delivery.carbonEmissions))).toFixed(1),
        cost: String(safeNumber(parsed.savings?.cost, (delivery.fuelConsumption - safeNumber(parsed.optimizedFuel, delivery.fuelConsumption)) * 55.5).toFixed(2))
      },
      aiRecommendations: Array.isArray(parsed.aiRecommendations) 
        ? parsed.aiRecommendations.slice(0, 6).map(r => safeString(r))
        : [],
      usedFallback: false
    };

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI Route optimization error:', error.message);
    // Return deterministic fallback on error
    const fallback = deterministicRouteFallback(delivery);
    res.json({
      success: true,
      data: fallback,
      message: 'Optimization completed with fallback: ' + error.message
    });
  }
});

// ============================================================
// POST /api/ai/dashboard-insights - Get AI-powered dashboard insights
// ============================================================
router.post('/dashboard-insights', authenticate, async (req, res) => {
  const { totalProducts, totalDeliveries, totalAlerts, ecoScore } = req.body;

  const stats = {
    totalProducts: totalProducts || 0,
    totalDeliveries: totalDeliveries || 0,
    totalAlerts: totalAlerts || 0,
    ecoScore: ecoScore || 0
  };

  try {
    const prompt = `Analyze these business metrics for a Philippine food distribution company.

CURRENT METRICS:
- Total Products in Inventory: ${stats.totalProducts}
- Active Deliveries This Period: ${stats.totalDeliveries}
- Active Spoilage Alerts: ${stats.totalAlerts}
- Eco Score: ${stats.ecoScore}/100

Return STRICT JSON with this exact structure:
{
  "urgentRecommendations": [
    {
      "priority": "HIGH",
      "type": "SPOILAGE",
      "title": "...",
      "description": "...",
      "estimatedImpact": { "financial": "...", "timeframe": "..." },
      "actionRequired": "..."
    }
  ],
  "todayOverview": {
    "keyMetrics": ["...", "..."],
    "opportunities": ["...", "..."],
    "warnings": ["..."]
  }
}`;

    const responseText = await callGroq(prompt);
    const parsed = strictJsonParse(responseText);

    if (!parsed || !parsed.urgentRecommendations) {
      const fallback = deterministicDashboardFallback(stats);
      return res.json({
        success: true,
        data: fallback,
        message: 'Insights generated with fallback'
      });
    }

    const result = {
      urgentRecommendations: Array.isArray(parsed.urgentRecommendations)
        ? parsed.urgentRecommendations.map(rec => ({
            priority: safeString(rec.priority, 'LOW').toUpperCase(),
            type: safeString(rec.type, 'ROUTE').toUpperCase(),
            title: safeString(rec.title, 'Recommendation'),
            description: safeString(rec.description, ''),
            estimatedImpact: {
              financial: safeString(rec.estimatedImpact?.financial, 'N/A'),
              timeframe: safeString(rec.estimatedImpact?.timeframe, 'N/A')
            },
            actionRequired: safeString(rec.actionRequired, '')
          }))
        : [],
      todayOverview: {
        keyMetrics: Array.isArray(parsed.todayOverview?.keyMetrics)
          ? parsed.todayOverview.keyMetrics.map(m => safeString(m)).filter(Boolean)
          : [],
        opportunities: Array.isArray(parsed.todayOverview?.opportunities)
          ? parsed.todayOverview.opportunities.map(o => safeString(o)).filter(Boolean)
          : [],
        warnings: Array.isArray(parsed.todayOverview?.warnings)
          ? parsed.todayOverview.warnings.map(w => safeString(w)).filter(Boolean)
          : []
      },
      usedFallback: false
    };

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI Dashboard insights error:', error.message);
    const fallback = deterministicDashboardFallback(stats);
    res.json({
      success: true,
      data: fallback,
      message: 'Insights generated with fallback: ' + error.message
    });
  }
});

// ============================================================
// POST /api/ai/inventory-dashboard-insights - Get AI-powered insights for inventory dashboard (aggregated stats)
// ============================================================
router.post('/inventory-dashboard-insights', authenticate, async (req, res) => {
  const { pendingApprovals, approvedToday, declined, highRisk, mediumRisk, lowRisk } = req.body;

  const stats = {
    pendingApprovals: safeNumber(pendingApprovals, 0),
    approvedToday: safeNumber(approvedToday, 0),
    declined: safeNumber(declined, 0),
    highRisk: safeNumber(highRisk, 0),
    mediumRisk: safeNumber(mediumRisk, 0),
    lowRisk: safeNumber(lowRisk, 0)
  };

  function deterministicDashboardInsightsFallback(stats) {
    const urgentRecommendations = [];
    const totalRisk = stats.highRisk + stats.mediumRisk + stats.lowRisk;
    
    if (stats.highRisk > 0) {
      urgentRecommendations.push({
        priority: 'HIGH',
        type: 'SPOILAGE',
        title: `${stats.highRisk} high-risk batch${stats.highRisk > 1 ? 'es' : ''} require immediate attention`,
        description: `${stats.highRisk} inventory batch${stats.highRisk > 1 ? 'es' : ''} flagged as high risk need urgent approval decision.`,
        estimatedImpact: {
          financial: `PHP ${(stats.highRisk * 15000).toLocaleString()} potential loss prevention`,
          timeframe: 'Within 24 hours'
        },
        actionRequired: 'Review and prioritize high-risk inventory batches for immediate dispatch or discount.'
      });
    }

    if (stats.mediumRisk > 0) {
      urgentRecommendations.push({
        priority: 'MEDIUM',
        type: 'INVENTORY',
        title: `${stats.mediumRisk} medium-risk batch${stats.mediumRisk > 1 ? 'es' : ''} need attention`,
        description: `${stats.mediumRisk} inventory batch${stats.mediumRisk > 1 ? 'es' : ''} require monitoring within the next few days.`,
        estimatedImpact: {
          financial: `PHP ${(stats.mediumRisk * 8000).toLocaleString()} potential savings`,
          timeframe: 'Within 3-5 days'
        },
        actionRequired: 'Schedule dispatch for medium-risk inventory within the week.'
      });
    }

    if (stats.pendingApprovals > 5) {
      urgentRecommendations.push({
        priority: stats.highRisk > 0 ? 'HIGH' : 'MEDIUM',
        type: 'APPROVAL',
        title: `${stats.pendingApprovals} pending approval${stats.pendingApprovals > 1 ? 's' : ''} backlog`,
        description: `${stats.pendingApprovals} inventory items await manager approval, creating potential delivery delays.`,
        estimatedImpact: {
          financial: `PHP ${(stats.pendingApprovals * 5000).toLocaleString()} in delayed sales`,
          timeframe: 'Immediate action needed'
        },
        actionRequired: 'Clear pending approvals to maintain delivery schedule.'
      });
    }

    if (urgentRecommendations.length === 0) {
      urgentRecommendations.push({
        priority: 'LOW',
        type: 'OPTIMIZATION',
        title: 'Inventory operations running smoothly',
        description: 'All inventory metrics are within acceptable ranges.',
        estimatedImpact: {
          financial: 'Continue current practices',
          timeframe: 'Ongoing'
        },
        actionRequired: 'Maintain standard monitoring and quality checks.'
      });
    }

    const warnings = [];
    if (stats.highRisk > 0) warnings.push(`${stats.highRisk} high-risk batches need immediate action`);
    if (stats.pendingApprovals > 5) warnings.push(`${stats.pendingApprovals} items pending approval`);
    if (stats.declined > stats.approvedToday) warnings.push('Declined items exceed approvals today');

    return {
      urgentRecommendations,
      todayOverview: {
        keyMetrics: [
          `${stats.pendingApprovals} items pending approval`,
          `${stats.approvedToday} approved today`,
          `${stats.declined} declined today`,
          `${totalRisk} total risk-flagged items (${stats.highRisk} high, ${stats.mediumRisk} medium, ${stats.lowRisk} low)`
        ],
        opportunities: [
          'Process high-risk items first to minimize spoilage',
          'Bundle medium-risk items with high-priority deliveries',
          'Review declined items for process improvement'
        ],
        warnings: warnings.length > 0 ? warnings : ['All systems normal']
      }
    };
  }

  try {
    const prompt = `Analyze this inventory dashboard data for a Philippine food distribution company.

CURRENT INVENTORY STATUS:
- Pending Approvals: ${stats.pendingApprovals}
- Approved Today: ${stats.approvedToday}
- Declined Today: ${stats.declined}
- High Risk Items: ${stats.highRisk}
- Medium Risk Items: ${stats.mediumRisk}
- Low Risk Items: ${stats.lowRisk}

Return STRICT JSON with this exact structure:
{
  "urgentRecommendations": [
    {
      "priority": "HIGH|MEDIUM|LOW",
      "type": "SPOILAGE|INVENTORY|APPROVAL|OPTIMIZATION",
      "title": "...",
      "description": "...",
      "estimatedImpact": { "financial": "...", "timeframe": "..." },
      "actionRequired": "..."
    }
  ],
  "todayOverview": {
    "keyMetrics": ["...", "..."],
    "opportunities": ["...", "..."],
    "warnings": ["..."]
  }
}`;

    const responseText = await callGroq(prompt);
    const parsed = strictJsonParse(responseText);

    if (!parsed || !parsed.urgentRecommendations) {
      const fallback = deterministicDashboardInsightsFallback(stats);
      return res.json({
        success: true,
        ...fallback,
        message: 'Insights generated with fallback'
      });
    }

    const result = {
      urgentRecommendations: Array.isArray(parsed.urgentRecommendations)
        ? parsed.urgentRecommendations.slice(0, 5).map(rec => ({
            priority: safeString(rec.priority, 'LOW').toUpperCase(),
            type: safeString(rec.type, 'OPTIMIZATION').toUpperCase(),
            title: safeString(rec.title, 'Recommendation'),
            description: safeString(rec.description, ''),
            estimatedImpact: {
              financial: safeString(rec.estimatedImpact?.financial, 'N/A'),
              timeframe: safeString(rec.estimatedImpact?.timeframe, 'N/A')
            },
            actionRequired: safeString(rec.actionRequired, '')
          }))
        : [],
      todayOverview: {
        keyMetrics: Array.isArray(parsed.todayOverview?.keyMetrics)
          ? parsed.todayOverview.keyMetrics.map(m => safeString(m)).filter(Boolean)
          : [],
        opportunities: Array.isArray(parsed.todayOverview?.opportunities)
          ? parsed.todayOverview.opportunities.map(o => safeString(o)).filter(Boolean)
          : [],
        warnings: Array.isArray(parsed.todayOverview?.warnings)
          ? parsed.todayOverview.warnings.map(w => safeString(w)).filter(Boolean)
          : []
      }
    };

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('AI Inventory dashboard insights error:', error.message);
    const fallback = deterministicDashboardInsightsFallback(stats);
    res.json({
      success: true,
      ...fallback,
      message: 'Insights generated with fallback: ' + error.message
    });
  }
});

// ============================================================
// POST /api/ai/inventory-insights - Get AI-powered inventory/alert insights
// ============================================================
router.post('/inventory-insights', authenticate, async (req, res) => {
  const { productName, riskLevel, daysLeft, temperature, humidity, location, quantity, value } = req.body;

  const alertData = {
    product_name: productName || 'Unknown',
    risk_level: riskLevel || 'LOW',
    days_left: daysLeft || 0,
    temperature: temperature || 0,
    humidity: humidity || 0,
    location: location || 'Unknown',
    quantity: quantity || 0,
    value: value || 0
  };

  function deterministicAlertFallback(alertData) {
    const days = safeNumber(alertData.days_left, 0);
    const risk = safeString(alertData.risk_level, 'LOW').toUpperCase();
    const val = safeNumber(alertData.value, 0);
    const temp = safeNumber(alertData.temperature, 0);
    const hum = safeNumber(alertData.humidity, 0);

    if (risk === 'HIGH') {
      return {
        recommendations: [
          `Prioritize immediate dispatch; ${days} day(s) left before expiry.`,
          'Apply limited-time discount to reduce spoilage exposure.',
          'Move high-risk stock to first stop in next delivery cycle.',
          `Verify storage controls at ${temp}C and ${hum}% humidity.`
        ],
        priority_actions: [
          'Immediate: Dispatch within 24 hours.',
          'Short-term: Contact top buyers for quick volume uptake.',
          'Medium-term: Reduce storage dwell time for this SKU.'
        ],
        cost_impact: (val * 0.8).toFixed(2)
      };
    }

    if (risk === 'MEDIUM') {
      return {
        recommendations: [
          `Schedule dispatch within 2-4 days; ${days} day(s) remaining.`,
          'Bundle with fast-moving inventory for turnover.',
          `Track storage consistency at ${temp}C and ${hum}% humidity.`,
          'Prioritize in upcoming route plans.'
        ],
        priority_actions: [
          'Immediate: Queue for next outbound batch.',
          'Short-term: Recheck quality status daily.',
          'Medium-term: Tune reorder levels for this item.'
        ],
        cost_impact: (val * 0.5).toFixed(2)
      };
    }

    return {
      recommendations: [
        `Maintain regular handling; ${days} day(s) remaining.`,
        'Continue routine quality checks.',
        'Keep standard distribution sequence.',
        'Monitor trend changes in shelf-life usage.'
      ],
      priority_actions: [
        'Immediate: Continue standard monitoring.',
        'Short-term: Keep FIFO allocation.',
        'Medium-term: Review weekly spoilage metrics.'
      ],
      cost_impact: (val * 0.1).toFixed(2)
    };
  }

  try {
    const prompt = `Analyze this spoilage alert for a Philippine food distribution business.

ALERT DATA:
- Product: ${alertData.product_name}
- Risk Level: ${alertData.risk_level}
- Days Left Until Expiry: ${alertData.days_left}
- Temperature: ${alertData.temperature}C
- Humidity: ${alertData.humidity}%
- Location: ${alertData.location}
- Quantity: ${alertData.quantity}
- Estimated Value: PHP ${alertData.value}

Return STRICT JSON with this exact structure:
{
  "recommendations": ["...", "...", "..."],
  "priority_actions": ["...", "...", "..."],
  "cost_impact": "0.00"
}`;

    const responseText = await callGroq(prompt);
    const parsed = strictJsonParse(responseText);

    if (!parsed || !parsed.recommendations) {
      const fallback = deterministicAlertFallback(alertData);
      return res.json({
        success: true,
        data: {
          recommendations: fallback.recommendations,
          priority_actions: fallback.priority_actions,
          cost_impact: fallback.cost_impact
        },
        message: 'Insights generated with fallback'
      });
    }

    const result = {
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 5).map(r => safeString(r)).filter(Boolean)
        : [],
      priority_actions: Array.isArray(parsed.priority_actions)
        ? parsed.priority_actions.slice(0, 5).map(a => safeString(a)).filter(Boolean)
        : [],
      cost_impact: safeString(parsed.cost_impact, '0.00')
    };

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI Inventory insights error:', error.message);
    const fallback = deterministicAlertFallback(alertData);
    res.json({
      success: true,
      data: {
        recommendations: fallback.recommendations,
        priority_actions: fallback.priority_actions,
        cost_impact: fallback.cost_impact
      },
      message: 'Insights generated with fallback: ' + error.message
    });
  }
});

// ============================================================
// Health check endpoint
// ============================================================
router.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'AI service is running',
    model: GROQ_MODEL,
    groqConfigured: !!process.env.GROQ_API_KEY
  });
});

module.exports = router;

