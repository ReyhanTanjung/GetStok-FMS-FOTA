// ====== ENHANCED FOTA SERVER WITH HTTP AND TCP SUPPORT ======
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const zlib = require('zlib');

// Configuration
const app = express();
const HTTP_PORT = 3000;
const TCP_PORT = 8266;

// FOTA Configuration
const FIRMWARE_DIR = path.join(__dirname, 'firmware');
const DEFAULT_CHUNK_SIZE = 512; // Only for TCP
const MAX_CHUNK_SIZE = 1024;
const MIN_CHUNK_SIZE = 128;
const CONNECTION_TIMEOUT = 30000;
const CHUNK_RETRY_LIMIT = 3;

// Session Management (Only for TCP)
const activeSessions = new Map();
const deviceConnections = new Map();

// Performance metrics
const performanceMetrics = {
  totalConnections: 0,
  successfulDownloads: 0,
  failedDownloads: 0,
  httpDownloads: 0,
  tcpDownloads: 0,
  averageSpeed: 0,
  chunksServed: 0,
  retryCount: 0
};

// Ensure firmware directory exists
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

// ======= HTTP FOTA ENDPOINTS =======

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTTP: Check firmware version
app.get('/api/firmware/check', async (req, res) => {
  try {
    const deviceId = req.query.device || req.headers['x-device-id'] || 'unknown';
    const currentVersion = req.query.version || req.headers['x-current-version'] || '0.0.0';
    
    console.log(`🌐 HTTP Firmware check from device: ${deviceId}, current version: ${currentVersion}`);
    
    const firmwareInfo = await getLatestFirmwareInfo();
    
    if (!firmwareInfo) {
      return res.status(404).json({
        status: 'error',
        message: 'No firmware available',
        code: 'NO_FIRMWARE'
      });
    }
    
    const hasUpdate = isNewerVersion(firmwareInfo.version, currentVersion);
    
    const response = {
      status: 'success',
      updateAvailable: hasUpdate,
      version: firmwareInfo.version,
      currentVersion: currentVersion,
      name: firmwareInfo.name,
      size: firmwareInfo.size,
      md5: firmwareInfo.md5,
      sha256: firmwareInfo.sha256,
      downloadUrl: `/api/firmware/download`,
      releaseNotes: `Firmware version ${firmwareInfo.version}`
    };
    
    console.log(`✅ HTTP Firmware check response: update=${hasUpdate}, latest=${firmwareInfo.version}`);
    res.json(response);
    
  } catch (error) {
    console.error('HTTP Firmware check error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  }
});

// HTTP: Download firmware (direct download, no chunking)
app.get('/api/firmware/download', async (req, res) => {
  try {
    const deviceId = req.query.device || req.headers['x-device-id'] || 'unknown';
    const acceptCompression = req.headers['accept-encoding']?.includes('gzip') || req.query.compress === 'true';
    
    console.log(`📥 HTTP Firmware download request from device: ${deviceId}, compression: ${acceptCompression}`);
    
    const firmwareInfo = await getLatestFirmwareInfo();
    
    if (!firmwareInfo) {
      return res.status(404).json({
        status: 'error',
        message: 'No firmware available',
        code: 'NO_FIRMWARE'
      });
    }
    
    const startTime = Date.now();
    
    // Read firmware file
    const firmwareBuffer = fs.readFileSync(firmwareInfo.path);
    
    // Set headers
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${firmwareInfo.name}"`);
    res.setHeader('X-Firmware-Version', firmwareInfo.version);
    res.setHeader('X-Firmware-Size', firmwareInfo.size.toString());
    res.setHeader('X-Firmware-MD5', firmwareInfo.md5);
    res.setHeader('X-Firmware-SHA256', firmwareInfo.sha256);
    res.setHeader('X-Device-ID', deviceId);
    
    // Optional compression
    if (acceptCompression && firmwareBuffer.length > 1024) {
      const compressedBuffer = zlib.gzipSync(firmwareBuffer);
      console.log(`🗜️ HTTP Compressed ${firmwareBuffer.length} → ${compressedBuffer.length} bytes (${((1 - compressedBuffer.length/firmwareBuffer.length) * 100).toFixed(1)}% reduction)`);
      
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressedBuffer.length.toString());
      res.setHeader('X-Original-Size', firmwareBuffer.length.toString());
      res.send(compressedBuffer);
    } else {
      res.setHeader('Content-Length', firmwareBuffer.length.toString());
      res.send(firmwareBuffer);
    }
    
    const downloadTime = Date.now() - startTime;
    const speedKbps = (firmwareInfo.size / 1024) / (downloadTime / 1000);
    
    performanceMetrics.httpDownloads++;
    performanceMetrics.successfulDownloads++;
    
    console.log(`✅ HTTP Firmware download completed for ${deviceId}: ${firmwareInfo.size} bytes in ${downloadTime}ms (${speedKbps.toFixed(2)} KB/s)`);
    
  } catch (error) {
    console.error('HTTP Firmware download error:', error);
    performanceMetrics.failedDownloads++;
    
    if (!res.headersSent) {
      res.status(500).json({
        status: 'error',
        message: 'Download failed',
        code: 'DOWNLOAD_ERROR'
      });
    }
  }
});

// HTTP: Verify firmware
app.post('/api/firmware/verify', async (req, res) => {
  try {
    const { hash, hashType = 'md5', deviceId = 'unknown' } = req.body;
    
    console.log(`🔍 HTTP Firmware verification from device: ${deviceId}, hash type: ${hashType}`);
    
    if (!hash) {
      return res.status(400).json({
        status: 'error',
        message: 'Hash is required',
        code: 'MISSING_HASH'
      });
    }
    
    const firmwareInfo = await getLatestFirmwareInfo();
    
    if (!firmwareInfo) {
      return res.status(404).json({
        status: 'error',
        message: 'No firmware available for verification',
        code: 'NO_FIRMWARE'
      });
    }
    
    const expectedHash = hashType === 'sha256' ? firmwareInfo.sha256 : firmwareInfo.md5;
    const isValid = hash.toLowerCase() === expectedHash.toLowerCase();
    
    const response = {
      status: 'success',
      verified: isValid,
      expectedHash: expectedHash,
      receivedHash: hash,
      hashType: hashType,
      firmwareVersion: firmwareInfo.version,
      message: isValid ? 'Firmware integrity verified' : 'Hash mismatch detected'
    };
    
    if (isValid) {
      console.log(`✅ HTTP Firmware verification successful for ${deviceId} (${hashType.toUpperCase()})`);
    } else {
      console.log(`❌ HTTP Firmware verification failed for ${deviceId} (${hashType.toUpperCase()})`);
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('HTTP Firmware verification error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Verification failed',
      code: 'VERIFY_ERROR'
    });
  }
});

// ======= CRC16 CALCULATION FOR TCP LENGTH PREFIXING =======
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

// ======= TCP SERVER IMPLEMENTATION (CHUNKED DOWNLOAD) =======
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

// Enhanced request handler for TCP
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
        await handleTcpFirmwareCheck(socket, deviceId, request, clientId);
        break;
        
      case 'download':
        await handleTcpFirmwareDownload(socket, deviceId, request, clientId);
        break;
        
      case 'verify':
        await handleTcpFirmwareVerify(socket, deviceId, request, clientId);
        break;
        
      case 'resume':
        await handleTcpDownloadResume(socket, deviceId, request, clientId);
        break;
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    const processingTime = Date.now() - startTime;
    console.log(`⚡ TCP Request processed in ${processingTime}ms`);
    
  } catch (error) {
    console.error(`🚨 Error handling TCP request from ${clientId}:`, error.message);
    await sendTcpResponse(socket, {
      status: 'error',
      message: error.message,
      code: 'REQUEST_ERROR'
    });
  }
}

