#include <Arduino.h>
#include <HardwareSerial.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <Update.h>
#include <MD5Builder.h>
#include <ArduinoJson.h>

// MQTT Configuration
#define MQTT_BROKER           "fota.getstokfms.com"
#define MQTT_PORT             "1883"
#define MQTT_CLIENT_ID        "esp32_device_001" // Unique ID for each device
#define MQTT_TOPIC_PUB        "device/firmware/request"
#define MQTT_TOPIC_INFO       "device/firmware/info"
#define MQTT_TOPIC_DATA       "device/firmware/data"
#define MQTT_KEEP_ALIVE       60  // seconds

// Device Information
#define FIRMWARE_VERSION      "1.0.0" // Current firmware version
#define DEVICE_ID             "esp32_001"

// SIM800L Configuration
#define SIM800L_SERIAL        2   // UART2
#define SIM800L_BAUD          115200
#define SIM800L_RX            16  // GPIO16
#define SIM800L_TX            17  // GPIO17
#define SIM_APN               "internet"  // Change according to your operator

// Timing Configuration
#define PING_INTERVAL         30000  // 30 seconds
#define FOTA_CHECK_INTERVAL   60000  // 60 seconds
#define AT_DEFAULT_TIMEOUT    2000   // 2 seconds
#define AT_CONNECT_TIMEOUT    5000   // 5 seconds

// MQTT Packet Types
#define MQTT_CONNECT          0x10
#define MQTT_PUBLISH          0x30
#define MQTT_SUBSCRIBE        0x82
#define MQTT_PINGREQ          0xC0

// FOTA Configuration
#define FIRMWARE_BUFFER_SIZE  1024
#define MAX_JSON_SIZE         512

// UART for SIM800L
HardwareSerial SerialAT(SIM800L_SERIAL);

// Global variables
TaskHandle_t mqttTaskHandle = NULL;
TaskHandle_t monitorTaskHandle = NULL;
TaskHandle_t fotaTaskHandle = NULL;
unsigned long lastPingTime = 0;
unsigned long lastFotaCheckTime = 0;
bool mqttConnected = false;

// FOTA Variables
struct FotaInfo {
  String version;
  String name;
  size_t size;
  String md5;
  bool updateAvailable;
  size_t currentOffset;
  bool updateInProgress;
  uint8_t* updateBuffer;
  MD5Builder md5Builder;
};

FotaInfo fotaInfo = {
  FIRMWARE_VERSION, // Current version
  "",               // Firmware name (will be filled)
  0,                // Size (will be filled)
  "",               // MD5 (will be filled)
  false,            // No update available by default
  0,                // Starting offset
  false,            // No update in progress
  nullptr,          // Buffer initialized later
  MD5Builder()      // MD5 calculator
};

// Function prototypes
void sendAT(String cmd, String expected, int timeout = AT_DEFAULT_TIMEOUT);
void sendRawMQTTConnect();
void sendRawMQTTSubscribe();
void sendPingReq();
void reconnectMQTT();
void sendMQTTPublish(const char* topic, const char* message);
void mqttTask(void *parameter);
void monitorTask(void *parameter);
void fotaTask(void *parameter);
String byteToHexString(uint8_t byte);
String bytesToHexString(const uint8_t* bytes, size_t length);
uint8_t hexCharToByte(char c);
void hexStringToBytes(const String& hexString, uint8_t* output, size_t* outputLength);
bool checkFirmwareUpdate();
void processFirmwareInfo(String jsonStr);
void requestFirmwareChunk(size_t offset, size_t size);
bool verifyFirmwareChecksum();
void startOtaUpdate();
int compareVersions(String v1, String v2);

