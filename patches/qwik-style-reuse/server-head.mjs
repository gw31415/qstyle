// Isolated upstream candidate: collect only rendered native styles in the head.
// Opting in buffers the full document; it deliberately does not support OOOS.
const NEEDS_HOIST = `
  nativeStyleNeedsHoist() {
    if (this.renderOptions.stylePlacement !== "head" || this.currentElementFrame?.elementName === "html") return false;
    for (let frame = this.currentElementFrame; frame; frame = frame.parent) {
      if (frame.elementName === "head") return false;
    }
    return true;
  }
`;
export function patchServerHead(source, replaceOnce) {
  source = replaceOnce(source, '  additionalHeadNodes = new Array();',
    '  additionalHeadNodes = new Array();\n  nativeHeadStyles = [];' + NEEDS_HOIST, 'server head style queue');
  source = replaceOnce(source,
    '      this.styleIds.add(styleId);\n      if (this.currentElementFrame?.elementName === "html") {',
    `      this.styleIds.add(styleId);
      if (this.nativeStyleNeedsHoist()) {
        // No ':' attribute: these are native style nodes, not resumable JSX nodes.
        const markup = '<style q:style="' + escapeHTML(styleId) + '">' + content + '</style>';
        this.nativeHeadStyles.push(markup);
        this.size += markup.length;
        return;
      }
      if (this.currentElementFrame?.elementName === "html") {`, 'server collect native styles');
  source = replaceOnce(source,
    '    const elementName = currentFrame.elementName;\n    if (!isSelfClosingTag(elementName)) {',
    `    const elementName = currentFrame.elementName;
    if (this.renderOptions.stylePlacement === "head" && elementName === "head") {
      if (this.streamHandler.nativeHeadOffset !== undefined) {
        throw new Error('Native head styles require exactly one head element');
      }
      this.streamHandler.nativeHeadOffset = this.streamHandler.buffer.length + this.streamHandler.streamBlockBuffer.length;
    }
    if (!isSelfClosingTag(elementName)) {`, 'server head insertion boundary');
  source = replaceOnce(source, '  flush() {\n    if (!this.buffer) {',
    `  flush() {
    if (this.opts.stylePlacement === "head" && !this.nativeHeadReady) return;
    if (!this.buffer) {`, 'server defer network flush');
  source = replaceOnce(source, 'var renderToStream = async (jsx, opts) => {',
    `var renderToStream = async (jsx, opts) => {
  if (opts.stylePlacement === "head" && opts.streaming?.outOfOrder === undefined) {
    opts = { ...opts, streaming: { ...opts.streaming, outOfOrder: false } };
  }`, 'server suspense default');
  source = replaceOnce(source,
    '  const containerTagName = opts.containerTagName ?? "html";\n  const buildBase = getBuildBase(opts);',
    `  const containerTagName = opts.containerTagName ?? "html";
  if (opts.stylePlacement === "head") {
    if (containerTagName !== "html" || opts.streaming?.outOfOrder) {
      throw new Error('Native head styles require a full HTML document without out-of-order streaming');
    }
    opts = { ...opts, streaming: { ...opts.streaming, inOrder: { strategy: "disabled" } } };
  }
  const buildBase = getBuildBase(opts);`, 'server head mode contract');
  source = replaceOnce(source,
    '  await ssrContainer.$renderPromise$;\n  await streamHandler.flush();',
    `  await ssrContainer.$renderPromise$;
  if (opts.stylePlacement === "head") {
    const offset = streamHandler.nativeHeadOffset;
    if (offset === undefined) throw new Error('Native head styles require exactly one head element');
    if (streamHandler.streamBlockDepth !== 0) throw new Error('Native head styles require completed stream blocks');
    const styles = ssrContainer.nativeHeadStyles.join('');
    streamHandler.buffer = streamHandler.buffer.slice(0, offset) + styles + streamHandler.buffer.slice(offset);
    streamHandler.bufferSize += styles.length;
    streamHandler.nativeHeadReady = true;
  }
  await streamHandler.flush();`, 'server final head styles');
  return source;
}

export function patchServerHeadProd(source, replaceOnce) {
  const replace = (before, after, label) => { source = replaceOnce(source, before, after, `server.prod ${label}`); };
  replace('    additionalHeadNodes=new Array;', '    additionalHeadNodes=new Array;\n    nativeHeadStyles=[];' + NEEDS_HOIST, 'queue');
  replace('            this.styleIds.add(e);\n            if (this.currentElementFrame?.elementName === "html") {',
    `            this.styleIds.add(e);
            if (this.nativeStyleNeedsHoist()) {
                const markup = '<style q:style="' + escapeHTML(e) + '">' + t + '</style>';
                this.nativeHeadStyles.push(markup);
                this.size += markup.length;
                return;
            }
            if (this.currentElementFrame?.elementName === "html") {`, 'collect');
  replace('        const e = t.elementName;\n        if (!isSelfClosingTag(e)) {',
    `        const e = t.elementName;
        if (this.renderOptions.stylePlacement === "head" && e === "head") {
            if (this.streamHandler.nativeHeadOffset !== undefined) throw new Error('Native head styles require exactly one head element');
            this.streamHandler.nativeHeadOffset = this.streamHandler.buffer.length + this.streamHandler.streamBlockBuffer.length;
        }
        if (!isSelfClosingTag(e)) {`, 'head boundary');
  replace('    flush() {\n        if (!this.buffer) {',
    '    flush() {\n        if (this.opts.stylePlacement === "head" && !this.nativeHeadReady) return;\n        if (!this.buffer) {', 'flush');
  replace('var renderToStream = async (t, e) => {',
    `var renderToStream = async (t, e) => {
    if (e.stylePlacement === "head" && e.streaming?.outOfOrder === undefined) {
        e = { ...e, streaming: { ...e.streaming, outOfOrder: false } };
    }`, 'suspense default');
  replace('    const n = e.containerTagName ?? "html";\n    const s = getBuildBase(e);',
    `    const n = e.containerTagName ?? "html";
    if (e.stylePlacement === "head") {
        if (n !== "html" || e.streaming?.outOfOrder) throw new Error('Native head styles require a full HTML document without out-of-order streaming');
        e = { ...e, streaming: { ...e.streaming, inOrder: { strategy: "disabled" } } };
    }
    const s = getBuildBase(e);`, 'contract');
  replace('    await l.l;\n    await a.flush();',
    `    await l.l;
    if (e.stylePlacement === "head") {
        const offset = a.nativeHeadOffset;
        if (offset === undefined) throw new Error('Native head styles require exactly one head element');
        if (a.streamBlockDepth !== 0) throw new Error('Native head styles require completed stream blocks');
        const styles = l.nativeHeadStyles.join('');
        a.buffer = a.buffer.slice(0, offset) + styles + a.buffer.slice(offset);
        a.bufferSize += styles.length;
        a.nativeHeadReady = true;
    }
    await a.flush();`, 'finalize');
  return source;
}
