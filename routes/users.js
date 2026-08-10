const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const supabase = require('../supabase'); // Service role
const { findAuthUserByEmail } = require('../utils/authHelpers');
const { sendSetupEmail } = require('../utils/mailer');

const VALID_ROLES = ['admin', 'dentist', 'patient']; // ⚠️ update to match your actual enum values

// Middleware to check admin from JWT
const checkAdmin = require('../middleware/checkAdmin');


// GET /users/all - Get all users (admin only)
router.get('/all', checkAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const role = (req.query.role || '').trim();

  let query = supabase
    .from('users')
    .select(`
      id, username, role, firstname, lastname, birthdate,
      contact, address, gender, allergies, medicalhistory,
      is_deleted, is_active, email, created_at, updated_at
    `)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });

    if (role) {
      query = query.eq('role', role.toLowerCase());
    }

    if (search) {
      query = query.or(
        `firstname.ilike.%${search}%,lastname.ilike.%${search}%,username.ilike.%${search}%,email.ilike.%${search}%`
      );
    }

    const { data: profiles, error: dbError } = await query;

    if (dbError) throw dbError;

    res.json({ data: profiles });
  } catch (err) {
    console.error('Error in /all route:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /users/add - Add or restore a user (admin only)
router.post(
  '/add',
  checkAdmin,
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('email').trim().notEmpty().withMessage('Email is required'),
  body('firstname').trim().notEmpty().withMessage('Firstname is required'),
  body('lastname').trim().notEmpty().withMessage('Lastname is required'),
  body('role')
    .trim()
    .notEmpty().withMessage('Role is required')
    .bail()
    .customSanitizer((val) => val.toLowerCase())
    .isIn(VALID_ROLES).withMessage(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const {
      username,
      email,
      role,
      firstname,
      lastname,
      birthdate,
      contact,
      address,
      gender,
      allergies,
      medicalhistory,
    } = req.body;

    const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    const formattedFirst = cap(firstname);
    const formattedLast = cap(lastname);
    const formattedUsername = username.toLowerCase();

    let createdNewAuthUser = false;
    let userIdToUse = null;

    try {
      // 1. Check username isn't taken by an active user
      const { data: existingUsername, error: usernameCheckError } = await supabase
        .from('users')
        .select('id')
        .eq('username', formattedUsername)
        .eq('is_deleted', false)
        .maybeSingle();

      if (usernameCheckError) throw new Error(usernameCheckError.message);
      if (existingUsername) {
        return res.status(400).json({ message: 'Username already taken.' });
      }

      // 2. Check if email exists in Auth already
      const matchedUser = await findAuthUserByEmail(email);
      let setupLink = null;
      let existingProfile = null; // ← lifted out so step 6 (undo_data) can see it

      if (matchedUser) {
        const { data: fetchedProfile } = await supabase
          .from('users')
          .select('*')
          .eq('id', matchedUser.id)
          .maybeSingle();
        existingProfile = fetchedProfile;

        if (!existingProfile || existingProfile.is_deleted === true) {
          userIdToUse = matchedUser.id;

          // Generate a fresh setup/recovery link for the restored user
          const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
            type: 'recovery',
            email,
            options: {
              redirectTo: process.env.FORGOTPASS_URL,
            },
          });
          if (linkError) throw new Error(linkError.message);
          setupLink = linkData.properties.action_link;
        } else {
          return res.status(400).json({ message: 'Email already in use by an active user.' });
        }
      } else {
        // 3. No existing auth user — create one with an invite link, no password set
        const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
          type: 'invite',
          email,
          options: {
            redirectTo: process.env.FORGOTPASS_URL,
          },
        });

        if (linkError) throw new Error(linkError.message);

        userIdToUse = linkData.user.id;
        setupLink = linkData.properties.action_link;
        createdNewAuthUser = true;
      }

      // 4. Insert / Restore profile
      const { data: newUser, error: profileError } = await supabase
        .from('users')
        .upsert({
          id: userIdToUse,
          username: formattedUsername,
          email,
          role,
          firstname: formattedFirst,
          lastname: formattedLast,
          birthdate,
          contact,
          address,
          gender,
          allergies,
          medicalhistory,
          is_deleted: false,
          deleted_at: null,
          updated_at: new Date(),
        })
        .select()
        .single();

      if (profileError) {
        if (createdNewAuthUser) {
          await supabase.auth.admin.deleteUser(userIdToUse).catch((cleanupErr) => {
            console.error('Failed to roll back orphaned auth user:', cleanupErr.message);
          });
        }
        if (profileError.code === '23505') {
          return res.status(400).json({ message: 'Username already taken.' });
        }
        throw new Error(profileError.message);
      }

      // 5. Send setup email (non-fatal if it fails)
      sendSetupEmail({
        to: email,
        firstname: formattedFirst,
        setupLink,
      }).catch((emailErr) => {
        console.error('Failed to send setup email:', emailErr.message);
      });

      // 6. Activity log (non-fatal)
      // isRestore is internal only — the admin just sees "created", but undo
      // needs to know whether reverting means soft-deleting a brand-new user
      // or writing back a prior soft-deleted user's exact old field values.
      const isRestore = !!existingProfile;

      const undoData = isRestore
        ? {
            primary_key: 'id',
            table: 'users',
            action: 'restore_previous', // undo = write these exact old fields back
            data: existingProfile,      // full prior row, including is_deleted: true, deleted_at
          }
        : {
            primary_key: 'id',
            table: 'users',
            action: 'soft_delete',      // undo = just soft-delete this brand-new user
            data: null,
          };

      const { error: logError } = await supabase
        .from('activity_logs')
        .insert([{
          admin_id: req.user.id,
          action: 'create_user',
          table_name: 'users',
          record_id: newUser.id,
          description: `Admin created user: ${formattedFirst} ${formattedLast} (${email})`,
          undo_data: undoData,
        }]);

      if (logError && process.env.NODE_ENV !== 'production') {
        console.error('Activity log insert failed:', logError.message);
      }

      return res.status(201).json({
        message: matchedUser ? 'User restored successfully' : 'User created successfully',
        user: newUser,
      });

    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Error in /users/add:', err.message);
      }
      return res.status(500).json({ message: err.message || 'Server error' });
    }
  }
);