void setup() {
  Serial.begin(115200);
  SerialAT.begin(SIM800L_BAUD, SERIAL_8N1, SIM800L_RX, SIM800L_TX);
  delay(3000);

  Serial.println("Initializing ESP32 FOTA with SIM800L via MQTT...");
  Serial.print("Current firmware version: ");
  Serial.println(FIRMWARE_VERSION);
  
  // Allocate buffer for firmware chunks
  fotaInfo.updateBuffer = new uint8_t[FIRMWARE_BUFFER_SIZE];
  if (!fotaInfo.updateBuffer) {
    Serial.println("Failed to allocate firmware buffer memory!");
    while(1) { delay(1000); } // Fatal error
  }
  
  // Initialize connection in the main setup without tasks first
  Serial.println("Setting up SIM800L for MQTT connection...");
  
  sendAT("AT", "OK");
  sendAT("ATE0", "OK");
  sendAT("AT+CPIN?", "READY");
  sendAT("AT+CSQ", "OK");
  sendAT("AT+CGATT?", "1");
  sendAT("AT+CIPSHUT", "SHUT OK");
  sendAT("AT+CSTT=\"" + String(SIM_APN) + "\"", "OK");
  sendAT("AT+CIICR", "OK");
  sendAT("AT+CIFSR", ".");
  
  // Connect TCP socket to MQTT broker
  sendAT("AT+CIPSTART=\"TCP\",\"" + String(MQTT_BROKER) + "\",\"" + String(MQTT_PORT) + "\"", "CONNECT OK", AT_CONNECT_TIMEOUT);
  
  delay(2000);
  sendRawMQTTConnect();
  delay(2000);
  sendRawMQTTSubscribe(); // Subscribe to FOTA topics
  
  lastPingTime = millis();
  lastFotaCheckTime = millis();
  mqttConnected = true;
  
  // Now create the tasks
  xTaskCreatePinnedToCore(
    mqttTask,
    "MQTTTask",
    4096,
    NULL,
    1,
    &mqttTaskHandle,
    0  // Core 0
  );
  
  xTaskCreatePinnedToCore(
    monitorTask,
    "MonitorTask",
    4096, // Increased stack size to handle JSON parsing
    NULL,
    1,
    &monitorTaskHandle,
    1  // Core 1
  );
  
  xTaskCreatePinnedToCore(
    fotaTask,
    "FOTATask",
    8192, // Large stack for OTA tasks
    NULL,
    1,
    &fotaTaskHandle,
    1  // Core 1
  );
}

void loop() {
  // Main loop is empty as we're using FreeRTOS tasks
  delay(1000);
}

// ==================== MQTT Task ====================
void mqttTask(void *parameter) {
  while(true) {
    // Send MQTT ping to keep connection alive
    if (millis() - lastPingTime > PING_INTERVAL) {
      sendPingReq();
      lastPingTime = millis();
    }
    
    // FOTA check periodically
    if (millis() - lastFotaCheckTime > FOTA_CHECK_INTERVAL && !fotaInfo.updateInProgress) {
      lastFotaCheckTime = millis();
      checkFirmwareUpdate();
    }
    
    // Short delay
    vTaskDelay(100 / portTICK_PERIOD_MS);
  }
}

