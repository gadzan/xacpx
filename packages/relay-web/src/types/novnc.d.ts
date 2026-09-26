declare module "@novnc/novnc" {
  /** noVNC's credentials object: standard VncAuth reads `.password` only. */
  export interface NoVncCredentials {
    password?: string;
    username?: string;
    [key: string]: string | undefined;
  }
  const RFB: new (
    target: HTMLElement,
    url: string,
    options?: Record<string, unknown>,
  ) => {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
    removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
    /** Takes a credentials OBJECT: passing a bare string leaves `.password`
     *  undefined and re-fires `credentialsrequired` forever. */
    sendCredentials(credentials: NoVncCredentials): void;
    disconnect(): void;
    /** Writable post-construction property; noVNC defaults it to `false`. */
    scaleViewport: boolean;
  };
  export default RFB;
  export { RFB };
}
