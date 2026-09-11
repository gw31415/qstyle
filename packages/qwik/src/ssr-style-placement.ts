import {
  renderToStream,
  renderToString,
  type RenderToStreamOptions,
  type RenderToStreamResult,
  type RenderToStringOptions,
  type RenderToStringResult,
} from '@qwik.dev/core/server';
import {
  defaultTreeAdapter,
  Parser,
  type DefaultTreeAdapterTypes,
  type TreeAdapter,
} from 'parse5';

type RenderInput = Parameters<typeof renderToString>[0];

/** Options accepted by the fixture's server-side style-placement wrapper. */
export type SSRStylePlacementOptions = {
  /** Emit generated styles collected during SSR in the document head. */
  readonly stylePlacement?: 'head' | 'body';
};

type HeadRenderOptions = Pick<RenderToStreamOptions, 'containerTagName' | 'streaming'>;

export type SSRRenderToStringOptions = RenderToStringOptions
  & SSRStylePlacementOptions
  & Partial<Pick<RenderToStreamOptions, 'streaming'>>;
export type SSRRenderToStreamOptions = RenderToStreamOptions & SSRStylePlacementOptions;

/** Request-local map used to collect generated CSS before the document is flushed. */
export const COLLECTED_STYLES_KEY = 'qstyle:collected-styles';

export type CollectedStyle = {
  readonly text?: string;
  readonly pending?: Promise<void>;
};

type ParsedElement = DefaultTreeAdapterTypes.Element;
type ParsedParentNode = DefaultTreeAdapterTypes.ParentNode;
type ParsedLocation = {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startTag?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  readonly endTag?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
};

type CompactTreeAdapterMap = DefaultTreeAdapterTypes.DefaultTreeAdapterMap;

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const PARSER_CHUNK_SIZE = 64 * 1024;

function tracksLocation(node: DefaultTreeAdapterTypes.Node): boolean {
  if (!defaultTreeAdapter.isElementNode(node)) return false;
  return node.tagName === 'html' || node.tagName === 'head' || node.tagName === 'body';
}

function appendCompactText(parent: DefaultTreeAdapterTypes.ParentNode): void {
  const children = defaultTreeAdapter.getChildNodes(parent);
  const previous = children[children.length - 1];
  // Parser decisions use the presence and location of text nodes, while the
  // text payload itself is irrelevant to structural validation. Keep one
  // empty node per contiguous run so source locations still work when needed.
  if (previous && defaultTreeAdapter.isTextNode(previous)) return;
  defaultTreeAdapter.appendChild(parent, defaultTreeAdapter.createTextNode(''));
}

function insertCompactTextBefore(
  parent: DefaultTreeAdapterTypes.ParentNode,
  referenceNode: DefaultTreeAdapterTypes.ChildNode,
): void {
  const children = defaultTreeAdapter.getChildNodes(parent);
  const referenceIndex = children.indexOf(referenceNode);
  const previous = children[referenceIndex - 1];
  if (previous && defaultTreeAdapter.isTextNode(previous)) return;
  defaultTreeAdapter.insertBefore(parent, defaultTreeAdapter.createTextNode(''), referenceNode);
}

// A default parse5 tree retains every body text payload and location object.
// Structural validation only needs the HTML tree shape plus html/head/body
// locations, so keep parser-visible nodes while omitting large text/comment
// strings and locations for unrelated nodes.
const compactTreeAdapter: TreeAdapter<CompactTreeAdapterMap> = {
  ...defaultTreeAdapter,
  createTextNode: () => defaultTreeAdapter.createTextNode(''),
  createCommentNode: () => defaultTreeAdapter.createCommentNode(''),
  insertText: (parent) => appendCompactText(parent),
  insertTextBefore: (parent, _text, referenceNode) => insertCompactTextBefore(parent, referenceNode),
  setNodeSourceCodeLocation: (node, location) => {
    if (tracksLocation(node)) defaultTreeAdapter.setNodeSourceCodeLocation(node, location);
  },
  updateNodeSourceCodeLocation: (node, endLocation) => {
    if (tracksLocation(node)) defaultTreeAdapter.updateNodeSourceCodeLocation(node, endLocation);
  },
};

function getElementLocation(element: ParsedElement): ParsedLocation | undefined {
  const location = defaultTreeAdapter.getNodeSourceCodeLocation(element);
  return location && 'startOffset' in location ? location as ParsedLocation : undefined;
}

function directElements(parent: ParsedParentNode): ParsedElement[] {
  return defaultTreeAdapter.getChildNodes(parent).filter(
    (node): node is ParsedElement => defaultTreeAdapter.isElementNode(node),
  );
}

