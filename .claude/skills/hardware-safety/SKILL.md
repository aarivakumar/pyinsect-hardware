---
name: hardware-safety
description: Safety checks to apply before recommending wiring, pin assignments, power arrangements, or code that drives motors, servos, relays, solenoids, high-current LEDs, or batteries. Use whenever advice could damage a board, component, or person if wrong.
---

# Hardware safety checks

Run through these before giving wiring or power advice, or code that switches loads. If a
check can't be confirmed from the repo or the user, **state the assumption explicitly**.

## Voltage levels
- Raspberry Pi GPIO and most modern MCUs (RP2040, ESP32, SAMD, nRF) are **3.3 V only and not 5 V tolerant**. Never connect a 5 V output directly; use a level shifter or voltage divider.
- Arduino-class boards (ATmega328P) are 5 V; a 3.3 V device may need shifting the other way.
- ADC inputs must stay within 0–Vref (often 3.3 V, ESP32 effectively lower); divide higher voltages.

## Current limits
- GPIO pins source/sink only a few mA (Pi: ~16 mA per pin, ~50 mA total; RP2040: ~12 mA). **Never drive motors, relays, solenoids, or LED strips directly from a pin.**
- LEDs always need a series resistor: R = (Vsupply − Vf) / I.
- Use a transistor/MOSFET (logic-level gate) or a driver board (DRV8833, TB6612, L298N, PCA9685 for servos) for any load above a few mA.

## Inductive loads (motors, relays, solenoids)
- Need a flyback diode across the coil, unless the driver board has one built in.
- Power servos and motors from a **separate supply** sized for stall current, with grounds tied together. Powering servos from the board's 5 V/3.3 V pin causes brown-outs and resets.
- Add bulk capacitance (e.g. 100–470 µF) near motor drivers.

## Power and batteries
- Check the regulator's current rating before adding peripherals to a board's 3.3 V rail.
- LiPo/Li-ion: use a proper charger/protection circuit, never short, puncture, or over-discharge; warn about this when batteries come up.
- Don't back-feed: avoid powering the board from USB and an external 5 V at the same time unless the board supports it.
- Mains voltage: do not give wiring instructions for mains; recommend a rated, enclosed relay module or a qualified electrician.

## Pin assignment
- Avoid boot-strapping and reserved pins (ESP32: GPIO 0, 2, 12, 15 and flash pins 6–11; Pi: GPIO 2/3 are I2C with fixed pull-ups, GPIO 14/15 UART).
- Check for conflicts: two devices on one pin, PWM channel sharing (RP2040 pins share slices), SPI/I2C pins reused as plain GPIO.
- Define a safe default state at boot (motors off, relays de-energized). Note that pins float during boot until code configures them; add pull-downs on driver enable pins if that matters.

## Code-level safety
- Motor/actuator code must stop outputs on exceptions and on exit (`try/finally`).
- Clamp duty cycles and servo angles to the mechanism's real limits.
- Add a timeout/watchdog for anything that could run away (e.g. `machine.WDT`, or stop motors if no command in N ms).

## Output
When giving wiring, include a short pin table (board pin → device pin → notes) and list every assumption (voltage, supply, driver board) you couldn't confirm.
