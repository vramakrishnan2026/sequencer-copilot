# 75F Site Sequencer: block guide for AI assistants

Guide version 10 (draft). Written for Connect module sequences, including model points.

This guide explains what the Site Sequencer blocks mean and how to use them. It is read together with the **live block list** exported from the editor, which lists every block in the palette with its exact field names, input names and dropdown values. When the guide and the block list disagree on a name or a value, **the block list wins**: it is read from the live editor.

Two kinds of request:
- **Blank canvas** (the default): build the sequence from scratch using the block list. No export is needed; do not ask for one, unless the request needs model points (they exist only in a sequence export). Create every block with a `ref`.
- **Existing sequence**: the person attaches a **sequence export** of that canvas. Existing blocks are referred to by the ids in that attachment, and only that attachment. If a request is about existing blocks and no sequence export is attached, ask for one.

## Output contract (read this first)

The Sequencer Copilot extension applies your answer to the canvas, so the format is fixed.

**How to answer**
- Questions, explanations and diagnosis: answer in prose. No JSON.
- A change to the canvas: 1–3 sentences saying what the plan does and which [NEEDS VERIFICATION] rules it relies on, then **exactly one** fenced code block marked `json` containing the plan. Nothing after it except an optional `findings` block.
- Unclear which input, output, relay, register, model point, setpoint or unit is meant: ask one short question instead of planning. A wrong number switches the wrong equipment.
- When you learn something this guide does not say or gets wrong (a correction from the person, the cause of a rejected plan, a fact the person confirms), end the reply with a fenced block marked `findings`: one `- ` line per lesson, each a self-contained sentence naming the block, field or value. Leave it out when there is nothing new.
- The plan is always complete. When the extension rejects a plan, the person pastes its error list back; reply with a corrected, complete plan, not a patch.

