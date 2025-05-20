// ====== TCP SERVER FOR ESP32 FOTA ======
// Import modul yang diperlukan
const express = require('express');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

// Import konfigurasi dari server yang ada
const app = express();
const PORT = 3000;
const MQTT_PORT = 1883;
const MQTT_BROKER = 'mqtt://localhost';
const TCP_PORT = 8266; // Port untuk koneksi TCP dari ESP32

// Import modul MQTT broker
const aedes = require('aedes')();

// Folder untuk menyimpan firmware
const FIRMWARE_DIR = path.join(__dirname, 'firmware');
const CHUNK_SIZE = 1024; // Default chunk size

// Pastikan direktori firmware ada
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR);
}

// ======= IMPLEMENTASI SERVER TCP =======
// Membuat server TCP
const tcpServer = net.createServer((socket) => {
  console.log('ESP32 terhubung melalui TCP:', socket.remoteAddress + ':' + socket.remotePort);
  
  // Data buffer untuk menerima request dari ESP32
  let dataBuffer = Buffer.alloc(0);
  
  // Event ketika menerima data dari ESP32
  socket.on('data', (data) => {
    // Menggabungkan buffer data
    dataBuffer = Buffer.concat([dataBuffer, data]);
    
    // Cek apakah message sudah lengkap (diakhiri dengan newline)
    if (data.includes('\n')) {
      try {
        // Parse pesan dari ESP32
        const message = dataBuffer.toString().trim();
        console.log('Pesan diterima dari ESP32:', message);
        
        // Reset buffer setelah memproses pesan
        dataBuffer = Buffer.alloc(0);
        
        // Handle request dari ESP32
        handleTcpRequest(socket, message);
      } catch (error) {
        console.error('Error memproses pesan TCP:', error);
      }
    }
  });
  
  // Event ketika koneksi terputus
  socket.on('close', () => {
    console.log('ESP32 terputus:', socket.remoteAddress + ':' + socket.remotePort);
  });
  
  // Event ketika terjadi error
  socket.on('error', (err) => {
    console.error('TCP socket error:', err);
  });
});

// Fungsi untuk menangani request dari ESP32 via TCP
function handleTcpRequest(socket, message) {
  try {
    // Parse JSON request dari ESP32
    const request = JSON.parse(message);
    
    // Ambil informasi dari request
    const deviceId = request.device || 'unknown';
    const action = request.action;
    
    console.log(`Permintaan TCP dari ${deviceId}, aksi: ${action}`);
    
    // Handle berbagai jenis action
    if (action === 'check') {
      // Kirim informasi firmware terbaru
      sendLatestFirmwareInfoTcp(socket, deviceId);
    } else if (action === 'download') {
      // Kirim chunk firmware
      const offset = request.offset || 0;
      const size = request.size || CHUNK_SIZE;
      sendFirmwareChunkTcp(socket, deviceId, offset, size);
    } else {
      // Aksi tidak dikenal
      sendTcpResponse(socket, {
        status: 'error',
        message: 'Unknown action'
      });
    }
  } catch (error) {
    console.error('Error handling TCP request:', error);
    sendTcpResponse(socket, {
      status: 'error',
      message: 'Invalid request format'
    });
  }
}

// Fungsi untuk mengirim informasi firmware terbaru melalui TCP
function sendLatestFirmwareInfoTcp(socket, deviceId) {
  try {
    // Cari file firmware terbaru
    const files = fs.readdirSync(FIRMWARE_DIR);
    if (files.length === 0) {
      console.log('Tidak ada firmware tersedia');
      sendTcpResponse(socket, {
        status: 'error',
        message: 'No firmware available'
      });
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
      sendTcpResponse(socket, {
        status: 'error',
        message: 'No firmware available'
      });
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
      status: 'success',
      version: version,
      name: latestFirmware.name,
      size: latestFirmware.size,
      md5: md5Hash
    };
    
    console.log(`Mengirim info firmware ke ${deviceId} via TCP: v${version}, size: ${latestFirmware.size}`);
    sendTcpResponse(socket, firmwareInfo);
  } catch (error) {
    console.error('Error sending firmware info via TCP:', error);
    sendTcpResponse(socket, {
      status: 'error',
      message: 'Internal server error'
    });
  }
}

