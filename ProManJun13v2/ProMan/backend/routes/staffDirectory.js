const express = require('express');
const router = express.Router();
const { getAssignableStaff } = require('../controllers/staffController');

// Public, read-only directory of assignable clinical staff. Used by the intake
// form's counselor/therapist picker (filled in by clients before authentication)
// and any other client-facing selector. Returns only non-sensitive fields.
router.get('/assignable', getAssignableStaff);

module.exports = router;
