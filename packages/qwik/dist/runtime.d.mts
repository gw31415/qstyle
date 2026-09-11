import { QRL } from "@qwik.dev/core";
//#region src/runtime.d.ts
export declare function retryStyleImport<T>(load: () => Promise<T>, href: string): Promise<T>;
export declare function useStyles(styles: QRL<string>, generatedPack?: boolean): {
  styleId: string;
};
export declare const useStylesQrl: (styles: QRL<string>, generatedPack?: boolean) => {
  styleId: string;
};
export declare const useStylesScoped: (styles: QRL<string>) => {
  scopeId: string;
};
export declare const useStylesScopedQrl: (styles: QRL<string>) => {
  scopeId: string;
};
export declare const useStyles$: (styles: string, generatedPack?: boolean) => {
  styleId: string;
};
export declare const useStylesScoped$: (styles: string) => {
  scopeId: string;
};
//#endregion
//# sourceMappingURL=runtime.d.mts.map