---
name: embedded-python
description: Conventions for writing Python that runs on microcontrollers and single-board computers (MicroPython, CircuitPython, Raspberry Pi). Use when writing or reviewing board-level code, main loops, sensor drivers, or pin configuration.
---

# Embedded Python conventions

## Know the runtime
| Runtime | Entry file | Pins / buses | Notes |
|---|---|---|---|
| MicroPython | `boot.py`, then `main.py` | `machine.Pin`, `machine.I2C`, `machine.SPI`, `machine.UART`, `machine.PWM` | `uasyncio`/`asyncio` available; `const()` for constants |
| CircuitPython | `code.py` | `board`, `digitalio`, `busio`, `pwmio`, `analogio` | Auto-reloads on save; no threads; `asyncio` on newer builds |
| CPython on Pi | any script | `gpiozero` (preferred), `RPi.GPIO`, `smbus2`, `spidev`, `pyserial` | Full stdlib; GPIO usually needs group `gpio` or root |

Don't mix APIs across runtimes. When code must run on more than one, put hardware access behind a small interface.

## Structure
- Keep every pin number and bus address in **one** config module (`pins.py` / `config.py`), named by function (`LEFT_MOTOR_PWM = 12`), not scattered literals.
- One small class per device (`class DistanceSensor`), constructed with its bus/pins injected, so it can be tested with a fake.
- Separate logic (gait state machine, filtering, thresholds) from I/O so the logic runs in desktop `pytest`.

## Main loop
- Never use long `time.sleep()` in a loop that also reads inputs. Use timestamps (`time.ticks_ms()`/`ticks_diff()` on MicroPython, `time.monotonic()` elsewhere) or `asyncio` tasks.
- On MicroPython, always compare ticks with `ticks_diff`; raw subtraction breaks on wraparound.
- Keep interrupt handlers (`Pin.irq`) tiny: set a flag or `micropython.schedule()`, with no allocation, printing, or I/O.
- Use `try/finally` (or `KeyboardInterrupt` handling) to stop motors, turn off PWM, and release GPIO on exit.

## Memory (microcontrollers)
- Avoid building strings or lists inside fast loops; preallocate `bytearray` buffers and use `readinto`.
- Use `const()` for integer constants on MicroPython.
- Call `gc.collect()` at known-idle points if allocations are unavoidable; check `gc.mem_free()` when debugging crashes.
- Large lookup tables belong in `bytes`/`array`, not lists of ints.

## Timing and signals
- PWM: state the frequency explicitly (servos ~50 Hz, 1–2 ms pulse; DC motor drivers often 1–20 kHz). Use `duty_u16` on MicroPython when available.
- Debounce mechanical inputs (≥20 ms) in software, or note that hardware debounce is assumed.
- ADC values differ by board (10/12/16-bit, different reference voltages); convert with named constants, not magic numbers.

## Deploying
- MicroPython: `mpremote connect auto cp main.py :` then `mpremote reset`; REPL with `mpremote`.
- CircuitPython: copy to the `CIRCUITPY` drive; serial console at 115200.
- Pi: run with the project venv; mention if `sudo` or group membership is needed.
