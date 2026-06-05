const FAQ = require('../models/FAQ');

// GET /api/faqs — list published FAQs (optional ?category= filter)
const getAllFaqs = async (req, res, next) => {
  try {
    const { category, limit = 50, offset = 0 } = req.query;
    const faqs = await FAQ.findAll(category || null, parseInt(limit), parseInt(offset));
    return res.json({ success: true, data: faqs });
  } catch (error) { next(error); }
};

// GET /api/faqs/categories — list distinct categories
const getCategories = async (req, res, next) => {
  try {
    const categories = await FAQ.getCategories();
    return res.json({ success: true, data: categories });
  } catch (error) { next(error); }
};

// GET /api/faqs/:id
const getFaq = async (req, res, next) => {
  try {
    const faq = await FAQ.findById(req.params.id);
    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found.' });
    return res.json({ success: true, data: faq });
  } catch (error) { next(error); }
};

// POST /api/faqs — staff only
const createFaq = async (req, res, next) => {
  try {
    const { question, answer, category } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ success: false, message: 'Question and answer are required.' });
    }
    const faq = await FAQ.create(question, answer, category, req.user.id);
    return res.status(201).json({ success: true, data: faq });
  } catch (error) { next(error); }
};

// PUT /api/faqs/:id — staff only
const updateFaq = async (req, res, next) => {
  try {
    const existing = await FAQ.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'FAQ not found.' });

    const faq = await FAQ.update(req.params.id, req.body);
    return res.json({ success: true, data: faq });
  } catch (error) { next(error); }
};

// DELETE /api/faqs/:id — staff only
const deleteFaq = async (req, res, next) => {
  try {
    const existing = await FAQ.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'FAQ not found.' });

    await FAQ.deleteById(req.params.id);
    return res.json({ success: true, message: 'FAQ deleted.' });
  } catch (error) { next(error); }
};

module.exports = { getAllFaqs, getCategories, getFaq, createFaq, updateFaq, deleteFaq };
