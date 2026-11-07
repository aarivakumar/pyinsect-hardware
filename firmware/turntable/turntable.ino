/*
 * PyInsect Turntable — ESP32-C3 + 360° (continuous rotation) servo, controlled over USB serial
 *
 * The web app (Chrome/Edge, Web Serial) sends one text command per line at 115200 baud.
 * Every command gets exactly ONE reply line:
 *
 *   R<deg>   rotate <deg> degrees, e.g. "R15" or "R15.62"  -> "OK R" when the move finishes
 *   D<ms>    spin continuously for <ms> milliseconds        -> "OK R" when it stops
 *   S        stop now                                      -> "OK S"  (a running R replies "ERR R stopped" first)
 *   C<ms>    set time for one full spin, saved to flash     -> "OK C"
 *   V<us>    set speed (pulse offset, negative = reverse)   -> "OK V"
 *   T<us>    set stop trim (fixes creeping when stopped)    -> "OK T"
 *   ?        status                                         -> "ms=6000 v=100 t=0"
 *
 * Lines starting with "#" are log messages; the web app ignores them.
 * You can type the same commands in the Arduino Serial Monitor (115200, Newline) to test.
 *
 * A 360° servo has no position sensor: speed is set by pulse width (1500 µs = stop),
 * so "rotate N degrees" = "spin for N/360 × msPerRev milliseconds". Calibrate msPerRev
 * from the web app (Calibrate turntable → Spin 360°).
 *
 * Library: "ESP32Servo" by Kevin Harrington (Library Manager).
 * Arduino IDE board: your ESP32-C3 board (e.g. "XIAO_ESP32C3" or "ESP32C3 Dev Module"),
 *   with Tools → USB CDC On Boot → Enabled so Serial goes over the USB-C port.
 */

#include <Arduino.h>
#include <ESP32Servo.h>
#include <Preferences.h>

// ---------- Settings you may need to change ----------
// Servo signal (orange/yellow/white) wire. GPIO4 = "D2" on a Seeed XIAO ESP32C3, "4" on a C3 SuperMini.
// Avoid GPIO 2, 8 and 9 on the ESP32-C3. These are strapping pins and can stop the board from booting.
static const int SERVO_PIN = 4;
static const int NEUTRAL_US = 1500;   // standard servo "stop" pulse

// ---------- State ----------
Servo servo;
Preferences prefs;

int msPerRev = 6000;                  // time for one full 360° spin at speedUs
int speedUs  = 100;                   // pulse offset from neutral while moving
int trimUs   = 0;                     // neutral correction

bool moving = false;
unsigned long moveStart = 0;
unsigned long moveDuration = 0;

void reply(const char *msg) { Serial.println(msg); }

void servoStop() { servo.writeMicroseconds(NEUTRAL_US + trimUs); }

void handleCommand(char *text) {
  while (*text == ' ') text++;
  for (int i = strlen(text) - 1; i >= 0 && isspace((unsigned char)text[i]); i--) text[i] = 0;
  if (!*text) return;

  char op = toupper(text[0]);
  const char *arg = text + 1;
  char buf[32];

  switch (op) {
    case 'R': {
      float deg = atof(arg);
      if (moving)                 { reply("ERR busy"); break; }
      if (deg <= 0 || deg > 3600) { reply("ERR R range"); break; }
      moveDuration = (unsigned long)(deg / 360.0f * msPerRev + 0.5f);
      moveStart = millis();
      moving = true;
      servo.writeMicroseconds(NEUTRAL_US + trimUs + speedUs);
      // reply is sent from loop() when the move finishes
      break;
    }
    case 'D': {   // spin continuously for <ms> milliseconds (used during the photo burst)
      long ms = atol(arg);
      if (moving)                   { reply("ERR busy"); break; }
      if (ms < 50 || ms > 600000)   { reply("ERR D range"); break; }
      moveDuration = (unsigned long)ms;
      moveStart = millis();
      moving = true;
      servo.writeMicroseconds(NEUTRAL_US + trimUs + speedUs);
      break;
    }
    case 'S':
      servoStop();
      if (moving) { moving = false; reply("ERR R stopped"); }
      reply("OK S");
      break;
    case 'C': {
      int v = atoi(arg);
      if (v < 500 || v > 60000) { reply("ERR C range"); break; }
      msPerRev = v;
      prefs.putInt("ms", msPerRev);
      reply("OK C");
      break;
    }
    case 'V': {
      int v = atoi(arg);
      if (abs(v) < 10 || abs(v) > 500) { reply("ERR V range"); break; }
      speedUs = v;
      prefs.putInt("v", speedUs);
      reply("OK V");
      break;
    }
    case 'T': {
      int v = atoi(arg);
      if (v < -100 || v > 100) { reply("ERR T range"); break; }
      trimUs = v;
      prefs.putInt("t", trimUs);
      if (!moving) servoStop();
      reply("OK T");
      break;
    }
    case '?':
      snprintf(buf, sizeof(buf), "ms=%d v=%d t=%d", msPerRev, speedUs, trimUs);
      reply(buf);
      break;
    default:
      reply("ERR ?");
  }
}

void setup() {
  Serial.begin(115200);

  prefs.begin("turntable", false);
  msPerRev = prefs.getInt("ms", msPerRev);
  speedUs  = prefs.getInt("v", speedUs);
  trimUs   = prefs.getInt("t", trimUs);

  // Attach and immediately send "stop" so a continuous servo doesn't spin on boot.
  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2500);
  servoStop();

  Serial.printf("# PyInsect Turntable ready on GPIO%d  ms=%d v=%d t=%d\n", SERVO_PIN, msPerRev, speedUs, trimUs);
}

void loop() {
  static char line[32];
  static uint8_t len = 0;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (len) { line[len] = 0; handleCommand(line); len = 0; }
    } else if (len < sizeof(line) - 1) {
      line[len++] = ch;
    }
  }

  if (moving && millis() - moveStart >= moveDuration) {
    servoStop();
    moving = false;
    reply("OK R");
  }

  delay(1);
}
