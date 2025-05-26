// ====== ENHANCED TCP SERVER WITH HTTP FOTA ======
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const zlib = require('zlib');

// Configuration
const app = express();
const PORT = 3000;
const TCP_PORT = 8266;

// FOTA Configuration
const FIRMWARE_DIR = path.join(__dirname, 'firmware');
const DEFAULT_CHUNK_SIZE = 512; // Optimized for mobile data
const MAX_CHUNK_SIZE = 1024;
const MIN_CHUNK_SIZE = 128;
const CONNECTION_TIMEOUT = 30000;
const CHUNK_RETRY_LIMIT = 3;

// Session Management
const activeSessions = new Map();
const deviceConnections = new Map();

// Performance metrics
const performanceMetrics = {
  totalConnections: 0,
  successfulDownloads: 0,
  failedDownloads: 0,
  averageSpeed: 0,
  chunksServed: 0,
  retryCount: 0,
  httpDownloads: 0,
  tcpDownloads: 0
};

// Ensure firmware directory exists
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

// ======= CRC16 CALCULATION FOR LENGTH PREFIXING =======
function calculateCRC16(data) {
  let crc = 0xFFFF;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xFFFF;
}

// ======= ENHANCED TCP SERVER IMPLEMENTATION =======
const tcpServer = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`🔌 ESP32 connected via TCP: ${clientId}`);
  
  // Connection management
  performanceMetrics.totalConnections++;
  deviceConnections.set(clientId, {
    socket: socket,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    chunksRequested: 0,
    bytesTransferred: 0,
    currentSession: null
  });
  
  socket.setTimeout(CONNECTION_TIMEOUT);
  let dataBuffer = Buffer.alloc(0);
  
  socket.on('data', (data) => {
    updateLastActivity(clientId);
    dataBuffer = Buffer.concat([dataBuffer, data]);
    
    // Process complete messages (ended with newline)
    let messages = [];
    let startIndex = 0;
    
    for (let i = 0; i < dataBuffer.length; i++) {
      if (dataBuffer[i] === 0x0A) { // newline
        const messageBuffer = dataBuffer.slice(startIndex, i);
        messages.push(messageBuffer.toString().trim());
        startIndex = i + 1;
      }
    }
    
    dataBuffer = dataBuffer.slice(startIndex);
    
    messages.forEach(message => {
      if (message.length > 0) {
        handleTcpRequest(socket, message, clientId);
      }
    });
  });
  
  socket.on('close', () => {
    console.log(`🔌 ESP32 disconnected: ${clientId}`);
    cleanupConnection(clientId);
  });
  
  socket.on('error', (err) => {
    console.error(`🚨 TCP socket error for ${clientId}:`, err.message);
    cleanupConnection(clientId);
  });
  
  socket.on('timeout', () => {
    console.warn(`⏰ Connection timeout for ${clientId}`);
    socket.destroy();
    cleanupConnection(clientId);
  });
});

function updateLastActivity(clientId) {
  const connection = deviceConnections.get(clientId);
  if (connection) {
    connection.lastActivity = Date.now();
  }
}

function cleanupConnection(clientId) {
  const connection = deviceConnections.get(clientId);
  if (connection && connection.currentSession) {
    // Mark session as interrupted but keep it for resume
    const session = activeSessions.get(connection.currentSession);
    if (session) {
      session.interrupted = true;
      session.interruptedAt = Date.now();
    }
  }
  deviceConnections.delete(clientId);
}

