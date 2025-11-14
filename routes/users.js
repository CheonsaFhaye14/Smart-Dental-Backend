const express = require('express');
const router = express.Router();
const supabase = require('../supabase'); // Service role
const jwt = require("jsonwebtoken");

// Middleware to check admin from JWT
const checkAdmin = async (req, res, next) => {
  try {
    const rawHeader = req.headers.authorization;
    const token = rawHeader?.split(" ")[1];

    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.usertype !== "admin") {
      return res.status(403).json({ message: "Admins only" });
    }

    req.user = decoded;
    req.token = token; // ✅ Save token for later logging

    next();
  } catch (err) {
    console.error("checkAdmin error:", err);
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ✅ GET ALL USERS (check users table first)
router.get('/all', checkAdmin, async (req, res) => {
  try {

    // ✅ Log token + decoded info
    console.log("\n🔐 Token used for /all:", req.token);
    console.log("👤 Decoded user:", req.user);

    // 1️⃣ Get all non-deleted users from your "users" table
    const { data: profiles, error: dbError } = await supabase
      .from('users')
      .select(`
        id, username, usertype, firstname, lastname, birthdate, 
        contact, address, gender, allergies, medicalhistory,
        is_deleted, created_at
      `)
      .eq('is_deleted', false);

    if (dbError) throw dbError;

    // 2️⃣ Get all users from Supabase Auth (handle pagination)
    let allAuthUsers = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const { data: authData, error: authError } = await supabase.auth.admin.listUsers({ page, perPage });
      if (authError) throw authError;

      allAuthUsers = allAuthUsers.concat(authData.users);

      if (!authData.nextPage) break;
      page++;
    }

    // 3️⃣ Merge profiles and attach email from auth.users
    const merged = profiles
      .map(profile => {
        const authUser = allAuthUsers.find(u => u.id === profile.id) || {};
        return {
          ...profile,
          email: authUser.email || null,
          created_at_auth: authUser.created_at || null
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 4️⃣ Count users by type
    const userTypeCount = merged.reduce((acc, user) => {
      acc[user.usertype] = (acc[user.usertype] || 0) + 1;
      return acc;
    }, {});

    console.log("📊 User count by type:", userTypeCount);

    res.json(merged);
  } catch (err) {
    console.error("Error in /all route:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});



// ✅ ADD NEW USER (DEBUG MODE) working
router.post('/add', checkAdmin, async (req, res) => { 
  console.log("🔥 /users/add called");

  const {
    username,
    email,
    password,
    usertype,
    firstname,
    lastname,
    birthdate,
    contact,
    address,
    gender,
    allergies,
    medicalhistory,
  } = req.body;

  if (!username || !email || !password || !usertype || !firstname || !lastname) {
    return res.status(400).json({ message: 'Required fields missing' });
  }

  // ✅ Format names (capitalize first letter)
  const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  const formattedFirst = cap(firstname);
  const formattedLast = cap(lastname);

  // ✅ Normalize username (optional: lowercase)
  const formattedUsername = username.toLowerCase();

  try {
    // ✅ 1. Check if email exists in Auth
    const { data: authList } = await supabase.auth.admin.listUsers();
    const matchedUser = authList.users.find(u => u.email === email);

    let userIdToUse = null;

    if (matchedUser) {
      console.log("📌 Email exists in Auth:", matchedUser.id);

      const { data: existingProfile } = await supabase
        .from('users')
        .select('*')
        .eq('id', matchedUser.id)
        .maybeSingle();

      if (!existingProfile || existingProfile.is_deleted === true) {
        console.log("♻️ Profile missing or deleted → reusing:", matchedUser.id);
        userIdToUse = matchedUser.id;
      } else {
        return res.status(400).json({ message: 'Email already in use by an active user.' });
      }

    } else {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (authError) throw new Error(authError.message);

      userIdToUse = authUser.user.id;
      console.log("✅ Created new Auth user:", userIdToUse);
    }

    // ✅ 4. Insert / Restore profile
    const { data: newUser, error: profileError } = await supabase
      .from('users')
      .upsert({
        id: userIdToUse,
        username: formattedUsername,
        usertype,
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
        updated_at: new Date()
      })
      .select()
      .single();

    if (profileError) throw new Error(profileError.message);

    console.log("✅ User profile inserted/restored:", newUser.id);

    // ✅ 5. Activity Log
    console.log("🧾 Attempting to write activity log...");
    console.log("📝 Log Details:", {
      admin_id: req.user.id,
      record_id: newUser.id,
      action: "create_or_restore_user"
    });

    const { error: logError } = await supabase
      .from('activity_logs')
      .insert([{
        admin_id: req.user.id,
        action: 'create_or_restore_user',
        table_name: 'users',
        record_id: newUser.id,
        description: `Admin created/restored user: ${formattedFirst} ${formattedLast} (${email})`,
      }]);

    if (logError) {
      console.log("❌ Activity Log INSERT FAILED:", logError);
    } else {
      console.log("✅ Activity log recorded successfully!");
    }

    return res.status(201).json({
      message: matchedUser ? 'User restored successfully' : 'User created successfully',
      user: newUser,
    });

  } catch (err) {
    console.log("💥 ERROR:", err.message);
    return res.status(500).json({ message: err.message || 'Server error' });
  }
});

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
      return res.status(404).json({ message: "User not found or already deleted" });
    }

    // 2️⃣ Soft delete the user
    const { data: deletedUser, error: deleteError } = await supabase
      .from('users')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
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
        data: {
          ...existingUser,
          is_deleted: true,
          deleted_at: new Date().toISOString()
        }
      }]);

    if (logError) console.error("Activity log error:", logError);

    // 4️⃣ Respond
    return res.status(200).json({
      message: "User deleted successfully",
      user: deletedUser
    });

  } catch (err) {
    console.error("💥 Error deleting user:", err.message);
    return res.status(500).json({ message: "Error deleting user", error: err.message });
  }
});

