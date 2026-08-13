import json

from comfy.comfy_types import IO


PIPE_TYPE = "DYNAMIC_PIPE"


class FlexibleInputs(dict):
    def __contains__(self, key):
        return True

    def __getitem__(self, key):
        if dict.__contains__(self, key):
            return super().__getitem__(key)
        return (IO.ANY, {"forceInput": True})


class DynamicReturnTypes(tuple):
    def __getitem__(self, index):
        if index >= len(self):
            return IO.ANY
        return super().__getitem__(index)


def parse_schema(raw_schema):
    try:
        schema = json.loads(raw_schema)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Dynamic Pipe schema is invalid") from error

    if not isinstance(schema, list):
        raise ValueError("Dynamic Pipe schema must be a list")

    for field in schema:
        if (
            not isinstance(field, dict)
            or not isinstance(field.get("key"), str)
            or not isinstance(field.get("name"), str)
            or not isinstance(field.get("type"), str)
        ):
            raise ValueError("Dynamic Pipe schema contains an invalid field")

    return schema


class ToDynamicPipe:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "_schema": (IO.STRING, {"default": "[]", "socketless": True, "hidden": True}),
            },
            "optional": FlexibleInputs(),
        }

    RETURN_TYPES = (PIPE_TYPE,)
    RETURN_NAMES = ("dynamic_pipe",)
    FUNCTION = "pack"
    CATEGORY = "utils/pipe"
    DESCRIPTION = "Packs any number of connected values into one dynamic pipe."

    def pack(self, _schema="[]", **kwargs):
        schema = parse_schema(_schema)
        values = {
            field["key"]: kwargs.get(field["key"])
            for field in schema
        }
        return ({"dynamic_pipe": True, "schema": schema, "values": values},)


class FromDynamicPipe:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dynamic_pipe": (PIPE_TYPE,),
                "_schema": (IO.STRING, {"default": "[]", "socketless": True, "hidden": True}),
            },
        }

    RETURN_TYPES = DynamicReturnTypes()
    FUNCTION = "unpack"
    CATEGORY = "utils/pipe"
    DESCRIPTION = "Exposes the named values carried by a Dynamic Pipe."

    def unpack(self, dynamic_pipe, _schema="[]"):
        schema = parse_schema(_schema)
        if (
            not isinstance(dynamic_pipe, dict)
            or dynamic_pipe.get("dynamic_pipe") is not True
            or not isinstance(dynamic_pipe.get("values"), dict)
        ):
            raise ValueError("Dynamic Pipe Unpack received an invalid pipe")

        values = dynamic_pipe["values"]
        missing = [field["key"] for field in schema if field["key"] not in values]
        if missing:
            raise ValueError(f"Dynamic Pipe schema does not match the connected pipe: {', '.join(missing)}")

        return tuple(values[field["key"]] for field in schema)


NODE_CLASS_MAPPINGS = {
    "ToDynamicPipe": ToDynamicPipe,
    "FromDynamicPipe": FromDynamicPipe,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ToDynamicPipe": "to Dynamic Pipe",
    "FromDynamicPipe": "from Dynamic Pipe",
}