// Enhanced request handler
async function handleTcpRequest(socket, message, clientId) {
  const startTime = Date.now();
  
  try {
    const request = JSON.parse(message);
    const deviceId = request.device || 'unknown';
    const action = request.action;
    
    console.log(`📨 TCP Request from ${deviceId} (${clientId}): ${action}`);
    
    const connection = deviceConnections.get(clientId);
    if (connection) {
      connection.chunksRequested++;
    }
    
    switch (action) {
      case 'check':
        await handleFirmwareCheck(socket, deviceId, request, clientId);
        break;
        
      case 'download':
        await handleFirmwareDownload(socket, deviceId, request, clientId);
        break;
        
      case 'verify':
        await handleFirmwareVerify(socket, deviceId, request, clientId);
        break;
        
      case 'resume':
        await handleDownloadResume(socket, deviceId, request, clientId);
        break;
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    const processingTime = Date.now() - startTime;
    console.log(`⚡ Request processed in ${processingTime}ms`);
    
  } catch (error) {
    console.error(`🚨 Error handling TCP request from ${clientId}:`, error.message);
    await sendTcpResponse(socket, {
      status: 'error',
      message: error.message,
      code: 'REQUEST_ERROR'
    });
  }
}

// Enhanced firmware check with session management
async function handleFirmwareCheck(socket, deviceId, request, clientId) {
  try {
    const firmwareInfo = await getLatestFirmwareInfo();
    
    if (!firmwareInfo) {
      return sendTcpResponse(socket, {
        status: 'error',
        message: 'No firmware available',
        code: 'NO_FIRMWARE'
      });
    }
    
    // Check if there's an existing session for this device
    let existingSession = null;
    for (let [sessionId, session] of activeSessions.entries()) {
      if (session.deviceId === deviceId && !session.completed) {
        existingSession = { sessionId, session };
        break;
      }
    }
    
    let sessionId, session;
    
    if (existingSession && existingSession.session.firmwareInfo.version === firmwareInfo.version) {
      // Resume existing session
      sessionId = existingSession.sessionId;
      session = existingSession.session;
      session.interrupted = false;
      console.log(`🔄 Resuming existing session for ${deviceId}: ${sessionId}`);
    } else {
      // Create new session
      sessionId = generateSessionId();
      sessionId = sessionId.substring(0, 16); // Shorter session ID
      
      session = {
        sessionId,
        clientId,
        deviceId,
        firmwareInfo,
        startTime: Date.now(),
        chunks: new Map(),
        totalChunks: Math.ceil(firmwareInfo.size / DEFAULT_CHUNK_SIZE),
        downloadedChunks: 0,
        lastOffset: 0,
        completed: false,
        interrupted: false
      };
      
      activeSessions.set(sessionId, session);
      console.log(`✨ Created new session for ${deviceId}: ${sessionId}`);
    }
    
    // Update connection session
    const connection = deviceConnections.get(clientId);
    if (connection) {
      connection.currentSession = sessionId;
    }
    
    const response = {
      status: 'success',
      version: firmwareInfo.version,
      name: firmwareInfo.name,
      size: firmwareInfo.size,
      md5: firmwareInfo.md5,
      sha256: firmwareInfo.sha256,
      sessionId: sessionId,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks: session.totalChunks,
      resumeOffset: session.lastOffset,
      downloadedChunks: session.downloadedChunks,
      compressionSupported: true,
      // Add HTTP download URL
      httpDownloadUrl: `http://localhost:${PORT}/api/firmware/download/${firmwareInfo.name}`
    };
    
    console.log(`✅ Firmware check for ${deviceId}: v${firmwareInfo.version}, ${firmwareInfo.size} bytes, resume=${session.lastOffset}`);
    await sendTcpResponse(socket, response);
    
  } catch (error) {
    console.error('Error in firmware check:', error);
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  }
}

// Enhanced firmware download with length prefixing
async function handleFirmwareDownload(socket, deviceId, request, clientId) {
  try {
    const offset = request.offset || 0;
    let chunkSize = request.size || DEFAULT_CHUNK_SIZE;
    const sessionId = request.sessionId;
    const useCompression = request.compression || false;
    
    // Validate session
    const session = activeSessions.get(sessionId);
    if (!session) {
      return sendTcpResponse(socket, {
        status: 'error',
        message: 'Invalid or expired session',
        code: 'INVALID_SESSION'
      });
    }
    
    // Adaptive chunk sizing
    const connection = deviceConnections.get(clientId);
    if (connection && connection.chunksRequested > 5) {
      const errorRate = (performanceMetrics.retryCount / connection.chunksRequested);
      if (errorRate > 0.15) { // Lower threshold for mobile networks
        chunkSize = Math.max(MIN_CHUNK_SIZE, chunkSize / 2);
        console.log(`📉 Reducing chunk size to ${chunkSize} due to error rate: ${(errorRate*100).toFixed(1)}%`);
      }
    }
    
    chunkSize = Math.min(chunkSize, MAX_CHUNK_SIZE);
    chunkSize = Math.max(chunkSize, MIN_CHUNK_SIZE);
    
    const firmwareData = await getFirmwareChunk(session.firmwareInfo.path, offset, chunkSize);
    
    if (!firmwareData) {
      return sendTcpResponse(socket, {
        status: 'error',
        message: 'Failed to read firmware data',
        code: 'READ_ERROR'
      });
    }
    
    // Calculate data CRC16 for integrity
    const dataCrc16 = calculateCRC16(firmwareData.chunk);
    
    // Optional compression
    let finalChunk = firmwareData.chunk;
    let compressed = false;
    
    if (useCompression && firmwareData.chunk.length > 100) {
      try {
        const compressedChunk = zlib.gzipSync(firmwareData.chunk);
        if (compressedChunk.length < firmwareData.chunk.length * 0.85) {
          finalChunk = compressedChunk;
          compressed = true;
          console.log(`🗜️ Compressed ${firmwareData.chunk.length} → ${compressedChunk.length} bytes`);
        }
      } catch (compError) {
        console.warn('Compression failed, using uncompressed data');
      }
    }
    
    // OPTIMIZED HEADER - Length Prefixing Approach
    const minimalHeader = {
      s: finalChunk.length,           // Size (length prefixing!)
      o: offset,                      // Offset
      c: dataCrc16,                   // CRC16 of original data
      f: compressed ? 1 : 0,          // Flags (compressed bit)
      p: Math.floor(((offset + firmwareData.actualSize) / firmwareData.totalSize) * 100),
      id: session.totalChunks > 255 ? Math.floor(offset / DEFAULT_CHUNK_SIZE) : Math.floor(offset / DEFAULT_CHUNK_SIZE) & 0xFF // Chunk ID
    };
    
    // Calculate header CRC
    const headerString = JSON.stringify(minimalHeader);
    const headerCrc16 = calculateCRC16(headerString);
    minimalHeader.h = headerCrc16;
    
    // Update session progress
    session.chunks.set(offset, {
      offset,
      size: firmwareData.actualSize,
      crc: dataCrc16,
      timestamp: Date.now()
    });
    session.downloadedChunks++;
    session.lastOffset = Math.max(session.lastOffset, offset + firmwareData.actualSize);
    
    // Update connection stats
    if (connection) {
      connection.bytesTransferred += firmwareData.actualSize;
    }
    
    performanceMetrics.chunksServed++;
    performanceMetrics.tcpDownloads++;
    
    console.log(`📦 Chunk: offset=${offset}, size=${firmwareData.actualSize}→${finalChunk.length}, crc=${dataCrc16}, comp=${compressed}, prog=${minimalHeader.p}%`);
    
    // Send response with LENGTH PREFIXED binary data
    await sendTcpResponseWithLengthPrefix(socket, minimalHeader, finalChunk);
    
  } catch (error) {
    console.error('Error in firmware download:', error);
    performanceMetrics.retryCount++;
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Download failed',
      code: 'DOWNLOAD_ERROR',
      retryable: true
    });
  }
}

