import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import urllib.request


def evaluate(fixture, prompt, token, engine):
    body = {
        "model": engine,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": fixture["message"]},
        ],
    }
    request = urllib.request.Request(
        "https://inference.ai.mod.gov.ua/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "echo-settlement-eval",
        },
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        response = json.load(response)
    text = response["choices"][0]["message"]["content"]
    content = text.strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[1].rsplit("```", 1)[0]
    parsed = json.loads(content)
    actual = parsed if isinstance(parsed, list) else parsed["settlements"]
    return {
        "case": fixture["case"],
        "expected": fixture["expected_ai_settlements"],
        "actual": actual,
        "passed": actual == fixture["expected_ai_settlements"],
        "response_text": text,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--engine", default="glm-5.3")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--fixtures", type=Path, default=Path(__file__).with_name("messages.json"))
    args = parser.parse_args()
    fixtures = json.loads(args.fixtures.read_text())
    prompt = args.prompt.read_text()
    token = args.token_file.read_text().strip()
    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        pending = {
            executor.submit(evaluate, fixture, prompt, token, args.engine): fixture
            for fixture in fixtures
        }
        for future in as_completed(pending):
            fixture = pending[future]
            try:
                result = future.result()
            except Exception as error:
                result = {
                    "case": fixture["case"],
                    "expected": fixture["expected_ai_settlements"],
                    "passed": False,
                    "error": str(error),
                }
            results.append(result)
            results.sort(key=lambda row: row["case"])
            args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(f"{sum(row['passed'] for row in results)}/{len(results)} passed")


if __name__ == "__main__":
    main()