// TCP firmware check with session management
async function handleTcpFirmwareCheck(socket, deviceId, request, clientId) {
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
      console.log(`🔄 Resuming existing TCP session for ${deviceId}: ${sessionId}`);
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
      console.log(`✨ Created new TCP session for ${deviceId}: ${sessionId}`);
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
      compressionSupported: true
    };
    
    console.log(`✅ TCP Firmware check for ${deviceId}: v${firmwareInfo.version}, ${firmwareInfo.size} bytes, resume=${session.lastOffset}`);
    await sendTcpResponse(socket, response);
    
  } catch (error) {
    console.error('Error in TCP firmware check:', error);
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Internal server error',
      code: 'SERVER_ERROR'
    });
  }
}

// TCP firmware download with length prefixing
async function handleTcpFirmwareDownload(socket, deviceId, request, clientId) {
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
          console.log(`🗜️ TCP Compressed ${firmwareData.chunk.length} → ${compressedChunk.length} bytes`);
        }
      } catch (compError) {
        console.warn('TCP Compression failed, using uncompressed data');
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
    
    console.log(`📦 TCP Chunk: offset=${offset}, size=${firmwareData.actualSize}→${finalChunk.length}, crc=${dataCrc16}, comp=${compressed}, prog=${minimalHeader.p}%`);
    
    // Send response with LENGTH PREFIXED binary data
    await sendTcpResponseWithLengthPrefix(socket, minimalHeader, finalChunk);
    
  } catch (error) {
    console.error('Error in TCP firmware download:', error);
    performanceMetrics.retryCount++;
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Download failed',
      code: 'DOWNLOAD_ERROR',
      retryable: true
    });
  }
}