// Enhanced resume handler
async function handleDownloadResume(socket, deviceId, request, clientId) {
  try {
    const sessionId = request.sessionId;
    
    const session = activeSessions.get(sessionId);
    if (!session) {
      return sendTcpResponse(socket, {
        status: 'error',
        message: 'Invalid session',
        code: 'INVALID_SESSION'
      });
    }
    
    // Update connection reference
    const connection = deviceConnections.get(clientId);
    if (connection) {
      connection.currentSession = sessionId;
    }
    
    session.clientId = clientId; // Update client ID
    session.interrupted = false;
    
    const response = {
      status: 'success',
      lastOffset: session.lastOffset,
      downloadedChunks: session.downloadedChunks,
      totalChunks: session.totalChunks,
      resumeAvailable: true,
      sessionId: sessionId,
      firmwareSize: session.firmwareInfo.size,
      chunkSize: DEFAULT_CHUNK_SIZE
    };
    
    console.log(`🔄 Resume for ${deviceId}: offset=${session.lastOffset}, chunks=${session.downloadedChunks}/${session.totalChunks}`);
    await sendTcpResponse(socket, response);
    
  } catch (error) {
    console.error('Error in download resume:', error);
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Resume failed',
      code: 'RESUME_ERROR'
    });
  }
}

