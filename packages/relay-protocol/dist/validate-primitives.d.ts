/** True for a non-null object; narrows to an indexable record for field access. */
export declare const isObj: (v: unknown) => v is Record<string, unknown>;
/** Required string. */
export declare const isStr: (v: unknown) => boolean;
/** Optional string: absent or a string. */
export declare const optStr: (v: unknown) => boolean;
/** Optional number: absent or a number. */
export declare const optNum: (v: unknown) => boolean;
/** Optional boolean: absent or a boolean. */
export declare const optBool: (v: unknown) => boolean;
