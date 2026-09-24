declare module "@novnc/novnc" {
  const RFB: new (
    target: HTMLElement,
    url: string,
    options?: Record<string, unknown>,
  ) => {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
    removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
    sendCredentials(password: string): void;
    disconnect(): void;
    scaleViewport: boolean;
  };
  export default RFB;
  export { RFB };
}