// Enhanced verification with SHA256 support
async function handleFirmwareVerify(socket, deviceId, request, clientId) {
  try {
    const sessionId = request.sessionId;
    const clientHash = request.hash;
    const hashType = request.hashType || 'md5';
    
    const session = activeSessions.get(sessionId);
    if (!session) {
      return sendTcpResponse(socket, {
        status: 'error',
        message: 'Invalid session',
        code: 'INVALID_SESSION'
      });
    }
    
    const expectedHash = hashType === 'sha256' ? 
      session.firmwareInfo.sha256 : session.firmwareInfo.md5;
    
    const isValid = clientHash.toLowerCase() === expectedHash.toLowerCase();
    
    const response = {
      status: 'success',
      verified: isValid,
      expectedHash: expectedHash,
      receivedHash: clientHash,
      hashType: hashType,
      message: isValid ? 'Firmware integrity verified' : 'Hash mismatch detected'
    };
    
    if (isValid) {
      session.completed = true;
      performanceMetrics.successfulDownloads++;
      console.log(`✅ Firmware verification successful for ${deviceId} (${hashType.toUpperCase()})`);
    } else {
      performanceMetrics.failedDownloads++;
      console.log(`❌ Firmware verification failed for ${deviceId} (${hashType.toUpperCase()})`);
    }
    
    await sendTcpResponse(socket, response);
    
  } catch (error) {
    console.error('Error in firmware verification:', error);
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Verification failed',
      code: 'VERIFY_ERROR'
    });
  }
}

// Enhanced firmware info with dual hash calculation
async function getLatestFirmwareInfo() {
  try {
    const files = fs.readdirSync(FIRMWARE_DIR);
    const firmwareFiles = files
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
    
    if (firmwareFiles.length === 0) {
      return null;
    }
    
    const latestFirmware = firmwareFiles[0];
    const versionMatch = latestFirmware.name.match(/_v(\d+\.\d+\.\d+)\.bin$/);
    const version = versionMatch ? versionMatch[1] : '1.0.0';
    
    // Calculate both hashes efficiently
    const fileBuffer = fs.readFileSync(latestFirmware.path);
    const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    return {
      name: latestFirmware.name,
      path: latestFirmware.path,
      version: version,
      size: latestFirmware.size,
      md5: md5Hash,
      sha256: sha256Hash,
      mtime: latestFirmware.mtime
    };
    
  } catch (error) {
    console.error('Error getting firmware info:', error);
    return null;
  }
}

async function getFirmwareChunk(filePath, offset, requestedSize) {
  try {
    const stats = fs.statSync(filePath);
    const totalSize = stats.size;
    
    if (offset >= totalSize) {
      throw new Error(`Invalid offset: ${offset}, file size: ${totalSize}`);
    }
    
    const actualSize = Math.min(requestedSize, totalSize - offset);
    const fileHandle = fs.openSync(filePath, 'r');
    const chunk = Buffer.alloc(actualSize);
    
    const bytesRead = fs.readSync(fileHandle, chunk, 0, actualSize, offset);
    fs.closeSync(fileHandle);
    
    if (bytesRead !== actualSize) {
      throw new Error(`Read mismatch: expected ${actualSize}, got ${bytesRead}`);
    }
    
    return {
      chunk: chunk,
      actualSize: actualSize,
      totalSize: totalSize
    };
    
  } catch (error) {
    console.error('Error reading firmware chunk:', error);
    return null;
  }
}

