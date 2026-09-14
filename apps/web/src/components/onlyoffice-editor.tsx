import { useEffect, useId, useRef, useState } from "react";

import { Notice, Spinner } from "@/components/ui";
import { API_ORIGIN, apiGet, apiPost } from "@/lib/api";

type EditorAction = "save-template" | "publish" | "save-draft" | "submit";
type EditorOperationStatus = "pending" | "completed" | "failed";

interface EditorLease {
  id: string;
  expiresAt: string;
  renewUrl: string;
  releaseUrl: string;
}

const leaseRenewalIntervalMs = 30_000;

interface EditorConfig {
  apiScriptUrl?: string;
  apiUrl?: string;
  bridge?: {
    capabilities?: Partial<Record<EditorAction, string>>;
    id?: string;
    lease?: EditorLease;
    pluginOrigin?: string;
  };
  config?: Record<string, unknown>;
  editorUrl?: string;
  [key: string]: unknown;
}

interface BridgeReadyMessage {
  bridgeId: string;
  source: "form-bridge";
  type: "bridge-ready";
}

interface CapabilityRequestMessage {
  action: EditorAction;
  bridgeId: string;
  requestId: string;
  source: "form-bridge";
  type: "capability-request";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isEditorAction = (value: unknown): value is EditorAction =>
  value === "save-template" ||
  value === "publish" ||
  value === "save-draft" ||
  value === "submit";

const isOperationStatus = (value: unknown): value is EditorOperationStatus =>
  value === "pending" || value === "completed" || value === "failed";

const isBridgeReadyMessage = (
  value: unknown,
  bridgeId: string
): value is BridgeReadyMessage =>
  isRecord(value) &&
  value.bridgeId === bridgeId &&
  value.source === "form-bridge" &&
  value.type === "bridge-ready";

const parseCapabilityRequest = (
  value: unknown,
  bridgeId: string
): CapabilityRequestMessage | null => {
  if (
    !isRecord(value) ||
    value.bridgeId !== bridgeId ||
    value.source !== "form-bridge" ||
    value.type !== "capability-request" ||
    typeof value.action !== "string" ||
    !isEditorAction(value.action) ||
    typeof value.requestId !== "string" ||
    !value.requestId
  ) {
    return null;
  }

  return value as unknown as CapabilityRequestMessage;
};

const parseOperationMessage = (
  value: unknown,
  bridgeId: string
): EditorBridgeMessage | null => {
  if (
    !isRecord(value) ||
    value.bridgeId !== bridgeId ||
    value.source !== "form-bridge" ||
    value.type !== "operation" ||
    typeof value.action !== "string" ||
    !isEditorAction(value.action) ||
    !isOperationStatus(value.status) ||
    (value.operationId !== undefined && !isNonEmptyString(value.operationId)) ||
    (value.status !== "failed" && !isNonEmptyString(value.operationId)) ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    return null;
  }

  if (value.operation !== undefined) {
    if (!isRecord(value.operation)) {
      return null;
    }
    if (value.operation.result !== undefined) {
      if (!isRecord(value.operation.result)) {
        return null;
      }
      if (
        value.operation.result.submissionId !== undefined &&
        typeof value.operation.result.submissionId !== "string"
      ) {
        return null;
      }
    }
  }

  return value as unknown as EditorBridgeMessage;
};

export interface EditorBridgeMessage {
  action: EditorAction;
  bridgeId: string;
  error?: string;
  operation?: {
    result?: {
      submissionId?: string;
    };
  };
  operationId?: string;
  source: "form-bridge";
  status: EditorOperationStatus;
  type: "operation";
}

const acknowledgeBridge = (
  source: MessageEventSource,
  pluginOrigin: string,
  bridgeId: string
) => {
  try {
    (source as Window).postMessage(
      {
        bridgeId,
        source: "folio-parent",
        type: "bridge-ack",
      },
      pluginOrigin
    );
  } catch {
    // The plugin may close its frame while the handshake is in flight.
  }
};

interface DocsApi {
  DocEditor: new (
    elementId: string,
    config: Record<string, unknown>
  ) => { destroyEditor?: () => void };
}

declare global {
  interface Window {
    DocsAPI?: DocsApi;
  }
}

export const OnlyOfficeEditor = ({
  configUrl,
  onBridgeMessage,
  title,
}: {
  configUrl?: string;
  onBridgeMessage?: (message: EditorBridgeMessage) => void | Promise<void>;
  title: string;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ destroyEditor?: () => void } | null>(null);
  const onBridgeMessageRef = useRef(onBridgeMessage);
  const pinnedSourceRef = useRef<MessageEventSource | null>(null);
  const terminalOperationIdsRef = useRef(new Set<string>());
  const editorId = useId().replaceAll(":", "");
  const leaseRef = useRef<EditorLease | null>(null);
  const [config, setConfig] = useState<EditorConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lease = configUrl ? config?.bridge?.lease : undefined;
    if (!lease) {
      leaseRef.current = null;
      return;
    }

    let cancelled = false;
    leaseRef.current = lease;

    const renewLease = async () => {
      const currentLease = leaseRef.current;
      if (cancelled || !currentLease) {
        return;
      }

      try {
        const response = await apiPost<{
          lease: Pick<EditorLease, "expiresAt" | "id">;
        }>(currentLease.renewUrl);
        const activeLease = leaseRef.current;
        if (
          !cancelled &&
          activeLease?.id === currentLease.id &&
          response.lease.id === currentLease.id
        ) {
          leaseRef.current = {
            ...activeLease,
            expiresAt: response.lease.expiresAt,
          };
        }
      } catch {
        // A transient heartbeat failure must not tear down unsaved editor state.
      }
    };

    const renewalTimer = window.setInterval(() => {
      void renewLease();
    }, leaseRenewalIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(renewalTimer);
      if (leaseRef.current?.id === lease.id) {
        leaseRef.current = null;
      }
    };
  }, [config, configUrl]);

  useEffect(() => {
    onBridgeMessageRef.current = onBridgeMessage;
  }, [onBridgeMessage]);

  useEffect(() => {
    if (!configUrl) {
      return;
    }

    let cancelled = false;
    const path = configUrl.startsWith("http")
      ? configUrl.replace(API_ORIGIN, "")
      : configUrl;

    const loadConfig = async () => {
      setConfig(null);
      setError(null);

      try {
        const nextConfig = await apiGet<EditorConfig>(path);
        if (!cancelled) {
          setConfig(nextConfig);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not prepare the document editor."
          );
        }
      }
    };

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [configUrl]);

  useEffect(() => {
    if (!config) {
      return;
    }

    const bridgeId = config.bridge?.id;
    const pluginOrigin = config.bridge?.pluginOrigin;
    if (
      typeof bridgeId !== "string" ||
      !bridgeId ||
      typeof pluginOrigin !== "string" ||
      !pluginOrigin
    ) {
      if (!config.editorUrl) {
        setError("The document editor bridge configuration is invalid.");
      }
      return;
    }
    let cancelled = false;

    const scriptUrl =
      config.apiScriptUrl ??
      `${config.apiUrl ?? "http://localhost:8080"}/web-apps/apps/api/documents/api.js`;
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${scriptUrl}"]`
    );
    pinnedSourceRef.current = null;
    terminalOperationIdsRef.current.clear();
    const respondToCapabilityRequest = (
      request: CapabilityRequestMessage,
      response: { capability: string } | { error: string }
    ) => {
      if (cancelled) {
        return;
      }
      const pinnedSource = pinnedSourceRef.current;
      if (!pinnedSource) {
        return;
      }
      try {
        (pinnedSource as Window).postMessage(
          {
            action: request.action,
            bridgeId,
            requestId: request.requestId,
            source: "folio-parent",
            type: "capability-response",
            ...response,
          },
          pluginOrigin
        );
      } catch {
        // The plugin may close its frame while renewal is in flight.
      }
    };

    const renewCapability = async (request: CapabilityRequestMessage) => {
      if (!configUrl) {
        respondToCapabilityRequest(request, {
          error: "Editor capability unavailable.",
        });
        return;
      }

      const requestedLeaseId = leaseRef.current?.id;
      try {
        const path = configUrl.startsWith("http")
          ? configUrl.replace(API_ORIGIN, "")
          : configUrl;
        const fresh = await apiGet<EditorConfig>(path);
        if (cancelled) {
          return;
        }
        const freshLease = fresh.bridge?.lease;
        if (
          freshLease &&
          requestedLeaseId &&
          leaseRef.current?.id === requestedLeaseId
        ) {
          leaseRef.current = freshLease;
        }

        const capability = fresh.bridge?.capabilities?.[request.action];
        if (typeof capability !== "string" || !capability) {
          respondToCapabilityRequest(request, {
            error: "Editor capability unavailable.",
          });
          return;
        }
        respondToCapabilityRequest(request, { capability });
      } catch {
        if (!cancelled) {
          respondToCapabilityRequest(request, {
            error: "Editor capability unavailable.",
          });
        }
      }
    };

    const handleBridgeMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== pluginOrigin) {
        return;
      }

      const { data } = event;
      if (isBridgeReadyMessage(data, bridgeId)) {
        if (!event.source) {
          return;
        }
        if (
          pinnedSourceRef.current &&
          pinnedSourceRef.current !== event.source
        ) {
          return;
        }
        pinnedSourceRef.current = event.source;
        acknowledgeBridge(event.source, pluginOrigin, bridgeId);
        return;
      }

      const pinnedSource = pinnedSourceRef.current;
      if (!pinnedSource || event.source !== pinnedSource) {
        return;
      }

      const capabilityRequest = parseCapabilityRequest(data, bridgeId);
      if (capabilityRequest) {
        void renewCapability(capabilityRequest);
        return;
      }

      const message = parseOperationMessage(data, bridgeId);
      if (!message) {
        return;
      }
      const isTerminal =
        message.status === "completed" || message.status === "failed";
      if (
        isTerminal &&
        message.operationId &&
        terminalOperationIdsRef.current.has(message.operationId)
      ) {
        return;
      }
      if (isTerminal && message.operationId) {
        terminalOperationIdsRef.current.add(message.operationId);
      }
      onBridgeMessageRef.current?.(message);
    };

    window.addEventListener("message", handleBridgeMessage);

    if (config.editorUrl || !hostRef.current) {
      return () => {
        cancelled = true;
        window.removeEventListener("message", handleBridgeMessage);
        pinnedSourceRef.current = null;
      };
    }

    if (!isRecord(config.config)) {
      setError("The document editor configuration is invalid.");
      return () => {
        cancelled = true;
        window.removeEventListener("message", handleBridgeMessage);
        pinnedSourceRef.current = null;
      };
    }

    const editorConfig = config.config;
    const mount = () => {
      if (cancelled) {
        return;
      }
      if (!window.DocsAPI || !hostRef.current) {
        setError(
          "The document editor is unavailable. Check that ONLYOFFICE is running."
        );
        return;
      }

      editorRef.current = new window.DocsAPI.DocEditor(editorId, editorConfig);
    };
    const handleScriptError = () => {
      if (!cancelled) {
        setError("Could not load ONLYOFFICE. Check the local service.");
      }
    };

    if (window.DocsAPI) {
      mount();
    } else if (existing) {
      existing.addEventListener("load", mount, { once: true });
      existing.addEventListener("error", handleScriptError, { once: true });
    } else {
      const script = document.createElement("script");
      script.src = scriptUrl;
      script.addEventListener("load", mount, { once: true });
      script.addEventListener("error", handleScriptError, { once: true });
      document.head.append(script);
    }

    return () => {
      cancelled = true;
      window.removeEventListener("message", handleBridgeMessage);
      pinnedSourceRef.current = null;
      editorRef.current?.destroyEditor?.();
      editorRef.current = null;
    };
  }, [config, configUrl, editorId]);

  if (error) {
    return (
      <div className="grid min-h-[520px] place-items-center p-8">
        <Notice tone="danger">{error}</Notice>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="grid min-h-[520px] place-items-center gap-3 p-8 text-center">
        <Spinner />
        <p className="text-sm text-[var(--ink-soft)]">
          Preparing your document editor…
        </p>
      </div>
    );
  }

  if (config.editorUrl) {
    return (
      <iframe
        title={title}
        src={config.editorUrl}
        className="h-[min(72vh,760px)] min-h-[520px] w-full border-0"
      />
    );
  }

  return (
    <div className="h-[min(72vh,760px)] min-h-[520px] w-full">
      <div
        ref={hostRef}
        id={editorId}
        className="h-full w-full"
        aria-label={title}
      />
    </div>
  );
};
