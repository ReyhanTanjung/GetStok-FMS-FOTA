// server.js
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = 3000;

// Folder untuk menyimpan firmware
const FIRMWARE_DIR = path.join(__dirname, 'firmware');

// Pastikan direktori firmware ada
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR);
}

// Middleware untuk logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Rute statis untuk file firmware
app.use('/firmware', express.static(FIRMWARE_DIR));

// Informasi tentang firmware terbaru
app.get('/api/firmware/latest', (req, res) => {
  try {
    // Cari file firmware terbaru di folder
    const files = fs.readdirSync(FIRMWARE_DIR);
    if (files.length === 0) {
      return res.status(404).json({ error: 'Tidak ada firmware tersedia' });
    }

    // Urutkan file berdasarkan waktu modifikasi (terbaru ke lama)
    const sortedFiles = files
      .filter(file => file.endsWith('.bin'))
      .map(file => {
        const filePath = path.join(FIRMWARE_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          path: filePath,
          size: stats.size,
          mtime: stats.mtime
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (sortedFiles.length === 0) {
      return res.status(404).json({ error: 'Tidak ada firmware tersedia' });
    }

    // Ambil file terbaru
    const latestFirmware = sortedFiles[0];
    
    // Ekstrak versi dari nama file
    const versionMatch = latestFirmware.name.match(/_v(\d+\.\d+\.\d+)\.bin$/);
    const version = versionMatch ? versionMatch[1] : '1.0.0';
    
    // Hitung MD5 hash
    const fileBuffer = fs.readFileSync(latestFirmware.path);
    const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    
    const firmwareInfo = {
      version: version,
      name: latestFirmware.name,
      file: `firmware/${latestFirmware.name}`,
      size: latestFirmware.size,
      md5: md5Hash
    };
    
    res.json(firmwareInfo);
  } catch (error) {
    console.error('Error accessing firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload firmware baru
app.post('/api/firmware/upload', express.raw({ type: 'application/octet-stream', limit: '8mb' }), (req, res) => {
  try {
    // Dapatkan versi dari query parameter
    const version = req.query.version || '1.0.0';
    const fileName = `esp32_firmware_v${version}.bin`;
    const filePath = path.join(FIRMWARE_DIR, fileName);
    
    // Tulis file firmware
    fs.writeFileSync(filePath, req.body);
    
    // Hitung MD5 hash
    const md5Hash = crypto.createHash('md5').update(req.body).digest('hex');
    
    res.json({
      success: true,
      fileName: fileName,
      size: req.body.length,
      md5: md5Hash
    });
  } catch (error) {
    console.error('Error uploading firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Daftar firmware yang tersedia
app.get('/api/firmware/list', (req, res) => {
  try {
    const files = fs.readdirSync(FIRMWARE_DIR)
      .filter(file => file.endsWith('.bin'))
      .map(file => {
        const filePath = path.join(FIRMWARE_DIR, file);
        const stats = fs.statSync(filePath);
        const fileBuffer = fs.readFileSync(filePath);
        const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
        
        // Ekstrak versi dari nama file
        const versionMatch = file.match(/_v(\d+\.\d+\.\d+)\.bin$/);
        const version = versionMatch ? versionMatch[1] : 'unknown';
        
        return {
          name: file,
          version: version,
          size: stats.size,
          date: stats.mtime,
          md5: md5Hash
        };
      })
      .sort((a, b) => b.date - a.date);
    
    res.json(files);
  } catch (error) {
    console.error('Error listing firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Tampilkan halaman dashboard sederhana
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Cek status server
app.get('/api/status', (req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

// Mulai server HTTPS
let server;
try {
  const sslOptions = {
    key: fs.readFileSync('localhost+2-key.pem'),
    cert: fs.readFileSync('localhost+2.pem')
  };
  
  server = https.createServer(sslOptions, app).listen(PORT, () => {
    console.log(`Server OTA berjalan di port ${PORT}`);
    console.log(`Buka https://localhost:${PORT} untuk dashboard`);
  });
} catch (error) {
  console.error('Error starting HTTPS server:', error);
  console.log('Falling back to HTTP server...');
  
  server = app.listen(PORT, () => {
    console.log(`Server OTA (HTTP) berjalan di port ${PORT}`);
    console.log(`Buka http://localhost:${PORT} untuk dashboard`);
  });
}