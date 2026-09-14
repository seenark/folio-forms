import { callbackOperationId, createCallbackUserdata } from "../src/onlyoffice";

export type OnlyOfficeFakeScenario =
  | "signed-success"
  | "explicit-failure"
  | "timeout"
  | "duplicate"
  | "malformed"
  | "replay";

export interface OnlyOfficeHttpFakeOptions {
  callbackUrl: string;
  callbackDelayMs?: number;
  callbackScenario?: OnlyOfficeFakeScenario;
  commandScenario?: OnlyOfficeFakeScenario;
  converterScenario?: OnlyOfficeFakeScenario;
  document?: Uint8Array;
  pdf?: Uint8Array;
  scenario?: OnlyOfficeFakeScenario;
  timeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

interface FakeServer {
  readonly url: URL;
  stop: (closeActiveConnections?: boolean) => void;
}

const defaultDocument = new TextEncoder().encode("fake-docx");
const defaultPdf = new TextEncoder().encode("%PDF-fake");

export class OnlyOfficeHttpFake {
  readonly callbackBodies: unknown[] = [];
  readonly commands: JsonRecord[] = [];
  readonly converters: JsonRecord[] = [];
  readonly server: FakeServer;
  readonly url: string;

  private readonly callbackDelayMs: number;
  private readonly callbackScenario: OnlyOfficeFakeScenario;
  private readonly callbackUrl: string;
  private readonly commandScenario: OnlyOfficeFakeScenario;
  private readonly converterScenario: OnlyOfficeFakeScenario;
  private readonly document: Uint8Array;
  private readonly pdf: Uint8Array;
  private readonly timeoutMs: number;
  private readonly pendingCallbacks = new Set<Promise<void>>();

  constructor(options: OnlyOfficeHttpFakeOptions) {
    this.callbackDelayMs = options.callbackDelayMs ?? 0;
    this.callbackScenario =
      options.callbackScenario ?? options.scenario ?? "signed-success";
    this.callbackUrl = options.callbackUrl;
    this.commandScenario =
      options.commandScenario ?? options.scenario ?? "signed-success";
    this.converterScenario =
      options.converterScenario ?? options.scenario ?? "signed-success";
    this.document = options.document ?? defaultDocument;
    this.pdf = options.pdf ?? defaultPdf;
    this.timeoutMs = options.timeoutMs ?? 25;
    this.server = Bun.serve({
      fetch: (request) => this.handle(request),
      port: 0,
    });
    this.url = this.server.url.origin;
  }

  async idle(): Promise<void> {
    const completion = Promise.all(this.pendingCallbacks);
    this.pendingCallbacks.clear();
    await completion;
  }

  close(): void {
    this.server.stop(true);
  }

  private handle(request: Request): Promise<Response> | Response {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/command") {
      return this.handleCommand(request);
    }
    if (request.method === "POST" && url.pathname === "/converter") {
      return this.handleConverter(request);
    }
    if (request.method === "GET" && url.pathname.startsWith("/documents/")) {
      return new Response(this.document, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/converted/")) {
      return new Response(this.pdf, {
        headers: { "Content-Type": "application/pdf" },
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async handleCommand(request: Request): Promise<Response> {
    const payload: unknown = await request.json();
    const command =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as JsonRecord)
        : undefined;
    if (command) {
      this.commands.push(command);
    }
    if (this.commandScenario === "timeout") {
      await Bun.sleep(this.timeoutMs);
      return Response.json(
        { error: 1, message: "Fake ONLYOFFICE command timed out" },
        { status: 504 }
      );
    }
    if (this.commandScenario === "malformed") {
      return new Response("{", {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (this.commandScenario === "explicit-failure") {
      return Response.json({
        error: 1,
        message: "Fake ONLYOFFICE command failed",
      });
    }

    if (command) {
      const key = typeof command.key === "string" ? command.key : "";
      const userdata =
        typeof command.userdata === "string" ? command.userdata : "";
      const operationId = callbackOperationId(userdata);
      if (key && operationId) {
        this.scheduleCallbacks(key, operationId);
      }
    }
    return Response.json({ error: 0 });
  }

  private async handleConverter(request: Request): Promise<Response> {
    const payload: unknown = await request.json();
    const conversion =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as JsonRecord)
        : undefined;
    if (conversion) {
      this.converters.push(conversion);
    }
    if (this.converterScenario === "timeout") {
      await Bun.sleep(this.timeoutMs);
      return Response.json(
        { error: 1, message: "Fake ONLYOFFICE converter timed out" },
        { status: 504 }
      );
    }
    if (this.converterScenario === "malformed") {
      return new Response("{", {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (this.converterScenario === "explicit-failure") {
      return Response.json({ error: 1 });
    }
    const key =
      conversion && typeof conversion.key === "string"
        ? conversion.key
        : "document";
    return Response.json({
      error: 0,
      fileUrl: `${this.url}/converted/${encodeURIComponent(key)}.pdf`,
    });
  }

  private scheduleCallbacks(key: string, operationId: string): void {
    this.pendingCallbacks.add(this.emitCallbacks(key, operationId));
  }

  private async emitCallbacks(key: string, operationId: string): Promise<void> {
    const scenario = this.callbackScenario;
    if (scenario === "timeout") {
      await Bun.sleep(this.timeoutMs);
      return;
    }
    if (scenario === "malformed") {
      await this.sendRawCallback("{");
      return;
    }
    const payload = {
      key,
      status: scenario === "explicit-failure" ? 7 : 6,
      url: `${this.url}/documents/${encodeURIComponent(key)}.docx`,
      userdata: createCallbackUserdata(operationId),
    };
    if (scenario === "duplicate") {
      await Promise.all([
        this.sendCallback(payload),
        this.sendCallback(payload),
      ]);
      return;
    }
    await this.sendCallback(payload);
    if (scenario === "replay") {
      if (this.callbackDelayMs > 0) {
        await Bun.sleep(this.callbackDelayMs);
      }
      await this.sendCallback(payload);
    }
  }

  private async sendCallback(payload: JsonRecord): Promise<void> {
    this.callbackBodies.push(payload);
    await fetch(this.callbackUrl, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }

  private async sendRawCallback(body: string): Promise<void> {
    this.callbackBodies.push(body);
    await fetch(this.callbackUrl, {
      body,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }
}
