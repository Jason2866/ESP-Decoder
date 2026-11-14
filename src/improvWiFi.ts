/**
 * Improv-WiFi serial protocol engine.
 *
 * Implements the host side of the Improv serial protocol
 * (https://www.improv-wifi.com/serial/) so a connected ESP board running
 * Improv-capable firmware can be handed WiFi credentials over the same UART.
 *
 * This module is transport-agnostic and free of any `vscode` import so it can
 * be unit-tested in Node (like ansiParser/trbr). The caller supplies a
 * `write(Buffer)` function and pumps received bytes in via `feed(Buffer)`.
 *
 * Wire format of one packet:
 *
 *   "IMPROV" (6) | 0x01 version | TYPE | LEN | PAYLOAD[LEN] | CHECKSUM | 0x0A
 *
 * CHECKSUM = (sum of every byte up to but excluding the checksum) & 0xff.
 */

/** ASCII bytes of the packet header "IMPROV". */
export const IMPROV_HEADER = [73, 77, 80, 82, 79, 86]; // "IMPROV"
export const IMPROV_VERSION = 0x01;

/** Packet TYPE field. */
export enum ImprovType {
  CurrentState = 0x01, // device -> host
  ErrorState = 0x02, // device -> host
  RPCCommand = 0x03, // host   -> device
  RPCResult = 0x04, // device -> host
}

/** Current-state values (TYPE 0x01). */
export enum ImprovState {
  Ready = 0x02, // authorized, ready to accept credentials
  Provisioning = 0x03,
  Provisioned = 0x04,
}

/** Error-state values (TYPE 0x02). */
export enum ImprovError {
  None = 0x00,
  InvalidRPCPacket = 0x01,
  UnknownRPCCommand = 0x02,
  UnableToConnect = 0x03,
  NotAuthorized = 0x04,
  Unknown = 0xff,
}

/** RPC command IDs (first byte of a TYPE 0x03 payload). */
export enum ImprovRPCCommand {
  SendWifiSettings = 0x01,
  RequestCurrentState = 0x02,
  RequestDeviceInformation = 0x03,
  RequestScannedWifiNetworks = 0x04,
}

export interface ImprovDeviceInfo {
  firmware: string;
  version: string;
  chipFamily: string;
  name: string;
}

export interface ImprovNetwork {
  ssid: string;
  rssi: number;
  secured: boolean;
}

export interface ImprovProvisionResult {
  /** URLs the device reports the host should open next (may be empty). */
  nextUrl: string[];
}

/** A decoded inbound packet. */
interface ImprovPacket {
  type: ImprovType;
  payload: number[];
}

export class ImprovError_ extends Error {
  constructor(
    message: string,
    readonly code?: ImprovError,
  ) {
    super(message);
    this.name = 'ImprovError';
  }
}

/**
 * Build the on-the-wire bytes for a packet of `type` carrying `payload`.
 */
export function encodePacket(type: ImprovType, payload: number[]): Buffer {
  const bytes = [...IMPROV_HEADER, IMPROV_VERSION, type, payload.length, ...payload];
  let checksum = 0;
  for (const b of bytes) {
    checksum += b;
  }
  bytes.push(checksum & 0xff);
  bytes.push(0x0a); // newline terminator
  return Buffer.from(bytes);
}

/** Length-prefix a UTF-8 string: [len, ...bytes]. */
function lenPrefixed(str: string): number[] {
  const data = Array.from(Buffer.from(str, 'utf-8'));
  return [data.length, ...data];
}

/**
 * Build an RPC command packet (TYPE 0x03). The payload is
 * `[command, commandDataLength, ...commandData]`.
 */
export function encodeRPC(command: ImprovRPCCommand, commandData: number[] = []): Buffer {
  return encodePacket(ImprovType.RPCCommand, [command, commandData.length, ...commandData]);
}

/**
 * Decode the length-prefixed string list carried in an RPC result payload.
 * Payload layout: `[command, blobLength, (len, ...bytes)...]`.
 */
function decodeRPCStrings(payload: number[]): string[] {
  const out: string[] = [];
  const blobLength = payload[1] ?? 0;
  let idx = 2;
  const end = 2 + blobLength;
  while (idx < end && idx < payload.length) {
    const len = payload[idx];
    const slice = payload.slice(idx + 1, idx + 1 + len);
    out.push(Buffer.from(slice).toString('utf-8'));
    idx += len + 1;
  }
  return out;
}

