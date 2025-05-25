#include "FotaSIM800L.h"

FotaSIM800L::FotaSIM800L(HardwareSerial& serial, const char* server_address, int port, 
                         const char* device_name, const char* version, 
                         const char* apn_name, const char* apn_username, const char* apn_password)
  : serialAT(serial) {
  server_ip = server_address;
  server_port = port;
  device_id = String(device_name);
  current_version = String(version);
  apn = String(apn_name);
  apn_user = String(apn_username);
  apn_pass = String(apn_password);
}

bool FotaSIM800L::begin() {
  Serial.println("Initializing SIM800L...");
  
  // Initialize serial port
  serialAT.begin(SIM800L_BAUD, SERIAL_8N1, SIM800L_RX, SIM800L_TX);
  delay(3000);
  
  // Initialize SIM800L
  if (!initSIM800L()) {
    Serial.println("Failed to initialize SIM800L");
    return false;
  }
  
  // Setup GPRS
  if (!setupGPRS()) {
    Serial.println("Failed to setup GPRS");
    return false;
  }
  
  gprs_connected = true;
  return true;
}

bool FotaSIM800L::sendATCommand(const String& cmd, const String& expected, unsigned long timeout) {
  flushSerialAT();
  
  Serial.print(">> ");
  Serial.println(cmd);
  
  serialAT.println(cmd);
  
  if (expected.length() == 0) {
    return true;
  }
  
  return waitForResponse(expected, timeout);
}

bool FotaSIM800L::waitForResponse(const String& expected, unsigned long timeout) {
  unsigned long start = millis();
  String response = "";
  
  while (millis() - start < timeout) {
    if (serialAT.available()) {
      char c = serialAT.read();
      response += c;
      
      if (response.indexOf(expected) != -1) {
        Serial.print("<< ");
        Serial.println(response);
        return true;
      }
      
      if (response.indexOf("ERROR") != -1) {
        Serial.print("<< ");
        Serial.println(response);
        return false;
      }
    }
  }
  
  Serial.println("<< Timeout");
  return false;
}

String FotaSIM800L::readATResponse(unsigned long timeout) {
  unsigned long start = millis();
  String response = "";
  
  while (millis() - start < timeout) {
    if (serialAT.available()) {
      char c = serialAT.read();
      response += c;
    }
  }
  
  return response;
}

void FotaSIM800L::flushSerialAT() {
  while (serialAT.available()) {
    serialAT.read();
  }
}

bool FotaSIM800L::initSIM800L() {
  // Test AT communication
  for (int i = 0; i < 3; i++) {
    if (sendATCommand("AT", "OK")) {
      break;
    }
    delay(1000);
  }
  
  // Disable echo
  sendATCommand("ATE0", "OK");
  
  // Check SIM card
  if (!sendATCommand("AT+CPIN?", "READY", 5000)) {
    Serial.println("SIM card not ready");
    return false;
  }
  
  // Wait for network registration
  Serial.println("Waiting for network registration...");
  for (int i = 0; i < 60; i++) {
    sendATCommand("AT+CREG?", "", 1000);
    String response = readATResponse(1000);
    if (response.indexOf("+CREG: 0,1") != -1 || response.indexOf("+CREG: 0,5") != -1) {
      Serial.println("Network registered");
      break;
    }
    delay(1000);
  }
  
  // Get signal quality
  sendATCommand("AT+CSQ", "OK");
  
  return true;
}

