#include <HardwareSerial.h>

// UART2 ke SIM800L
HardwareSerial SerialAT(2); // RX2 = GPIO16, TX2 = GPIO17

void sendAT(String cmd, String expected, int timeout = 2000) {
  SerialAT.println(cmd);
  Serial.print(">> "); Serial.println(cmd);
  long t = millis();
  while (millis() - t < timeout) {
    if (SerialAT.available()) {
      String r = SerialAT.readString();
      Serial.print(r);
      if (r.indexOf(expected) != -1) break;
    }
  }
}

void setup() {
  Serial.begin(115200);
  SerialAT.begin(115200, SERIAL_8N1, 16, 17);
  delay(3000);

  Serial.println("Initializing SIM800L for MQTT...");

  sendAT("AT", "OK");

}

void loop() {
  if (SerialAT.available()) {
    Serial.write(SerialAT.read());
  }

  if (Serial.available()) {
    SerialAT.write(Serial.read());
  }
}
