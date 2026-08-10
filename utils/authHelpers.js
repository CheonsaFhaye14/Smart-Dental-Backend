// utils/authHelpers.js
const supabase = require('../supabase'); // adjust if supabase.js exports differently

async function findAuthUserByEmail(email) {
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const found = data.users.find(u => u.email === email);
    if (found) return found;
    if (data.users.length < perPage) return null;
    page++;
  }
}

module.exports = { findAuthUserByEmail };