const db = require('../config/db');

const Profile = {
  /**
   * Get the full profile for a user (joins users, user_profiles, privacy_settings).
   */
  async findByUserId(userId) {
    const result = await db.query(
      `SELECT
         u.id, u.full_name, u.email, u.contact_number, u.is_verified,
         p.gender, p.date_of_birth, p.civil_status, p.address,
         p.medical_history, p.current_medications, p.previous_treatments,
         ps.show_contact_number, ps.show_date_of_birth, ps.show_address,
         ps.show_medical_history, ps.show_current_medications, ps.show_previous_treatments,
         u.created_at, p.updated_at AS profile_updated_at
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       LEFT JOIN privacy_settings ps ON ps.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Upsert user_profiles row.
   */
  async upsert(userId, data) {
    const {
      gender = null,
      date_of_birth = null,
      civil_status = null,
      address = null,
      medical_history = null,
      current_medications = null,
      previous_treatments = null,
    } = data;

    const result = await db.query(
      `INSERT INTO user_profiles
         (user_id, gender, date_of_birth, civil_status, address,
          medical_history, current_medications, previous_treatments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         gender              = COALESCE(EXCLUDED.gender, user_profiles.gender),
         date_of_birth       = COALESCE(EXCLUDED.date_of_birth, user_profiles.date_of_birth),
         civil_status        = COALESCE(EXCLUDED.civil_status, user_profiles.civil_status),
         address             = COALESCE(EXCLUDED.address, user_profiles.address),
         medical_history     = COALESCE(EXCLUDED.medical_history, user_profiles.medical_history),
         current_medications = COALESCE(EXCLUDED.current_medications, user_profiles.current_medications),
         previous_treatments = COALESCE(EXCLUDED.previous_treatments, user_profiles.previous_treatments),
         updated_at          = NOW()
       RETURNING *`,
      [userId, gender, date_of_birth, civil_status, address,
       medical_history, current_medications, previous_treatments]
    );
    return result.rows[0];
  },

  /**
   * Delete profile row for a user.
   */
  async deleteByUserId(userId) {
    await db.query('DELETE FROM user_profiles WHERE user_id = $1', [userId]);
  },
};

const PrivacySettings = {
  /**
   * Upsert privacy settings for a user.
   */
  async upsert(userId, settings) {
    const {
      show_contact_number = false,
      show_date_of_birth = false,
      show_address = false,
      show_medical_history = false,
      show_current_medications = false,
      show_previous_treatments = false,
    } = settings;

    const result = await db.query(
      `INSERT INTO privacy_settings
         (user_id, show_contact_number, show_date_of_birth, show_address,
          show_medical_history, show_current_medications, show_previous_treatments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         show_contact_number      = EXCLUDED.show_contact_number,
         show_date_of_birth       = EXCLUDED.show_date_of_birth,
         show_address             = EXCLUDED.show_address,
         show_medical_history     = EXCLUDED.show_medical_history,
         show_current_medications = EXCLUDED.show_current_medications,
         show_previous_treatments = EXCLUDED.show_previous_treatments,
         updated_at               = NOW()
       RETURNING *`,
      [userId, show_contact_number, show_date_of_birth, show_address,
       show_medical_history, show_current_medications, show_previous_treatments]
    );
    return result.rows[0];
  },

  /**
   * Delete privacy settings for a user.
   */
  async deleteByUserId(userId) {
    await db.query('DELETE FROM privacy_settings WHERE user_id = $1', [userId]);
  },
};

module.exports = { Profile, PrivacySettings };
