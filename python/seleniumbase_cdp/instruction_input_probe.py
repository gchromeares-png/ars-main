from __future__ import annotations

from instruction_input_runtime import InstructionInputRuntime


class FakeSb:
    def __init__(self) -> None:
        self.calls = []

    def execute_script(self, script, *args):
        self.calls.append((script, args))
        if "document.querySelectorAll(selector)" in script:
            return {
                "pageText": "Gib 42 ein.",
                "controls": [
                    {
                        "fieldId": "ares-instruction-0",
                        "index": 0,
                        "tagName": "input",
                        "inputType": "number",
                        "placeholder": "",
                        "ariaLabel": "",
                        "value": "",
                    }
                ],
            }
        return {"acted": True, "verified": True, "reason": "", "observedValue": str(args[1])}


def main() -> int:
    sb = FakeSb()
    runtime = InstructionInputRuntime(sb)

    decision = runtime.infer()
    assert decision["matched"] is True
    assert decision["value"] == "42"
    assert decision["fieldId"] == "ares-instruction-0"

    result = runtime.apply()
    assert result["acted"] is True
    assert result["verified"] is True
    assert result["requestedValue"] == "42"
    assert result["observedValue"] == "42"

    runtime.observe = lambda: {
        "pageText": "Tippe TEST123.",
        "controls": [{
            "fieldId": "ares-instruction-1",
            "index": 0,
            "tagName": "input",
            "inputType": "text",
            "placeholder": "",
            "ariaLabel": "",
            "value": "",
        }],
    }
    text_decision = runtime.infer()
    assert text_decision["matched"] is True
    assert text_decision["value"] == "TEST123"

    runtime.observe = lambda: {
        "pageText": "Willkommen auf der Testseite.",
        "controls": [{
            "fieldId": "ares-instruction-2",
            "index": 0,
            "tagName": "input",
            "inputType": "text",
            "placeholder": "",
            "ariaLabel": "",
            "value": "",
        }],
    }
    no_match = runtime.infer()
    assert no_match["matched"] is False
    assert no_match["reason"] == "no-simple-instruction"

    print("instruction input runtime probe: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