// Fungsi untuk mengirim chunk firmware melalui TCP
function sendFirmwareChunkTcp(socket, deviceId, offset, size) {
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
      sendTcpResponse(socket, {
        status: 'error',
        message: 'No firmware available'
      });
      return;
    }
    
    const firmware = files[0];
    const fileBuffer = fs.readFileSync(firmware.path);
    
    // Validasi offset dan size
    if (offset >= fileBuffer.length) {
      console.log(`Offset tidak valid: ${offset}, ukuran file: ${fileBuffer.length}`);
      sendTcpResponse(socket, {
        status: 'error',
        message: 'Invalid offset',
        offset: offset,
        size: fileBuffer.length
      });
      return;
    }
    
    // Batasi size chunk
    const chunkSize = Math.min(size, fileBuffer.length - offset);
    const chunk = fileBuffer.slice(offset, offset + chunkSize);
    
    // Buat header JSON
    const header = {
      status: 'success',
      offset: offset,
      size: chunkSize,
      total: fileBuffer.length,
      remaining: fileBuffer.length - (offset + chunkSize),
      position: parseFloat(((offset + chunkSize) / fileBuffer.length * 100).toFixed(2)) // Persentase
    };
    
    console.log(`Mengirim chunk: offset=${offset}, size=${chunkSize}, total=${fileBuffer.length}, percent=${header.position}%`);

    // Convert header ke string dan tambahkan separator
    const headerStr = JSON.stringify(header) + '\n';
    const headerBuffer = Buffer.from(headerStr);
    
    // Gabungkan header dan data binary
    const responseBuffer = Buffer.concat([headerBuffer, chunk]);
    
    // Kirim ke ESP32
    socket.write(responseBuffer, (err) => {
      if (err) {
        console.error('Error mengirim chunk firmware via TCP:', err);
      }
    });
  } catch (error) {
    console.error('Error sending firmware chunk via TCP:', error);
    sendTcpResponse(socket, {
      status: 'error',
      message: 'Internal server error'
    });
  }
}

// Fungsi untuk mengirim response JSON melalui TCP
function sendTcpResponse(socket, responseObject) {
  try {
    const responseStr = JSON.stringify(responseObject) + '\n';
    socket.write(responseStr, (err) => {
      if (err) {
        console.error('Error sending TCP response:', err);
      }
    });
  } catch (error) {
    console.error('Error creating TCP response:', error);
  }
}

// Mulai TCP server
tcpServer.listen(TCP_PORT, () => {
  console.log(`TCP server berjalan di port ${TCP_PORT}`);
});

// ======= IMPLEMENTASI DARI SERVER YANG SUDAH ADA =======

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

// Handle permintaan firmware dari device melalui MQTT
mqttClient.on('message', (topic, message) => {
  if (topic === 'device/firmware/request') {
    handleFirmwareRequest(message);
  }
});

// Fungsi untuk menangani permintaan firmware melalui MQTT
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

// Fungsi untuk mengirim informasi firmware terbaru melalui MQTT
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

// Fungsi untuk mengirim chunk firmware melalui MQTT
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
  res.json({ 
    status: 'running', 
    timestamp: new Date().toISOString(),
    tcp_port: TCP_PORT,
    mqtt_port: MQTT_PORT
  });
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

// Delete Firmware from the list
app.delete('/api/firmware/delete/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(FIRMWARE_DIR, filename);
    
    // Verifikasi bahwa file ada
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File tidak ditemukan' });
    }
    
    // Verifikasi bahwa file adalah firmware .bin
    if (!filename.endsWith('.bin')) {
      return res.status(400).json({ error: 'Hanya file firmware .bin yang dapat dihapus' });
    }
    
    // Hapus file
    fs.unlinkSync(filePath);
    
    res.json({
      success: true,
      message: `Firmware ${filename} berhasil dihapus`
    });
  } catch (error) {
    console.error('Error deleting firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mulai HTTP server
app.listen(PORT, () => {
  console.log(`HTTP server berjalan di port ${PORT}`);
});