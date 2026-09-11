import { RenderToStreamOptions, RenderToStreamResult, RenderToStringOptions, RenderToStringResult, renderToString as renderToString$1 } from "@qwik.dev/core/server";
//#region src/server.d.ts
type Input = Parameters<typeof renderToString$1>[0];
export declare const renderToString: (jsx: Input, options?: RenderToStringOptions) => Promise<RenderToStringResult>;
export declare const renderToStream: (jsx: Input, options: RenderToStreamOptions) => Promise<RenderToStreamResult>;
//#endregion
//# sourceMappingURL=server.d.mts.map