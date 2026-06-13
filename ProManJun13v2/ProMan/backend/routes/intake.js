const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  submitIntakeForm,
  checkoutIntake,
  abandonCheckout,
  notifyPaymentPending,
  getIntakeForms,
  getIntakeForm,
} = require('../controllers/intakeController');

router.use(authenticate);

// Client submits intake form
router.post('/',            submitIntakeForm);
router.post('/checkout',     checkoutIntake);
router.delete('/checkout/:paymentId', abandonCheckout);
router.post('/notify-payment', notifyPaymentPending);

// List intake forms (clients see own, staff see all)
router.get('/',             getIntakeForms);

// Get single intake form
router.get('/:id',          getIntakeForm);


module.exports = router;
