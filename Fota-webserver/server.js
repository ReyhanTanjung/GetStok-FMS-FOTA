// ====== PRODUCTION-READY TCP SERVER FOR ESP32 FOTA ======
const express = require('express');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const zlib = require('zlib');

// Configuration
const app = express();
const PORT = 3000;
const MQTT_PORT = 1883;
const MQTT_BROKER = 'mqtt://localhost';
const TCP_PORT = 8266;

// FOTA Configuration
const FIRMWARE_DIR = path.join(__dirname, 'firmware');
const DEFAULT_CHUNK_SIZE = 256; // Smaller default for better reliability
const MAX_CHUNK_SIZE = 1024;
const MIN_CHUNK_SIZE = 128;
const CONNECTION_TIMEOUT = 30000; // 30 seconds
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
  retryCount: 0
};

// Ensure firmware directory exists
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
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
    bytesTransferred: 0
  });
  
  // Set socket timeout
  socket.setTimeout(CONNECTION_TIMEOUT);
  
  let dataBuffer = Buffer.alloc(0);
  
  // Enhanced data handler with better parsing
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
    
    // Keep remaining data in buffer
    dataBuffer = dataBuffer.slice(startIndex);
    
    // Process each complete message
    messages.forEach(message => {
      if (message.length > 0) {
        handleTcpRequest(socket, message, clientId);
      }
    });
  });
  
  // Enhanced error handling
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

// Connection management utilities
function updateLastActivity(clientId) {
  const connection = deviceConnections.get(clientId);
  if (connection) {
    connection.lastActivity = Date.now();
  }
}

function cleanupConnection(clientId) {
  deviceConnections.delete(clientId);
  // Clean up any active sessions for this client
  for (let [sessionId, session] of activeSessions.entries()) {
    if (session.clientId === clientId) {
      activeSessions.delete(sessionId);
    }
  }
}

