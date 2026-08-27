import { useEffect, useId, useRef, useState } from "react";

import { Notice, Spinner } from "@/components/ui";
import { API_ORIGIN, apiGet } from "@/lib/api";

interface EditorConfig {
  editorUrl?: string;
  apiScriptUrl?: string;
  apiUrl?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

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
  title,
}: {
  configUrl?: string;
  title: string;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ destroyEditor?: () => void } | null>(null);
  const editorId = useId().replaceAll(":", "");
  const [config, setConfig] = useState<EditorConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (!config || !hostRef.current || config.editorUrl) {
      return;
    }

    let cancelled = false;
    const editorConfig = (config.config ?? config) as Record<string, unknown>;
    const scriptUrl =
      config.apiScriptUrl ??
      `${config.apiUrl ?? "http://localhost:8080"}/web-apps/apps/api/documents/api.js`;
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${scriptUrl}"]`
    );

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

    if (window.DocsAPI) {
      mount();
    } else if (existing) {
      existing.addEventListener("load", mount, { once: true });
      existing.addEventListener(
        "error",
        () => setError("Could not load ONLYOFFICE. Check the local service."),
        { once: true }
      );
    } else {
      const script = document.createElement("script");
      script.src = scriptUrl;
      script.addEventListener("load", mount, { once: true });
      script.addEventListener(
        "error",
        () => setError("Could not load ONLYOFFICE. Check the local service."),
        { once: true }
      );
      document.head.append(script);
    }

    return () => {
      cancelled = true;
      editorRef.current?.destroyEditor?.();
      editorRef.current = null;
    };
  }, [config, editorId]);

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