type PendingResolver = {
  resolve: (packets: ImprovPacket[]) => void;
  reject: (err: Error) => void;
  /** Collected RPCResult packets for the in-flight command. */
  results: ImprovPacket[];
  /** Stop collecting and resolve when this returns true for the latest result. */
  isTerminal: (packet: ImprovPacket) => boolean;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Stateful Improv host engine. Frame parsing tolerates arbitrary non-Improv
 * bytes (e.g. firmware log lines) interleaved in the stream: it resynchronises
 * on the next "IMPROV" magic.
 */
export class ImprovEngine {
  private buf: number[] = [];
  private pending: PendingResolver | null = null;
  private _state: ImprovState | null = null;

  constructor(
    private readonly write: (data: Buffer) => Promise<void>,
    private readonly defaultTimeoutMs = 30000,
  ) {}

  get state(): ImprovState | null {
    return this._state;
  }

  /** Pump received serial bytes into the parser. */
  feed(chunk: Buffer): void {
    for (const b of chunk) {
      this.buf.push(b);
    }
    this.parse();
  }

  /** Extract complete packets from `buf`, resynchronising on the magic header. */
  private parse(): void {
    // Drop bytes until the buffer starts with the header (or runs out).
    for (;;) {
      const start = this.indexOfHeader();
      if (start < 0) {
        // No header present. Keep only the last few bytes in case a header is
        // split across chunk boundaries.
        if (this.buf.length > IMPROV_HEADER.length) {
          this.buf = this.buf.slice(-(IMPROV_HEADER.length - 1));
        }
        return;
      }
      if (start > 0) {
        this.buf = this.buf.slice(start);
      }
      // Need header(6)+version(1)+type(1)+len(1) before we know the size.
      if (this.buf.length < IMPROV_HEADER.length + 3) {
        return;
      }
      const len = this.buf[8];
      // A frame ends at the checksum byte. The trailing newline that senders
      // (incl. our own encoder) append is optional per the Improv spec — some
      // firmwares (e.g. the Arduino ImprovWiFi library) omit it. So do NOT
      // require it here; it is harmlessly skipped as inter-frame noise.
      const total = IMPROV_HEADER.length + 3 + len + 1; // +checksum
      if (this.buf.length < total) {
        return; // wait for more bytes
      }
      const frame = this.buf.slice(0, total);
      this.buf = this.buf.slice(total);
      this.handleFrame(frame);
    }
  }

  /** Index of the next "IMPROV" header in `buf`, or -1. */
  private indexOfHeader(): number {
    outer: for (let i = 0; i + IMPROV_HEADER.length <= this.buf.length; i++) {
      for (let j = 0; j < IMPROV_HEADER.length; j++) {
        if (this.buf[i + j] !== IMPROV_HEADER[j]) {
          continue outer;
        }
      }
      return i;
    }
    return -1;
  }

  /** Validate checksum, decode, and dispatch a complete frame. */
  private handleFrame(frame: number[]): void {
    const version = frame[6];
    if (version !== IMPROV_VERSION) {
      return; // not a packet we understand; ignore
    }
    // Checksum is the final byte; sum covers everything before it.
    const checksumByte = frame[frame.length - 1];
    let sum = 0;
    for (let i = 0; i < frame.length - 1; i++) {
      sum += frame[i];
    }
    if ((sum & 0xff) !== checksumByte) {
      return; // corrupt — ignore (false-positive magic in log text, etc.)
    }
    const type = frame[7] as ImprovType;
    const len = frame[8];
    const payload = frame.slice(9, 9 + len);
    this.dispatch({ type, payload });
  }

  private dispatch(packet: ImprovPacket): void {
    if (packet.type === ImprovType.CurrentState) {
      this._state = packet.payload[0] as ImprovState;
      return;
    }
    if (packet.type === ImprovType.ErrorState) {
      const code = packet.payload[0] as ImprovError;
      if (code !== ImprovError.None && this.pending) {
        this.rejectPending(new ImprovError_(`Improv device error: ${ImprovError[code] ?? code}`, code));
      }
      return;
    }
    if (packet.type === ImprovType.RPCResult && this.pending) {
      this.pending.results.push(packet);
      if (this.pending.isTerminal(packet)) {
        this.resolvePending();
      }
    }
  }

  private resolvePending(): void {
    if (!this.pending) {
      return;
    }
    clearTimeout(this.pending.timer);
    const { resolve, results } = this.pending;
    this.pending = null;
    resolve(results);
  }

  private rejectPending(err: Error): void {
    if (!this.pending) {
      return;
    }
    clearTimeout(this.pending.timer);
    const { reject } = this.pending;
    this.pending = null;
    reject(err);
  }

  /**
   * Send an RPC command and collect result packets until `isTerminal` accepts
   * one (default: the first result).
   */
  private async sendRPC(
    command: ImprovRPCCommand,
    commandData: number[],
    opts: { isTerminal?: (p: ImprovPacket) => boolean; timeoutMs?: number } = {},
  ): Promise<ImprovPacket[]> {
    if (this.pending) {
      throw new ImprovError_('Another Improv command is already in flight');
    }
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const promise = new Promise<ImprovPacket[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new ImprovError_('Improv command timed out — no response from device'));
      }, timeoutMs);
      this.pending = {
        resolve,
        reject,
        results: [],
        isTerminal: opts.isTerminal ?? (() => true),
        timer,
      };
    });
    await this.write(encodeRPC(command, commandData));
    return promise;
  }

  /** Request firmware/chip/name info. */
  async requestInfo(timeoutMs?: number): Promise<ImprovDeviceInfo> {
    const [packet] = await this.sendRPC(ImprovRPCCommand.RequestDeviceInformation, [], { timeoutMs });
    const [firmware = '', version = '', chipFamily = '', name = ''] = decodeRPCStrings(packet.payload);
    return { firmware, version, chipFamily, name };
  }

  /**
   * Request a WiFi scan. The device streams one RPCResult per network and a
   * final empty result that terminates the list.
   */
  async scan(timeoutMs?: number): Promise<ImprovNetwork[]> {
    const packets = await this.sendRPC(ImprovRPCCommand.RequestScannedWifiNetworks, [], {
      // An empty (blobLength 0) result marks the end of the list.
      isTerminal: (p) => (p.payload[1] ?? 0) === 0,
      timeoutMs,
    });
    const networks: ImprovNetwork[] = [];
    for (const p of packets) {
      const fields = decodeRPCStrings(p.payload);
      if (fields.length < 3) {
        continue; // terminating empty result
      }
      const [ssid, rssi, secured] = fields;
      networks.push({ ssid, rssi: parseInt(rssi, 10), secured: secured === 'YES' });
    }
    networks.sort((a, b) => b.rssi - a.rssi);
    return networks;
  }

  /**
   * Provision WiFi credentials. Resolves with the device-reported next-url(s)
   * once the device reaches the Provisioned state; rejects on an error-state.
   */
  async provision(ssid: string, password: string, timeoutMs?: number): Promise<ImprovProvisionResult> {
    const data = [...lenPrefixed(ssid), ...lenPrefixed(password)];
    const [packet] = await this.sendRPC(ImprovRPCCommand.SendWifiSettings, data, { timeoutMs });
    return { nextUrl: decodeRPCStrings(packet.payload) };
  }

  /** Ask the device to (re)send its current state. */
  async requestState(timeoutMs?: number): Promise<void> {
    // No RPCResult is returned for this; the device emits a CurrentState packet.
    // Fire-and-forget with a short window so callers can poll `state`.
    if (this.pending) {
      throw new ImprovError_('Another Improv command is already in flight');
    }
    await this.write(encodeRPC(ImprovRPCCommand.RequestCurrentState, []));
    void timeoutMs;
  }

  /** Abort any in-flight command (e.g. on teardown). */
  dispose(): void {
    this.rejectPending(new ImprovError_('Improv session closed'));
    this.buf = [];
  }
}

/**
 * Minimal serial transport an Improv session needs. Implemented by
 * SerialPortManager; declared here so this module stays free of `vscode`.
 */
export interface ImprovTransport {
  isConnected: boolean;
  writeBytes(data: Buffer): Promise<void>;
  setRxInterceptor(fn: ((data: Buffer) => void) | null): void;
}

/**
 * Run `fn` with an {@link ImprovEngine} wired to `transport`. Installs an RX
 * interceptor for the duration and always clears it (and disposes the engine)
 * afterwards, so the normal serial monitor resumes when provisioning ends.
 */
export async function withImprovSession<T>(
  transport: ImprovTransport,
  timeoutMs: number,
  fn: (engine: ImprovEngine) => Promise<T>,
): Promise<T> {
  if (!transport.isConnected) {
    throw new ImprovError_('Serial port not connected');
  }
  const engine = new ImprovEngine((data) => transport.writeBytes(data), timeoutMs);
  transport.setRxInterceptor((data) => engine.feed(data));
  try {
    return await fn(engine);
  } finally {
    transport.setRxInterceptor(null);
    engine.dispose();
  }
}
