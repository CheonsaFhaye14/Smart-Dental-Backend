import express from 'express';
import { body, validationResult } from 'express-validator';
const router = express.Router();
const supabase = require('../supabase');

// ------------------ MIDDLEWARE TO CHECK ADMIN ------------------
const checkAdmin = async (req, res, next) => {
  const { usertype } = req.body; // ideally from JWT
  if (usertype !== 'admin') return res.status(403).json({ message: "Admins only" });
  next();
};

// ------------------ SERVICES ------------------

// Add Service
router.post('/services', checkAdmin, [
  body('name').notEmpty().withMessage('Name is required'),
  body('price').isNumeric().withMessage('Price must be a number')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, description, price, allow_installment, installment_times, installment_interval } = req.body;

  try {
    const { data, error } = await supabase.from('services').insert([{
      name,
      description,
      price,
      allow_installment: allow_installment || false,
      installment_times: installment_times || 0,
      installment_interval: installment_interval || 'monthly',
      created_at: new Date(),
      updated_at: new Date()
    }]).select('*').single();

    if (error) return res.status(400).json({ message: error.message });
    res.status(201).json({ message: 'Service added', service: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Edit Service
router.put('/services/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;
  const updates = { ...req.body, updated_at: new Date() };

  try {
    const { data, error } = await supabase.from('services')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ message: error.message });
    res.json({ message: 'Service updated', service: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Soft Delete Service
router.delete('/services/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase.from('services')
      .update({ is_deleted: true, deleted_at: new Date() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ message: error.message });
    res.json({ message: 'Service soft deleted', service: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Fetch Services (only non-deleted)
router.get('/services', async (req, res) => {
  try {
    const { data, error } = await supabase.from('services')
      .select('*')
      .eq('is_deleted', false);

    if (error) return res.status(400).json({ message: error.message });
    res.json({ services: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ------------------ SERVICE CATEGORIES ------------------

// Add Category
router.post('/categories', checkAdmin, [
  body('name').notEmpty().withMessage('Name is required')
], async (req, res) => {
  const { name } = req.body;

  try {
    const { data, error } = await supabase.from('service_categories').insert([{ name }]).select('*').single();
    if (error) return res.status(400).json({ message: error.message });
    res.status(201).json({ message: 'Category added', category: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Edit Category
router.put('/categories/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;
  const updates = { ...req.body, updated_at: new Date() };

  try {
    const { data, error } = await supabase.from('service_categories')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ message: error.message });
    res.json({ message: 'Category updated', category: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Soft Delete Category
router.delete('/categories/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase.from('service_categories')
      .update({ is_deleted: true, deleted_at: new Date() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ message: error.message });
    res.json({ message: 'Category soft deleted', category: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Fetch Categories (only non-deleted)
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await supabase.from('service_categories')
      .select('*')
      .eq('is_deleted', false);

    if (error) return res.status(400).json({ message: error.message });
    res.json({ categories: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;
