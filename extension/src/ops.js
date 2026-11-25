/**
 * The plan format the extension accepts: one source for the block guide, the ChatGPT
 * instructions and exports made without the guide.
 */

export const PLAN_SCHEMA = `{
  "type": "object",
  "required": ["reply", "actions"],
  "properties": {
    "reply": { "type": "string", "description": "One-line summary of the change" },
    "actions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["op", "why"],
        "properties": {
          "op": { "enum": ["create", "setField", "connect", "disconnect", "move", "delete"] },
          "why": { "type": "string" },
          "ref": { "type": "string", "description": "create: temporary name for the new block" },
          "type": { "type": "string", "description": "create: block type from the export" },
          "fields": {
            "type": "array",
            "description": "create: a LIST of {name, value}, never an object",
            "items": {
              "type": "object",
              "required": ["name", "value"],
              "properties": { "name": { "type": "string" }, "value": { "type": "string" } }
            }
          },
          "extraState": { "type": "string", "description": "create: JSON text for expandable blocks" },
          "block": { "type": "string", "description": "setField/disconnect/move/delete: existing id or ref" },
          "field": { "type": "string" },
          "value": { "type": "string", "description": "setField: always a string" },
          "parent": { "type": "string" },
          "input": { "type": "string", "description": "input name, or NEXT to stack below parent" },
          "child": { "type": "string" },
          "x": { "type": "number" },
          "y": { "type": "number" }
        }
      }
    }
  }
}`;

// A real, tested request: "Add AO1 at 4 V in the DO branch and 0 V in the ELSE branch" on a sequence
// whose if-block branches each hold a Set Relay Output block. Ids are from that canvas.
export const PLAN_EXAMPLE = `{
  "reply": "Add AO1 at 4 V in the DO branch, keeping Relay 1.",
  "actions": [
    { "op": "create", "ref": "ao_do", "type": "conn_mod_set_analog_output", "why": "Analog output command for the DO branch" },
    { "op": "create", "ref": "ao_do_num", "type": "conn_mod_analog_output_number",
      "fields": [{ "name": "analog_output_number", "value": "0" }], "why": "AO1 is stored as 0" },
    { "op": "create", "ref": "ao_do_val", "type": "conn_mod_analog_output_value",
      "fields": [{ "name": "analog_output_value", "value": "4" }], "why": "4 V when above 76" },
    { "op": "connect", "parent": "ao_do", "input": "aout_number", "child": "ao_do_num", "why": "Select AO1" },
    { "op": "connect", "parent": "ao_do", "input": "aout_value", "child": "ao_do_val", "why": "Set 4 V" },
    { "op": "connect", "parent": ",5nQ),(P9KF|$yPzv\`~M", "input": "NEXT", "child": "ao_do", "why": "Stack below the existing Relay 1 On block; the relay is kept because the request said add" }
  ]
}`;

export const OPS_GUIDE = `Operations (properties not listed for an op are ignored):
- create {ref, type, fields?, extraState?, x?, y?}: add a block. "ref" is a short temporary name (e.g. "n1") that later actions use instead of an id. "fields" is a LIST: [{"name": "...", "value": "..."}]. x/y matter only for blocks that stay top-level; omit them to let the tool place the block. For expandable blocks, "extraState" (a JSON string) sets their shape, e.g. controls_if '{"elseIfCount":1,"hasElse":true}' adds inputs IF1/DO1 and ELSE; text_join and lists_create_with '{"itemCount":3}' add ADD0..ADD2.
- setField {block, field, value}: change a field on an existing block or ref. value is always a string. Checkboxes use "TRUE"/"FALSE". Dropdowns take the stored option value, not the label. Variable fields take the variable's name; a new name creates that variable.
- connect {parent, input, child}: plug child into parent. input is an input name of the parent's block type, or "NEXT" to stack child directly below parent (this inserts; blocks already below move down). Value inputs take value blocks; statement inputs and NEXT take statement blocks. Respect the input's type check. Connecting into an input that already holds a block displaces the old block (Blockly moves it below the new one or out of the way), so to add next to an existing block, stack under it with NEXT; to replace one, delete it.
- disconnect {block}: unplug a block from its parent; blocks that were below it close the gap.
- move {block, x, y}: move a top-level block to absolute workspace coordinates (numbers).
- delete {block}: delete a block and everything nested inside it; blocks below it close the gap.

"block", "parent" and "child" are either an existing block's "id" copied exactly from the exported sequence, or a "ref" created in the same plan.
Order actions: create, setField, connect, disconnect/move, delete. All field values are strings. Give each action a short "why".`;
