const express = require('express');
const multer = require('multer');
const fs = require('fs');
const router = express.Router();
const supabase = require('../supabase'); // your supabase client

// Multer setup to handle file uploads (stores files temporarily)
const upload = multer({ dest: 'uploads/' });

// 📤 Upload BEFORE model (GLTF + optional BIN)
router.post(
  '/upload/beforemodel',
  upload.fields([
    { name: 'gltf', maxCount: 1 },
    { name: 'bin', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { record_id } = req.body;
      if (!record_id) return res.status(400).json({ error: 'Missing record_id' });

      const bucketName = '3d-Dental-Model'; // your Supabase bucket name

      // 🦷 Upload GLTF file
      const gltfFile = req.files['gltf'][0];
      const gltfBuffer = fs.readFileSync(gltfFile.path);
      const gltfPath = `models/DentalModel_${record_id}.gltf`;

      const { error: gltfError } = await supabase.storage
        .from(bucketName)
        .upload(gltfPath, gltfBuffer, {
          contentType: 'model/gltf+json',
          upsert: true,
        });

      fs.unlinkSync(gltfFile.path);
      if (gltfError) throw gltfError;

      // 🧩 Upload BIN file (optional)
      let binPath = null;
      if (req.files['bin']) {
        const binFile = req.files['bin'][0];
        const binBuffer = fs.readFileSync(binFile.path);
        binPath = `models/DentalModel_${record_id}.bin`;

        const { error: binError } = await supabase.storage
          .from(bucketName)
          .upload(binPath, binBuffer, {
            contentType: 'application/octet-stream',
            upsert: true,
          });

        fs.unlinkSync(binFile.path);
        if (binError) throw binError;
      }

      // 💾 Save in dental_models table
      const { error: dbError } = await supabase
        .from('dental_models')
        .upsert([
          {
            record_id,
            before_model_url: gltfPath,
            before_model_bin_url: binPath,
            before_uploaded_at: new Date(),
          },
        ]);

      if (dbError) throw dbError;

      res.json({
        success: true,
        message: 'Model uploaded successfully',
        record_id,
        gltfPath,
        binPath,
      });
    } catch (error) {
      console.error('❌ Upload error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// 📥 Fetch BEFORE model (generates signed URLs)
router.get('/model/:record_id', async (req, res) => {
  const { record_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('dental_models')
      .select('*')
      .eq('record_id', record_id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Model not found' });

    const { data: gltfUrl } = await supabase.storage
      .from('dental-models')
      .createSignedUrl(data.before_model_url, 600); // valid 10 minutes

    const { data: binUrl } = data.before_model_bin_url
      ? await supabase.storage
          .from('dental-models')
          .createSignedUrl(data.before_model_bin_url, 600)
      : { data: null };

    res.json({
      record_id,
      gltfUrl: gltfUrl?.signedUrl || null,
      binUrl: binUrl?.signedUrl || null,
    });
  } catch (error) {
    console.error('❌ Fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
