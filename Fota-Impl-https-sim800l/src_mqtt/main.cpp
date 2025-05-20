#include <Arduino.h>
#include <HardwareSerial.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// MQTT Configuration
#define MQTT_BROKER           "fota.getstokfms.com"
#define MQTT_PORT             "1883"
#define MQTT_CLIENT_ID        "client"
#define MQTT_TOPIC            "esp32/test"
#define MQTT_MESSAGE          "hello"
#define MQTT_KEEP_ALIVE       60  // seconds

// SIM800L Configuration
#define SIM800L_SERIAL        2   // UART2
#define SIM800L_BAUD          115200
#define SIM800L_RX            16  // GPIO16
#define SIM800L_TX            17  // GPIO17
#define SIM_APN               "internet"  // Change according to your operator

// Timing Configuration
#define PING_INTERVAL         30000  // 30 seconds
#define PUBLISH_INTERVAL      10000  // 10 seconds
#define AT_DEFAULT_TIMEOUT    2000   // 2 seconds
#define AT_CONNECT_TIMEOUT    5000   // 5 seconds

// MQTT Packet Types
#define MQTT_CONNECT          0x10
#define MQTT_PUBLISH          0x30
#define MQTT_PINGREQ          0xC0

// UART for SIM800L
HardwareSerial SerialAT(SIM800L_SERIAL);

// Global variables
TaskHandle_t mqttTaskHandle = NULL;
TaskHandle_t monitorTaskHandle = NULL;
unsigned long lastPingTime = 0;
unsigned long lastPublishTime = 0;
bool mqttConnected = false;

// Function prototypes
void sendAT(String cmd, String expected, int timeout = AT_DEFAULT_TIMEOUT);
void sendRawMQTTConnect();
void sendPingReq();
void reconnectMQTT();
void sendMQTTPublish(const char* topic, const char* message);
void mqttTask(void *parameter);
void monitorTask(void *parameter);
String byteToHexString(uint8_t byte);
String bytesToHexString(const uint8_t* bytes, size_t length);
uint8_t hexCharToByte(char c);
void hexStringToBytes(const String& hexString, uint8_t* output, size_t* outputLength);

void setup() {
  Serial.begin(115200);
  SerialAT.begin(SIM800L_BAUD, SERIAL_8N1, SIM800L_RX, SIM800L_TX);
  delay(3000);

  Serial.println("Initializing dual-core MQTT client with SIM800L...");
  
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
  lastPingTime = millis();
  lastPublishTime = millis();
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
    2048,
    NULL,
    1,
    &monitorTaskHandle,
    1  // Core 1
  );
}

void loop() {
  // Main loop is empty as we're using FreeRTOS tasks
  delay(1000); // Standard delay instead of vTaskDelay to simplify
}

// ==================== MQTT Task ====================
void mqttTask(void *parameter) {
  // Just handle periodic operations, connection is already established
  while(true) {
    // Send MQTT ping to keep connection alive
    if (millis() - lastPingTime > PING_INTERVAL) {
      sendPingReq();
      lastPingTime = millis();
    }
    
    // Publish message periodically
    if (millis() - lastPublishTime > PUBLISH_INTERVAL) {
      sendMQTTPublish(MQTT_TOPIC, MQTT_MESSAGE);
      lastPublishTime = millis();
    }
    
    // Short delay
    vTaskDelay(100 / portTICK_PERIOD_MS);
  }
}

// ==================== Monitor Task ====================
void monitorTask(void *parameter) {
  while(true) {
    // Check for incoming data from SIM800L
    if (SerialAT.available()) {
      String response = SerialAT.readString();
      Serial.print(response);
      
      // Check if connection is lost
      if (response.indexOf("CLOSED") != -1 || response.indexOf("ERROR") != -1) {
        Serial.println("Connection lost. Will attempt to reconnect...");
        mqttConnected = false;
        
        // Attempt reconnection
        reconnectMQTT();
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
    delay(10);  // Simple delay instead of vTaskDelay
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
  lastPingTime = millis();
  lastPublishTime = millis();
  mqttConnected = true;
}

// ==================== MQTT Protocol Functions ====================
void sendRawMQTTConnect() {
  // Use exact same packet as original successful code
  uint8_t mqttPacket[] = {
    0x10, 0x12,                  // Fixed header (CONNECT + remaining length)
    0x00, 0x04, 'M','Q','T','T', // Protocol Name
    0x04,                        // Protocol Level = 4 (MQTT 3.1.1)
    0x02,                        // Connect Flags (clean session)
    0x00, 0x3C,                  // Keep Alive = 60s
    0x00, 0x06,                  // Client ID length = 6
    'c','l','i','e','n','t'      // Client ID
  };

  Serial.print("MQTT CONNECT packet (HEX): ");
  Serial.println(bytesToHexString(mqttPacket, sizeof(mqttPacket)));

  // Send exactly like original
  SerialAT.println("AT+CIPSEND");
  delay(1000);

  for (int i = 0; i < sizeof(mqttPacket); i++) {
    SerialAT.write(mqttPacket[i]);
  }

  delay(100);
  SerialAT.write(0x1A); // Ctrl+Z
  Serial.println(">> MQTT CONNECT packet sent");
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