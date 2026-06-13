const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { updateProfileRules } = require('../middleware/profileValidate');
const { handleValidation } = require('../middleware/validate');
const { getProfile, verifyPassword, updateProfile, deleteProfile, changePassword } = require('../controllers/profileController');

// All profile routes require authentication
router.use(authenticate);

// GET /api/profile — Fetch current user's profile
router.get('/', getProfile);

// POST /api/profile/verify-password — Verify user's password
router.post('/verify-password', verifyPassword);

// POST /api/profile/change-password — Send password reset email
router.post('/change-password', changePassword);

// PUT /api/profile — Update current user's profile
router.put('/', updateProfileRules, handleValidation, updateProfile);

// DELETE /api/profile — Delete current user's account (requires password in body)
router.delete('/', deleteProfile);

// DELETE /api/profile/my-data — Right to be forgotten: anonymize all community content
router.delete('/my-data', async (req, res, next) => {
  try {
    const privacyService = require('../services/privacyService');
    const counts = await privacyService.deleteAllUserContent(req.user.id, req.user.id);
    return res.json({
      success: true,
      message: 'All your community content has been anonymized.',
      data: counts,
    });
  } catch (error) { next(error); }
});

module.exports = router;