// ==================== Monitor Task ====================
void monitorTask(void *parameter) {
  String receivedData = "";
  bool receivingBinaryData = false;
  size_t binaryDataLength = 0;
  size_t dataOffset = 0;
  
  while(true) {
    // Check for incoming data from SIM800L
    while (SerialAT.available()) {
      char c = SerialAT.read();
      Serial.write(c); // Echo untuk debugging
      
      if (receivingBinaryData) {
        fotaInfo.updateBuffer[dataOffset++] = c;
        
        if (dataOffset >= binaryDataLength) {
          receivingBinaryData = false;
          
          // Process received firmware chunk
          if (Update.write(fotaInfo.updateBuffer, binaryDataLength) != binaryDataLength) {
            Serial.println("Error writing firmware chunk!");
          } else {
            fotaInfo.md5Builder.add(fotaInfo.updateBuffer, binaryDataLength);
            fotaInfo.currentOffset += binaryDataLength;
            
            Serial.print("Chunk written. Progress: ");
            Serial.print((fotaInfo.currentOffset * 100) / fotaInfo.size);
            Serial.println("%");
            
            // Request next chunk if not complete
            if (fotaInfo.currentOffset < fotaInfo.size) {
              size_t remainingBytes = fotaInfo.size - fotaInfo.currentOffset;
              size_t chunkSize = remainingBytes > FIRMWARE_BUFFER_SIZE ? FIRMWARE_BUFFER_SIZE : remainingBytes;
              requestFirmwareChunk(fotaInfo.currentOffset, chunkSize);
            } else {
              // Firmware download complete, verify checksum
              fotaInfo.md5Builder.calculate();
              String calculatedMD5 = fotaInfo.md5Builder.toString();
              
              Serial.print("Download complete. Verifying MD5: ");
              Serial.println(calculatedMD5);
              
              if (calculatedMD5.equalsIgnoreCase(fotaInfo.md5)) {
                Serial.println("MD5 verification successful!");
                if (Update.end(true)) {
                  Serial.println("Update success! Rebooting...");
                  ESP.restart();
                } else {
                  Serial.println("Update failed!");
                }
              } else {
                Serial.println("MD5 verification failed. Aborting update.");
                Update.abort();
                fotaInfo.updateInProgress = false;
              }
            }
          }
        }
      } else {
        receivedData += c;
        
        // Cek apakah ada pesan MQTT firmware info
        if (receivedData.indexOf(MQTT_TOPIC_INFO) != -1) {
          int jsonStart = receivedData.indexOf('{');
          int jsonEnd = receivedData.lastIndexOf('}');
          
          if (jsonStart != -1 && jsonEnd != -1 && jsonEnd > jsonStart) {
            String jsonStr = receivedData.substring(jsonStart, jsonEnd + 1);
            Serial.println("\n--- Received firmware info JSON: ---");
            Serial.println(jsonStr);
            Serial.println("-----------------------------------");
            
            processFirmwareInfo(jsonStr);
            
            // Clear buffer setelah pemrosesan
            receivedData = "";
          }
        }
        
        // Cek apakah ada pesan MQTT firmware data
        if (receivedData.indexOf(MQTT_TOPIC_DATA) != -1) {
          int headerStart = receivedData.indexOf('{');
          int headerEnd = receivedData.indexOf('\n', headerStart);
          
          if (headerStart != -1 && headerEnd != -1) {
            String headerJson = receivedData.substring(headerStart, headerEnd);
            
            // Parse header
            StaticJsonDocument<200> doc;
            DeserializationError error = deserializeJson(doc, headerJson);
            
            if (!error) {
              size_t offset = doc["offset"];
              size_t size = doc["size"];
              size_t total = doc["total"];
              
              Serial.print("\nReceived firmware chunk: offset=");
              Serial.print(offset);
              Serial.print(", size=");
              Serial.print(size);
              Serial.print(", total=");
              Serial.println(total);
              
              // Prepare to receive binary data
              receivingBinaryData = true;
              binaryDataLength = size;
              dataOffset = 0;
              
              // Look for any binary data already received
              int dataStart = headerEnd + 1;
              if (dataStart < receivedData.length()) {
                // Copy binary data already in the buffer
                for (int i = dataStart; i < receivedData.length() && dataOffset < binaryDataLength; i++) {
                  fotaInfo.updateBuffer[dataOffset++] = receivedData[i];
                }
              }
              
              // Clear buffer after processing header
              receivedData = "";
            }
          }
        }
        
        // Prevent buffer overflow - trim if too long
        if (receivedData.length() > 1024) {
          receivedData = receivedData.substring(receivedData.length() - 512);
        }
        
        // Cek koneksi terputus
        if (receivedData.indexOf("CLOSED") != -1 || receivedData.indexOf("ERROR") != -1) {
          Serial.println("\nConnection lost. Will attempt to reconnect...");
          mqttConnected = false;
          receivedData = "";
          
          // Attempt reconnection
          reconnectMQTT();
        }
      }
    }
    
    // Check for serial input from debug console
    if (Serial.available()) {
      SerialAT.write(Serial.read());
    }
    
    // Short delay
    vTaskDelay(20 / portTICK_PERIOD_MS);
  }
}

// ==================== FOTA Task ====================
void fotaTask(void *parameter) {
  while(true) {
    if (fotaInfo.updateAvailable && !fotaInfo.updateInProgress) {
      Serial.println("\n!!! New firmware version available. Starting update process !!!");
      startOtaUpdate();
    } else {
      if (fotaInfo.updateAvailable) {
        Serial.println("Update available but already in progress");
      }
    }
    
    // Not much to do if no update is available or in progress
    vTaskDelay(1000 / portTICK_PERIOD_MS);
  }
}

