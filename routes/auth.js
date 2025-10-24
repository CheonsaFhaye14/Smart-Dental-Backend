const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const supabase = require('../supabase'); // your supabase client
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const refreshToken = crypto.randomBytes(64).toString('hex');

// Utility for creating JWT tokens
const generateTokens = (user) => {
  const accessToken = jwt.sign({ id: user.id, usertype: user.usertype }, JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "7d" });
  return { accessToken, refreshToken };
};

// ------------------ WEBSITE LOGIN (Admins Only) ------------------
router.post('/website/login', [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters long'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;

  try {
    // Fetch user
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (userError || !userData) return res.status(400).json({ message: 'User not found.' });

    const user = userData;

    // Check if admin
    if (user.usertype !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    // Compare password (assuming passwords are hashed)
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Incorrect password' });

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, usertype: user.usertype },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      message: 'Admin login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        usertype: user.usertype,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error during login.' });
  }
});

// ------------------ APP LOGIN (Patients & Dentists) ------------------
router.post('/app/login', [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters long'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
  body('fcmToken').optional().isString(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password, fcmToken } = req.body;

  try {
    // Fetch user
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (userError || !userData) return res.status(400).json({ message: 'User not found.' });

    const user = userData;

    // Restrict usertype
    if (user.usertype !== 'patient' && user.usertype !== 'dentist') {
      return res.status(403).json({ message: 'Access denied. Patients and Dentists only.' });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Incorrect password' });

    // Update FCM Token if provided
    if (fcmToken) {
      await supabase
        .from('users')
        .update({ fcm_token: fcmToken })
        .eq('id', user.id);
    }

    // Generate access and refresh tokens
    const accessToken = jwt.sign(
      { id: user.id, username: user.username, usertype: user.usertype },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = crypto.randomBytes(64).toString('hex');

    // Store refresh token in Supabase
    await supabase.from('refresh_tokens').insert([
      { token: refreshToken, user_id: user.id, created_at: new Date() }
    ]);

    return res.status(200).json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        usertype: user.usertype,
      },
    });

  } catch (err) {
    console.error('Error during app login:', err.message);
    return res.status(500).json({ message: 'Server error during login.', error: err.message });
  }
});

// ------------------ APP REGISTER (Patients & Dentists Only) ------------------
router.post('/app/register', [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters long'),
  body('email').isEmail().withMessage('Invalid email format'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
  body('usertype').isIn(['patient', 'dentist']).withMessage('Invalid usertype'),
  body('firstname').notEmpty().withMessage('Firstname is required'),
  body('lastname').notEmpty().withMessage('Lastname is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, email, password, usertype, firstname, lastname } = req.body;

  try {
    // Check if username already exists
    const { data: existingUsername } = await supabase
      .from('users')
      .select('username')
      .eq('username', username)
      .maybeSingle();

    if (existingUsername) {
      return res.status(400).json({ message: 'Username already taken' });
    }

    // Check if email already exists
    const { data: existingEmail } = await supabase
      .from('users')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (existingEmail) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{
        username,
        email,
        password: hashedPassword,
        usertype,
        firstname,
        lastname,
        created_at: new Date(),
        updated_at: new Date()
      }])
      .select('*')
      .single();

    if (insertError) {
      console.error('Supabase insert error:', insertError.message);
      return res.status(500).json({ message: 'Failed to register user', error: insertError.message });
    }

    // Exclude password from response
    const { password: _, ...userWithoutPassword } = newUser;

    return res.status(201).json({
      message: 'User registered successfully',
      user: userWithoutPassword
    });

  } catch (err) {
    console.error('Error during registration:', err.message);
    return res.status(500).json({ message: 'Server error during registration', error: err.message });
  }
});

// ------------------ FORGOT PASSWORD ------------------
router.post('/forgot-password', [
  body('email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email } = req.body;

  try {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: process.env.FORGOTPASS_URL // URL user will be redirected to after reset
    });

    if (error) return res.status(400).json({ message: error.message });

    return res.status(200).json({ message: 'Password reset email sent successfully.' });
  } catch (err) {
    console.error('Error during forgot password:', err.message);
    return res.status(500).json({
      message: 'Server error during password reset.',
      error: err.message
    });
  }
});

// ------------------ RESET PASSWORD ------------------
router.post('/reset-password', [
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { newPassword } = req.body;

  try {
    const { data, error } = await supabase.auth.updateUser({
      password: newPassword
    });

    if (error) return res.status(400).json({ message: error.message });

    return res.status(200).json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Error resetting password:', err.message);
    return res.status(500).json({
      message: 'Server error during password reset.',
      error: err.message
    });
  }
});

// ------------------ REFRESH TOKEN ------------------
router.post('/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ message: "Missing refresh token" });

  try {
    // Check if token exists in table
    const { data: tokenData, error: tokenError } = await supabase
      .from('refresh_tokens')
      .select('*')
      .eq('token', refreshToken)
      .maybeSingle();

    if (tokenError || !tokenData) return res.status(403).json({ message: "Invalid refresh token" });

    // Fetch user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', tokenData.user_id)
      .single();

    if (userError || !user) return res.status(404).json({ message: "User not found" });

    // Generate new access token
    const accessToken = jwt.sign(
      { id: user.id, username: user.username, usertype: user.usertype },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({ accessToken });
  } catch (err) {
    console.error('Refresh token error:', err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ------------------ LOGOUT ------------------
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ message: "Missing refresh token" });

  try {
    await supabase.from('refresh_tokens').delete().eq('token', refreshToken);
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ------------------ CHANGE PASSWORD ------------------
router.patch("/change-password", async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;

  try {
    const { data: user, error } = await supabase.from("users").select("*").eq("id", userId).single();
    if (error || !user) return res.status(404).json({ message: "User not found" });

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) return res.status(400).json({ message: "Current password incorrect" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const { error: updateError } = await supabase.from("users").update({ password: hashedPassword }).eq("id", userId);

    if (updateError) return res.status(400).json({ message: "Error updating password" });

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("Change password error:", err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

module.exports = router;
