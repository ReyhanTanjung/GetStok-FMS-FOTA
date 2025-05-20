#include <Arduino.h>
#include "FOTA.h"

// Definisi pin untuk SIM800L
#define SIM800L_RX 16
#define SIM800L_TX 17
#define SIM800L_RST 5
#define SIM800L_BAUD 9600

// Konfigurasi APN untuk kartu SIM
const char* apn = "internet"; // Ganti dengan APN provider Anda
const char* apnUser = "";     // Username jika diperlukan
const char* apnPass = "";     // Password jika diperlukan

// Konfigurasi server OTA
const char* otaServer = "https://5ce4-2a09-bac1-34a0-30-00-277-8.ngrok-free.app"; // Ganti dengan URL server Anda
const char* firmwareVersionEndpoint = "/api/firmware/latest";
const char* firmwareEndpoint = "/api/firmware/";
const char* currentVersion = "1.0.0"; // Versi firmware saat ini

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("ESP32 FOTA dengan SIM800L");
  Serial.println("Firmware Version = 1.0.02");
  
  // Inisialisasi SIM800L untuk FOTA
  initFOTA(SIM800L_RX, SIM800L_TX, SIM800L_RST, SIM800L_BAUD);
  
  // Sambungkan ke jaringan GPRS
  if (connectGPRS(apn, apnUser, apnPass)) {
    // Cek pembaruan firmware
    checkFirmwareUpdate(currentVersion, otaServer, firmwareVersionEndpoint, firmwareEndpoint);
  }
  
  // Sisanya dari kode setup Anda
  Serial.println("Setup selesai");
}

void loop() {
  // Kode utama Anda di sini
  
  // Cek pembaruan firmware setiap 24 jam
  static unsigned long lastCheckTime = 0;
  if (millis() - lastCheckTime > 24 * 60 * 60 * 1000UL) {
    if (isGPRSConnected() || connectGPRS(apn, apnUser, apnPass)) {
      checkFirmwareUpdate(currentVersion, otaServer, firmwareVersionEndpoint, firmwareEndpoint);
    }
    lastCheckTime = millis();
  }
  
  delay(1000);
}