// Standard JSON response
async function sendTcpResponse(socket, responseObject) {
  return new Promise((resolve, reject) => {
    try {
      const responseStr = JSON.stringify(responseObject) + '\n';
      socket.write(responseStr, (err) => {
        if (err) {
          console.error('Error sending TCP response:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (error) {
      console.error('Error creating TCP response:', error);
      reject(error);
    }
  });
}

// NEW: Length-prefixed binary response
async function sendTcpResponseWithLengthPrefix(socket, header, binaryData) {
  return new Promise((resolve, reject) => {
    try {
      // Create the response with length prefixing
      const headerStr = JSON.stringify(header) + '\n';
      const headerBuffer = Buffer.from(headerStr);
      
      // The header already contains 's' field with binary data length
      // ESP32 will read exactly header.s bytes after parsing JSON
      const responseBuffer = Buffer.concat([headerBuffer, binaryData]);
      
      socket.write(responseBuffer, (err) => {
        if (err) {
          console.error('Error sending length-prefixed response:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (error) {
      console.error('Error creating length-prefixed response:', error);
      reject(error);
    }
  });
}

function generateSessionId() {
  return crypto.randomBytes(8).toString('hex'); // Shorter session IDs
}

// Enhanced session cleanup
setInterval(() => {
  const now = Date.now();
  const SESSION_TIMEOUT = 45 * 60 * 1000; // 45 minutes
  const INTERRUPTED_TIMEOUT = 10 * 60 * 1000; // 10 minutes for interrupted sessions
  
  for (let [sessionId, session] of activeSessions.entries()) {
    const age = now - session.startTime;
    const shouldCleanup = session.completed || 
      (session.interrupted && (now - session.interruptedAt) > INTERRUPTED_TIMEOUT) ||
      age > SESSION_TIMEOUT;
    
    if (shouldCleanup) {
      console.log(`🧹 Cleaning up session: ${sessionId} (${session.completed ? 'completed' : session.interrupted ? 'interrupted' : 'expired'})`);
      activeSessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// ======= HTTP FOTA ENDPOINTS =======

// HTTP Firmware Check
app.get('/api/fota/check', async (req, res) => {
  try {
    const deviceId = req.query.device || req.headers['user-agent'] || 'unknown';
    const currentVersion = req.query.version || '0.0.0';
    
    console.log(`🌐 HTTP FOTA check from device: ${deviceId}, current version: ${currentVersion}`);
    
    const firmwareInfo = await getLatestFirmwareInfo();
    
    if (!firmwareInfo) {
      return res.status(404).json({
        status: 'error',
        message: 'No firmware available',
        code: 'NO_FIRMWARE'
      });
    }
    
    const updateAvailable = firmwareInfo.version !== currentVersion;
    
    const response = {
      status: 'success',
      updateAvailable: updateAvailable,
      version: firmwareInfo.version,
      name: firmwareInfo.name,
      size: firmwareInfo.size,
      md5: firmwareInfo.md5,
      sha256: firmwareInfo.sha256,
      downloadUrl: `/api/fota/download/${firmwareInfo.name}`,
      fullDownloadUrl: `http://localhost:${PORT}/api/fota/download/${firmwareInfo.name}`
    };
    
    console.log(`✅ HTTP FOTA check result: ${updateAvailable ? 'Update available' : 'Up to date'} - v${firmwareInfo.version}`);
    res.json(response);
    
  } catch (error) {
    console.error('Error in HTTP FOTA check:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  }
});

// HTTP Firmware Download - Full file without chunking
app.get('/api/fota/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(FIRMWARE_DIR, filename);
    const deviceId = req.query.device || req.headers['user-agent'] || 'unknown';
    
    console.log(`📥 HTTP FOTA download request from ${deviceId}: ${filename}`);
    
    // Verify file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        status: 'error',
        message: 'Firmware file not found',
        code: 'FILE_NOT_FOUND'
      });
    }
    
    // Get file stats
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    
    // Calculate MD5 for integrity check
    const fileBuffer = fs.readFileSync(filePath);
    const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    // Set appropriate headers
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Firmware-MD5', md5Hash);
    res.setHeader('X-Firmware-SHA256', sha256Hash);
    res.setHeader('X-Firmware-Size', fileSize);
    res.setHeader('Cache-Control', 'no-cache');
    
    console.log(`📦 Sending full firmware file: ${filename} (${fileSize} bytes, MD5: ${md5Hash})`);
    
    // Track download
    performanceMetrics.httpDownloads++;
    const startTime = Date.now();
    
    // Send the entire file
    const fileStream = fs.createReadStream(filePath);
    
    fileStream.on('end', () => {
      const downloadTime = Date.now() - startTime;
      const speedKBps = Math.round((fileSize / 1024) / (downloadTime / 1000));
      console.log(`✅ HTTP FOTA download completed for ${deviceId}: ${filename} in ${downloadTime}ms (${speedKBps} KB/s)`);
      performanceMetrics.successfulDownloads++;
    });
    
    fileStream.on('error', (error) => {
      console.error(`❌ HTTP FOTA download error for ${deviceId}:`, error);
      performanceMetrics.failedDownloads++;
    });
    
    fileStream.pipe(res);
    
  } catch (error) {
    console.error('Error in HTTP FOTA download:', error);
    performanceMetrics.failedDownloads++;
    res.status(500).json({
      status: 'error',
      message: 'Download failed',
      code: 'DOWNLOAD_ERROR'
    });
  }
});

// HTTP Firmware Verify
app.post('/api/fota/verify', express.json(), async (req, res) => {
  try {
    const { filename, hash, hashType = 'md5' } = req.body;
    const deviceId = req.body.device || req.headers['user-agent'] || 'unknown';
    
    console.log(`🔍 HTTP FOTA verify request from ${deviceId}: ${filename} (${hashType.toUpperCase()})`);
    
    if (!filename || !hash) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing filename or hash',
        code: 'MISSING_PARAMETERS'
      });
    }
    
    const filePath = path.join(FIRMWARE_DIR, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        status: 'error',
        message: 'Firmware file not found',
        code: 'FILE_NOT_FOUND'
      });
    }
    
    // Calculate expected hash
    const fileBuffer = fs.readFileSync(filePath);
    const expectedHash = hashType === 'sha256' ? 
      crypto.createHash('sha256').update(fileBuffer).digest('hex') :
      crypto.createHash('md5').update(fileBuffer).digest('hex');
    
    const isValid = hash.toLowerCase() === expectedHash.toLowerCase();
    
    const response = {
      status: 'success',
      verified: isValid,
      expectedHash: expectedHash,
      receivedHash: hash,
      hashType: hashType,
      message: isValid ? 'Firmware integrity verified' : 'Hash mismatch detected'
    };
    
    if (isValid) {
      console.log(`✅ HTTP FOTA verification successful for ${deviceId} (${hashType.toUpperCase()})`);
    } else {
      console.log(`❌ HTTP FOTA verification failed for ${deviceId} (${hashType.toUpperCase()})`);
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Error in HTTP FOTA verification:', error);
    res.status(500).json({
      status: 'error',
      message: 'Verification failed',
      code: 'VERIFY_ERROR'
    });
  }
});

// Enhanced metrics
app.get('/api/metrics', (req, res) => {
  const activeConnectionCount = deviceConnections.size;
  const activeSessionCount = activeSessions.size;
  
  const sessionsInfo = Array.from(activeSessions.values()).map(s => ({
    id: s.sessionId,
    device: s.deviceId,
    progress: Math.floor((s.lastOffset / s.firmwareInfo.size) * 100),
    interrupted: s.interrupted,
    completed: s.completed,
    age: Math.floor((Date.now() - s.startTime) / 1000)
  }));
  
  const metrics = {
    ...performanceMetrics,
    activeConnections: activeConnectionCount,
    activeSessions: activeSessionCount,
    sessions: sessionsInfo,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  };
  
  res.json(metrics);
});

// Start servers
tcpServer.listen(TCP_PORT, () => {
  console.log(`🚀 Enhanced TCP FOTA server with Length Prefixing running on port ${TCP_PORT}`);
  console.log(`📊 Chunk size range: ${MIN_CHUNK_SIZE}-${MAX_CHUNK_SIZE} bytes`);
  console.log(`🔧 Features: Length prefixing, CRC16, Resume, Compression, SHA256`);
});

tcpServer.on('error', (err) => {
  console.error('🚨 TCP server error:', err);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  tcpServer.close(() => {
    console.log('✅ TCP server closed');
    process.exit(0);
  });
});

// HTTP server setup
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Firmware upload endpoint
app.post('/api/firmware/upload', express.raw({ type: 'application/octet-stream', limit: '8mb' }), (req, res) => {
  try {
    // Get version from query parameter
    const version = req.query.version || '1.0.0';
    const fileName = `esp32_firmware_v${version}.bin`;
    const filePath = path.join(FIRMWARE_DIR, fileName);
    
    // Write firmware file
    fs.writeFileSync(filePath, req.body);
    
    // Calculate MD5 and SHA256 hash
    const md5Hash = crypto.createHash('md5').update(req.body).digest('hex');
    const sha256Hash = crypto.createHash('sha256').update(req.body).digest('hex');
    
    console.log(`📤 Firmware uploaded: ${fileName} (${req.body.length} bytes, MD5: ${md5Hash})`);
    
    res.json({
      success: true,
      fileName: fileName,
      size: req.body.length,
      md5: md5Hash,
      sha256: sha256Hash,
      version: version
    });
  } catch (error) {
    console.error('Error uploading firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List firmware files
app.get('/api/firmware/list', (req, res) => {
  try {
    const files = fs.readdirSync(FIRMWARE_DIR)
      .filter(file => file.endsWith('.bin'))
      .map(file => {
        const filePath = path.join(FIRMWARE_DIR, file);
        const stats = fs.statSync(filePath);
        const fileBuffer = fs.readFileSync(filePath);
        const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
        const sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        
        // Extract version from filename
        const versionMatch = file.match(/_v(\d+\.\d+\.\d+)\.bin$/);
        const version = versionMatch ? versionMatch[1] : 'unknown';
        
        return {
          name: file,
          version: version,
          size: stats.size,
          date: stats.mtime,
          md5: md5Hash,
          sha256: sha256Hash
        };
      })
      .sort((a, b) => b.date - a.date);
    
    res.json(files);
  } catch (error) {
    console.error('Error listing firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Status check endpoint
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'running', 
    timestamp: new Date().toISOString(),
    tcp_port: TCP_PORT,
    http_port: PORT,
    features: {
      tcp_fota: true,
      http_fota: true,
      chunked_download: true,
      full_download: true,
      compression: true,
      resume: true,
      dual_hash: true
    }
  });
});

// Latest firmware info
app.get('/api/firmware/latest', async (req, res) => {
  try {
    const firmwareInfo = await getLatestFirmwareInfo();
    
    if (!firmwareInfo) {
      return res.status(404).json({ error: 'No firmware available' });
    }
    
    const response = {
      version: firmwareInfo.version,
      name: firmwareInfo.name,
      file: `firmware/${firmwareInfo.name}`,
      size: firmwareInfo.size,
      md5: firmwareInfo.md5,
      sha256: firmwareInfo.sha256,
      date: firmwareInfo.mtime,
      // Add direct download URLs
      tcpDownload: `tcp://localhost:${TCP_PORT}`,
      httpDownload: `http://localhost:${PORT}/api/fota/download/${firmwareInfo.name}`,
      checkUrl: `http://localhost:${PORT}/api/fota/check`
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error accessing firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete firmware
app.delete('/api/firmware/delete/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(FIRMWARE_DIR, filename);
    
    // Verify file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Verify it's a .bin file
    if (!filename.endsWith('.bin')) {
      return res.status(400).json({ error: 'Only .bin firmware files can be deleted' });
    }
    
    // Delete file
    fs.unlinkSync(filePath);
    
    console.log(`🗑️ Firmware deleted: ${filename}`);
    
    res.json({
      success: true,
      message: `Firmware ${filename} successfully deleted`
    });
  } catch (error) {
    console.error('Error deleting firmware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy firmware download endpoint (for backward compatibility)
app.get('/api/firmware/download/:filename', (req, res) => {
  // Redirect to FOTA download endpoint
  res.redirect(`/api/fota/download/${req.params.filename}`);
});

app.listen(PORT, () => {
  console.log(`📊 HTTP server running on port ${PORT}`);
  console.log(`🌐 HTTP FOTA endpoints available:`);
  console.log(`   • Check: GET /api/fota/check?device=<device_id>&version=<current_version>`);
  console.log(`   • Download: GET /api/fota/download/<filename>?device=<device_id>`);
  console.log(`   • Verify: POST /api/fota/verify`);
  console.log(`📡 TCP FOTA server running on port ${TCP_PORT}`);
  console.log(`🔧 Both TCP chunked and HTTP full-file downloads supported`);
});