// ==================== AT Command Functions ====================
void sendAT(String cmd, String expected, int timeout) {
  SerialAT.println(cmd);
  Serial.print(">> "); Serial.println(cmd);
  
  long t = millis();
  while (millis() - t < timeout) {
    if (SerialAT.available()) {
      String r = SerialAT.readString();
      Serial.print(r);
      if (r.indexOf(expected) != -1) break;
    }
    delay(10);
  }
}

// Reconnect function
void reconnectMQTT() {
  Serial.println("Attempting to reconnect to MQTT broker...");
  
  sendAT("AT+CIPSHUT", "SHUT OK");
  sendAT("AT+CSTT=\"" + String(SIM_APN) + "\"", "OK");
  sendAT("AT+CIICR", "OK");
  sendAT("AT+CIFSR", ".");
  
  // Connect TCP socket to MQTT broker
  sendAT("AT+CIPSTART=\"TCP\",\"" + String(MQTT_BROKER) + "\",\"" + String(MQTT_PORT) + "\"", "CONNECT OK", AT_CONNECT_TIMEOUT);
  
  delay(2000);
  sendRawMQTTConnect();
  delay(1000);
  sendRawMQTTSubscribe(); // Re-subscribe to FOTA topics
  
  lastPingTime = millis();
  mqttConnected = true;
}

// ==================== MQTT Protocol Functions ====================
void sendRawMQTTConnect() {
  uint8_t clientId[] = MQTT_CLIENT_ID;
  uint8_t clientIdLength = strlen(MQTT_CLIENT_ID);
  
  // Fixed header
  uint8_t fixedHeader = MQTT_CONNECT;
  // Variable header length + payload length
  uint8_t remainingLength = 10 + 2 + clientIdLength;
  
  // Fixed Header
  // MQTT CONNECT (1 byte) + Remaining Length (1 byte)
  uint8_t mqttPacket[2] = {fixedHeader, remainingLength};
  
  Serial.print("MQTT CONNECT header (HEX): ");
  Serial.println(bytesToHexString(mqttPacket, sizeof(mqttPacket)));

  // Start CIPSEND
  SerialAT.println("AT+CIPSEND");
  delay(100);

  // Send fixed header
  SerialAT.write(mqttPacket, 2);
  
  // Variable Header
  // Protocol Name
  SerialAT.write(0x00); // Length MSB
  SerialAT.write(0x04); // Length LSB
  SerialAT.write('M');
  SerialAT.write('Q');
  SerialAT.write('T');
  SerialAT.write('T');
  
  // Protocol Level
  SerialAT.write(0x04); // MQTT 3.1.1
  
  // Connect Flags
  SerialAT.write(0x02); // Clean Session
  
  // Keep Alive
  SerialAT.write(0x00); // MSB
  SerialAT.write(MQTT_KEEP_ALIVE); // LSB
  
  // Payload
  // Client ID
  SerialAT.write(0x00); // Length MSB
  SerialAT.write(clientIdLength); // Length LSB
  SerialAT.write(clientId, clientIdLength);
  
  // End CIPSEND
  SerialAT.write(0x1A); // CTRL+Z
  
  Serial.println(">> MQTT CONNECT packet sent");
}

