const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const supabase = require('../supabase');
const checkAdmin = require('../middleware/checkAdmin');

// GET /services/grouped - Get services grouped by category (admin only)
router.get('/grouped', checkAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const includeInactive = req.query.includeInactive === 'true';

    let categoryQuery = supabase
      .from('service_categories')
      .select('*')
      .eq('is_deleted', false)
      .order('name', { ascending: true });

    let serviceQuery = supabase
      .from('services')
      .select('*')
      .eq('is_deleted', false);

    if (!includeInactive) {
      serviceQuery = serviceQuery.eq('is_active', true);
    }

    if (search) {
      serviceQuery = serviceQuery.ilike('name', `%${search}%`);
    }

    const [
      { data: categories, error: catError },
      { data: services, error: servError },
      { data: links, error: linkError }
    ] = await Promise.all([
      categoryQuery,
      serviceQuery,
      supabase.from('service_category_links').select('*').eq('is_deleted', false)
    ]);

    if (catError) throw catError;
    if (servError) throw servError;
    if (linkError) throw linkError;

    // Map categoryId -> category object (preserve order from categories array)
    const categoryMap = Object.fromEntries(
      categories.map(cat => [cat.id, { id: cat.id, name: cat.name, services: [] }])
    );

    // "No Category" bucket for services with no links
    const noCategory = { id: null, name: 'No Category', services: [] };

    // Assign each service to every category it's linked to (services can belong to multiple)
    services.forEach(serv => {
      const serviceLinks = links.filter(l => l.service_id === serv.id);

      if (serviceLinks.length === 0) {
        noCategory.services.push(serv);
        return;
      }

      serviceLinks.forEach(link => {
        const categoryObj = categoryMap[link.category_id];
        if (categoryObj) categoryObj.services.push(serv);
      });
    });

    // Sort services inside each category
    const sortByName = (a, b) =>
      (a.name || '').toString().trim().toLowerCase().localeCompare((b.name || '').toString().trim().toLowerCase());

    Object.values(categoryMap).forEach(cat => cat.services.sort(sortByName));
    noCategory.services.sort(sortByName);

    // Build sorted category array
    let groupedArray = Object.values(categoryMap).sort((a, b) =>
      a.name.toString().trim().toLowerCase().localeCompare(b.name.toString().trim().toLowerCase())
    );

    // Put "No Category" at the end if it has services
    if (noCategory.services.length > 0) groupedArray.push(noCategory);

    res.json({ data: groupedArray });
  } catch (err) {
    console.error('Error in /grouped route:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});


// POST create category (optionally with services)
router.post(
  '/categories',
  checkAdmin,
  body('name').notEmpty().withMessage('Category name is required'),
  body('services').optional().custom(val => {
    if (!Array.isArray(val) && typeof val !== 'number') {
      throw new Error('Services must be an array of IDs or a single ID');
    }
    return true;
  }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, services } = req.body;
      const adminId = req.user?.id; // ✅ admin ID from middleware

      // ✅ UNIQUE NAME CHECK (case-insensitive)
      const { data: existingCategory } = await supabase
        .from('service_categories')
        .select('id')
        .ilike('name', name)
        .maybeSingle();

      if (existingCategory) {
        return res.status(400).json({ message: "Category name must be unique" });
      }

      // ✅ Insert category
      const { data: newCategory, error: catError } = await supabase
        .from('service_categories')
        .insert({ name })
        .select()
        .single();

      if (catError) {
        return res.status(400).json({ message: catError.message });
      }

      // ✅ Handle service linking
      let servicesArray = [];
      if (typeof services === 'number') servicesArray = [services];
      else if (Array.isArray(services)) servicesArray = services;

      if (servicesArray.length > 0) {
        const linksToInsert = servicesArray.map(service_id => ({
          service_id,
          category_id: newCategory.id
        }));

        const { error: linkError } = await supabase
          .from('service_category_links')
          .insert(linksToInsert);

        if (linkError) {
          return res.status(400).json({ message: linkError.message });
        }
      }

      // ✅ Activity Log
      await supabase.from('activity_logs').insert({
        admin_id: adminId,
        action: 'CREATE',
        table_name: 'service_categories',
        record_id: String(newCategory.id),
        description: `Created category: ${name}`,
        undo_data: {
          ...newCategory,
          linked_services: servicesArray
        }
      });

      const notifText = `New category created: ${name}`;

      const { error: notifError } = await supabase
        .from('notifications')
        .insert({
          message: notifText,
          created_by: adminId,
          type: "category_created"
        });

      if (notifError) {
        console.log("❌ Notification insert failed:", notifError.message);
      } else {
        console.log("✅ Notification inserted successfully:", notifText);
      }

      // ✅ Response
      res.status(201).json({ message: 'Category created', category: newCategory });

    } catch (err) {
      console.error("Server error:", err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

router.put(
  '/categories/:id',
  checkAdmin,
  body('name').notEmpty().withMessage('Category name is required'),
  body('services').optional().custom(val => {
    if (!Array.isArray(val) && typeof val !== 'number') {
      throw new Error('Services must be an array of IDs or a single ID');
    }
    return true;
  }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const categoryId = Number(req.params.id);
      if (isNaN(categoryId)) {
        return res.status(400).json({ message: "Invalid category ID" });
      }

      const { name, services } = req.body;
      const adminId = req.user?.id;

      // ✅ Unique name check
      const { data: existingCategory } = await supabase
        .from('service_categories')
        .select('id')
        .ilike('name', name)
        .neq('id', categoryId)
        .maybeSingle();

      if (existingCategory) {
        return res.status(400).json({ message: "Category name must be unique" });
      }

      // ✅ Update category
      const { data: updatedCategory, error: catError } = await supabase
        .from('service_categories')
        .update({
          name,
          updated_at: new Date().toISOString()
        })
        .eq('id', categoryId)
        .select()
        .single();

      if (catError) {
        return res.status(400).json({ message: catError.message });
      }

      // ✅ Handle service linking
      if (services !== undefined) {
        const servicesArray = Array.isArray(services)
          ? [...new Set(services.map(Number).filter(Boolean))]
          : [Number(services)];

        await supabase
          .from('service_category_links')
          .delete()
          .eq('category_id', categoryId);

        if (servicesArray.length > 0) {
          const { error: linkError } = await supabase
            .from('service_category_links')
            .insert(
              servicesArray.map(service_id => ({
                service_id,
                category_id: categoryId
              }))
            );

          if (linkError) {
            return res.status(400).json({ message: linkError.message });
          }
        }
      }

      // ✅ Log + notify
      await supabase.from('activity_logs').insert({
        admin_id: adminId,
        action: 'UPDATE',
        table_name: 'service_categories',
        record_id: String(categoryId),
        description: `Updated category: ${name}`,
        undo_data: { ...updatedCategory, linked_services: services || null }
      });

      await supabase.from('notifications').insert({
        message: `Category updated: ${name}`,
        created_by: adminId,
        type: "category_updated"
      });

      res.status(200).json({
        message: 'Category updated successfully',
        category: updatedCategory
      });
    } catch (err) {
      console.error("Server error:", err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);



// POST create service (link to ONE category)
router.post(
  '/',
  checkAdmin,
  body('name').notEmpty().withMessage('Service name is required'),
  body('price').isNumeric().withMessage('Price must be numeric'),
  body('categories')
    .optional()
    .isNumeric()
    .withMessage('Category must be a single category ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const adminId = req.user?.id;
      const {
        name,
        description,
        price,
        allow_installment = false,
        installment_times,
        installment_interval,
        custom_interval_days,
        categories // now expected to be a single ID
      } = req.body;

      // ✅ UNIQUE NAME CHECK
      const { data: existingService } = await supabase
        .from('services')
        .select('id')
        .ilike('name', name)
        .maybeSingle();

      if (existingService) {
        return res.status(400).json({ message: "Service name must be unique" });
      }

      // ✅ Conditional installment validation
      let finalInstallmentTimes = null;
      let finalInstallmentInterval = null;
      let finalCustomIntervalDays = null;

      if (allow_installment) {
        finalInstallmentTimes = installment_times ?? 0;

        if (!installment_interval) {
          return res.status(400).json({ message: "installment_interval is required when allow_installment is true" });
        }

        finalInstallmentInterval = installment_interval;

        if (installment_interval === "custom") {
          if (!custom_interval_days) {
            return res.status(400).json({ message: "custom_interval_days is required when interval is custom" });
          }
          finalCustomIntervalDays = custom_interval_days;
        }
      }

      // ✅ Insert Service
      const { data: newService, error: svcError } = await supabase
        .from('services')
        .insert({
          name,
          description,
          price,
          allow_installment,
          installment_times: finalInstallmentTimes,
          installment_interval: finalInstallmentInterval,
          custom_interval_days: finalCustomIntervalDays
        })
        .select()
        .single();

      if (svcError) {
        return res.status(400).json({ message: svcError.message });
      }

      // ✅ Link to ONE category
      if (categories) {
        const { error: linkError } = await supabase
          .from('service_category_links')
          .insert({
            service_id: newService.id,
            category_id: categories
          });

        if (linkError) {
          return res.status(400).json({ message: linkError.message });
        }
      }

      // ✅ ACTIVITY LOG
      await supabase.from('activity_logs').insert({
        admin_id: adminId,
        action: 'CREATE',
        table_name: 'services',
        record_id: String(newService.id),
        description: `Created service: ${newService.name}`,
        undo_data: {
          ...newService,
          linked_category: categories || null
        }
      });

      // ✅ PUSH NOTIFICATIONS
      try {
        const { data: usersWithTokens } = await supabase
          .from("users")
          .select("fcm_token")
          .not("fcm_token", "is", null);

        const tokens = usersWithTokens.map(u => u.fcm_token).filter(Boolean);

        if (tokens.length > 0) {
          const notificationPayload = {
            notification: {
              title: "🦷 New Dental Service Available",
              body: `${newService.name} has been added to our services list!`
            },
            data: {
              serviceId: newService.id.toString(),
              serviceName: newService.name
            }
          };

          const MAX_BATCH = 500;
          for (let i = 0; i < tokens.length; i += MAX_BATCH) {
            const batch = tokens.slice(i, i + MAX_BATCH);
            await admin.messaging().sendEachForMulticast({
              tokens: batch,
              ...notificationPayload
            });
          }
        }
      } catch (pushErr) {
        console.warn("⚠️ Push notification failed:", pushErr.message);
      }

      return res.status(201).json({
        message: 'Service created',
        service: newService
      });

    } catch (err) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);


// PUT update service (link to ONE category)
router.put(
  '/:id',
  checkAdmin,
  body('name').notEmpty().withMessage('Service name is required'),
  body('price').isNumeric().withMessage('Price must be numeric'),
  body('categories')
    .optional()
    .isNumeric()
    .withMessage('Category must be a single category ID'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const serviceId = req.params.id;
      const adminId = req.user?.id;
      const {
        name,
        description,
        price,
        allow_installment = false,
        installment_times,
        installment_interval,
        custom_interval_days,
        categories
      } = req.body;

      // ✅ UNIQUE NAME CHECK (exclude current service)
      const { data: existingService } = await supabase
        .from('services')
        .select('id')
        .ilike('name', name)
        .neq('id', serviceId)
        .maybeSingle();

      if (existingService) {
        return res.status(400).json({ message: "Service name must be unique" });
      }

      // ✅ Conditional installment validation
      let finalInstallmentTimes = null;
      let finalInstallmentInterval = null;
      let finalCustomIntervalDays = null;

      if (allow_installment) {
        finalInstallmentTimes = installment_times ?? 0;

        if (!installment_interval) {
          return res.status(400).json({ message: "installment_interval is required when allow_installment is true" });
        }

        finalInstallmentInterval = installment_interval;

        if (installment_interval === "custom") {
          if (!custom_interval_days) {
            return res.status(400).json({ message: "custom_interval_days is required when interval is custom" });
          }
          finalCustomIntervalDays = custom_interval_days;
        }
      }

      // ✅ Update Service
      const { data: updatedService, error: svcError } = await supabase
        .from('services')
        .update({
          name,
          description,
          price,
          allow_installment,
          installment_times: finalInstallmentTimes,
          installment_interval: finalInstallmentInterval,
          custom_interval_days: finalCustomIntervalDays
        })
        .eq('id', serviceId)
        .select()
        .single();

      if (svcError) {
        return res.status(400).json({ message: svcError.message });
      }

      // ✅ Update link to ONE category
      if (categories) {
        // Delete old link first
        await supabase
          .from('service_category_links')
          .delete()
          .eq('service_id', serviceId);

        // Insert new link
        const { error: linkError } = await supabase
          .from('service_category_links')
          .insert({
            service_id: serviceId,
            category_id: categories
          });

        if (linkError) {
          return res.status(400).json({ message: linkError.message });
        }
      }

      // ✅ Activity Log
      await supabase.from('activity_logs').insert({
        admin_id: adminId,
        action: 'UPDATE',
        table_name: 'services',
        record_id: String(serviceId),
        description: `Updated service: ${updatedService.name}`,
        undo_data: { ...updatedService, linked_category: categories || null }
      });

      // ✅ Optional: Push notifications
      try {
        const { data: usersWithTokens } = await supabase
          .from("users")
          .select("fcm_token")
          .not("fcm_token", "is", null);

        const tokens = usersWithTokens.map(u => u.fcm_token).filter(Boolean);

        if (tokens.length > 0) {
          const notificationPayload = {
            notification: {
              title: "🦷 Dental Service Updated",
              body: `${updatedService.name} has been updated!`
            },
            data: {
              serviceId: updatedService.id.toString(),
              serviceName: updatedService.name
            }
          };

          const MAX_BATCH = 500;
          for (let i = 0; i < tokens.length; i += MAX_BATCH) {
            const batch = tokens.slice(i, i + MAX_BATCH);
            await admin.messaging().sendEachForMulticast({
              tokens: batch,
              ...notificationPayload
            });
          }
        }
      } catch (pushErr) {
        console.warn("⚠️ Push notification failed:", pushErr.message);
      }

      return res.status(200).json({
        message: 'Service updated',
        service: updatedService
      });

    } catch (err) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);







module.exports = router;
