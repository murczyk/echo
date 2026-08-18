from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer
from lxml import etree, html

from .config import ExtractionConfig
from .pipeline import Extractor
from .validation import evaluate as evaluate_packages
from .validation import validate_package

app = typer.Typer(no_args_is_help=True)


@app.command()
def extract(
    inputs: list[Path] = typer.Argument(...),
    output: Path = typer.Option(..., "--output"),
    config: Path = typer.Option(..., "--config", exists=True, readable=True),
    manifest: Path | None = typer.Option(None, "--manifest", exists=True, readable=True),
) -> None:
    result = asyncio.run(Extractor(ExtractionConfig.from_yaml(config)).extract(inputs, manifest))
    result.write_package(output)
    typer.echo(result.status.value)


@app.command()
def validate(output_dir: Path = typer.Argument(..., exists=True, file_okay=False)) -> None:
    errors = validate_package(output_dir)
    if errors:
        for error in errors:
            typer.echo(error, err=True)
        raise typer.Exit(1)
    typer.echo("valid")


@app.command()
def inspect(output_dir: Path = typer.Argument(..., exists=True, file_okay=False)) -> None:
    provenance = json.loads((output_dir / "provenance.json").read_text(encoding="utf-8"))
    evidence = {item["id"]: item for item in provenance["evidence"]}
    document = html.Element("article")
    etree.SubElement(document, "h1").text = "Extraction inspection"
    pages = etree.SubElement(document, "section")
    etree.SubElement(pages, "h2").text = "Source pages and crops"
    image_paths = [
        *sorted((output_dir / "raw" / "pages").glob("*.png")),
        *sorted((output_dir / "raw" / "crops").glob("*.png")),
    ]
    for image_path in image_paths:
        figure = etree.SubElement(pages, "figure")
        etree.SubElement(figure, "figcaption").text = image_path.name
        etree.SubElement(figure, "img", {"src": image_path.relative_to(output_dir).as_posix()})
    for decision in provenance["decisions"]:
        section = etree.SubElement(document, "section")
        etree.SubElement(section, "h2").text = decision["unit_id"]
        etree.SubElement(section, "p").text = decision["reason"]
        etree.SubElement(section, "p").text = f"selected: {decision.get('selected_evidence_id') or 'none'}"
        if decision.get("alternative_evidence_ids"):
            etree.SubElement(section, "p").text = "rejected: " + ", ".join(
                decision["alternative_evidence_ids"]
            )
        for rank in decision.get("ranks", []):
            details = etree.SubElement(section, "details")
            etree.SubElement(details, "summary").text = rank["evidence_id"]
            etree.SubElement(details, "pre").text = json.dumps(
                {"rank": rank, "candidate": evidence.get(rank["evidence_id"])},
                ensure_ascii=False,
                indent=2,
            )
        for retry in decision.get("retries", []):
            etree.SubElement(section, "p").text = f"retry {retry['request_id']}: {retry['reason']}"
    target = output_dir / "inspection.html"
    target.write_text(
        "<!doctype html>\n" + html.tostring(document, encoding="unicode", pretty_print=True), encoding="utf-8"
    )
    target.chmod(0o600)
    typer.echo(str(target))


@app.command()
def evaluate(
    gold_dir: Path = typer.Argument(..., exists=True, file_okay=False),
    output_dir: Path = typer.Argument(..., exists=True, file_okay=False),
    deterministic_dir: Path | None = typer.Option(None, "--deterministic-run", exists=True, file_okay=False),
) -> None:
    metrics = evaluate_packages(gold_dir, output_dir, deterministic_dir)
    typer.echo(json.dumps(metrics, ensure_ascii=False, indent=2))
    if not metrics["passed"]:
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
