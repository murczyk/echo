import json
import sys
import time
import urllib.request
from pathlib import Path


def ask(engine, system, body):
    url = engine["url"].rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if engine.get("token"):
        headers["Authorization"] = "Bearer " + engine["token"]
    payload = {
        "model": engine["model_name"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": body},
        ],
    }
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        text = json.load(response)["choices"][0]["message"]["content"].strip()
    if text.startswith("```"):
        text = "\n".join(text.splitlines()[1:-1])
    return [name.strip().lower() for name in json.loads(text)["callsigns"]]


def evaluate(engine, prompt, refiner, case):
    initial = ask(engine, prompt, case["body"])
    final = initial
    refined = case["feedback_callsign"] in initial
    if refined:
        body = json.dumps(
            {
                "CURRENT_MESSAGE": case["body"],
                "INITIAL_CALLSIGNS": initial,
                "TEMPLATE_CALLSIGNS": case["templates"],
                "FEEDBACK": [{
                    "callsign": case["feedback_callsign"],
                    "removal_count": 3,
                    "examples": [case["feedback_body"]],
                }],
            },
            ensure_ascii=False,
        )
        final = ask(engine, prompt + "\n\n" + refiner, body)
    final = list(dict.fromkeys(case["templates"] + final))
    passed = all(name in final for name in case["required"]) and not any(
        name in final for name in case["excluded"]
    )
    return {"initial": initial, "final": final, "refined": refined, "passed": passed}


def main():
    engine = json.loads(Path(sys.argv[1]).read_text())
    here = Path(__file__).resolve().parent
    root = here.parent.parent
    cases = json.loads((here / "cases.json").read_text())
    prompt = (root / "ai-eval/2026-08-10-callsign-prompt/prompt.txt").read_text()
    refiner = (root / "wdintel-rs/src/ai_callsign/feedback_prompt.txt").read_text()
    passed = True
    for case in cases:
        started = time.monotonic()
        try:
            result = evaluate(engine, prompt, refiner, case)
            passed = passed and result["passed"]
        except Exception as error:
            result = {"error_type": type(error).__name__, "status": getattr(error, "code", None)}
            passed = False
        result.update(id=case["id"], seconds=round(time.monotonic() - started, 2))
        print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