router.put('/edit/:id', checkAdmin, async (req, res) => {
  console.log("🔥 /users/edit called");

  const userId = req.params.id;
  delete req.body.id; // Prevent accidental override

  const {
    username,
    email,
    password,
    usertype,
    firstname,
    lastname,
    birthdate,
    contact,
    address,
    gender,
    allergies,
    medicalhistory,
  } = req.body;

  if (!username || !email || !usertype || !firstname || !lastname) {
    return res.status(400).json({ message: "Required fields missing" });
  }

  const validUsertypes = ["patient", "dentist", "admin"];
  if (!validUsertypes.includes(usertype.toLowerCase())) {
    return res.status(400).json({ message: "Invalid usertype" });
  }

  try {
    // ✅ Fetch existing user
    const { data: existingUser, error: fetchErr } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (fetchErr || !existingUser) {
      console.log("❌ User not found in users table", fetchErr);
      return res.status(404).json({ message: "User not found" });
    }

    // ✅ Check unique username
    const { data: usernameExists } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .neq("id", userId);

    if (usernameExists?.length > 0) {
      return res.status(409).json({ message: "Username already exists" });
    }

    // ✅ Update Supabase Auth (email/password only)
    if (email !== existingUser.email || password) {
      const { error: authUpdateError } = await supabase.auth.admin.updateUserById(
        userId,
        {
          email,
          ...(password && { password }),
        }
      );

      if (authUpdateError) {
        console.log("❌ Auth update error", authUpdateError);
        return res.status(500).json({ message: authUpdateError.message });
      }
    }

    // ✅ Only update profile fields — NO email here
    const profilePayload = {
      username,
      usertype,
      firstname,
      lastname,
      birthdate,
      contact,
      address,
      gender,
      allergies,
      medicalhistory,
      updated_at: new Date()
    };

    const { data: updatedUser, error: updateErr } = await supabase
      .from("users")
      .update(profilePayload)
      .eq("id", userId)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ message: "Failed to update user" });
    }

    // ✅ Track changed fields
    const changes = {};
    const changedFields = [];

    Object.keys(profilePayload).forEach(field => {
      if (existingUser[field]?.toString() !== updatedUser[field]?.toString()) {
        changes[field] = existingUser[field];
        changedFields.push(field);
      }
    });

    if (changedFields.length > 0) {
      await supabase.from("activity_logs").insert([{
        admin_id: req.user.id,
        action: "update_user",
        table_name: "users",
        record_id: userId,
        description: `Admin updated ${firstname} ${lastname} (${changedFields.join(", ")})`,
        undo_data: { primary_key: "id", table: "users", data: changes }
      }]);
    }

    return res.status(200).json({
      success: true,
      message: "User updated successfully",
      user: { ...updatedUser, email }, // return email
    });

  } catch (error) {
    console.error("💥 ERROR:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
});

module.exports = router;
