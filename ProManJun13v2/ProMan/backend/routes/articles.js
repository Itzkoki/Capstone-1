const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  createArticle, getAllArticles, getArticle, updateArticle, deleteArticle,
  approveArticle, rejectArticle, getPendingArticles,
  importPreview, importPublish,
} = require('../controllers/articleController');

router.use(authenticate);

// Import routes (staff-only, must be before /:id)
router.post('/import/preview',  authorizeMinRole('psychometrician'), importPreview);
router.post('/import/publish',  authorizeMinRole('psychometrician'), importPublish);

// Pending queue (must be before /:id)
router.get('/pending',        getPendingArticles);

// Standard CRUD
router.post('/',              createArticle);
router.get('/',               getAllArticles);
router.get('/:id',            getArticle);
router.put('/:id',            updateArticle);
router.put('/:id/approve',    approveArticle);
router.put('/:id/reject',     rejectArticle);
router.delete('/:id',         deleteArticle);

module.exports = router;
