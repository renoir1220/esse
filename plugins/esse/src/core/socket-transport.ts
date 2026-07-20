import type net from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class SocketServerTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private started = false;
  private closed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  constructor(private readonly socket: net.Socket) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("SocketServerTransport already started.");
    this.started = true;
    this.socket.on("data", this.onData);
    this.socket.on("error", this.onSocketError);
    this.socket.on("close", this.onSocketClose);
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed || this.socket.destroyed) throw new Error("Esse Core socket is closed.");
    await new Promise<void>((resolve, reject) => {
      this.socket.write(serializeMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeListeners();
    this.readBuffer.clear();
    if (!this.socket.destroyed) this.socket.destroy();
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer) => {
    this.readBuffer.append(chunk);
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  private readonly onSocketError = (error: Error) => this.onerror?.(error);

  private readonly onSocketClose = () => {
    if (this.closed) return;
    this.closed = true;
    this.removeListeners();
    this.readBuffer.clear();
    this.onclose?.();
  };

  private removeListeners(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onSocketError);
    this.socket.off("close", this.onSocketClose);
  }
}
