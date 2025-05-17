#include "FOTA.h"

// Variabel global
SoftwareSerial* simSerial = NULL;
uint8_t SIM800L_RST_PIN = -1;
bool gprsConnected = false;
#define BUFFER_SIZE 1024
char buffer[BUFFER_SIZE];

// Fungsi untuk reset SIM800L
void resetSIM800L() {
  if (SIM800L_RST_PIN >= 0) {
    pinMode(SIM800L_RST_PIN, OUTPUT);
    digitalWrite(SIM800L_RST_PIN, LOW);
    delay(1000);
    digitalWrite(SIM800L_RST_PIN, HIGH);
    delay(3000);
  }
}

// Inisialisasi SIM800L untuk FOTA
void initFOTA(uint8_t rx_pin, uint8_t tx_pin, uint8_t rst_pin, uint32_t baud_rate) {
  // Alokasi memori untuk objek SoftwareSerial
  if (simSerial != NULL) {
    delete simSerial;
  }
  simSerial = new SoftwareSerial(rx_pin, tx_pin);
  simSerial->begin(baud_rate);
  
  // Simpan pin reset
  SIM800L_RST_PIN = rst_pin;
  
  // Reset SIM800L jika pin reset diberikan
  if (SIM800L_RST_PIN >= 0) {
    resetSIM800L();
  }
  
  // Tunggu SIM800L siap
  delay(3000);
  
  // Matikan echo
  sendATCommand("ATE0");
  
  Serial.println("SIM800L FOTA diinisialisasi");
}

// Fungsi untuk mengirim perintah AT dan membaca respons
String sendATCommand(const char* command, int timeout) {
  if (simSerial == NULL) {
    Serial.println("SIM800L belum diinisialisasi");
    return "";
  }
  
  simSerial->println(command);
  String response = "";
  unsigned long startTime = millis();
  
  while (millis() - startTime < timeout) {
    if (simSerial->available()) {
      char c = simSerial->read();
      response += c;
    }
  }
  
  Serial.println("AT Command: " + String(command));
  Serial.println("Response: " + response);
  return response;
}

// Fungsi untuk mengirim perintah AT dengan parameter string
String sendATCommandWithString(String command, int timeout) {
  return sendATCommand(command.c_str(), timeout);
}

// Fungsi untuk terhubung ke jaringan GPRS
bool connectGPRS(const char* apn, const char* user, const char* password) {
  Serial.println("Menghubungkan ke jaringan GPRS...");
  
  if (simSerial == NULL) {
    Serial.println("SIM800L belum diinisialisasi");
    return false;
  }
  
  // Periksa status SIM800L
  String response = sendATCommand("AT", 1000);
  if (response.indexOf("OK") == -1) {
    Serial.println("SIM800L tidak merespons");
    return false;
  }
  
  // Periksa registrasi jaringan
  response = sendATCommand("AT+CREG?", 1000);
  if (response.indexOf("+CREG: 0,1") == -1 && response.indexOf("+CREG: 0,5") == -1) {
    Serial.println("Tidak terdaftar ke jaringan");
    return false;
  }
  
  // Periksa kualitas sinyal
  response = sendATCommand("AT+CSQ", 1000);
  Serial.println("Kualitas sinyal: " + response);
  
  // Konfigurasi APN
  sendATCommand("AT+SAPBR=3,1,\"CONTYPE\",\"GPRS\"", 1000);
  
  String apnCmd = "AT+SAPBR=3,1,\"APN\",\"";
  apnCmd += apn;
  apnCmd += "\"";
  sendATCommandWithString(apnCmd, 1000);
  
  if (strlen(user) > 0) {
    String userCmd = "AT+SAPBR=3,1,\"USER\",\"";
    userCmd += user;
    userCmd += "\"";
    sendATCommandWithString(userCmd, 1000);
  }
  
  if (strlen(password) > 0) {
    String pwdCmd = "AT+SAPBR=3,1,\"PWD\",\"";
    pwdCmd += password;
    pwdCmd += "\"";
    sendATCommandWithString(pwdCmd, 1000);
  }
  
  // Aktifkan konteks GPRS
  response = sendATCommand("AT+SAPBR=1,1", 10000);
  if (response.indexOf("OK") == -1) {
    Serial.println("Gagal mengaktifkan konteks GPRS");
    return false;
  }
  
  // Periksa IP yang diberikan
  response = sendATCommand("AT+SAPBR=2,1", 2000);
  if (response.indexOf("+SAPBR: 1,1") == -1) {
    Serial.println("Konteks GPRS tidak aktif");
    return false;
  }
  
  Serial.println("Terhubung ke jaringan GPRS");
  gprsConnected = true;
  return true;
}

