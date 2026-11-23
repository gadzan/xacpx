// Opt-in, default-off probe of which RFB encodings the server ACTUALLY used.
//
// Setting `qualityLevel` / `compressionLevel` only makes noVNC SEND the
// pseudo-encodings in SetEncodings; whether the server honours them is
// untested (未实测). This counts the encodings that arrive in FramebufferUpdate
// rects. Raw/CopyRect/ZRLE/Hextile have no quality knob at all; only
// Tight/JPEG-style encodings CAN use it (and a server may still ignore it), so
// a human with a real Mac can at least tell which encodings were negotiated.
//
// Output is counts + encoding numbers/names only: no pixel bytes, no
// credentials, no URL/ticket.

const STORAGE_KEY = "xacpx.desktop.diagnostics";

/** RFB standard data encodings (noVNC core/encodings.js). */
const ENCODING_NAMES: Record<number, string> = {
  0: "Raw",
  1: "CopyRect",
  2: "RRE",
  5: "Hextile",
  6: "Zlib",
  7: "Tight",
  16: "ZRLE",
  21: "JPEG",
  50: "H.264",
  [-260]: "TightPNG",
};

export interface DesktopEncodingSummary {
  /** False when noVNC's internals were not found: the probe never ran. */
  available: boolean;
  unavailableReason?: string;
  /** Completed data rects counted so far. */
  rects: number;
  encodings: Array<{ encoding: number; name: string; count: number }>;
  /** Whether smooth-first was requested for this connection. */
  smoothFirst: boolean;
  /** Levels noVNC last put on the wire, when readable. */
  qualityLevel?: number;
  compressionLevel?: number;
}

/** Structural view of the noVNC internals this probe depends on. */
interface RfbWithRectInternals {
  _handleDataRect?: () => boolean;
  _FBU?: { encoding?: number | null };
  _qualityLevel?: number;
  _compressionLevel?: number;
}

export function desktopDiagnosticsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Wraps the RFB instance's rect handler to count encodings.
 *
 * Feature-detected, never assumed: if noVNC's internals drift the probe
 * reports "unavailable" and the connection is left exactly as it was.
 */
export class DesktopEncodingProbe {
  private readonly counts = new Map<number, number>();
  private rects = 0;
  private readonly unavailableReason?: string;
  private readonly base?: () => boolean;
  private readonly rfb: RfbWithRectInternals;

  constructor(rfb: unknown) {
    this.rfb = (rfb ?? {}) as RfbWithRectInternals;
    const base = this.rfb._handleDataRect;
    if (typeof base !== "function") {
      this.unavailableReason = "noVNC _handleDataRect missing";
      return;
    }
    // `_FBU.encoding` is the rect currently being decoded; it is only reset to
    // null after the whole FramebufferUpdate is consumed, so reading it inside
    // the wrapper is safe.
    if (!this.rfb._FBU || typeof this.rfb._FBU !== "object") {
      this.unavailableReason = "noVNC _FBU missing";
      return;
    }
    this.base = base.bind(this.rfb);
    const base2 = this.base;
    this.rfb._handleDataRect = () => {
      // true == this rect finished decoding; false == waiting for more bytes.
      const done = base2();
      if (done === true) {
        const encoding = this.rfb._FBU?.encoding;
        if (typeof encoding === "number") {
          this.counts.set(encoding, (this.counts.get(encoding) ?? 0) + 1);
          this.rects += 1;
        }
      }
      return done;
    };
  }

  get available(): boolean {
    return this.unavailableReason === undefined;
  }

  summary(smoothFirst: boolean): DesktopEncodingSummary {
    const encodings = [...this.counts.entries()]
      .map(([encoding, count]) => ({
        encoding,
        name: ENCODING_NAMES[encoding] ?? `unknown(${encoding})`,
        count,
      }))
      .sort((a, b) => a.encoding - b.encoding);
    const qualityLevel = typeof this.rfb._qualityLevel === "number" ? this.rfb._qualityLevel : undefined;
    const compressionLevel = typeof this.rfb._compressionLevel === "number" ? this.rfb._compressionLevel : undefined;
    return {
      available: this.available,
      ...(this.unavailableReason !== undefined ? { unavailableReason: this.unavailableReason } : {}),
      rects: this.rects,
      encodings,
      smoothFirst,
      ...(qualityLevel !== undefined ? { qualityLevel } : {}),
      ...(compressionLevel !== undefined ? { compressionLevel } : {}),
    };
  }
}

declare global {
  interface Window {
    /** On-demand desktop encoding diagnostic, when enabled. */
    __xacpxDesktopDiag?: () => DesktopEncodingSummary;
  }
}