// TCP resume handler
async function handleTcpDownloadResume(socket, deviceId, request, clientId) {
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
    
    console.log(`🔄 TCP Resume for ${deviceId}: offset=${session.lastOffset}, chunks=${session.downloadedChunks}/${session.totalChunks}`);
    await sendTcpResponse(socket, response);
    
  } catch (error) {
    console.error('Error in TCP download resume:', error);
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Resume failed',
      code: 'RESUME_ERROR'
    });
  }
}

// TCP verification with SHA256 support
async function handleTcpFirmwareVerify(socket, deviceId, request, clientId) {
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
      console.log(`✅ TCP Firmware verification successful for ${deviceId} (${hashType.toUpperCase()})`);
    } else {
      performanceMetrics.failedDownloads++;
      console.log(`❌ TCP Firmware verification failed for ${deviceId} (${hashType.toUpperCase()})`);
    }
    
    await sendTcpResponse(socket, response);
    
  } catch (error) {
    console.error('Error in TCP firmware verification:', error);
    await sendTcpResponse(socket, {
      status: 'error',
      message: 'Verification failed',
      code: 'VERIFY_ERROR'
    });
  }
}

// ======= SHARED HELPER FUNCTIONS =======

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

// Version comparison helper
function isNewerVersion(latest, current) {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);
  
  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
    const latestPart = latestParts[i] || 0;
    const currentPart = currentParts[i] || 0;
    
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  
  return false;
}

// Standard JSON response for TCP
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

// Length-prefixed binary response for TCP
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

// Enhanced session cleanup (TCP only)
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
      console.log(`🧹 Cleaning up TCP session: ${sessionId} (${session.completed ? 'completed' : session.interrupted ? 'interrupted' : 'expired'})`);
      activeSessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// Enhanced metrics endpoint
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
    timestamp: new Date().toISOString(),
    protocols: {
      http: {
        downloads: performanceMetrics.httpDownloads,
        features: ['Direct Download', 'Compression', 'Resume Support']
      },
      tcp: {
        downloads: performanceMetrics.tcpDownloads,
        features: ['Chunked Download', 'Length Prefixing', 'CRC16', 'Session Management']
      }
    }
  };
  
  res.json(metrics);
});

// API endpoint to list available firmware
app.get('/api/firmware/list', async (req, res) => {
  try {
    const files = fs.readdirSync(FIRMWARE_DIR);
    const firmwareFiles = files
      .filter(file => file.endsWith('.bin'))
      .map(file => {
        const filePath = path.join(FIRMWARE_DIR, file);
        const stats = fs.statSync(filePath);
        const versionMatch = file.match(/_v(\d+\.\d+\.\d+)\.bin$/);
        const version = versionMatch ? versionMatch[1] : '1.0.0';
        
        return {
          name: file,
          version: version,
          size: stats.size,
          modified: stats.mtime,
          sizeHuman: formatBytes(stats.size)
        };
      })
      .sort((a, b) => b.modified - a.modified);
    
    res.json({
      status: 'success',
      firmware: firmwareFiles,
      total: firmwareFiles.length
    });
    
  } catch (error) {
    console.error('Error listing firmware:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to list firmware files',
      code: 'LIST_ERROR'
    });
  }
});

// Helper function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Start servers
tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(`🚀 TCP FOTA server (chunked) running on port ${TCP_PORT}`);
  console.log(`📊 Chunk size range: ${MIN_CHUNK_SIZE}-${MAX_CHUNK_SIZE} bytes`);
  console.log(`🔧 TCP Features: Length prefixing, CRC16, Resume, Compression, SHA256`);
});

app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP FOTA server (direct) running on port ${HTTP_PORT}`);
  console.log(`🔧 HTTP Features: Direct download, Compression, Verification`);
  console.log(`📁 Firmware directory: ${FIRMWARE_DIR}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET  /api/firmware/check     - Check for firmware updates`);
  console.log(`   GET  /api/firmware/download  - Download firmware directly`);
  console.log(`   POST /api/firmware/verify    - Verify firmware integrity`);
  console.log(`   GET  /api/firmware/list      - List available firmware`);
  console.log(`   GET  /api/metrics            - Server metrics and stats`);
});

tcpServer.on('error', (err) => {
  console.error('🚨 TCP server error:', err);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down servers...');
  tcpServer.close(() => {
    console.log('✅ TCP server closed');
    process.exit(0);
  });
});

console.log(`\n🎯 FOTA Server Ready!`);
console.log(`📡 TCP (chunked):  esp32 → tcp://server:${TCP_PORT}`);
console.log(`🌐 HTTP (direct):  esp32 → http://server:${HTTP_PORT}/api/firmware/*`);
console.log(`📊 Metrics:        http://server:${HTTP_PORT}/api/metrics`);
console.log(`\n💡 Usage Examples:`);
console.log(`   curl http://localhost:${HTTP_PORT}/api/firmware/check?device=esp32_001&version=1.0.0`);
console.log(`   curl -o firmware.bin http://localhost:${HTTP_PORT}/api/firmware/download?device=esp32_001`);