bool FotaSIM800L::setupGPRS() {
  Serial.println("Setting up GPRS connection...");
  
  // Step 1: Check network registration first
  Serial.println("Checking network registration...");
  bool registered = false;
  for (int i = 0; i < 30; i++) {
    sendATCommand("AT+CREG?", "", 1000);
    String response = readATResponse(1000);
    if (response.indexOf("+CREG: 0,1") != -1 || response.indexOf("+CREG: 0,5") != -1) {
      Serial.println("Network registered");
      registered = true;
      break;
    }
    delay(2000);
  }
  
  if (!registered) {
    Serial.println("Network registration failed");
    return false;
  }
  
  // Step 2: Check GPRS attachment
  Serial.println("Checking GPRS attachment...");
  for (int i = 0; i < 10; i++) {
    if (sendATCommand("AT+CGATT?", "+CGATT: 1")) {
      Serial.println("GPRS attached");
      break;
    }
    sendATCommand("AT+CGATT=1", "OK");
    delay(2000);
  }
  
  // Step 3: Close any existing connections
  sendATCommand("AT+CIPSHUT", "SHUT OK", 10000);
  delay(1000);
  
  // Step 4: Set single connection mode
  if (!sendATCommand("AT+CIPMUX=0", "OK")) {
    Serial.println("Failed to set single connection mode");
    return false;
  }
  
  // Step 5: Set APN with retry
  String apnCmd = "AT+CSTT=\"" + apn + "\"";
  if (apn_user.length() > 0) {
    apnCmd += ",\"" + apn_user + "\"";
    if (apn_pass.length() > 0) {
      apnCmd += ",\"" + apn_pass + "\"";
    }
  }
  
  bool apnSet = false;
  for (int i = 0; i < 3; i++) {
    if (sendATCommand(apnCmd, "OK")) {
      apnSet = true;
      break;
    }
    delay(2000);
  }
  
  if (!apnSet) {
    Serial.println("Failed to set APN");
    return false;
  }
  
  // Step 6: Bring up GPRS connection with retry
  bool gprsUp = false;
  for (int i = 0; i < 3; i++) {
    Serial.print("Bringing up GPRS, attempt ");
    Serial.println(i + 1);
    
    if (sendATCommand("AT+CIICR", "OK", 30000)) {
      gprsUp = true;
      break;
    }
    
    Serial.println("GPRS activation failed, retrying...");
    delay(5000);
  }
  
  if (!gprsUp) {
    Serial.println("Failed to bring up GPRS");
    return false;
  }
  
  // Step 7: Get and validate IP address
  sendATCommand("AT+CIFSR", "", 3000);
  String ip = readATResponse(3000);
  ip.trim();
  
  Serial.print("IP Address: ");
  Serial.println(ip);
  
  // Check if we got a valid IP
  if (ip.length() == 0 || ip.indexOf("ERROR") != -1) {
    Serial.println("Failed to get IP address");
    return false;
  }
  
  Serial.println("GPRS setup successful");
  return true;
}

bool FotaSIM800L::connectTCP() {
  if (tcp_connected) {
    Serial.println("TCP already connected");
    return true;
  }
  
  Serial.print("Connecting to TCP server ");
  Serial.print(server_ip);
  Serial.print(":");
  Serial.println(server_port);
  
  // PENTING: Harus shutdown semua koneksi dulu sebelum set CIPMUX
  Serial.println("Shutting down existing connections...");
  sendATCommand("AT+CIPCLOSE", "", 3000);
  delay(1000);
  sendATCommand("AT+CIPSHUT", "SHUT OK", 10000);
  delay(2000);
  
  // Re-establish GPRS setelah shutdown
  Serial.println("Re-establishing GPRS...");
  if (!setupGPRS()) {
    Serial.println("Failed to re-establish GPRS");
    return false;
  }
  
  // Set single connection mode (sekarang harus berhasil)
  if (!sendATCommand("AT+CIPMUX=0", "OK")) {
    Serial.println("Failed to set single connection mode");
    return false;
  }
  
  // Start TCP connection
  String cmd = "AT+CIPSTART=\"TCP\",\"" + String(server_ip) + "\",\"" + String(server_port) + "\"";
  
  serialAT.println(cmd);
  Serial.print(">> ");
  Serial.println(cmd);
  
  // Wait for connection response
  unsigned long start = millis();
  String response = "";
  bool success = false;
  
  while (millis() - start < AT_CONNECT_TIMEOUT) {
    if (serialAT.available()) {
      char c = serialAT.read();
      response += c;
      
      if (response.indexOf("CONNECT OK") != -1 || response.indexOf("CONNECT") != -1) {
        success = true;
        break;
      }
      
      if (response.indexOf("CONNECT FAIL") != -1 || 
          response.indexOf("ERROR") != -1) {
        break;
      }
      
      if (response.indexOf("ALREADY CONNECT") != -1) {
        success = true;
        break;
      }
    }
  }
  
  Serial.print("<< ");
  Serial.println(response);
  
  if (success) {
    tcp_connected = true;
    Serial.println("TCP connected successfully");
    return true;
  }
  
  Serial.println("TCP connection failed");
  return false;
}

void FotaSIM800L::disconnectTCP() {
  if (tcp_connected) {
    sendATCommand("AT+CIPCLOSE", "CLOSE OK", 2000);
    tcp_connected = false;
  }
}

bool FotaSIM800L::sendTCPData(const String& data) {
  return sendTCPData((const uint8_t*)data.c_str(), data.length());
}

bool FotaSIM800L::sendTCPData(const uint8_t* data, size_t length) {
  if (!tcp_connected) {
    return false;
  }
  
  // Start data transmission
  String cmd = "AT+CIPSEND=" + String(length);
  serialAT.println(cmd);
  
  // Wait for prompt
  if (!waitForResponse(">", 5000)) {
    Serial.println("No prompt received");
    return false;
  }
  
  // Send data
  for (size_t i = 0; i < length; i++) {
    serialAT.write(data[i]);
  }
  
  // Wait for send confirmation
  if (!waitForResponse("SEND OK", 10000)) {
    Serial.println("Send failed");
    return false;
  }
  
  return true;
}