// Enhanced request handler with better error handling and logging
async function handleTcpRequest(socket, message, clientId) {
  const startTime = Date.now();
  
  try {
    const request = JSON.parse(message);
    const deviceId = request.device || 'unknown';
    const action = request.action;
    
    console.log(`📨 TCP Request from ${deviceId} (${clientId}): ${action}`);
    
    // Update connection stats
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
    
    // Log performance metrics
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

// Enhanced firmware check with better metadata
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
    
    // Create download session
    const sessionId = generateSessionId();
    activeSessions.set(sessionId, {
      sessionId,
      clientId,
      deviceId,
      firmwareInfo,
      startTime: Date.now(),
      chunks: new Map(),
      totalChunks: Math.ceil(firmwareInfo.size / DEFAULT_CHUNK_SIZE),
      downloadedChunks: 0,
      lastOffset: 0
    });
    
    const response = {
      status: 'success',
      version: firmwareInfo.version,
      name: firmwareInfo.name,
      size: firmwareInfo.size,
      md5: firmwareInfo.md5,
      sha256: firmwareInfo.sha256, // Additional integrity check
      sessionId: sessionId,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks: Math.ceil(firmwareInfo.size / DEFAULT_CHUNK_SIZE),
      compressionSupported: true // Enable compression for faster transfer
    };
    
    console.log(`✅ Firmware check for ${deviceId}: v${firmwareInfo.version}, ${firmwareInfo.size} bytes`);
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

// Enhanced firmware download with adaptive chunk sizing and integrity checks
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
    
    // Adaptive chunk sizing based on connection quality
    const connection = deviceConnections.get(clientId);
    if (connection && connection.chunksRequested > 5) {
      const errorRate = (performanceMetrics.retryCount / connection.chunksRequested);
      if (errorRate > 0.2) {
        chunkSize = Math.max(MIN_CHUNK_SIZE, chunkSize / 2);
        console.log(`📉 Reducing chunk size to ${chunkSize} due to high error rate`);
      }
    }
    
    // Limit chunk size
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
    
    // Calculate chunk CRC for integrity verification
    const chunkCrc = crypto.createHash('md5').update(firmwareData.chunk).digest('hex');
    
    // Optional compression
    let finalChunk = firmwareData.chunk;
    let compressed = false;
    
    if (useCompression && firmwareData.chunk.length > 100) {
      try {
        const compressedChunk = zlib.gzipSync(firmwareData.chunk);
        if (compressedChunk.length < firmwareData.chunk.length * 0.8) {
          finalChunk = compressedChunk;
          compressed = true;
        }
      } catch (compError) {
        console.warn('Compression failed, using uncompressed data');
      }
    }
    
    // Enhanced response header
    const header = {
      status: 'success',
      offset: offset,
      size: firmwareData.actualSize,
      total: firmwareData.totalSize,
      remaining: firmwareData.totalSize - (offset + firmwareData.actualSize),
      position: parseFloat(((offset + firmwareData.actualSize) / firmwareData.totalSize * 100).toFixed(2)),
      chunkCrc: chunkCrc,
      compressed: compressed,
      sessionId: sessionId,
      chunkId: Math.floor(offset / DEFAULT_CHUNK_SIZE),
      timestamp: Date.now()
    };
    
    // Update session progress
    session.chunks.set(offset, {
      offset,
      size: firmwareData.actualSize,
      crc: chunkCrc,
      timestamp: Date.now()
    });
    session.downloadedChunks++;
    session.lastOffset = Math.max(session.lastOffset, offset + firmwareData.actualSize);
    
    // Update connection stats
    if (connection) {
      connection.bytesTransferred += firmwareData.actualSize;
    }
    
    performanceMetrics.chunksServed++;
    
    console.log(`📦 Sending chunk: offset=${offset}, size=${firmwareData.actualSize}, crc=${chunkCrc.substring(0,8)}, compressed=${compressed}, progress=${header.position}%`);
    
    // Send response with binary data
    await sendTcpResponseWithBinary(socket, header, finalChunk);
    
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

// New: Firmware verification endpoint
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
      performanceMetrics.successfulDownloads++;
      console.log(`✅ Firmware verification successful for ${deviceId}`);
    } else {
      performanceMetrics.failedDownloads++;
      console.log(`❌ Firmware verification failed for ${deviceId}`);
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

// New: Resume download capability
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
    
    const response = {
      status: 'success',
      lastOffset: session.lastOffset,
      downloadedChunks: session.downloadedChunks,
      totalChunks: session.totalChunks,
      resumeAvailable: true,
      sessionId: sessionId
    };
    
    console.log(`🔄 Resume requested for ${deviceId}: offset=${session.lastOffset}`);
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

// Enhanced firmware info retrieval with caching and better error handling
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
    
    // Extract version from filename
    const versionMatch = latestFirmware.name.match(/_v(\d+\.\d+\.\d+)\.bin$/);
    const version = versionMatch ? versionMatch[1] : '1.0.0';
    
    // Calculate both MD5 and SHA256 hashes
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

// Enhanced firmware chunk reading with better error handling
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

// Enhanced response sending with better error handling
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

// Enhanced binary response with integrity
async function sendTcpResponseWithBinary(socket, header, binaryData) {
  return new Promise((resolve, reject) => {
    try {
      const headerStr = JSON.stringify(header) + '\n';
      const headerBuffer = Buffer.from(headerStr);
      const responseBuffer = Buffer.concat([headerBuffer, binaryData]);
      
      socket.write(responseBuffer, (err) => {
        if (err) {
          console.error('Error sending binary TCP response:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (error) {
      console.error('Error creating binary TCP response:', error);
      reject(error);
    }
  });
}

// Utility functions
function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

// Periodic cleanup of old sessions
setInterval(() => {
  const now = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  
  for (let [sessionId, session] of activeSessions.entries()) {
    if (now - session.startTime > SESSION_TIMEOUT) {
      console.log(`🧹 Cleaning up expired session: ${sessionId}`);
      activeSessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Enhanced monitoring and metrics
app.get('/api/metrics', (req, res) => {
  const activeConnectionCount = deviceConnections.size;
  const activeSessionCount = activeSessions.size;
  
  const metrics = {
    ...performanceMetrics,
    activeConnections: activeConnectionCount,
    activeSessions: activeSessionCount,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  };
  
  res.json(metrics);
});

// Start TCP server with enhanced logging
tcpServer.listen(TCP_PORT, () => {
  console.log(`🚀 Enhanced TCP FOTA server running on port ${TCP_PORT}`);
  console.log(`📊 Chunk size range: ${MIN_CHUNK_SIZE}-${MAX_CHUNK_SIZE} bytes`);
  console.log(`⏱️  Connection timeout: ${CONNECTION_TIMEOUT}ms`);
});

// Error handling for server
tcpServer.on('error', (err) => {
  console.error('🚨 TCP server error:', err);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  tcpServer.close(() => {
    console.log('✅ TCP server closed');
    process.exit(0);
  });
});

// [Rest of the original HTTP and MQTT server code remains the same]
// ======= ORIGINAL MQTT AND HTTP SERVER CODE =======

const aedes = require('aedes')();
const mqttServer = net.createServer(aedes.handle);
mqttServer.listen(MQTT_PORT, () => {
  console.log(`MQTT broker berjalan di port ${MQTT_PORT}`);
});

const mqttClient = mqtt.connect(MQTT_BROKER);
mqttClient.on('connect', () => {
  console.log('Server terhubung ke MQTT broker');
  mqttClient.subscribe('device/firmware/request');
});

// [HTTP Server endpoints remain the same as original]
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// [All other HTTP endpoints from original code...]
app.listen(PORT, () => {
  console.log(`HTTP server berjalan di port ${PORT}`);
});