function parseDocumentUntilBody(html: string, scriptingEnabled: boolean): {
  readonly document: DefaultTreeAdapterTypes.Document;
  readonly parseErrors: ReadonlyArray<{ readonly code: string }>;
} {
  const parseErrors: Array<{ readonly code: string }> = [];
  let parser: Parser<CompactTreeAdapterMap> | undefined;
  let stoppedAtBody = false;

  const treeAdapter: TreeAdapter<CompactTreeAdapterMap> = {
    ...compactTreeAdapter,
    onItemPush: (node) => {
      if (!parser || !defaultTreeAdapter.isElementNode(node) || node.tagName !== 'body') return;
      if (defaultTreeAdapter.getNamespaceURI(node) !== HTML_NAMESPACE) return;
      const parent = defaultTreeAdapter.getParentNode(node);
      if (!parent || !defaultTreeAdapter.isElementNode(parent)) return;
      if (parent.tagName !== 'html' || defaultTreeAdapter.getNamespaceURI(parent) !== HTML_NAMESPACE) return;
      // Once the parser has attached a direct HTML body, everything after its
      // start tag is an opaque suffix. Pausing here keeps malformed or huge
      // body content out of the structural validation path.
      stoppedAtBody = true;
      parser.tokenizer.pause();
    },
  };

  parser = new Parser({
    sourceCodeLocationInfo: true,
    scriptingEnabled,
    treeAdapter,
    onParseError: (error) => parseErrors.push(error),
  });

  if (html.length === 0) {
    parser.tokenizer.write('', true);
  } else {
    for (let offset = 0; offset < html.length && !stoppedAtBody; offset += PARSER_CHUNK_SIZE) {
      const end = Math.min(offset + PARSER_CHUNK_SIZE, html.length);
      parser.tokenizer.write(html.slice(offset, end), end === html.length);
    }
  }
  return { document: parser.document, parseErrors };
}

function invalidDocument(message: string): never {
  throw new Error(`Native head styles require ${message}`);
}

