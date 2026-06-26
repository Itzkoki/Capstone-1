const db = require('../config/db');

/**
 * PsychologistAvailability model — scheduling validation.
 */
const PsychologistAvailability = {
  async getByPsychologistId(psychologistId) {
    const result = await db.query(
      `SELECT * FROM psychologist_availability
       WHERE psychologist_id = $1 AND is_available = TRUE
         AND effective_from <= CURRENT_DATE
         AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
       ORDER BY day_of_week, start_time`,
      [psychologistId]
    );
    return result.rows;
  },

  async isAvailable(psychologistId, dateTime) {
    const dt = new Date(dateTime);
    const dayOfWeek = dt.getDay(); // 0=Sun, 6=Sat
    const timeStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:00`;
    const dateStr = dt.toISOString().split('T')[0];

    const result = await db.query(
      `SELECT 1 FROM psychologist_availability
       WHERE psychologist_id = $1
         AND day_of_week = $2
         AND start_time <= $3::time AND end_time > $3::time
         AND is_available = TRUE
         AND effective_from <= $4::date
         AND (effective_until IS NULL OR effective_until >= $4::date)
       LIMIT 1`,
      [psychologistId, dayOfWeek, timeStr, dateStr]
    );
    return result.rows.length > 0;
  },

  async setAvailability({ psychologistId, dayOfWeek, startTime, endTime, effectiveFrom, effectiveUntil }) {
    // Upsert: if same psychologist + day + time exists, update it
    const existing = await db.query(
      `SELECT availability_id FROM psychologist_availability
       WHERE psychologist_id = $1 AND day_of_week = $2 AND start_time = $3 AND end_time = $4`,
      [psychologistId, dayOfWeek, startTime, endTime]
    );
    if (existing.rows.length > 0) {
      const result = await db.query(
        `UPDATE psychologist_availability
         SET is_available = TRUE, effective_from = $1, effective_until = $2
         WHERE availability_id = $3
         RETURNING *`,
        [effectiveFrom || new Date(), effectiveUntil || null, existing.rows[0].availability_id]
      );
      return result.rows[0];
    }
    const result = await db.query(
      `INSERT INTO psychologist_availability (psychologist_id, day_of_week, start_time, end_time, effective_from, effective_until)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [psychologistId, dayOfWeek, startTime, endTime, effectiveFrom || new Date(), effectiveUntil || null]
    );
    return result.rows[0];
  },

  async removeAvailability(availabilityId) {
    await db.query(
      `UPDATE psychologist_availability SET is_available = FALSE WHERE availability_id = $1`,
      [availabilityId]
    );
  },
};

module.exports = PsychologistAvailability;
