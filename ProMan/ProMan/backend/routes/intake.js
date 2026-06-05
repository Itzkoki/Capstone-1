const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  submitIntakeForm,
  getIntakeForms,
  getIntakeForm,
  updateIntakeStatus,
} = require('../controllers/intakeController');

router.use(authenticate);

// Client submits intake form
router.post('/',            submitIntakeForm);

// List intake forms (clients see own, staff see all)
router.get('/',             getIntakeForms);

// Get single intake form
router.get('/:id',          getIntakeForm);

// Staff-only: update status
router.put('/:id/status',   updateIntakeStatus);

module.exports = router;