bool FotaSIM800L::readTCPData(uint8_t* buffer, size_t& length, unsigned long timeout) {
  unsigned long start = millis();
  size_t received = 0;
  
  while (received < length && millis() - start < timeout) {
    if (serialAT.available()) {
      buffer[received++] = serialAT.read();
    }
  }
  
  length = received;
  return received > 0;
}

String FotaSIM800L::readTCPLine(unsigned long timeout) {
  unsigned long start = millis();
  String line = "";
  
  while (millis() - start < timeout) {
    if (serialAT.available()) {
      char c = serialAT.read();
      if (c == '\n') {
        break;
      }
      if (c != '\r') {
        line += c;
      }
    }
  }
  
  return line;
}

bool FotaSIM800L::sendRequest(const JsonDocument& doc) {
  String request;
  serializeJson(doc, request);
  request += "\n";
  
  return sendTCPData(request);
}

bool FotaSIM800L::readResponseHeader(JsonDocument& doc) {
  // Read response line
  String response = readTCPLine(5000);
  
  if (response.length() == 0) {
    Serial.println("No response received");
    return false;
  }
  
  Serial.print("Response: ");
  Serial.println(response);
  
  // Parse JSON response
  DeserializationError error = deserializeJson(doc, response);
  if (error) {
    Serial.print("JSON parse error: ");
    Serial.println(error.c_str());
    return false;
  }
  
  return true;
}

bool FotaSIM800L::receiveBinaryData(size_t chunk_size) {
  size_t remaining = chunk_size;
  size_t bytes_read = 0;
  
  unsigned long timeout = millis() + 30000; // 30 second timeout for data
  
  while (remaining > 0 && millis() < timeout) {
    if (serialAT.available()) {
      // Read data into buffer
      size_t to_read = min(BUFFER_SIZE - buffer_pos, remaining);
      
      while (to_read > 0 && serialAT.available()) {
        buffer[buffer_pos++] = serialAT.read();
        bytes_read++;
        remaining--;
        to_read--;
        
        // Reset timeout on data received
        timeout = millis() + 30000;
      }
      
      // If buffer is full or all data is read, write to flash
      if (buffer_pos == BUFFER_SIZE || remaining == 0) {
        if (Update.write(buffer, buffer_pos) != buffer_pos) {
          Serial.println("Error writing to flash");
          return false;
        }
        buffer_pos = 0;
      }
    }
    
    yield();
  }
  
  return bytes_read == chunk_size;
}

bool FotaSIM800L::verifyMD5(const String& expected_md5) {
  if (!Update.end()) {
    Serial.println("Error finalizing update");
    Serial.println(Update.errorString());
    return false;
  }
  
  if (expected_md5.length() == 32) {
    if (Update.md5String().equalsIgnoreCase(expected_md5)) {
      Serial.println("MD5 verification passed");
      return true;
    } else {
      Serial.println("MD5 verification failed");
      Serial.print("Expected: ");
      Serial.println(expected_md5);
      Serial.print("Actual: ");
      Serial.println(Update.md5String());
      return false;
    }
  }
  
  return true;
}

bool FotaSIM800L::isConnected() {
  // Only check GPRS connection, TCP will be established when needed
  return gprs_connected;
}

int FotaSIM800L::getSignalQuality() {
  sendATCommand("AT+CSQ", "", 1000);
  String response = readATResponse(1000);
  
  int start = response.indexOf("+CSQ: ");
  if (start != -1) {
    start += 6;
    int end = response.indexOf(",", start);
    if (end != -1) {
      String rssi = response.substring(start, end);
      return rssi.toInt();
    }
  }
  
  return -1;
}

String FotaSIM800L::getConnectionStatus() {
  sendATCommand("AT+CIPSTATUS", "", 1000);
  String response = readATResponse(1000);
  
  if (response.indexOf("CONNECT OK") != -1) {
    return "TCP Connected";
  } else if (response.indexOf("TCP CLOSED") != -1) {
    tcp_connected = false;
    return "TCP Closed";
  } else if (response.indexOf("IP INITIAL") != -1) {
    return "IP Initial";
  } else if (response.indexOf("IP START") != -1) {
    return "IP Start";
  } else if (response.indexOf("IP CONFIG") != -1) {
    return "IP Config";
  } else if (response.indexOf("IP GPRSACT") != -1) {
    return "GPRS Active";
  } else if (response.indexOf("IP STATUS") != -1) {
    return "Got IP";
  } else if (response.indexOf("TCP CONNECTING") != -1) {
    return "TCP Connecting";
  } else if (response.indexOf("PDP DEACT") != -1) {
    gprs_connected = false;
    tcp_connected = false;
    return "PDP Deactivated";
  }
  
  return "Unknown";
}

