const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  createPayment, uploadProof, getPayments, getPayment, getPaymentCounts, verifyPayment, updatePaymentOption,
} = require('../controllers/paymentController');

router.use(authenticate);

// Literal paths first
router.get('/counts', authorizeMinRole('psychometrician'), getPaymentCounts);

// Client creates a payment + uploads proof
router.post('/',           createPayment);
router.post('/:id/proof',  uploadProof);
router.put('/:id/option',  updatePaymentOption);

// Listing & detail (clients see own, staff see all)
router.get('/',     getPayments);
router.get('/:id',  getPayment);

// Staff-only verification
router.put('/:id/verify', authorizeMinRole('psychometrician'), verifyPayment);

module.exports = router;