// DELETE /users/:id (soft delete)
router.delete('/delete/:id', checkAdmin, async (req, res) => {
  const userId = req.params.id;
  const adminId = req.user.id;

  try {
    // 1️⃣ Fetch user profile first
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('is_deleted', false)
      .single();

    if (fetchError || !existingUser) {
      return res.status(404).json({ message: 'User not found or already deleted' });
    }

    // 2️⃣ Soft delete the user
    const { data: deletedUser, error: deleteError } = await supabase
      .from('users')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (deleteError) throw deleteError;

    // 3️⃣ Log activity
    const { error: logError } = await supabase
      .from('activity_logs')
      .insert([{
        admin_id: adminId,
        action: 'delete_user',
        table_name: 'users',
        record_id: userId,
        description: `Deleted user ${existingUser.firstname} ${existingUser.lastname}`,
        undo_data: {
          primary_key: 'id',
          table: 'users',
          action: 'restore_previous', // undo = write these exact pre-delete fields back
          data: existingUser,         // untouched row, is_deleted: false, deleted_at: null
        },
      }]);

    if (logError) console.error('Activity log error:', logError);

    // 4️⃣ Respond
    return res.status(200).json({
      message: 'User deleted successfully',
      user: deletedUser,
    });

  } catch (err) {
    console.error('💥 Error deleting user:', err.message);
    return res.status(500).json({ message: 'Error deleting user', error: err.message });
  }
});

