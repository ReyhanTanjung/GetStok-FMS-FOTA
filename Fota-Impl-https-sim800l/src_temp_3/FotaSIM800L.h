#ifndef FOTA_SIM800L_H
#define FOTA_SIM800L_H

#include <Arduino.h>
#include <HardwareSerial.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <MD5Builder.h>

// SIM800L Configuration
#define SIM800L_SERIAL        2   // UART2
#define SIM800L_BAUD          115200
#define SIM800L_RX            16  // GPIO16
#define SIM800L_TX            17  // GPIO17

// AT Command Timeouts
#define AT_DEFAULT_TIMEOUT    2000   // 2 seconds
#define AT_CONNECT_TIMEOUT    10000  // 10 seconds
#define AT_DATA_TIMEOUT       5000   // 5 seconds

class FotaSIM800L {
  private:
    // Server details
    const char* server_ip;
    int server_port;
    
    // Device details
    String device_id;
    String current_version;
    
    // SIM800L Serial
    HardwareSerial& serialAT;
    
    // Update status
    bool update_in_progress = false;
    size_t total_size = 0;
    size_t current_offset = 0;
    String update_md5 = "";
    String update_version = "";
    
    // Connection status
    bool tcp_connected = false;
    bool gprs_connected = false;
    
    // APN Configuration
    String apn;
    String apn_user;
    String apn_pass;
    
    // Buffering
    static const size_t BUFFER_SIZE = 1024;
    uint8_t buffer[BUFFER_SIZE];
    size_t buffer_pos = 0;
    
    // Response buffer for AT commands
    String response_buffer;
    
    // Private methods
    bool sendATCommand(const String& cmd, const String& expected = "OK", unsigned long timeout = AT_DEFAULT_TIMEOUT);
    bool waitForResponse(const String& expected, unsigned long timeout);
    String readATResponse(unsigned long timeout = AT_DEFAULT_TIMEOUT);
    bool initSIM800L();
    bool setupGPRS();
    bool connectTCP();
    void disconnectTCP();
    bool sendTCPData(const String& data);
    bool sendTCPData(const uint8_t* data, size_t length);
    bool readTCPData(uint8_t* buffer, size_t& length, unsigned long timeout = AT_DATA_TIMEOUT);
    String readTCPLine(unsigned long timeout = AT_DATA_TIMEOUT);    
    bool sendRequest(const JsonDocument& doc);
    bool readResponseHeader(JsonDocument& doc);
    bool receiveBinaryData(size_t chunk_size);
    bool verifyMD5(const String& expected_md5);
    void flushSerialAT();

  public:
    // Constructor
    FotaSIM800L(HardwareSerial& serial, const char* server_address, int port, 
                const char* device_name, const char* version, 
                const char* apn_name, const char* apn_username = "", const char* apn_password = "");
    
    // Initialize SIM800L module
    bool begin();
    
    // Check if module is connected
    bool isConnected();
    
    int getSignalQuality();

    // Function to check for updates
    bool checkForUpdates();
    
    // Function to download and apply update
    bool downloadAndApplyUpdate();
    
    // Function to reset device after update
    void restart();
    
    // Get connection status
    bool isGPRSConnected() { return gprs_connected; }
    bool isTCPConnected() { return tcp_connected; }
    String getConnectionStatus();
};

#endif // FOTA_SIM800L_H