void sendRawMQTTSubscribe() {
  // Topics to subscribe
  const char* topics[] = {MQTT_TOPIC_INFO, MQTT_TOPIC_DATA};
  uint8_t topicsCount = 2;
  
  // Packet ID
  uint16_t packetId = 1; // Can be any 16-bit value
  
  // Calculate length
  uint8_t lengthSum = 2; // Packet ID length
  for (int i = 0; i < topicsCount; i++) {
    lengthSum += 2 + strlen(topics[i]) + 1; // Topic length (2 bytes) + Topic + QoS (1 byte)
  }
  
  // Start CIPSEND
  SerialAT.println("AT+CIPSEND");
  delay(500);
  
  // Fixed Header
  SerialAT.write(MQTT_SUBSCRIBE); // SUBSCRIBE
  SerialAT.write(lengthSum); // Remaining Length
  
  // Variable Header
  SerialAT.write(packetId >> 8); // Packet ID MSB
  SerialAT.write(packetId & 0xFF); // Packet ID LSB
  
  // Payload
  for (int i = 0; i < topicsCount; i++) {
    uint16_t topicLength = strlen(topics[i]);
    SerialAT.write(topicLength >> 8); // Topic Length MSB
    SerialAT.write(topicLength & 0xFF); // Topic Length LSB
    
    // Topic Name
    for (int j = 0; j < topicLength; j++) {
      SerialAT.write(topics[i][j]);
    }
    
    // QoS
    SerialAT.write(0x00); // QoS 0
  }
  
  // End CIPSEND
  SerialAT.write(0x1A); // CTRL+Z
  
  Serial.println(">> MQTT SUBSCRIBE packet sent for FOTA topics");
}

void sendPingReq() {
  SerialAT.println("AT+CIPSEND");
  delay(500);

  SerialAT.write(0xC0); // MQTT PINGREQ
  SerialAT.write(0x00); // Remaining Length = 0
  
  delay(100);
  SerialAT.write(0x1A); // Ctrl+Z

  Serial.println(">> MQTT PINGREQ sent");
}

void sendMQTTPublish(const char* topic, const char* message) {
  uint8_t topicLen = strlen(topic);
  uint8_t messageLen = strlen(message);

  // Total Remaining Length = Topic length (2 bytes + topic) + message
  uint8_t remainingLength = 2 + topicLen + messageLen;

  SerialAT.println("AT+CIPSEND");
  delay(500);

  SerialAT.write(0x30);           // PUBLISH (QoS 0, no DUP, no RETAIN)
  SerialAT.write(remainingLength); // Remaining Length

  // Topic Length (2 bytes MSB, LSB)
  SerialAT.write(0x00);
  SerialAT.write(topicLen);

  // Topic
  for (int i = 0; i < topicLen; i++) {
    SerialAT.write(topic[i]);
  }

  // Payload
  for (int i = 0; i < messageLen; i++) {
    SerialAT.write(message[i]);
  }

  delay(100);
  SerialAT.write(0x1A); // Ctrl+Z

  Serial.println(">> MQTT PUBLISH sent");
  Serial.print("   Topic: ");
  Serial.println(topic);
  Serial.print("   Message: ");
  Serial.println(message);
}

// ==================== FOTA Functions ====================
bool checkFirmwareUpdate() {
  Serial.println("Checking for firmware updates...");
  
  // Prepare JSON request
  StaticJsonDocument<200> doc;
  doc["device"] = DEVICE_ID;
  doc["action"] = "check";
  doc["version"] = FIRMWARE_VERSION;
  
  // Serialize JSON
  char buffer[256];
  serializeJson(doc, buffer);
  
  // Send request
  sendMQTTPublish(MQTT_TOPIC_PUB, buffer);
  
  return true;
}

void processFirmwareInfo(String jsonStr) {
  Serial.println("\n=== Processing firmware info ===");
  
  StaticJsonDocument<MAX_JSON_SIZE> doc;
  DeserializationError error = deserializeJson(doc, jsonStr);
  
  if (error) {
    Serial.print("JSON parsing error: ");
    Serial.println(error.c_str());
    return;
  }
  
  String newVersion = doc["version"].as<String>();
  Serial.print("Current firmware version: ");
  Serial.println(FIRMWARE_VERSION);
  Serial.print("Available firmware version: ");
  Serial.println(newVersion);
  
  // Debug printouts untuk perbandingan versi
  Serial.print("Version comparison result: ");
  int compResult = compareVersions(newVersion, FIRMWARE_VERSION);
  Serial.println(compResult);
  
  // Compare versions to see if update needed
  if (compResult > 0) {
    Serial.println("NEW FIRMWARE VERSION AVAILABLE!");
    
    // Store firmware details
    fotaInfo.version = newVersion;
    fotaInfo.name = doc["name"].as<String>();
    fotaInfo.size = doc["size"];
    fotaInfo.md5 = doc["md5"].as<String>();
    fotaInfo.updateAvailable = true;
    
    Serial.print("Firmware details: name=");
    Serial.print(fotaInfo.name);
    Serial.print(", size=");
    Serial.print(fotaInfo.size);
    Serial.print(" bytes, md5=");
    Serial.println(fotaInfo.md5);
    Serial.println("Update will start soon...");
  } else {
    Serial.println("No firmware update needed, already on latest version.");
    fotaInfo.updateAvailable = false;
  }
  Serial.println("=== End processing firmware info ===\n");
}

