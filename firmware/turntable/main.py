"""PyInsect turntable controller for an ESP32-C3 running MicroPython.

USB serial protocol used by the web app (115200 baud):
  R<degrees>  timed rotation; replies OK R when finished
  D<millis>   continuous spin; replies OK R when finished
  S           stop; replies OK S (and ERR R stopped for a canceled move)
  C<millis>   set milliseconds per revolution; replies OK C
  V<offset>   set signed speed offset; replies OK V
  T<offset>   set neutral trim; replies OK T
  ?           report ms, v, and t settings

The slower default pulses are 1,750,000 ns forward, 1,250,000 ns reverse,
and 1,500,000 ns stop at 50 Hz. A +250 us offset selects forward; -250 us
selects reverse.
"""

from machine import Pin, PWM
import sys
import time

try:
    import select
except ImportError:
    import uselect as select

try:
    import esp32
    settings = esp32.NVS("turntable")
except (ImportError, AttributeError):
    settings = None


SERVO_PIN = 6
PWM_HZ = 50
NEUTRAL_US = 1500
DEFAULT_MS_PER_REV = 6000
DEFAULT_SPEED_US = 250
DEFAULT_TRIM_US = 0


def load_setting(key, default):
    if settings is None:
        return default
    try:
        return settings.get_i32(key)
    except OSError:
        return default


def save_setting(key, value):
    if settings is not None:
        settings.set_i32(key, value)
        settings.commit()


ms_per_rev = load_setting("ms", DEFAULT_MS_PER_REV)
speed_us = load_setting("v", DEFAULT_SPEED_US)
trim_us = load_setting("t", DEFAULT_TRIM_US)

# The previous defaults were +100 us and +500 us. Migrate either to the
# slower +250 us pulse once, preserving any other saved calibration.
if speed_us == 100 or speed_us == 500:
    speed_us = 250
    save_setting("v", speed_us)

servo = PWM(Pin(SERVO_PIN), freq=PWM_HZ)
moving = False
move_start = 0
move_duration = 0
input_buffer = ""


def write_pulse_us(pulse_us):
    servo.duty_ns(pulse_us * 1000)


def stop_servo():
    write_pulse_us(NEUTRAL_US + trim_us)


def move_servo(duration_ms):
    global moving, move_start, move_duration
    moving = True
    move_start = time.ticks_ms()
    move_duration = max(1, duration_ms)
    write_pulse_us(NEUTRAL_US + trim_us + speed_us)


def reply(message):
    print(message)


def handle_command(line):
    global ms_per_rev, speed_us, trim_us, moving
    line = line.strip()
    if not line:
        return

    op = line[0].upper()
    arg = line[1:].strip()

    if op == "R":
        try:
            degrees = float(arg)
        except ValueError:
            reply("ERR R range")
            return
        if moving:
            reply("ERR busy")
        elif degrees <= 0 or degrees > 3600:
            reply("ERR R range")
        else:
            move_servo(int(degrees / 360.0 * ms_per_rev + 0.5))
        return

    if op == "D":
        try:
            duration = int(arg)
        except ValueError:
            reply("ERR D range")
            return
        if moving:
            reply("ERR busy")
        elif duration < 50 or duration > 600000:
            reply("ERR D range")
        else:
            move_servo(duration)
        return

    if op == "S":
        was_moving = moving
        moving = False
        stop_servo()
        if was_moving:
            reply("ERR R stopped")
        reply("OK S")
        return

    if op == "C":
        try:
            value = int(arg)
        except ValueError:
            reply("ERR C range")
            return
        if value < 500 or value > 60000:
            reply("ERR C range")
            return
        try:
            save_setting("ms", value)
        except OSError:
            reply("ERR storage")
            return
        ms_per_rev = value
        reply("OK C")
        return

    if op == "V":
        try:
            value = int(arg)
        except ValueError:
            reply("ERR V range")
            return
        if abs(value) < 10 or abs(value) > 500:
            reply("ERR V range")
            return
        try:
            save_setting("v", value)
        except OSError:
            reply("ERR storage")
            return
        speed_us = value
        reply("OK V")
        return

    if op == "T":
        try:
            value = int(arg)
        except ValueError:
            reply("ERR T range")
            return
        if value < -100 or value > 100:
            reply("ERR T range")
            return
        try:
            save_setting("t", value)
        except OSError:
            reply("ERR storage")
            return
        trim_us = value
        if not moving:
            stop_servo()
        reply("OK T")
        return

    if op == "?":
        reply("ms={} v={} t={}".format(ms_per_rev, speed_us, trim_us))
        return

    reply("ERR ?")


stop_servo()
poller = select.poll()
poller.register(sys.stdin, select.POLLIN)
reply("# PyInsect Turntable ready on GPIO{} ms={} v={} t={}".format(
    SERVO_PIN, ms_per_rev, speed_us, trim_us
))

while True:
    # Read available characters without blocking the movement timer.
    for _ in range(32):
        if not poller.poll(0):
            break
        char = sys.stdin.read(1)
        if not char:
            break
        if char == "\r" or char == "\n":
            if input_buffer:
                handle_command(input_buffer)
                input_buffer = ""
        elif len(input_buffer) < 31:
            input_buffer += char
        else:
            input_buffer = ""

    if moving and time.ticks_diff(time.ticks_ms(), move_start) >= move_duration:
        stop_servo()
        moving = False
        reply("OK R")

    time.sleep_ms(1)
