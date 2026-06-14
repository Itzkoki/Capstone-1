const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  submitAssessmentIntake,
  getAssessmentIntakeForms,
  getAssessmentIntakeForm,
} = require('../controllers/assessmentIntakeController');

router.use(authenticate);

// Client submits assessment intake form (staged for review, like counseling)
router.post('/', submitAssessmentIntake);

// List assessment intake forms (clients see own, staff see all)
router.get('/', getAssessmentIntakeForms);

// Get a single assessment intake form
router.get('/:id', getAssessmentIntakeForm);

module.exports = router;
