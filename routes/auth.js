const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const supabase = require('../supabase'); // your supabase client
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const { findAuthUserByEmail } = require('../utils/authHelpers');
const { sendSetupEmail } = require('../utils/mailer');

// ------------------ WEBSITE LOGIN (Admins Only) Working ------------------
router.post('/website/login', [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters long'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;

  try {
    // 1) Get user from your custom table
    const { data: localUser, error: localError } = await supabase
      .from('users')
      .select('id, role, username, is_active')
      .eq('username', username)
      .single();

    if (localError || !localUser) {
      return res.status(400).json({ message: 'User not found.' });
    }

    if (localUser.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    if (!localUser.is_active) {
      return res.status(403).json({ message: 'Account is deactivated.' });
    }

    // 2) Fetch Auth user email via Supabase Admin API
    const { data: authData, error: authError } = await supabase.auth.admin.getUserById(localUser.id);

    if (authError || !authData?.user) {
      return res.status(400).json({ message: 'Failed to find auth user.' });
    }

    const userEmail = authData.user.email;

    // 3) Validate password using Supabase Auth
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password
    });

    if (loginError) {
      return res.status(400).json({ message: 'Incorrect password.' });
    }

    // 4) Generate JWT
    const token = jwt.sign(
      { id: localUser.id, username: localUser.username, role: localUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      message: 'Admin login successful',
      token,
      user: {
        id: localUser.id,
        username: localUser.username,
        role: localUser.role,
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

    // Restrict role
    if (user.role !== 'patient' && user.role !== 'dentist') {
      return res.status(403).json({ message: 'Access denied. Patients and Dentists only.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: 'Account is deactivated. Please contact your administrator.' });
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
      { id: user.id, username: user.username, role: user.role },
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
        role: user.role,
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
  body('role').isIn(['patient', 'dentist']).withMessage('Invalid role'),
  body('firstname').notEmpty().withMessage('Firstname is required'),
  body('lastname').notEmpty().withMessage('Lastname is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, email, password, role, firstname, lastname } = req.body;

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
        role,
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
    // 1️⃣ Check if the email exists in auth.users
    const matchedUser = await findAuthUserByEmail(email);

    if (!matchedUser) {
      return res.status(404).json({ message: 'Email not found' });
    }

    const { data: localUser } = await supabase
      .from('users')
      .select('is_active, firstname')
      .eq('email', email)
      .single();

    if (localUser && !localUser.is_active) {
      return res.status(403).json({ message: 'Account is deactivated. Cannot reset password.' });
    }

    // 2️⃣ Generate our own recovery link (instead of Supabase's built-in reset email)
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
        options: {
    redirectTo: process.env.FORGOTPASS_URL,
  },
    });

    if (linkError) return res.status(400).json({ message: linkError.message });

    // 3️⃣ Send it through our own mailer, same template used everywhere else
    await sendSetupEmail({
      to: email,
      firstname: localUser?.firstname || 'there',
      setupLink: linkData.properties.action_link,
      mode: 'reset'
    });

    return res.status(200).json({ message: 'Password reset email sent successfully.' });

  } catch (err) {
    console.error('Error during forgot password:', err.message);
    return res.status(500).json({
      message: 'Server error during password reset.',
      error: err.message
    });
  }
});

// ------------------ RESET PASSWORD Working ------------------
router.post(
  '/reset-password',
  body('access_token').notEmpty().withMessage('Access token is required.'),
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { access_token, newPassword } = req.body;

    try {
      // 1️⃣ Get user info using token
      const { data: session, error: sessionError } = await supabase.auth.getUser(access_token);
      if (sessionError || !session.user) {
        return res.status(400).json({ message: 'Invalid or expired token.' });
      }

      const userId = session.user.id;

      const { data: localUser } = await supabase
        .from('users')
        .select('is_active')
        .eq('id', userId)
        .single();

      if (localUser && !localUser.is_active) {
        return res.status(403).json({ message: 'Account is deactivated. Cannot reset password.' });
      }

      // 2️⃣ Update password using Admin API
      const { data, error } = await supabase.auth.admin.updateUserById(userId, {
        password: newPassword
      });

      if (error) return res.status(400).json({ message: error.message });

      return res.status(200).json({ message: 'Password updated successfully.' });
    } catch (err) {
      console.error('Error resetting password:', err.message);
      return res.status(500).json({ message: 'Server error during password reset.', error: err.message });
    }
  }
);
// ------------------ LOGOUT ------------------
router.post(
  '/logout',
  body('refreshToken').notEmpty().withMessage('Missing refresh token'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const { refreshToken } = req.body;

    try {
      await supabase.from('refresh_tokens').delete().eq('token', refreshToken);
      res.json({ message: 'Logged out successfully' });
    } catch (err) {
      console.error('Logout error:', err.message);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

// ------------------ CHANGE PASSWORD ------------------
router.patch(
  '/change-password',
  body('userId').notEmpty().withMessage('User ID is required'),
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters long'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    }

    const { userId, currentPassword, newPassword } = req.body;

    try {
      const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();
      if (error || !user) return res.status(404).json({ message: 'User not found' });

      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) return res.status(400).json({ message: 'Current password incorrect' });

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const { error: updateError } = await supabase.from('users').update({ password: hashedPassword }).eq('id', userId);

      if (updateError) return res.status(400).json({ message: 'Error updating password' });

      res.json({ message: 'Password changed successfully' });
    } catch (err) {
      console.error('Change password error:', err.message);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

module.exports = router;