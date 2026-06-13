const SystemSettings = require('../models/SystemSettings');
const db = require('../config/db');

// GET /api/system/settings
const getSystemSettings = async (req, res, next) => {
  try {
    const settings = await SystemSettings.getAll();
    return res.status(200).json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
};

// PUT /api/system/settings
const updateSystemSettings = async (req, res, next) => {
  try {
    const { settings } = req.body; // Array of { key, value }
    if (!settings || !Array.isArray(settings)) {
      return res.status(400).json({ success: false, message: 'Settings array is required.' });
    }

    const updated = [];
    for (const { key, value } of settings) {
      if (key && value !== undefined) {
        const result = await SystemSettings.set(key, value, req.user.id);
        updated.push(result);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${updated.length} setting(s) updated.`,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/system/health
const getSystemHealth = async (req, res, next) => {
  try {
    // Database check
    const dbResult = await db.query('SELECT NOW() AS server_time, current_database() AS database');
    const dbInfo = dbResult.rows[0];

    // User count
    const userResult = await db.query('SELECT COUNT(*) AS count FROM users');

    // Table sizes
    const tableResult = await db.query(`
      SELECT tablename, pg_size_pretty(pg_total_relation_size(quote_ident(tablename))) AS size
      FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);

    return res.status(200).json({
      success: true,
      data: {
        status: 'healthy',
        serverTime: dbInfo.server_time,
        database: dbInfo.database,
        totalUsers: parseInt(userResult.rows[0].count),
        tables: tableResult.rows,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getSystemSettings, updateSystemSettings, getSystemHealth };
