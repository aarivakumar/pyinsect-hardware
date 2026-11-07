#!/usr/bin/env bash
# One-time setup so Chrome/Edge (Web Serial) and the Arduino IDE can open the
# PyInsect turntable's USB serial port on Ubuntu / Debian Linux.
#
#   bash scripts/setup-linux-serial.sh
#
# What it does (asks for your password once):
#   1. Installs a udev rule that gives the logged-in user access to ESP32 USB serial
#      ports (Espressif native USB, CH340/CH9102, CP210x) as soon as they're plugged in.
#   2. Adds you to the "dialout" group (the standard Linux serial-port group) as a backup.
#   3. Reloads udev so it works right away, with no log-out needed.
set -euo pipefail

RULE_FILE=/etc/udev/rules.d/70-pyinsect-turntable.rules   # must sort before 73-seat-late.rules for uaccess
TARGET_USER="${SUDO_USER:-$USER}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script is only needed on Linux." >&2
  exit 1
fi

echo "==> Installing udev rule: $RULE_FILE"
sudo tee "$RULE_FILE" >/dev/null <<'EOF'
# PyInsect turntable: let the logged-in user open ESP32 USB serial ports (Web Serial / Arduino IDE)
# Espressif native USB (ESP32-C3, ESP32-S3 "USB JTAG/serial debug unit")
SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", GROUP="dialout", MODE="0660", TAG+="uaccess"
# WCH CH340 / CH9102 USB-serial chips
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", GROUP="dialout", MODE="0660", TAG+="uaccess"
# Silicon Labs CP210x USB-serial chips
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", GROUP="dialout", MODE="0660", TAG+="uaccess"
EOF

echo "==> Adding $TARGET_USER to the dialout group"
sudo usermod -aG dialout "$TARGET_USER"

echo "==> Reloading udev rules"
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=tty --action=change
sleep 1

# Ubuntu's braille-display service (brltty) grabs CH340 boards and makes the port vanish.
if lsusb 2>/dev/null | grep -qi "1a86:" && systemctl is-active --quiet brltty-udev.service 2>/dev/null; then
  echo
  echo "!! A CH340 USB-serial board is plugged in and the 'brltty' braille service is running."
  echo "   brltty often steals CH340 ports. If you don't use a braille display, disable it with:"
  echo "     sudo systemctl mask brltty-udev.service && sudo systemctl stop brltty-udev.service"
fi

# Chromium installed as a Snap needs an extra permission.
if command -v snap >/dev/null && snap list chromium >/dev/null 2>&1; then
  echo "==> Chromium Snap found: allowing it to use USB serial"
  sudo snap connect chromium:raw-usb || true
fi

echo
echo "==> Checking ports"
found=0
for p in /dev/ttyACM* /dev/ttyUSB*; do
  [[ -e "$p" ]] || continue
  found=1
  if [[ -r "$p" && -w "$p" ]]; then
    echo "   OK   $p is usable by $TARGET_USER"
  else
    echo "   ??   $p still not usable. Unplug and replug the ESP32, or log out and back in."
  fi
done
[[ $found == 1 ]] || echo "   (no ESP32 plugged in right now: plug it in and it will just work)"

echo
echo "Done. Reload http://localhost:8000 in Chrome and press Connect turntable."
