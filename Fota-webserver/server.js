// server.js
const express = require('express');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = 3000;
const MQTT_PORT = 1883;
const MQTT_BROKER = 'mqtt://localhost';

// Import modul MQTT broker
const aedes = require('aedes')();
const net = require('net');

// Folder untuk menyimpan firmware
const FIRMWARE_DIR = path.join(__dirname, 'firmware');
const CHUNK_SIZE = 1024; // Default chunk size

// Pastikan direktori firmware ada
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR);
}

// Mulai MQTT Broker
const mqttServer = net.createServer(aedes.handle);
mqttServer.listen(MQTT_PORT, () => {
  console.log(`MQTT broker berjalan di port ${MQTT_PORT}`);
});

// Connect ke MQTT broker
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
  console.log('Server terhubung ke MQTT broker');
  mqttClient.subscribe('device/firmware/request');
});

// Handle permintaan firmware dari device
mqttClient.on('message', (topic, message) => {
  if (topic === 'device/firmware/request') {
    handleFirmwareRequest(message);
  }
});

// Fungsi untuk menangani permintaan firmware
function handleFirmwareRequest(message) {
  try {
    const request = JSON.parse(message.toString());
    const deviceId = request.device;
    const action = request.action;
    const currentVersion = request.version;
    
    console.log(`Permintaan firmware dari ${deviceId}, aksi: ${action}`);
    
    if (action === 'check') {
      // Kirim informasi firmware terbaru
      sendLatestFirmwareInfo(deviceId);
    } else if (action === 'download') {
      // Kirim chunk firmware
      const offset = request.offset;
      const size = request.size || CHUNK_SIZE;
      sendFirmwareChunk(deviceId, offset, size);
    }
  } catch (error) {
    console.error('Error handling firmware request:', error);
  }
}

// Fungsi untuk mengirim informasi firmware terbaru
function sendLatestFirmwareInfo(deviceId) {
  try {
    // Cari file firmware terbaru
    const files = fs.readdirSync(FIRMWARE_DIR);
    if (files.length === 0) {
      console.log('Tidak ada firmware tersedia');
      return;
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
      console.log('Tidak ada firmware tersedia');
      return;
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
      size: latestFirmware.size,
      md5: md5Hash
    };
    
    console.log(`Mengirim info firmware ke ${deviceId}: v${version}, size: ${latestFirmware.size}`);
    mqttClient.publish(`device/firmware/info`, JSON.stringify(firmwareInfo));
  } catch (error) {
    console.error('Error sending firmware info:', error);
  }
}

// Fungsi untuk mengirim chunk firmware
function sendFirmwareChunk(deviceId, offset, size) {
  try {
    // Cari file firmware terbaru
    const files = fs.readdirSync(FIRMWARE_DIR)
      .filter(file => file.endsWith('.bin'))
      .map(file => {
        const filePath = path.join(FIRMWARE_DIR, file);
        const stats = fs.statSync(filePath);
        return { name: file, path: filePath, size: stats.size, mtime: stats.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    
    if (files.length === 0) {
      console.log('Tidak ada firmware tersedia untuk chunk');
      return;
    }
    
    const firmware = files[0];
    const fileBuffer = fs.readFileSync(firmware.path);
    
    // Validasi offset dan size
    if (offset >= fileBuffer.length) {
      console.log(`Offset tidak valid: ${offset}, ukuran file: ${fileBuffer.length}`);
      return;
    }
    
    // Batasi size chunk
    const chunkSize = Math.min(size, fileBuffer.length - offset);
    const chunk = fileBuffer.slice(offset, offset + chunkSize);
    
    // Buat header JSON
    const header = JSON.stringify({
      offset: offset,
      size: chunkSize,
      total: fileBuffer.length
    });
    
    // Gabungkan header dan data binari dengan separator newline
    const message = Buffer.concat([
      Buffer.from(header + '\n'),
      chunk
    ]);
    
    console.log(`Mengirim chunk: offset=${offset}, size=${chunkSize}, total=${fileBuffer.length}`);
    mqttClient.publish(`device/firmware/data`, message);
  } catch (error) {
    console.error('Error sending firmware chunk:', error);
  }
}

// HTTP Server untuk upload dan manajemen firmware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API untuk upload firmware
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

// API untuk daftar firmware
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

// Api Status Checker
app.get('/api/status', (req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

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

// Mulai HTTP server
app.listen(PORT, () => {
  console.log(`HTTP server berjalan di port ${PORT}`);
});