**Interpreting the request**
- "Add" or "also" means keep every existing block and add new ones beside them (usually stacked with `NEXT`). Never delete to make room.
- "Replace", "change to" or "instead of" means the old block goes: delete it, or `setField` it if only a value changes.
- "Remove" or "delete" means delete, and nothing else.
- Change only what was asked. If you notice another problem, mention it in prose; do not fix it in the plan.
- For an existing sequence, build every plan from the latest sequence export. Block ids change when a sequence is reloaded; copy them character for character (they contain symbols such as `` ` ``, `$` and `|`).

**The plan's shape** (JSON Schema)

```json
{{PLAN_SCHEMA}}
```

**A complete, tested example.** Request: "Add AO1, set to 4 V when the condition is true." The if-block's DO branch already holds a Set Relay Output block with id `` ,5nQ),(P9KF|$yPzv`~M ``, and it must be kept:

```json
{{PLAN_EXAMPLE}}
```

**Operations**

{{OPS_GUIDE}}

**Edge only, or linked to a model**
Before building a new sequence (blank canvas, or a `model_block` with no model chosen), ask once: "Edge only, or linked to a model so its values reach the portal as model points?" Skip it if a model is already chosen or the person said.
- Edge only: build as usual.
- Linked to a model: two rounds, since a model's points only appear once the person picks the model. Round 1: a plan that only adds a `model_block` as the first block in `sequence_run_startup` (create startup, `DEVICE_TYPE` `CONNECT_MODULE`, if missing), `selected_model` unset; tell the person to apply it, pick the model in Select Model, then copy the sequence in Edit mode and send it back. Round 2: the full plan, from that export. Never guess a model id or point before round 2.

**Model points**
They belong to the model in `model_block` and appear only in an export's Model Points category: use only those; if one is needed and no export is attached, ask for one.
- Each is a value block with a `model_point_*` type id, labelled `<prefix>_<Point name>_<register>` (registers 40000 up, step 2). Talk in point names and registers; in plans copy the type id exactly (some contain spaces).
- Read: plug the `model_point_*` block into a value input.
- Write: `point_setter`, with `selected_point_name` = the point's type id and `setter_model_value` = the `model_block`'s `selectedModelId`; the value goes in `input_value_field`. The extension fills `selected_point_ref` and the dropdown (the one exception to the stored-value rule).
- The person's wording decides: "write/set model point X" is `point_setter`, "write Modbus register N" is `conn_mod_write_modbus_register`. Never swap them or choose for them; if "write to 40006" matches a point, ask which.
- When a value plausibly matches a model point, offer the mapping as a question; never add it unasked.

**Common mistakes that get plans rejected or change the wrong thing**
- Writing `fields` as an object (`{"analog_output_number": "0"}`). It must be a list: `[{"name": "analog_output_number", "value": "0"}]`.
- Writing numbers or booleans without quotes. Every field value is a string: `"4"`, `"TRUE"`.
- Using a dropdown's label instead of its stored value: Relay 1 is `"0"`, AO1 is `"0"`.
- Deleting existing blocks when the person asked to add.
- Inventing block types, field names or input names. Use only those in the block list, spelled exactly, including odd ones such as `register data type` and `NAME`.
- Block ids not in the attached export. Ids change on every reload, so earlier ones are stale: ask for a fresh export.
- A model point's label or a retyped type id instead of the copied type id.
- Asking for an export on a blank-canvas request that needs no model points.
- Referring to a ref before the action that creates it, or reusing a ref name.
- Connecting into an input that already holds a block (such as startup's `sequence`): it pushes the existing blocks down. Select Model stays first in startup; stack after it with NEXT.
- Putting a statement block into a value input, or a value block into a statement input or `NEXT`.
- Number values outside a field's range. The block list gives min and max; for example `analog_output_value` accepts 0 to 10.

**Self-check before sending a plan**
1. The JSON matches the schema: `fields` are lists, all values are strings, every action has `op` and `why`.
2. Every existing id is copied exactly from the latest sequence export (a blank-canvas plan has none); every ref is created before it is used.
3. Every dropdown uses a stored value from the block list (except `point_setter`, see Model points), and every number is within its field's range.
4. Nothing is deleted unless the person asked for removal or replacement.
5. Every output, relay and model point write is commanded on every path, and no PI controller number, BACnet instance or Modbus address is reused by mistake.
6. Units match on both sides of every comparison; configuration sits in startup, reads, logic and writes in continuous.

## How much to trust each statement

Every rule below carries one of three tags.

- **[VERIFIED]** Read directly from the editor, or tested: the editor accepted it and the blocks landed as described. This says nothing about how the device behaves at runtime.
- **[OBSERVED]** Seen in a real, working 75F sequence. A reasonable pattern to copy, but not a proven rule.
- **[NEEDS VERIFICATION]** The author's best understanding, not yet confirmed by a 75F engineer. When a plan depends on one of these, say so in your answer so the person can check.

## The numbering rule (most common source of mistakes)

- **[VERIFIED]** Most 75F dropdowns store a 0-based value but display a 1-based label. "Relay 3" is stored as `"2"`; universal input 1 is `"0"`; analog output 1 is `"0"`; PI controller 1 is `"0"`. Always use the stored value, never the label.
- **[VERIFIED]** Relay state: Off is `"0"`, On is `"1"`. Universal input mode: Analog is `"0"`, Thermistor is `"1"`.
- **[VERIFIED]** Not every list is in label order. Sensor bus sensor type is Temperature `"0"`, Humidity `"1"`, CO2 `"2"`, Occupancy `"3"`, Pressure `"4"`, even though the palette lists Pressure before CO2. Look up each value.
- **[VERIFIED]** Days of the week are the exception: MONDAY is `"1"` through SUNDAY `"7"`.
- **[OBSERVED]** Home-screen input numbers are typed as plain `math_number` blocks and are also 0-based: the first home-screen input is `0`.
- **[VERIFIED]** Standard sensor types are chosen by value, for example Space Temperature is `"39"`. The full list is in the block list.

## How a sequence is structured

- **[VERIFIED]** `sequence_run_startup` is a top-level block with a `DEVICE_TYPE` dropdown (`CONNECT_MODULE` or `SMART_NODE`) and a `sequence` statement input.
- **[VERIFIED]** `sequence_run_continuous` has a `run_rate` value input (seconds) and a `sequence` statement input.
- **[OBSERVED]** A working sequence uses two separate top-level stacks: a startup stack that configures things once, and a continuous stack that reads, computes and writes on every cycle. The observed run rate was 1 second.
- **[OBSERVED]** Configuration blocks (universal input mode, home-screen inputs, custom Modbus registers) live in startup. Reads, calculations, home-screen updates, output writes and register writes live in continuous.
- **[NEEDS VERIFICATION]** Startup runs once when the device boots or the sequence is deployed; continuous then repeats every `run_rate` seconds.
- **[NEEDS VERIFICATION]** Variables keep their values between continuous cycles. This matters for latching logic, counters and timers.
- **[NEEDS VERIFICATION]** One continuous cycle should finish well inside `run_rate`; long delays inside the loop may stretch or overlap cycles.
- **[NEEDS VERIFICATION]** Each sequence should contain one startup stack and one continuous stack.

## Standard Blockly categories

Logic, Loops, Math, Text, Lists, Variables and Functions are standard Blockly blocks. Their usual Blockly meaning applies.

- **[VERIFIED]** `controls_if` is expandable: `extraState` `{"elseIfCount":1,"hasElse":true}` adds `IF1`/`DO1` and `ELSE`.
- **[VERIFIED]** `text_join` and `lists_create_with` take `{"itemCount":N}` to add `ADD0`..`ADD(N-1)`.
- **[VERIFIED]** Variables are referred to by name in plans; a new name in a variable field creates the variable.
- **[OBSERVED]** Working sequences use `logic_compare`, `logic_operation`, `math_arithmetic`, `math_round`, `variables_set`/`variables_get` and `text` heavily.
- **[VERIFIED]** Functions with parameters (`procedures_defnoreturn` + `procedures_callnoreturn`) and bounded `controls_for` loops are used in working 75F sequences. See Functions.
- **[NEEDS VERIFICATION]** Whether the device runtime supports every other standard block. Prefer simple logic, math, variables and functions. Avoid unbounded loops (`controls_whileUntil`) and list or text manipulation unless the person confirms they work on the device: an unbounded loop in the continuous sequence could stall the controller.

## Functions

Use a function when the same logic repeats for several channels (outputs, zones, equipment): write it once with parameters and call it once per channel.

- **[VERIFIED]** A function is a top-level `procedures_defnoreturn` stack (not inside startup or continuous). Its name is the `NAME` field; its parameters are set by `extraState` `{"params":[{"name":"<param 1>"},{"name":"<param 2>"}]}`. Inside its `STACK`, read a parameter with `variables_get` using the parameter's name.
- **[VERIFIED]** A call is `procedures_callnoreturn` with `extraState` `{"name":"<function NAME>","params":["<param 1>","<param 2>"]}`: names and order exactly as in the function. That creates value inputs `ARG0`, `ARG1`… in the same order; plug each argument in (numbers, `variables_get`, `model_point_*` blocks…).
- **[VERIFIED]** In a sequence export, existing functions and calls show their `extraState`; copy names and order from there. The fields `WITH`, `PARAMS` and `ARGNAME0`… are display labels: never set them.
- **[VERIFIED]** In a plan, create a new function before any call to it. A call runs where it is placed (usually inside continuous), so the function body runs on that cycle.
- **[OBSERVED]** A pattern for repeated channels: a `controls_for` loop over the channel count, an if / else-if chain on the loop variable (one branch per channel), and in each branch one call with that channel's own arguments. Hardware numbers passed as arguments stay 0-based, as everywhere else.
- **[NEEDS VERIFICATION]** Functions with a return value (`procedures_defreturn`, `procedures_callreturn`) have not been seen in a working sequence.

## Custom Code Device (75F)

These blocks talk to the Connect module's hardware. The palette often delivers a block with small "number" blocks already plugged in; the block list shows these as "Palette version comes as". Use the same child blocks in plans.

### Relays and analog outputs

- **[VERIFIED]** `conn_mod_set_relay_output` (statement): `relay_number` takes `conn_mod_relay_output_number` (values `"0"`..`"7"` = Relay 1..8); `relay_state` takes `conn_mod_relay_output_state` (`"0"` Off, `"1"` On).
- **[VERIFIED]** `conn_mod_set_analog_output` (statement): `aout_number` takes `conn_mod_analog_output_number` (`"0"`..`"3"` = AO1..AO4); `aout_value` takes a number.
- **[VERIFIED]** `conn_mod_analog_output_value` accepts 0 to 10 in steps of 0.1; the editor enforces this range.
- **[OBSERVED]** A working sequence sent a PI controller output divided by 10 to an analog output, which suggests analog output values are volts (0–10 V) while PI output is 0–100 (%).
- **[VERIFIED]** A plan setting AO1 to 4 in one branch and 0 in the other was validated and applied.
- **[NEEDS VERIFICATION]** That the value is volts, and what happens when a computed value (not the fixed-value block) goes outside 0–10.
- **[NEEDS VERIFICATION]** Whether a relay or output keeps its last commanded state if the sequence stops writing it. Plans should command every output on every path (for example with an else branch), rather than only switching it on.
- **[NEEDS VERIFICATION]** Minimum on/off times or anti-short-cycle protection for relays driving compressors. Nothing in the palette provides it, so logic that can flip a relay every cycle may need a deadband or timer. Ask the person.

### Universal inputs

- **[VERIFIED]** `conn_mod_set_universal_input_mode` (statement): `uin_number` takes `conn_mod_universal_input_number` (`"0"`..`"7"` = UI1..UI8); `uin_mode` takes `conn_mod_universal_input_mode` (`"0"` Analog, `"1"` Thermistor), or `universal_input_get_mode_from_standard_sensor_type`.
- **[VERIFIED]** `conn_mod_get_universal_input_value` (value, Number): raw reading of one universal input.
- **[VERIFIED]** `conn_mod_get_universal_input_mode` outputs a String, not a Number.
- **[VERIFIED]** A tested build set UI1 to Thermistor in startup, then in continuous converted its reading with Space Temperature (`"39"`) and stored it in a variable.
- **[OBSERVED]** The usual chain is: startup sets the mode, continuous reads with `conn_mod_get_universal_input_value`, then converts with `universal_input_convert_value_from_standard_sensor_type`.
- **[NEEDS VERIFICATION]** Mode must be set before readings are meaningful; the raw value's units per mode (volts for Analog, ohms or a count for Thermistor).
- **[OBSERVED]** Converted temperatures are °F. A working 75F sequence converts Supply Air Temperature 1 (`"85"`), Chilled Water Inlet Temp (`"6"`) and Chilled Water Outlet Temp (`"7"`), then turns each result into °C with (value − 32) × 5 ÷ 9. Other sensor types are assumed to behave the same **[NEEDS VERIFICATION]**. Compare converted temperatures with °F setpoints, and convert explicitly if °C is needed.

### Standard sensor types

- **[VERIFIED]** `universal_input_standard_sensor_types` is a dropdown of standard sensors (voltage, resistance, duct static pressure ranges, air temperatures, flow, humidity, status inputs and more). Use the value from the block list.
- **[VERIFIED]** Helpers that take a sensor type index: `universal_input_get_mode_from_standard_sensor_type` (mode to configure), `universal_input_convert_value_from_standard_sensor_type` (raw value → engineering value), `universal_input_get_name_from_standard_sensor_type` and `universal_input_get_units_from_standard_sensor_type` (text for the home screen).
- **[NEEDS VERIFICATION]** Using the mode helper in startup and the convert helper in continuous, with the same sensor type, is the intended pattern; mismatched types give wrong readings.

### Sensor bus and POR bus

- **[VERIFIED]** `conn_mod_get_sensor_bus_value` (value, Number/Boolean): `sensor_number` takes `conn_mod_sensor_number` (`"0"`..`"3"` = sensor 1..4); `sensor_type` takes `sensor_bus_sensor_type`.
- **[VERIFIED]** `conn_mod_get_por_bus_value` works the same way with `conn_mod_por_sensor_number` (`"0"`..`"10"`, where `"10"` is labelled Mysense) and `por_bus_sensor_type` (Temperature `"0"`, Humidity `"1"`, CO2 `"2"`, Occupancy `"3"`, Pressure `"4"`).
- **[NEEDS VERIFICATION]** What the sensor bus and POR bus physically are, and which sensor types each physical sensor supports. Occupancy likely returns a Boolean; the others a Number.

### Home screen

- **[VERIFIED]** `conn_mod_configure_home_screen_input` (statement): `uin_number` (number), `input_name` (String), `input_units` (String), `input_val` (Number or String).
- **[VERIFIED]** `conn_mod_update_home_screen_input` (statement): `uin_number`, `input_val`.
- **[OBSERVED]** Configured once in startup (a working sequence configured 10 entries, numbered from 0, with a blank `" "` initial value) and updated every cycle in continuous.
- **[NEEDS VERIFICATION]** The maximum number of home-screen entries, and whether `uin_number` here means the display slot rather than the physical universal input (the observed usage suggests a display slot).

### PI controllers

- **[VERIFIED]** `pi_controller_process` (value, Number) inputs: `controller_number` (takes `pi_controller_number`, `"0"`..`"7"` = controller 1..8), `process_variable`, `set_point`, `proportional_gain`, `integral_gain`, `error_range`, `integration_time`, `sample_time`.
- **[OBSERVED]** A working loop used proportional gain 0.5, integral gain 0.5, error range 1, integration time 180 and sample time 3000, with the process variable and setpoint held in variables.
- **[NEEDS VERIFICATION]** Each controller number keeps its own internal state, so every PI loop in a sequence needs a different controller number. Reusing a number would mix two loops.
- **[NEEDS VERIFICATION]** Output range 0–100 (%), units of `integration_time` (seconds assumed) and `sample_time` (milliseconds assumed), and the meaning of `error_range` (a proportional band or deadband).
- **[NEEDS VERIFICATION]** How to make a loop reverse-acting (heating versus cooling). There is no direction input; the person may swap process variable and setpoint or invert the output. Ask.
- **[NEEDS VERIFICATION]** Recommended gain ranges for common loops (discharge air temperature, duct static pressure, space temperature). Do not invent tuning values; copy existing loops or ask.

### Scaling, timing and device time

- **[VERIFIED]** `conversion_scale_value` (value, Number): maps `input_value` from `input_value_min`..`input_value_max` to `output_value_min`..`output_value_max`.
- **[OBSERVED]** Used to turn a 0–10 feedback signal into 0–100 %.
- **[NEEDS VERIFICATION]** Whether the result is clamped to the output range.
- **[VERIFIED]** `sequence_delay_milliseconds` (statement): `delay_ms`.
- **[NEEDS VERIFICATION]** Whether the delay blocks the whole sequence. Avoid long delays in continuous; prefer counters kept in variables.
- **[VERIFIED]** `set_device_time` and `sequence_time` have `hours`, `minutes` and `day` (MONDAY `"1"`..SUNDAY `"7"`). `get_device_time` returns the device time.
- **[NEEDS VERIFICATION]** How to compare device time to a `sequence_time` for schedules, and whether hours are 24-hour.

### Other device blocks

- **[VERIFIED]** `conn_mod_enable_fail_safe` (statement): `fail_safe_enable` takes a Boolean.
- **[NEEDS VERIFICATION]** What fail safe does (likely driving outputs to safe states on a fault) and where it should be placed. Do not add or remove it without asking.
- **[VERIFIED]** `print_string` (statement): `string_to_print` takes a String or Number.
- **[OBSERVED]** Used for debug messages in working sequences.
- **[NEEDS VERIFICATION]** Where printed output appears (device log, portal or serial console). If unknown, use a spare home-screen entry as a debug probe instead.
- **[VERIFIED]** `model_block` names a sequence and helps canvas navigation (from its tooltip). Do not add, change or delete it unless asked. Its `selectedModelId` is the model id `point_setter` needs (see Model points).

## BACnet communication

- **[VERIFIED]** Every BACnet object block takes its `instance` from a `bacnet_object_instance` block (field `instance`, a number). Other number blocks will not plug in.
- **[VERIFIED]** Configure blocks exist for Analog Input (`..._ai_object`: instance, name, units), Analog Value (`..._av_object`: plus `min_val`, `max_val`), Binary Input and Binary Value (instance, name, `active_text`, `inactive_text`), Multistate Input and Multistate Value (instance, name, `state_text` as a list, for example `lists_create_with` of `text` blocks).
- **[VERIFIED]** Write blocks exist for all six object types; read blocks exist for AV (Number), BV (Boolean) and MSV (Number).
- **[VERIFIED]** `bacnet_units` is a dropdown whose values follow the standard BACnet engineering-units numbering (for example `"0"` square metre, `"5"` volt). Look the value up in the block list.
- **[NEEDS VERIFICATION]** Configure objects in startup, write or read them in continuous (the Modbus pattern suggests this).
- **[NEEDS VERIFICATION]** Instance numbers must be unique within each object type in a sequence, and may need to avoid ranges reserved by 75F's own points.
- **[NEEDS VERIFICATION]** Inputs (AI, BI, MSI) are written by the sequence and read by the BMS; values (AV, BV, MSV) can also be written by the BMS, which is why only those have read blocks. Use AV, BV or MSV for setpoints and commands coming from the BMS.
- **[NEEDS VERIFICATION]** Multistate values start at 1 (BACnet standard), not 0.

## Modbus communication

- **[VERIFIED]** `modbus_register_type`: Input `"0"`, Holding `"1"`, Coil `"2"`, Discrete `"3"`. It plugs only into `register_type` inputs.
- **[VERIFIED]** `modbus_register_address` (field `address`) plugs only into address inputs. `conn_mod_data_type_block`: int `"0"`, float `"1"`.
- **[VERIFIED]** Quirky input names: `conn_mod_datatype_configure_custom_modbus_register` uses `register data type` (with spaces); `conn_mod_datatype_read_modbus_register` uses `register data type` and `NAME` for the address; `conn_mod_datatype_write_modbus_register` uses `Data Type` (with a space and capitals). Copy them exactly.
- **[OBSERVED]** A working sequence configured 13 custom Holding registers (addresses from 1) in startup, wrote 14 register values every cycle in continuous, and read 3 Holding registers (for example address 13) as commands from outside.
- **[OBSERVED]** Values were rounded before writing to plain (non-datatype) registers, which suggests those registers hold integers. Scale decimals (for example ×10) or use the float datatype blocks.
- **[NEEDS VERIFICATION]** A register must be configured in startup before it is written or read.
- **[NEEDS VERIFICATION]** Float registers occupy two consecutive addresses, so addresses must not overlap. Duplicate addresses are always a bug.
- **[NEEDS VERIFICATION]** By Modbus convention, Input and Discrete registers are read-only to the BMS, and Holding and Coil registers are writable. Use Holding or Coil for anything the BMS commands.
- **[NEEDS VERIFICATION]** What `conn_mod_write_universal_input_modbus_register`, `conn_mod_read_universal_input_mapping_modbus_register`, `conn_mod_read_analog_output_modbus_register` and `conn_mod_read_relay_output_modbus_register` expose, and at which fixed addresses.

## Model points

- **[VERIFIED]** Model points exist only after a Hayloft model is chosen in `model_block`. The editor then adds a Model Points category to the palette: one value block per point, plus `point_setter`. Points differ per model, so this guide names none; they come only from a sequence export.
- **[VERIFIED]** The visible label is `<prefix>_<Point name>_<register>`; registers start at 40000 and step by 2. The export's label also carries a hidden id and, on some points, a trailing `0`; the person never sees these.
- **[VERIFIED]** Type ids are hand-named and irregular, and some contain spaces. Copy them exactly; never build them from the label.
- **[VERIFIED]** Point blocks are value blocks with no inputs.
- **[VERIFIED]** When a point is picked by hand in `point_setter`, the editor stores the point's type id in both `selected_point_name` and `selected_point_ref`, and the `model_block`'s `selectedModelId` in `setter_model_value`. Seen on two sites, for a command and a status point.
- **[VERIFIED]** A `point_setter` dropdown lists only the point chosen in it (a new one lists only "select point"); the Sequencer fills that one entry when a person picks a point. The extension does the same, sets all three fields itself, and restores the canvas if the point won't hold. A plan only needs the right point type id and model id; the extension fills the reference.
- **[VERIFIED]** The person's wording decides the block: "write/set model point" means `point_setter`, "write Modbus register" means `conn_mod_write_modbus_register`. Never pick one on the person's behalf; if the wording doesn't say which, ask.
- **[VERIFIED]** Every model point is a Holding register underneath and can be written, whatever its name (Cmd, Status, Sensor). No point is read-only; write the one the person asks for without questioning it.

- **[NEEDS VERIFICATION]** The Sequencer appears to drop `point_setter` blocks when Select Model is not the first block in Run on Startup (seen once). Keep it first; add startup blocks after it with NEXT. The extension rejects plans that would move it.
- **[NEEDS VERIFICATION]** Home screen "Input Number" (configure and update) takes a plain `math_number` for the line (0, 1, …), as in working sequences, not a universal-input picker.

## A tested example

**[VERIFIED]** This small sequence was applied to a blank canvas and every block landed correctly (device behaviour not tested):

- Startup (Connect module): set UI1 (`"0"`) to Thermistor (`"1"`); configure home-screen input `0` as "Zone Temp", units "°F", value 0.
- Continuous every 5 seconds: set variable `zoneTemp` to UI1's value converted as Space Temperature (`"39"`); update home-screen input `0` with `zoneTemp`; if `zoneTemp` > 76, set Relay 1 (`"0"`) On (`"1"`), else Off (`"0"`).

## Open questions for 75F engineers

These are the [NEEDS VERIFICATION] items above, collected so the guide can be finished:

1. Startup and continuous semantics: when each runs, whether variables persist, how many of each are allowed.
2. Which standard Blockly blocks the device runtime supports.
3. Analog output units (volts assumed; 0–10 range verified); output behaviour when not written; relay minimum on/off protection.
4. Raw universal input units per mode; confirm that converted temperatures are °F for every sensor type (observed for types 6, 7 and 85).
5. What the sensor bus and POR bus are, and supported sensor types.
6. Home-screen entry limit and the meaning of its number input.
7. PI controller: state per controller number, output range, time units, error range, reverse acting, recommended gains.
8. Whether scaling is clamped; whether delays block; schedule comparisons with device time.
9. What fail safe does; where print output appears.
10. BACnet: instance rules, input versus value objects, multistate numbering, configure/write placement.
11. Modbus: configure-before-use, float register width, read/write permissions per type, and the fixed universal input, analog output and relay registers.
