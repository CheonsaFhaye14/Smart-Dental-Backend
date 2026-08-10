const express = require('express');
const router = express.Router();
const supabase = require('../supabase'); // Service role

// Middleware to check admin from JWT
const checkAdmin = require('../middleware/checkAdmin');

const VALID_CATEGORIES = ['allergy', 'condition']; // ⚠️ must match medical_reference_category enum

// GET /medical-reference?category=allergy - Get reference items (admin only)
router.get('/', checkAdmin, async (req, res) => {
  try {
    const category = (req.query.category || '').trim().toLowerCase();

    let query = supabase
      .from('medical_reference_items')
      .select('id, category, label, created_at')
      .eq('is_deleted', false)
      .order('label', { ascending: true });

    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      query = query.eq('category', category);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({ data });
  } catch (err) {
    console.error('Error in GET /medical-reference:', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /medical-reference - Add a new reference item (admin only)
router.post('/', checkAdmin, async (req, res) => {
  let { category, label } = req.body;

  category = String(category || '').trim().toLowerCase();
  label = String(label || '').trim();

  if (!category || !label) {
    return res.status(400).json({ message: 'Category and label are required' });
  }

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  try {
    // Upsert so a duplicate add from another admin, or re-adding a
    // previously soft-deleted item, doesn't error out.
    const { data: item, error: upsertError } = await supabase
      .from('medical_reference_items')
      .upsert(
        {
          category,
          label,
          is_deleted: false,
          deleted_at: null,
          updated_at: new Date(),
        },
        { onConflict: 'category,label' }
      )
      .select()
      .single();

    if (upsertError) throw upsertError;

    // Activity log (non-fatal)
    const { error: logError } = await supabase
      .from('activity_logs')
      .insert([{
        admin_id: req.user.id,
        action: 'add_medical_reference_item',
        table_name: 'medical_reference_items',
        record_id: item.id,
        description: `Admin added ${category} option: "${label}"`,
      }]);

    if (logError && process.env.NODE_ENV !== 'production') {
      console.error('Activity log insert failed:', logError.message);
    }

    return res.status(201).json({ message: 'Item added successfully', data: item });
  } catch (err) {
    console.error('Error in POST /medical-reference:', err.message);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE /medical-reference/:id - Soft delete a reference item (admin only)
router.delete('/:id', checkAdmin, async (req, res) => {
  const itemId = req.params.id;

  try {
    const { data: existingItem, error: fetchError } = await supabase
      .from('medical_reference_items')
      .select('*')
      .eq('id', itemId)
      .eq('is_deleted', false)
      .single();

    if (fetchError || !existingItem) {
      return res.status(404).json({ message: 'Item not found or already deleted' });
    }

    const { data: deletedItem, error: deleteError } = await supabase
      .from('medical_reference_items')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .select()
      .single();

    if (deleteError) throw deleteError;

    const { error: logError } = await supabase
      .from('activity_logs')
      .insert([{
        admin_id: req.user.id,
        action: 'delete_medical_reference_item',
        table_name: 'medical_reference_items',
        record_id: itemId,
        description: `Admin removed ${existingItem.category} option: "${existingItem.label}"`,
      }]);

    if (logError) console.error('Activity log error:', logError);

    return res.status(200).json({ message: 'Item deleted successfully', data: deletedItem });
  } catch (err) {
    console.error('Error deleting medical reference item:', err.message);
    return res.status(500).json({ message: 'Error deleting item', error: err.message });
  }
});

module.exports = router;