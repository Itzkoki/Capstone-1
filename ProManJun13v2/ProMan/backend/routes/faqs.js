const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  getAllFaqs, getCategories, getFaq,
  createFaq, updateFaq, deleteFaq,
} = require('../controllers/faqController');

router.use(authenticate);

// Public (authenticated) routes
router.get('/',           getAllFaqs);
router.get('/categories', getCategories);
router.get('/:id',        getFaq);

// Staff-only routes
router.post('/',          authorizeMinRole('psychologist'), createFaq);
router.put('/:id',        authorizeMinRole('psychologist'), updateFaq);
router.delete('/:id',     authorizeMinRole('psychologist'), deleteFaq);

module.exports = router;