// Fungsi untuk memutuskan koneksi GPRS
void disconnectGPRS() {
  if (simSerial == NULL) {
    return;
  }
  
  sendATCommand("AT+SAPBR=0,1", 5000);
  gprsConnected = false;
  Serial.println("Terputus dari jaringan GPRS");
}

// Cek status koneksi GPRS
bool isGPRSConnected() {
  return gprsConnected;
}

// Fungsi untuk mendapatkan informasi firmware terbaru
bool getFirmwareInfo(FirmwareInfo &info, const char* server, const char* endpoint) {
  Serial.println("Memeriksa pembaruan firmware...");
  
  if (!gprsConnected) {
    Serial.println("GPRS tidak terhubung");
    return false;
  }
  
  // Inisialisasi HTTP
  sendATCommand("AT+HTTPTERM", 1000);
  sendATCommand("AT+HTTPINIT", 1000);
  
  // Setel bearerProfile
  sendATCommand("AT+HTTPPARA=\"CID\",1", 1000);
  
  // Setel URL server
  String url = String(server) + String(endpoint);
  String urlCmd = "AT+HTTPPARA=\"URL\",\"";
  urlCmd += url;
  urlCmd += "\"";
  sendATCommandWithString(urlCmd, 1000);
  
  // Mulai HTTP GET
  String response = sendATCommand("AT+HTTPACTION=0", 10000);
  if (response.indexOf("+HTTPACTION: 0,200") == -1) {
    Serial.println("Gagal mendapatkan informasi firmware");
    sendATCommand("AT+HTTPTERM", 1000);
    return false;
  }
  
  // Baca respons HTTP
  response = sendATCommand("AT+HTTPREAD", 5000);
  
  // Parse JSON
  int jsonStart = response.indexOf('{');
  int jsonEnd = response.lastIndexOf('}');
  
  if (jsonStart == -1 || jsonEnd == -1) {
    Serial.println("Format respons tidak valid");
    sendATCommand("AT+HTTPTERM", 1000);
    return false;
  }
  
  String jsonStr = response.substring(jsonStart, jsonEnd + 1);
  Serial.println("JSON: " + jsonStr);
  
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, jsonStr);
  
  if (error) {
    Serial.print("deserializeJson() gagal: ");
    Serial.println(error.c_str());
    sendATCommand("AT+HTTPTERM", 1000);
    return false;
  }
  
  info.version = doc["version"].as<String>();
  info.name = doc["name"].as<String>();
  info.url = doc["file"].as<String>();
  info.size = doc["size"].as<unsigned int>();
  info.md5 = doc["md5"].as<String>();
  
  sendATCommand("AT+HTTPTERM", 1000);
  return true;
}

