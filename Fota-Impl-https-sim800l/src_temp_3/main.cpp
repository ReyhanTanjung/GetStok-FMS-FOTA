#include <Arduino.h>
#include <HardwareSerial.h>
#include "FotaSIM800L.h"
#include "Version.h"

// FOTA server details
const char* fota_server = "fota.getstokfms.com"; // Your FOTA server
const int fota_port = 8266; // TCP port (same as WiFi version)

// Device identification
const char* device_name = "ESP32-SIM800L-001"; // Unique device ID

// SIM800L Configuration
HardwareSerial SerialAT(2); // UART2

// APN Configuration (change according to your carrier)
const char* apn = "internet";      // Change this to your carrier's APN
const char* apn_user = "";         // Usually empty
const char* apn_pass = "";         // Usually empty

// FOTA client instance
FotaSIM800L* fotaClient = nullptr;

// Timing variables
unsigned long lastUpdateCheck = 0;
unsigned long lastStatusReport = 0;
const unsigned long UPDATE_CHECK_INTERVAL = 3600000; // 1 hour
const unsigned long STATUS_REPORT_INTERVAL = 30000;  // 30 seconds

// Function declarations
void checkForFirmwareUpdates();
void performNormalOperation();

void setup() {
  // Initialize serial communication
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n\n==================================");
  Serial.println("ESP32 FOTA Client with SIM800L");
  Serial.print("Current Firmware Version: ");
  Serial.println(FIRMWARE_VERSION);
  Serial.println("==================================\n");
  
  // Create FOTA client
  fotaClient = new FotaSIM800L(SerialAT, fota_server, fota_port, 
                               device_name, FIRMWARE_VERSION, 
                               apn, apn_user, apn_pass);
  
  // Initialize SIM800L
  if (!fotaClient->begin()) {
    Serial.println("Failed to initialize SIM800L!");
    Serial.println("Please check:");
    Serial.println("1. SIM800L power and connections");
    Serial.println("2. SIM card is inserted and active");
    Serial.println("3. APN settings are correct");
    Serial.println("System will retry in 30 seconds...");
    delay(30000);
    ESP.restart();
  }
  
  Serial.println("SIM800L initialized successfully!");
  
  // Show signal quality
  int signal = fotaClient->getSignalQuality();
  Serial.print("Signal quality: ");
  Serial.print(signal);
  Serial.println(" (0-31, higher is better)");
  
  // Check for updates on startup
  delay(2000);
  checkForFirmwareUpdates();
  
  // Initialize timing
  lastUpdateCheck = millis();
  lastStatusReport = millis();
}

void loop() {
  // Perform normal device operation
  performNormalOperation();
  
  // Check for updates periodically
  if (millis() - lastUpdateCheck > UPDATE_CHECK_INTERVAL) {
    lastUpdateCheck = millis();
    checkForFirmwareUpdates();
  }
  
  // Status report
  if (millis() - lastStatusReport > STATUS_REPORT_INTERVAL) {
    lastStatusReport = millis();
    
    Serial.print("Device running - Firmware v");
    Serial.print(FIRMWARE_VERSION);
    
    int signal = fotaClient->getSignalQuality();
    if (signal >= 0) {
      Serial.print(" | Signal: ");
      Serial.print(signal);
      Serial.print("/31");
    }
    
    Serial.print(" | Uptime: ");
    Serial.print(millis() / 1000);
    Serial.println(" seconds");
  }
  
  delay(100);
}

void checkForFirmwareUpdates() {
  Serial.println("\n--- Checking for firmware updates ---");
  
  // Check for updates (TCP connection will be established inside checkForUpdates)
  if (fotaClient->checkForUpdates()) {
    Serial.println("\n!!! NEW FIRMWARE AVAILABLE !!!");
    Serial.println("Starting download in 5 seconds...");
    delay(5000);
    
    // Download and apply update
    if (fotaClient->downloadAndApplyUpdate()) {
      Serial.println("\n*** FIRMWARE UPDATE SUCCESSFUL ***");
      Serial.println("Device will restart in 3 seconds...");
      delay(3000);
      fotaClient->restart();
    } else {
      Serial.println("\n*** FIRMWARE UPDATE FAILED ***");
      Serial.println("Device will continue with current firmware");
    }
  } else {
    Serial.println("No updates available or check failed");
  }
  
  Serial.println("--- Update check complete ---\n");
}

void performNormalOperation() {
  // Your device's main functionality goes here
  // This is where you implement your actual application logic
  
  // Example: Read sensors, process data, etc.
  
  // For demonstration, we'll just toggle the built-in LED
  static unsigned long lastBlink = 0;
  static bool ledState = false;
  
  if (millis() - lastBlink > 1000) {
    lastBlink = millis();
    ledState = !ledState;
    
    // Most ESP32 boards have LED on GPIO2
    pinMode(2, OUTPUT);
    digitalWrite(2, ledState ? HIGH : LOW);
  }
  
  // Add your application code here
}