bool FotaSIM800L::checkForUpdates() {
  Serial.println("Checking for firmware updates...");
  
  // Ensure GPRS is connected
  if (!gprs_connected) {
    Serial.println("GPRS not connected, attempting to reconnect...");
    if (!setupGPRS()) {
      Serial.println("Failed to setup GPRS");
      return false;
    }
  }
  
  // Ensure TCP connection
  if (!connectTCP()) {
    Serial.println("Failed to connect to server");
    return false;
  }
  
  // Create check request
  StaticJsonDocument<256> request;
  request["device"] = device_id;
  request["action"] = "check";
  request["version"] = current_version;
  
  // Send request
  if (!sendRequest(request)) {
    Serial.println("Failed to send check request");
    disconnectTCP();
    return false;
  }
  
  // Read response
  StaticJsonDocument<512> response;
  if (!readResponseHeader(response)) {
    Serial.println("Failed to parse response");
    disconnectTCP();
    return false;
  }
  
  // Check response status
  if (response["status"] != "success") {
    Serial.print("Error: ");
    Serial.println(response["message"].as<String>());
    disconnectTCP();
    return false;
  }
  
  // Get firmware information
  update_version = response["version"].as<String>();
  total_size = response["size"].as<size_t>();
  update_md5 = response["md5"].as<String>();
  
  Serial.print("Server firmware version: ");
  Serial.println(update_version);
  Serial.print("Current version: ");
  Serial.println(current_version);
  
  // Compare versions
  if (update_version == current_version) {
    Serial.println("Already running the latest version");
    disconnectTCP();
    return false;
  }
  
  Serial.println("New firmware available");
  Serial.print("Size: ");
  Serial.print(total_size);
  Serial.println(" bytes");
  
  disconnectTCP();
  return true;
}

bool FotaSIM800L::downloadAndApplyUpdate() {
  Serial.println("Starting firmware download...");
  
  // Ensure TCP connection
  if (!connectTCP()) {
    Serial.println("Failed to connect to server");
    return false;
  }
  
  // Begin OTA update
  if (!Update.begin(total_size)) {
    Serial.println("Not enough space for update");
    disconnectTCP();
    return false;
  }
  
  // Set the MD5
  Update.setMD5(update_md5.c_str());
  
  // Reset buffer and offset
  buffer_pos = 0;
  current_offset = 0;
  update_in_progress = true;
  
  // Download firmware in chunks
  while (current_offset < total_size) {
    // Calculate chunk size
    size_t chunk_size = min(BUFFER_SIZE, total_size - current_offset);
    
    // Create download request
    StaticJsonDocument<256> request;
    request["device"] = device_id;
    request["action"] = "download";
    request["offset"] = current_offset;
    request["size"] = chunk_size;
    
    // Send request
    if (!sendRequest(request)) {
      Serial.println("Failed to send download request");
      Update.abort();
      disconnectTCP();
      update_in_progress = false;
      return false;
    }
    
    // Read response header
    StaticJsonDocument<512> response;
    if (!readResponseHeader(response)) {
      Serial.println("Failed to parse response");
      Update.abort();
      disconnectTCP();
      update_in_progress = false;
      return false;
    }
    
    // Check response status
    if (response["status"] != "success") {
      Serial.print("Error: ");
      Serial.println(response["message"].as<String>());
      Update.abort();
      disconnectTCP();
      update_in_progress = false;
      return false;
    }
    
    // Get chunk information
    size_t response_offset = response["offset"].as<size_t>();
    size_t response_size = response["size"].as<size_t>();
    size_t response_total = response["total"].as<size_t>();
    float position = response["position"].as<float>();
    
    // Validate response
    if (response_offset != current_offset || response_total != total_size) {
      Serial.println("Invalid chunk information received");
      Update.abort();
      disconnectTCP();
      update_in_progress = false;
      return false;
    }
    
    // Read and process binary data
    if (!receiveBinaryData(response_size)) {
      Serial.println("Failed to receive binary data");
      Update.abort();
      disconnectTCP();
      update_in_progress = false;
      return false;
    }
    
    // Update offset
    current_offset += response_size;
    
    // Display progress
    Serial.print("Download progress: ");
    Serial.print(position);
    Serial.print("% (");
    Serial.print(current_offset);
    Serial.print("/");
    Serial.print(total_size);
    Serial.println(" bytes)");
  }
  
  // Verify firmware
  if (!verifyMD5(update_md5)) {
    Serial.println("Firmware verification failed");
    disconnectTCP();
    update_in_progress = false;
    return false;
  }
  
  Serial.println("Firmware download complete and verified");
  disconnectTCP();
  update_in_progress = false;
  return true;
}

void FotaSIM800L::restart() {
  Serial.println("Restarting device...");
  delay(1000);
  ESP.restart();
}