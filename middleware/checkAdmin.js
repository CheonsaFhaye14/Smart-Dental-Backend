const jwt = require('jsonwebtoken');

const checkAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) return res.status(401).json({ message: 'No token' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Admins only' });
    }

    req.user = decoded;
    req.token = token;
    next();
  } catch (err) {
    console.error('checkAdmin error:', err.message);

    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }

    return res.status(401).json({ message: 'Invalid token' });
  }
};

module.exports = checkAdmin;