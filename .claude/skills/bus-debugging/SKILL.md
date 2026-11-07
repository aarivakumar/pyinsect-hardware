---
name: bus-debugging
description: Systematic checklist for diagnosing I2C, SPI, UART/serial, and 1-Wire communication failures between a board and peripherals. Use when a sensor isn't detected, returns garbage or constant values, times out, or communication is intermittent.
---

# Bus debugging checklist

Work **bottom-up**. Most "driver bugs" turn out to be wiring, power, or addressing. Record what each step showed.

## 0. Power and ground (all buses)
- Is the device powered at its rated voltage? Measure at the device pins, not the supply.
- Is there a **common ground** between board and device? Missing ground is the #1 cause of garbage data.
- Are the logic levels compatible (3.3 V MCU vs 5 V device)? See `hardware-safety`.

## I2C
1. **Scan first.** MicroPython: `i2c.scan()`; CircuitPython: `while not i2c.try_lock(): pass; i2c.scan()`; Pi: `i2cdetect -y 1`.
   - Empty scan → wiring, power, pull-ups, or wrong pins/bus ID.
   - Device at an unexpected address → check address-select pins (ADDR/SA0) and the datasheet's 7-bit vs 8-bit notation (divide 8-bit by 2).
   - Every address responds → SDA/SCL shorted or pulled low.
2. **Pull-ups.** SDA and SCL each need a pull-up (typically 2.2k–10k to 3.3 V). Breakout boards usually include them; many boards in parallel can make the combined pull-up too strong.
3. **Speed.** Drop to 100 kHz (`freq=100_000`) for long wires or flaky reads.
4. **Read a known register** (WHO_AM_I/chip ID) and compare to the datasheet before trusting data.
5. `OSError: [Errno 19] ENODEV` / `ETIMEDOUT` (MicroPython) → device not ACKing; go back to step 1.

## SPI
1. Confirm MOSI↔SDI/DIN, MISO↔SDO/DOUT, SCK↔SCLK, and a **dedicated CS** pin driven high when idle.
2. Match **mode** (CPOL/CPHA = polarity/phase) and bit order to the datasheet; wrong mode gives shifted or garbage bytes.
3. Start slow (≤1 MHz), then increase.
4. All `0x00` or all `0xFF` reads → MISO floating, CS not asserted, or device unpowered.
5. Shared bus: make sure every other device's CS is high.

## UART / serial
1. TX → RX and RX → TX (crossed), plus common ground.
2. Match baud rate, data bits, parity, stop bits (usually 8N1). Garbage characters almost always mean a baud mismatch.
3. On Pi: serial console disabled and UART enabled (`raspi-config`); correct device (`/dev/serial0`, `/dev/ttyUSB0`, `/dev/ttyACM0`).
4. Use timeouts on reads; check for line endings (`\r\n` vs `\n`) in protocol parsing.
5. USB serial devices: check `dmesg` / `ls /dev/tty*` before and after plugging in; user may need the `dialout` group.

## 1-Wire (e.g. DS18B20)
- Needs a 4.7k pull-up on the data line. `ds.scan()` empty → pull-up or wiring.
- Allow the conversion time (~750 ms at 12-bit) before reading.

## Intermittent faults
- Long or unshielded wires, motors on the same supply (brown-outs/noise), loose breadboard contacts, missing decoupling capacitor (0.1 µF near device VCC).
- Add retries with a logged count so frequency is visible, instead of silently swallowing errors.

## Report
State which step failed, the evidence (scan output, error text, measured voltage), and the next physical check the user should do if it can't be verified from code.