// PUT /users/edit/:id - Edit user details (admin only)
router.put(
  '/edit/:id',
  checkAdmin,
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('email').trim().notEmpty().withMessage('Email is required'),
  body('firstname').trim().notEmpty().withMessage('Firstname is required'),
  body('lastname').trim().notEmpty().withMessage('Lastname is required'),
  body('role')
    .trim()
    .notEmpty().withMessage('Role is required')
    .bail()
    .customSanitizer((val) => val.toLowerCase())
    .isIn(VALID_ROLES).withMessage(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const userId = req.params.id;
    delete req.body.id; // Prevent accidental override

    const {
      username,
      email,
      role,
      firstname,
      lastname,
      birthdate,
      contact,
      address,
      gender,
      allergies,
      medicalhistory,
    } = req.body;

    try {
      // ✅ Fetch existing user
      const { data: existingUser, error: fetchErr } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

      if (fetchErr || !existingUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      // ✅ Check unique username
      const { data: usernameExists } = await supabase
        .from('users')
        .select('id')
        .eq('username', username)
        .neq('id', userId);

      if (usernameExists?.length > 0) {
        return res.status(409).json({ message: 'Username already exists' });
      }

      // ✅ Update Supabase Auth (email only — password changes go through send-password-reset)
      if (email !== existingUser.email) {
        const { error: authUpdateError } = await supabase.auth.admin.updateUserById(userId, { email });

        if (authUpdateError) {
          return res.status(500).json({ message: authUpdateError.message });
        }
      }

      // ✅ Update profile fields — email included now that Auth is in sync
      const profilePayload = {
        username,
        email,
        role,
        firstname,
        lastname,
        birthdate,
        contact,
        address,
        gender,
        allergies,
        medicalhistory,
        updated_at: new Date(),
      };

      const { data: updatedUser, error: updateErr } = await supabase
        .from('users')
        .update(profilePayload)
        .eq('id', userId)
        .select()
        .single();

      if (updateErr) {
        return res.status(500).json({ message: 'Failed to update user' });
      }

      // ✅ Track changed fields
      // - excludes updated_at (it always differs, it's not a real "change")
      // - uses JSON.stringify for object/array fields (allergies, medicalhistory)
      //   since .toString() collapses all objects to "[object Object]"
      const changes = {};
      const changedFields = [];

      const normalize = (val) =>
        val !== null && typeof val === 'object' ? JSON.stringify(val) : val?.toString();

      const DIFF_FIELDS = Object.keys(profilePayload).filter((f) => f !== 'updated_at');

      DIFF_FIELDS.forEach((field) => {
        if (normalize(existingUser[field]) !== normalize(updatedUser[field])) {
          changes[field] = existingUser[field];
          changedFields.push(field);
        }
      });

      if (changedFields.length > 0) {
        await supabase.from('activity_logs').insert([{
          admin_id: req.user.id,
          action: 'update_user',
          table_name: 'users',
          record_id: userId,
          description: `Admin updated ${firstname} ${lastname} (${changedFields.join(', ')})`,
          undo_data: {
            primary_key: 'id',
            table: 'users',
            action: 'restore_previous', // undo = write these specific old field values back
            data: changes,              // only the fields that actually changed
          },
        }]);
      }

      return res.status(200).json({
        success: true,
        message: 'User updated successfully',
        user: updatedUser,
      });

    } catch (error) {
      console.error('💥 ERROR:', error);
      return res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// POST /users/send-password-reset/:id - Admin triggers a reset link for a user
router.post('/send-password-reset/:id', checkAdmin, async (req, res) => {
  const userId = req.params.id;

  try {
    const { data: profile, error: profileErr } = await supabase
      .from('users')
      .select('id, email, firstname, is_deleted')
      .eq('id', userId)
      .single();

    if (profileErr || !profile || profile.is_deleted) {
      return res.status(404).json({ message: 'User not found' });
    }

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: profile.email,
              options: {
    redirectTo: process.env.FORGOTPASS_URL,
  },
    });

    if (linkError) throw new Error(linkError.message);

    const setupLink = linkData.properties.action_link;

    await sendSetupEmail({
      to: profile.email,
      firstname: profile.firstname,
      setupLink,
      mode: 'reset',
    });

    await supabase.from('activity_logs').insert([{
      admin_id: req.user.id,
      action: 'send_password_reset',
      table_name: 'users',
      record_id: userId,
      description: `Admin sent a password reset link to ${profile.email}`,
    }]);

    return res.status(200).json({ message: 'Password reset email sent.' });

  } catch (err) {
    console.error('send-password-reset error:', err.message);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /users/toggle-status/:id - Toggle user active status (admin only)
router.put('/toggle-status/:id', checkAdmin, async (req, res) => {
  const userId = req.params.id;

  try {
    // ✅ Read current is_active from your users table — source of truth
    const { data: profile, error: profileErr } = await supabase
      .from('users')
      .select('id, is_active, is_deleted, firstname, lastname')
      .eq('id', userId)
      .single();

    if (profileErr || !profile || profile.is_deleted) {
      return res.status(404).json({ message: 'User not found or deleted' });
    }

    const isCurrentlyActive = profile.is_active;
    const newIsActive = !isCurrentlyActive; // ✅ simple toggle

    // ✅ Ban/unban in Supabase Auth
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      ban_duration: newIsActive ? 'none' : '876600h',
    });

    if (updateErr) throw updateErr;

    // ✅ Update is_active in users table
    const { error: dbErr } = await supabase
      .from('users')
      .update({
        is_active: newIsActive,
        updated_at: new Date(),
      })
      .eq('id', userId);

    if (dbErr) throw dbErr;

    // ✅ Activity log
    await supabase.from('activity_logs').insert([{
      admin_id: req.user.id,
      action: newIsActive ? 'enable_user' : 'disable_user',
      table_name: 'users',
      record_id: userId,
      description: `Admin ${newIsActive ? 'enabled' : 'disabled'} ${profile.firstname} ${profile.lastname}`,
      undo_data: {
        primary_key: 'id',
        table: 'users',
        action: 'restore_previous', // undo = flip is_active back to what it was
        data: { is_active: isCurrentlyActive },
      },
    }]);

    return res.status(200).json({
      message: `User ${newIsActive ? 'enabled' : 'disabled'} successfully`,
      is_active: newIsActive,
    });

  } catch (err) {
    console.error('toggle-status error:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /users/audit-log - Get all activity logs for the users table (admin only)
router.get('/audit-log', checkAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const action = (req.query.action || '').trim();

    let query = supabase
      .from('activity_logs')
      .select(`
        id, action, table_name, record_id, description,
        is_undone, undone_at, created_at, undo_data,
        admin:admin_id ( id, firstname, lastname, username )
      `)
      .eq('table_name', 'users')
      .order('created_at', { ascending: false });

    if (action) {
      query = query.eq('action', action);
    }

    if (search) {
      query = query.ilike('description', `%${search}%`);
    }

    const { data: logs, error: dbError } = await query;

    if (dbError) throw dbError;

    // Strip the raw undo payload before sending to the client — the frontend
    // only needs to know *whether* an entry is undoable, not the field values
    const sanitized = (logs || []).map(({ undo_data, ...rest }) => ({
      ...rest,
      can_undo: !!undo_data,
    }));

    res.json({ data: sanitized });
  } catch (err) {
    console.error('Error in /users/audit-log route:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /users/audit-log/:id/undo - Reverse a logged action (admin only)
router.post('/audit-log/:id/undo', checkAdmin, async (req, res) => {
  const logId = req.params.id;

  try {
    // 1️⃣ Fetch the log entry
    const { data: log, error: logErr } = await supabase
      .from('activity_logs')
      .select('*')
      .eq('id', logId)
      .single();

    if (logErr || !log) {
      return res.status(404).json({ message: 'Log entry not found' });
    }

    if (log.is_undone) {
      return res.status(400).json({ message: 'This action was already undone' });
    }

    if (!log.undo_data) {
      return res.status(400).json({ message: 'This action cannot be undone' });
    }

    // 2️⃣ Guard: block undo if a newer action exists on the same record
    const { data: newerLogs, error: newerErr } = await supabase
      .from('activity_logs')
      .select('id')
      .eq('table_name', log.table_name)
      .eq('record_id', log.record_id)
      .gt('created_at', log.created_at)
      .limit(1);

    if (newerErr) throw newerErr;

    if (newerLogs && newerLogs.length > 0) {
      return res.status(409).json({
        message: 'A newer action exists on this record — undo this one first',
      });
    }

    const { table, action, data } = log.undo_data;

    if (!table) {
      return res.status(400).json({ message: 'Malformed undo data' });
    }

    // 3️⃣ Special case: enable/disable_user also needs the Auth ban toggled
    if (log.action === 'enable_user' || log.action === 'disable_user') {
      const { error: authErr } = await supabase.auth.admin.updateUserById(log.record_id, {
        ban_duration: data.is_active ? 'none' : '876600h',
      });
      if (authErr) throw authErr;
    }

    // 4️⃣ Apply the write — branch on soft_delete vs restore_previous
    if (action === 'soft_delete') {
      // undo of a brand-new create_user: just soft-delete it, same as the delete route
      const { error: writeErr } = await supabase
        .from(table)
        .update({
          is_deleted: true,
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', log.record_id);

      if (writeErr) throw writeErr;
    } else if (action === 'restore_previous') {
      if (!data) {
        return res.status(400).json({ message: 'Malformed undo data' });
      }

      // If email is part of what's being restored, keep Supabase Auth in sync —
      // otherwise users.email and the Auth account's email would disagree,
      // and the user would log in with an email that doesn't match the table.
      if (data.email) {
        const { error: authEmailErr } = await supabase.auth.admin.updateUserById(log.record_id, {
          email: data.email,
        });
        if (authEmailErr) throw authEmailErr;
      }

      const { error: writeErr } = await supabase
        .from(table)
        .update(data)
        .eq('id', log.record_id);

      if (writeErr) throw writeErr;
    } else {
      return res.status(400).json({ message: 'Unknown undo action type' });
    }

    // 5️⃣ Mark the log entry as undone
    const { error: markErr } = await supabase
      .from('activity_logs')
      .update({ is_undone: true, undone_at: new Date().toISOString() })
      .eq('id', logId);

    if (markErr) console.error('Failed to mark log as undone:', markErr.message);

    return res.status(200).json({ message: 'Action undone successfully' });

  } catch (err) {
    console.error('undo error:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;