function findDocumentParts(html: string): {
  readonly headClose: number;
  readonly bodyOpen: number;
} {
  const boundaries = [
    parseDocumentUntilBody(html, true),
    parseDocumentUntilBody(html, false),
  ].map(({ document, parseErrors }) => {
    const htmlElements = directElements(document).filter((element) => element.tagName === 'html');
    if (htmlElements.length !== 1 || !getElementLocation(htmlElements[0]!)) {
      invalidDocument('exactly one html element');
    }

    const htmlElement = htmlElements[0]!;
    if (defaultTreeAdapter.getNamespaceURI(htmlElement) !== HTML_NAMESPACE
      || defaultTreeAdapter.getParentNode(htmlElement) !== document) {
      invalidDocument('exactly one direct HTML html element');
    }
    const headElements = directElements(htmlElement).filter((element) => element.tagName === 'head');
    const bodyElements = directElements(htmlElement).filter((element) => element.tagName === 'body');
    if (headElements.length !== 1 || !getElementLocation(headElements[0]!)) {
      invalidDocument('exactly one head element');
    }
    if (bodyElements.length !== 1 || !getElementLocation(bodyElements[0]!)) {
      invalidDocument('exactly one body element');
    }
    if (parseErrors.length > 0) invalidDocument('a valid HTML document before the body');

    const headElement = headElements[0]!;
    const bodyElement = bodyElements[0]!;
    if (defaultTreeAdapter.getNamespaceURI(headElement) !== HTML_NAMESPACE
      || defaultTreeAdapter.getParentNode(headElement) !== htmlElement
      || defaultTreeAdapter.getNamespaceURI(bodyElement) !== HTML_NAMESPACE
      || defaultTreeAdapter.getParentNode(bodyElement) !== htmlElement) {
      invalidDocument('direct HTML head and body elements');
    }

    const headLocation = getElementLocation(headElement);
    const bodyLocation = getElementLocation(bodyElement);
    const headStartTag = headLocation?.startTag;
    const headEndTag = headLocation?.endTag;
    const bodyStartTag = bodyLocation?.startTag;
    if (!headLocation || !headStartTag || !headEndTag || !bodyLocation || !bodyStartTag) {
      invalidDocument('an explicit html/head/body boundary');
    }

    const headClose = headEndTag.startOffset;
    const bodyOpen = bodyLocation.startOffset;
    if (headStartTag.endOffset > headClose || headClose > bodyOpen || bodyStartTag.startOffset !== bodyOpen) {
      invalidDocument('a valid head/body boundary');
    }
    return { headClose, bodyOpen };
  });
  if (boundaries[0]!.headClose !== boundaries[1]!.headClose || boundaries[0]!.bodyOpen !== boundaries[1]!.bodyOpen) {
    invalidDocument('a consistent head/body boundary with scripting enabled and disabled');
  }
  return boundaries[0]!;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function assertCollectedStylesResolved(collectedStyles: ReadonlyMap<string, CollectedStyle>): ReadonlyArray<[string, string]> {
  const unresolved: string[] = [];
  const resolved: Array<[string, string]> = [];
  for (const [styleId, style] of collectedStyles) {
    if (style.pending !== undefined || style.text === undefined) {
      unresolved.push(styleId);
    } else {
      resolved.push([styleId, style.text]);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(`Native head styles require collected styles to resolve before flush: ${unresolved.join(', ')}`);
  }
  for (const [styleId, text] of resolved) {
    // Styles are HTML raw text. A literal closing sequence would terminate the
    // injected node and change the document before the browser can parse CSS.
    if (/<\/style/i.test(text)) {
      throw new Error(`Native head styles reject CSS containing a literal </style sequence (${styleId})`);
    }
  }
  return resolved;
}

/** Injects completed collected styles immediately before the parsed `</head>`. */
export function injectCollectedStyles(html: string, collectedStyles: ReadonlyMap<string, CollectedStyle>): string {
  const styles = assertCollectedStylesResolved(collectedStyles);
  const document = findDocumentParts(html);
  if (styles.length === 0) return html;
  const markup = styles
    .map(([styleId, text]) => `<style q:style="${escapeHtmlAttribute(styleId)}">${text}</style>`)
    .join('');
  return html.slice(0, document.headClose) + markup + html.slice(document.headClose);
}

function prepareCollectedStyleData(
  serverData: RenderToStringOptions['serverData'],
): {
  readonly serverData: NonNullable<RenderToStringOptions['serverData']>;
  readonly collectedStyles: Map<string, CollectedStyle>;
} {
  const source = serverData ?? {};
  // The collector is always request-local. A caller-provided Map may hold
  // promises or CSS from an earlier render and must never be reused.
  const collectedStyles = new Map<string, CollectedStyle>();
  return {
    serverData: { ...source, [COLLECTED_STYLES_KEY]: collectedStyles },
    collectedStyles,
  };
}

/** Renders a complete Qwik document and emits collected generated styles in `<head>`. */
export async function renderToStringWithHeadStyles(
  jsx: RenderInput,
  options: SSRRenderToStringOptions = {},
): Promise<RenderToStringResult> {
  const { stylePlacement, ...renderOptions } = options;
  if (stylePlacement !== 'head') return renderToString(jsx, renderOptions);
  assertHeadStreamSupported(renderOptions);
  const { serverData, collectedStyles } = prepareCollectedStyleData(renderOptions.serverData);
  const result = await renderToString(jsx, { ...renderOptions, serverData });
  return { ...result, html: injectCollectedStyles(result.html, collectedStyles) };
}

function assertHeadStreamSupported(options: HeadRenderOptions): void {
  if ((options.containerTagName ?? 'html') !== 'html' || options.streaming?.outOfOrder === true) {
    throw new Error('Native head styles require a full HTML document without out-of-order streaming');
  }
}

/** Buffers a Qwik stream, injects collected styles, and writes one final chunk. */
export async function renderToStreamWithHeadStyles(
  jsx: RenderInput,
  options: SSRRenderToStreamOptions,
): Promise<RenderToStreamResult> {
  if (options.stylePlacement !== 'head') return renderToStream(jsx, options);
  assertHeadStreamSupported(options);

  const {
    stylePlacement: _stylePlacement,
    stream: destination,
    onBeforeFirstFlush,
    ...renderOptions
  } = options;
  const chunks: string[] = [];
  const { serverData, collectedStyles } = prepareCollectedStyleData(renderOptions.serverData);
  const result = await renderToStream(jsx, {
    ...renderOptions,
    serverData,
    // A single internal flush keeps timing/flush accounting coherent while
    // ensuring no bytes escape before all generated styles have resolved.
    streaming: { ...renderOptions.streaming, inOrder: { strategy: 'disabled' }, outOfOrder: false },
    stream: { write(chunk: string) { chunks.push(chunk); } },
  });

  const html = injectCollectedStyles(chunks.join(''), collectedStyles);
  onBeforeFirstFlush?.({ errorBoundaryCaught: result.errorBoundaryCaught === true });
  await destination.write(html);
  return { ...result, flushes: 1 };
}
