import createDOMPurify from 'dompurify';

const DOMPurify = createDOMPurify(window);
const DOCX_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];
const DOCX_ALLOWED_ATTR = ['alt', 'colspan', 'href', 'rowspan', 'src', 'title'];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return;

  for (const attribute of Array.from(node.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim().toLowerCase();

    if (name.startsWith('on')) {
      node.removeAttribute(attribute.name);
      continue;
    }

    if (name === 'style') {
      node.removeAttribute(attribute.name);
      continue;
    }

    if (name === 'href' || name === 'xlink:href') {
      const isSafeValue = value === '' || value.startsWith('#');
      if (!isSafeValue) {
        node.removeAttribute(attribute.name);
      }
      continue;
    }

    if (name === 'src') {
      const isSafeValue = value === '' || value.startsWith('data:image/');
      if (!isSafeValue) {
        node.removeAttribute(attribute.name);
      }
    }
  }
});

export function sanitizeDocxHtml(html: string): string {
  if (html.trim() === '') return '';

  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_ATTR: DOCX_ALLOWED_ATTR,
    ALLOWED_TAGS: DOCX_ALLOWED_TAGS,
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'link',
      'meta',
      'form',
      'input',
      'textarea',
      'select',
      'button',
    ],
  });

  const parser = new DOMParser();
  const document = parser.parseFromString(sanitized, 'text/html');

  for (const element of Array.from(
    document.querySelectorAll(
      'script, iframe, object, embed, link, meta, form, input, textarea, select, button',
    ),
  )) {
    element.remove();
  }

  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();

      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === 'style') {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === 'href' || name === 'xlink:href') {
        const isSafeValue = value === '' || value.startsWith('#');
        if (!isSafeValue) {
          element.removeAttribute(attribute.name);
        }
        continue;
      }

      if (name === 'src') {
        const isSafeValue = value === '' || value.startsWith('data:image/');
        if (!isSafeValue) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }

  return document.body.innerHTML;
}
