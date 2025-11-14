// import express framework
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// import and use routes
const authRoutes = require('./routes/auth');
const bucketRoutes = require('./routes/buckets');
const userRoutes = require('./routes/users');
const serviceRoutes = require('./routes/services')

app.use('/auth', authRoutes);
app.use('/buckets', bucketRoutes);
app.use('/users', userRoutes);
app.use('/services',serviceRoutes);

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