void startOtaUpdate() {
  Serial.println("Starting OTA update process...");
  
  // Initialize MD5 builder
  fotaInfo.md5Builder.begin();
  
  // Initialize update
  if (!Update.begin(fotaInfo.size)) {
    Serial.println("Not enough space for update!");
    fotaInfo.updateAvailable = false;
    return;
  }
  
  // Mark update as in progress
  fotaInfo.updateInProgress = true;
  fotaInfo.currentOffset = 0;
  
  // Request first chunk
  size_t chunkSize = FIRMWARE_BUFFER_SIZE;
  if (chunkSize > fotaInfo.size) {
    chunkSize = fotaInfo.size;
  }
  
  requestFirmwareChunk(0, chunkSize);
}

void requestFirmwareChunk(size_t offset, size_t size) {
  Serial.print("Requesting firmware chunk: offset=");
  Serial.print(offset);
  Serial.print(", size=");
  Serial.println(size);
  
  // Prepare JSON request
  StaticJsonDocument<200> doc;
  doc["device"] = DEVICE_ID;
  doc["action"] = "download";
  doc["offset"] = offset;
  doc["size"] = size;
  
  // Serialize JSON
  char buffer[256];
  serializeJson(doc, buffer);
  
  // Send request
  sendMQTTPublish(MQTT_TOPIC_PUB, buffer);
}

// ==================== Utility Functions ====================
String byteToHexString(uint8_t byte) {
  const char hexChars[] = "0123456789ABCDEF";
  String result = "";
  result += hexChars[byte >> 4];
  result += hexChars[byte & 0x0F];
  return result;
}

String bytesToHexString(const uint8_t* bytes, size_t length) {
  String result = "";
  for (size_t i = 0; i < length; i++) {
    result += byteToHexString(bytes[i]);
    result += " ";
  }
  return result;
}

uint8_t hexCharToByte(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return 0;
}

void hexStringToBytes(const String& hexString, uint8_t* output, size_t* outputLength) {
  String cleanHex = hexString;
  cleanHex.replace(" ", ""); // Remove spaces
  
  size_t length = cleanHex.length() / 2;
  *outputLength = length;
  
  for (size_t i = 0; i < length; i++) {
    uint8_t highNibble = hexCharToByte(cleanHex.charAt(i * 2));
    uint8_t lowNibble = hexCharToByte(cleanHex.charAt(i * 2 + 1));
    output[i] = (highNibble << 4) | lowNibble;
  }
}

// Compare two semantic version strings (returns 1 if v1 > v2, 0 if equal, -1 if v1 < v2)
int compareVersions(String v1, String v2) {
  Serial.print("Comparing versions: ");
  Serial.print(v1);
  Serial.print(" vs ");
  Serial.println(v2);
  
  // Split first version string
  int v1major = 0, v1minor = 0, v1patch = 0;
  sscanf(v1.c_str(), "%d.%d.%d", &v1major, &v1minor, &v1patch);
  
  // Split second version string
  int v2major = 0, v2minor = 0, v2patch = 0;
  sscanf(v2.c_str(), "%d.%d.%d", &v2major, &v2minor, &v2patch);
  
  Serial.printf("Parsed v1: %d.%d.%d\n", v1major, v1minor, v1patch);
  Serial.printf("Parsed v2: %d.%d.%d\n", v2major, v2minor, v2patch);
  
  // Compare major version
  if (v1major > v2major) return 1;
  if (v1major < v2major) return -1;
  
  // Compare minor version
  if (v1minor > v2minor) return 1;
  if (v1minor < v2minor) return -1;
  
  // Compare patch version
  if (v1patch > v2patch) return 1;
  if (v1patch < v2patch) return -1;
  
  // All parts equal
  return 0;
}