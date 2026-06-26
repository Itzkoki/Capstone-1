const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  reportContent, getPendingFlags, getStats, getRecent, reviewFlag,
  getKeywords, addKeyword, removeKeyword, testFilter, seedKeywords,
} = require('../controllers/moderationController');

router.use(authenticate);

// Any authenticated user can report content
router.post('/flags', reportContent);

// Staff-only routes
router.get('/flags',      authorizeMinRole('psychometrician'), getPendingFlags);
router.get('/stats',      authorizeMinRole('psychometrician'), getStats);
router.get('/recent',     authorizeMinRole('psychometrician'), getRecent);
router.put('/flags/:id',  authorizeMinRole('psychometrician'), reviewFlag);

// Keyword management (staff-only)
router.get('/keywords',         authorizeMinRole('psychometrician'), getKeywords);
router.post('/keywords',        authorizeMinRole('psychometrician'), addKeyword);
router.delete('/keywords/:id',  authorizeMinRole('psychometrician'), removeKeyword);
router.post('/keywords/test',   authorizeMinRole('psychometrician'), testFilter);
router.post('/keywords/seed',   authorizeMinRole('psychometrician'), seedKeywords);

module.exports = router;
