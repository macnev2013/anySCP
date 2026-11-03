// macOS WebKit applies system autocorrect / auto-capitalization to every text
// field, and commits the pending suggestion when the field loses focus (#161).
// Hostnames, usernames, paths and commands must never be rewritten, so turn
// these off for every input and textarea unless a field opts back in by
// setting the attribute itself.

const ATTRS: ReadonlyArray<readonly [string, string]> = [
  ["autocorrect", "off"],
  ["autocapitalize", "off"],
  ["spellcheck", "false"],
];

const SELECTOR = "input, textarea";

function apply(el: Element): void {
  for (const [name, value] of ATTRS) {
    if (!el.hasAttribute(name)) el.setAttribute(name, value);
  }
}

function applyWithin(node: Node): void {
  if (!(node instanceof Element)) return;
  if (node.matches(SELECTOR)) apply(node);
  node.querySelectorAll(SELECTOR).forEach(apply);
}

export function disableTextAssist(root: HTMLElement = document.body): () => void {
  applyWithin(root);
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach(applyWithin);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