// Fungsi untuk mengunduh dan memperbarui firmware
bool downloadAndUpdateFirmware(FirmwareInfo &info, const char* server) {
  Serial.println("Mengunduh firmware baru: " + info.version);
  
  if (!gprsConnected) {
    Serial.println("GPRS tidak terhubung");
    return false;
  }
  
  // Dapatkan partisi OTA yang tidak aktif
  const esp_partition_t* updatePartition = esp_ota_get_next_update_partition(NULL);
  if (!updatePartition) {
    Serial.println("Tidak dapat menemukan partisi OTA yang valid");
    return false;
  }
  
  Serial.print("Menulis ke partisi: ");
  Serial.println(updatePartition->label);
  
  // Inisialisasi HTTP
  sendATCommand("AT+HTTPTERM", 1000);
  sendATCommand("AT+HTTPINIT", 1000);
  
  // Setel bearerProfile
  sendATCommand("AT+HTTPPARA=\"CID\",1", 1000);
  
  // Setel URL firmware
  String url = String(server) + info.url;
  String urlCmd = "AT+HTTPPARA=\"URL\",\"";
  urlCmd += url;
  urlCmd += "\"";
  sendATCommandWithString(urlCmd, 1000);
  
  // Mulai HTTP GET
  String response = sendATCommand("AT+HTTPACTION=0", 30000);
  if (response.indexOf("+HTTPACTION: 0,200") == -1) {
    Serial.println("Gagal mengunduh firmware");
    sendATCommand("AT+HTTPTERM", 1000);
    return false;
  }
  
  // Dapatkan ukuran firmware
  int contentLength = 0;
  int actionIndex = response.indexOf("+HTTPACTION: 0,200,");
  if (actionIndex > 0) {
    contentLength = response.substring(actionIndex + 17).toInt();
  }
  
  if (contentLength != info.size) {
    Serial.println("Ukuran firmware tidak sesuai");
    sendATCommand("AT+HTTPTERM", 1000);
    return false;
  }
  
  // Persiapkan update
  if (!Update.begin(info.size, U_FLASH, LED_BUILTIN)) {
    Serial.println("Tidak cukup ruang untuk update");
    sendATCommand("AT+HTTPTERM", 1000);
    return false;
  }
  
  // Mengatur MD5 untuk verifikasi
  Update.setMD5(info.md5.c_str());
  
  // Baca firmware dengan chunking
  size_t totalBytesRead = 0;
  int chunkSize = 1024; // Ukuran chunk dalam byte
  
  for (int i = 0; i < info.size; i += chunkSize) {
    int endPos = min(i + chunkSize - 1, (int)info.size - 1);
    String range = "AT+HTTPREAD=" + String(i) + "," + String(endPos);
    response = sendATCommandWithString(range, 10000);
    
    // Ekstrak data dari respons
    int dataStart = response.indexOf("\r\n") + 2;
    int chunkLength = response.substring(dataStart).toInt();
    
    if (chunkLength <= 0) {
      Serial.println("Respons tidak valid");
      Update.abort();
      sendATCommand("AT+HTTPTERM", 1000);
      return false;
    }
    
    // Temukan awal data sebenarnya
    dataStart = response.indexOf("\r\n", dataStart) + 2;
    
    // Salin data ke buffer
    size_t bytesToRead = min((size_t)chunkLength, (size_t)(endPos - i + 1));
    for (size_t j = 0; j < bytesToRead && (dataStart + j) < response.length(); j++) {
      buffer[j] = response.charAt(dataStart + j);
    }
    
    // Tulis buffer ke flash
    if (Update.write((uint8_t*)buffer, bytesToRead) != bytesToRead) {
      Serial.println("Gagal menulis ke flash");
      Update.abort();
      sendATCommand("AT+HTTPTERM", 1000);
      return false;
    }
    
    totalBytesRead += bytesToRead;
    Serial.printf("Diunduh %.2f%%\n", (totalBytesRead * 100.0) / info.size);
  }
  
  sendATCommand("AT+HTTPTERM", 1000);
  
  // Selesaikan update
  if (!Update.end()) {
    Serial.println("Error finishing update: " + String(Update.getError()));
    return false;
  }
  
  if (!Update.isFinished()) {
    Serial.println("Update tidak selesai!");
    return false;
  }
  
  Serial.println("Update selesai");
  return true;
}

// Fungsi untuk memeriksa dan melakukan pembaruan firmware
void checkFirmwareUpdate(const char* currentVersion, const char* server, const char* versionEndpoint, const char* firmwareEndpoint) {
  FirmwareInfo newFirmware;
  
  if (!getFirmwareInfo(newFirmware, server, versionEndpoint)) {
    Serial.println("Gagal mendapatkan informasi firmware");
    return;
  }
  
  Serial.println("Firmware terbaru: " + newFirmware.version);
  Serial.println("Firmware saat ini: " + String(currentVersion));
  
  // Bandingkan versi
  if (newFirmware.version.compareTo(currentVersion) > 0) {
    Serial.println("Firmware baru tersedia. Memulai update...");
    
    if (downloadAndUpdateFirmware(newFirmware, server)) {
      Serial.println("Firmware berhasil diperbarui. Memulai ulang...");
      delay(1000);
      ESP.restart();
    } else {
      Serial.println("Pembaruan firmware gagal");
    }
  } else {
    Serial.println("Firmware sudah terbaru");
  }
}