#ifndef FOTA_H
#define FOTA_H

#include <Arduino.h>
#include <SoftwareSerial.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <MD5Builder.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>

// Struktur untuk informasi firmware
struct FirmwareInfo {
  String version;
  String name;
  String url;
  size_t size;
  String md5;
};

// Fungsi reset SIM800L
void resetSIM800L();

// Inisialisasi SIM800L
void initFOTA(uint8_t rx_pin, uint8_t tx_pin, uint8_t rst_pin = -1, uint32_t baud_rate = 9600);

// Fungsi koneksi GPRS
bool connectGPRS(const char* apn, const char* user = "", const char* password = "");
void disconnectGPRS();
bool isGPRSConnected();

// Fungsi AT Command
String sendATCommand(const char* command, int timeout = 2000);
String sendATCommandWithString(String command, int timeout = 2000);

// Fungsi cek dan update firmware
bool getFirmwareInfo(FirmwareInfo &info, const char* server, const char* endpoint);
bool downloadAndUpdateFirmware(FirmwareInfo &info, const char* server);
void checkFirmwareUpdate(const char* currentVersion, const char* server, const char* versionEndpoint, const char* firmwareEndpoint);

#endif // FOTA_H