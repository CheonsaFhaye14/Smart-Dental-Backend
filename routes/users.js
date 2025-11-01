const express = require('express');
const router = express.Router();
const supabase = require('../supabase'); // Service role
const jwt = require("jsonwebtoken");

// Middleware to check admin from JWT
const checkAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.usertype !== "admin") {
      return res.status(403).json({ message: "Admins only" });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ✅ GET ALL USERS (exclude soft-deleted)
router.get('/all', checkAdmin, async (req, res) => {
  try {
    const { data: users, error: authError } = await supabase.auth.admin.listUsers();
    if (authError) throw authError;

    const authInfo = users.users.map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at
    }));

    const { data: profiles, error: dbError } = await supabase
      .from('users')
      .select(`
        id, username, usertype, firstname, lastname, birthdate, 
        contact, address, gender, allergies, medicalhistory,
        is_deleted, created_at
      `)
      .or('is_deleted.is.null,is_deleted.eq.false');

    if (dbError) throw dbError;

    const merged = authInfo
      .map(a => {
        const match = profiles.find(p => p.id === a.id) || {};
        return { ...a, ...match };
      })
      .filter(u => !u.is_deleted)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ✅ ADD NEW USER (DEBUG MODE)
router.post('/add', checkAdmin, async (req, res) => {
  console.log("🔥 /users/add called");
  console.log("📩 Request Body:", req.body);
  console.log("🧑‍💼 Authenticated Admin:", req.user);

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

  // Validate fields
  if (!username || !email || !password || !usertype || !firstname || !lastname) {
    console.log("❌ Missing required fields");
    return res.status(400).json({ message: 'Required fields missing' });
  }

  let createdUserId = null;

  try {
    // ✅ 1. Create user in Supabase Auth
    console.log("🔐 Creating Supabase Auth user...");
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    console.log("📦 Auth Response:", authUser, authError);

    if (authError) {
      console.log("❌ Auth Error:", authError);
      throw new Error(authError.message || "Email already exists or invalid.");
    }

    createdUserId = authUser.user.id;
    console.log("✅ Created auth user with ID:", createdUserId);

    // ✅ 2. Insert user profile into `users`
    console.log("📝 Inserting profile into users table...");
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{
        id: createdUserId,
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
      }])
      .select()
      .single();

    console.log("📦 Insert Response:", newUser, insertError);

    if (insertError) {
      console.log("❌ Insert Error:", insertError);
      throw new Error(insertError.message || "Failed to save user profile.");
    }

    // ✅ 3. Activity Log (STRICT)
    console.log("🧾 Writing activity log...");
    const { error: logError } = await supabase
      .from('activity_logs')
      .insert([{
        admin_id: req.user.id,
        action: 'create_user',
        table_name: 'users',
        record_id: newUser.id,
        description: `Admin created user: ${firstname} ${lastname} (${email})`,
      }]);

    console.log("🧾 Log Response:", logError);

    if (logError) {
      console.log("❌ Activity Log Error:", logError);
      throw new Error(logError.message || "Failed to write activity log.");
    }

    console.log("✅ USER CREATION COMPLETE!");

    return res.status(201).json({
      message: 'User created successfully',
      user: newUser,
    });

  } catch (error) {
    console.log("💥 CATCH BLOCK TRIGGERED");
    console.log("❌ ERROR MESSAGE:", error.message);

    if (createdUserId) {
      console.log("♻️ Rolling back created user & profile...");
      await supabase.from('users').delete().eq('id', createdUserId);
      await supabase.auth.admin.deleteUser(createdUserId);
      console.log("✅ Rollback completed.");
    }

    return res.status(500).json({
      message: error.message || "Could not create user.",
    });
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
      message: "User soft-deleted successfully",
      user: deletedUser
    });

  } catch (err) {
    console.error("💥 Error deleting user:", err.message);
    return res.status(500).json({ message: "Error deleting user", error: err.message });
  }
});


module.exports = router;
