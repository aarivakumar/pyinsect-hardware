# pyinsect-hardware

**PyInsect Data Collector** builds photo datasets of insects. You put an insect on a turntable. A phone web app spins the turntable, changes the lighting and takes a photo at every angle. Then you review the photos and save them as a named folder.

```
webapp/                 phone web app (plain HTML/CSS/JS, no build step)
firmware/turntable/main.py       MicroPython controller used by the web app
firmware/turntable/turntable.ino  Arduino alternative for the ESP32-C3
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
| Signal (orange / yellow / white) | GPIO6 (board pin marked `6`). Change `SERVO_PIN` in the sketch if you use another pin |
| + (red) | **5V** (USB 5V / VBUS pin), **never 3V3** |
| − (brown / black) | GND |

The firmware drives a continuous-rotation servo at 50 Hz: 1750 µs turns forward, 1250 µs turns in reverse, and 1500 µs stops. The slower default speed offset is +250 µs; set it to −250 µs in calibration to reverse direction.

- Small 360° servos (SG90/MG90-type) can run from the board's 5V pin while it's on USB. For bigger servos (MG995/MG996R), use a separate 5V supply rated at 2 A or more, and connect its GND to the ESP32's GND.
- A 470 µF capacitor across the servo's 5V and GND helps stop resets when the motor starts.
- Avoid GPIO 2, 8 and 9 for the servo. They're strapping pins on the ESP32-C3.

### Installing the MicroPython controller
The web app expects the controller to run on the ESP32-C3's USB serial connection. The ESP32-C3 must already have MicroPython installed.

1. Install `mpremote` from the repository folder: `python -m pip install mpremote`.
2. Close the web app's serial connection and any serial monitor.
3. Copy the controller to the board as `main.py`: `python -m mpremote connect COM4 fs cp firmware/turntable/main.py :main.py`.
4. Restart the board so `main.py` starts: `python -m mpremote connect COM4 reset`.

The Arduino sketch is an alternative controller. To use it instead, install the Espressif **esp32** board package and **ESP32Servo** library, select **ESP32-C3 Dev Module**, enable **USB CDC On Boot**, then upload `firmware/turntable/turntable.ino`. Use only one controller at a time.

## Running the web app

The turntable connects over **USB serial** using Web Serial, which works in **Chrome or Edge on a computer**. Plug the ESP32 into the same computer that runs the app.

```
cd webapp && python3 -m http.server 8000
```
Open `http://localhost:8000`. The first time you press **Capture Dataset**, pick the ESP32's port (often "USB JTAG/serial debug unit"). After that it reconnects automatically. Close the Arduino Serial Monitor first, because only one program can use the port at a time.

### First-time calibration
A 360° servo can't sense its position, so it turns for a set time. Connect the turntable, open **Calibrate turntable** and press **Spin 360°**. If it turns too far, lower *Time for one full spin*. If it stops short, raise it. Then press **Save**. The setting is stored on the ESP32. If the turntable creeps when it should be still, adjust *Stop trim*.
