# pyinsect-hardware

**PyInsect Data Collector** builds photo datasets of insects. You put an insect on a turntable. A phone web app spins the turntable, changes the lighting and takes a photo at every angle. Then you review the photos and save them as a named folder.

```
webapp/                 phone web app (plain HTML/CSS/JS, no build step)
firmware/turntable/     Arduino sketch for the ESP32-C3 + 360° servo turntable
```

## User flow

1. **Capture**: press *Capture Dataset*. The app connects to the turntable over USB serial and opens the camera. It then takes a photo every **8 s** (change this with the slider) until it has **at least 500**. The lighting changes automatically at every turntable stop:
   - Camera with a flashlight (phone): room light, flashlight, darker exposure, brighter exposure
   - No flashlight (laptop webcam): the screen glows white, warm and cool, plus room light
   
   The turntable makes several full spins of 24 stops each. Each spin is shifted slightly, so every photo is at a new angle.
2. **Review**: a gallery shows every photo. Tap a photo to remove it.
3. **Name**: type the insect's name. The app saves `<name>.zip`, which holds `<name>/<name>_001_000p0deg_flash.jpg …` and a `labels.csv` (file, insect, angle, lighting, time).

## Turntable hardware

| Servo wire | Connect to |
|---|---|
| Signal (orange / yellow / white) | GPIO4 (`D2` on XIAO ESP32C3, `4` on C3 SuperMini). Change `SERVO_PIN` if you use another pin |
| + (red) | **5V** (USB 5V / VBUS pin), **never 3V3** |
| − (brown / black) | GND |

- Small 360° servos (SG90/MG90-type) can run from the board's 5V pin while it's on USB. For bigger servos (MG995/MG996R), use a separate 5V supply rated at 2 A or more, and connect its GND to the ESP32's GND.
- A 470 µF capacitor across the servo's 5V and GND helps stop resets when the motor starts.
- Avoid GPIO 2, 8 and 9 for the servo. They're strapping pins on the ESP32-C3.

### Flashing the firmware
1. Arduino IDE → install the **esp32** board package (Espressif) and the **ESP32Servo** library.
2. Choose your ESP32-C3 board and set *Tools → USB CDC On Boot → Enabled*.
3. Open `firmware/turntable/turntable.ino` and upload it.
4. Open the Serial Monitor at 115200 baud and type `R90` to test. The turntable should turn about a quarter turn.

## Running the web app

The turntable connects over **USB serial** using Web Serial, which works in **Chrome or Edge on a computer**. Plug the ESP32 into the same computer that runs the app.

```
cd webapp && python3 -m http.server 8000
```
Open `http://localhost:8000`. The first time you press **Capture Dataset**, pick the ESP32's port (often "USB JTAG/serial debug unit"). After that it reconnects automatically. Close the Arduino Serial Monitor first, because only one program can use the port at a time.

### First-time calibration
A 360° servo can't sense its position, so it turns for a set time. Connect the turntable, open **Calibrate turntable** and press **Spin 360°**. If it turns too far, lower *Time for one full spin*. If it stops short, raise it. Then press **Save**. The setting is stored on the ESP32. If the turntable creeps when it should be still, adjust *Stop trim*.
