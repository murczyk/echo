END_MARKER = "<!-- END_OCR -->"

TABLE_HTML_PROMPT = """Perform exact visual OCR of the complete source image into semantic HTML.

The image is primarily tabular. Return the visible title/captions and every table. Reproduce the physical grid exactly: emit every source row and cell once, retain empty cells, and use correct rowspan and colspan attributes. Preserve line breaks inside cells with <br>. Preserve meaningful formatting with data-fill="red|yellow|gray", data-font-color="red|...", and data-bold="true" where visible. For a map/photo-only cell, use <span data-image="present"></span>; do not OCR labels inside map imagery.

Copy all visible Russian/Ukrainian text, numbers, coordinates, punctuation, capitalization, and source spelling as closely as possible. Do not correct, summarize, infer, merge, move, invent, or repeat content. Use [неразборчиво] only when a character is genuinely unreadable. Process visual regions once, top to bottom and left to right.

Return only an <article> containing semantic HTML headings, captions, and <table> elements. Do not use Markdown or a code fence. End with this exact marker after </article>:
<!-- END_OCR -->"""

DOCUMENT_HTML_PROMPT = """Perform exact visual OCR of the complete source image into semantic HTML.

Preserve the document's visual reading order and grouping as closely as possible. Return one <article>. Represent each physical page or distinct visual box as a <section data-region="...">, with headings, paragraphs, lists, tables, and signature/address blocks as appropriate. If the image contains two pages side by side, transcribe the left page completely before the right page and put each in its own section. Keep paragraphs that occupy the same visual square or cell together. Do not flatten a visible table into prose.

Copy all visible Russian/Ukrainian text, numbers, coordinates, punctuation, capitalization, line grouping, and source spelling as closely as possible. Do not correct, summarize, infer, merge, invent, or repeat content. Use [неразборчиво] only when text is genuinely unreadable. Process every visual region exactly once.

Return only semantic HTML, without Markdown or a code fence. End with this exact marker after </article>:
<!-- END_OCR -->"""

PROMPTS = {
    "table": TABLE_HTML_PROMPT,
    "document": DOCUMENT_HTML_PROMPT,
}
