// oxlint-disable prefer-await-to-callbacks
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const pluginSource = await readFile(
  new URL("plugin.js", import.meta.url),
  "utf-8"
);

const createHarness = ({
  action = "fill",
  capabilityResponses = [],
  responses = [],
} = {}) => {
  const parentOrigin = "https://web.example.test";
  const bridgeId = "bridge-test-1";
  const messages = [];
  const messageListeners = [];
  const requests = [];
  const timers = [];
  const statusElement = { dataset: {}, textContent: "" };
  const queuedCapabilityResponses = [...capabilityResponses];
  const queuedResponses = [...responses];
  const dispatch = (event) => {
    for (const listener of messageListeners) {
      listener(event);
    }
  };
  const parentWindow = {
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });

      if (message.type !== "capability-request") {
        return;
      }

      const response = queuedCapabilityResponses.shift();
      if (response === undefined) {
        return;
      }

      queueMicrotask(() => {
        dispatch({
          data: {
            ...message,
            ...(typeof response === "string"
              ? { capability: response }
              : response),
            source: "folio-parent",
            type: "capability-response",
          },
          origin: parentOrigin,
          source: parentWindow,
        });
      });
    },
  };

  const plugin = {
    attachToolbarMenuClickEvent() {},
    callCommand(...args) {
      const done = args.at(-1);
      if (typeof done === "function") {
        done(JSON.stringify({ name: "Ada", value: "example" }));
      }
    },
    executeMethod(...args) {
      const done = args.at(-1);
      if (typeof done === "function") {
        done();
      }
    },
    info: {
      guid: "asc.test-plugin",
      options: {
        action,
        apiBase: "https://api.example.test/",
        bridgeId,
        documentKey: "document-key",
        formId: "form-id",
        parentOrigin,
        publicId: "public-id",
        responseId: "response-id",
      },
    },
  };

  const fetch = (input, init = {}) => {
    const payload = queuedResponses.shift();
    if (payload === undefined) {
      throw new Error("Unexpected plugin request");
    }
    requests.push({
      body: init.body,
      credentials: init.credentials,
      headers: init.headers,
      method: init.method ?? "GET",
      url: String(input),
    });
    return Response.json(payload);
  };

  const window = {
    Asc: { plugin },
    addEventListener(type, listener) {
      if (type === "message") {
        messageListeners.push(listener);
      }
    },
    clearTimeout(timer) {
      if (timer) {
        timer.cancelled = true;
      }
    },
    setTimeout(callback, milliseconds) {
      const timer = { callback, cancelled: false, milliseconds };
      timers.push(timer);
      if (milliseconds === 1000) {
        queueMicrotask(() => {
          if (!timer.cancelled) {
            return callback();
          }
        });
      }
      return timer;
    },
    top: parentWindow,
  };
  const document = {
    body: { append() {} },
    createElement() {
      return { dataset: {}, setAttribute() {}, textContent: "" };
    },
    querySelector() {
      return statusElement;
    },
  };
  const context = {
    Headers,
    Response,
    document,
    fetch,
    queueMicrotask,
    window,
  };

  runInNewContext(pluginSource, context, {
    filename: "apps/onlyoffice-plugin/plugin.js",
  });
  window.Asc.plugin.init();

  return {
    bridgeId,
    dispatch,
    expireCapabilityRequests() {
      for (const timer of timers) {
        if (timer.milliseconds !== 5000 || timer.cancelled) {
          continue;
        }
        timer.cancelled = true;
        timer.callback();
      }
    },
    messages,
    parentOrigin,
    parentWindow,
    requests,
    window,
  };
};

const completedOperation = (result = {}) => ({
  operation: { result, status: "completed" },
});
const acknowledgeBridge = (harness) => {
  harness.dispatch({
    data: {
      bridgeId: harness.bridgeId,
      source: "folio-parent",
      type: "bridge-ack",
    },
    origin: harness.parentOrigin,
    source: harness.parentWindow,
  });
};

test("uses fresh capabilities and an exact acknowledged bridge", async () => {
  const harness = createHarness({
    capabilityResponses: [
      "fresh-save-draft-capability",
      "fresh-submit-capability",
    ],
    responses: [
      {
        operationCapability: "save-operation-capability",
        operationId: "save-operation",
      },
      { operation: { status: "processing" } },
      completedOperation({ saved: true }),
      {
        operationCapability: "submit-operation-capability",
        operationId: "submit-operation",
      },
      { operation: { status: "processing" } },
      completedOperation({ submissionId: "submission-1" }),
    ],
  });

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0]).toEqual({
    message: {
      bridgeId: harness.bridgeId,
      source: "form-bridge",
      type: "bridge-ready",
    },
    targetOrigin: harness.parentOrigin,
  });

  acknowledgeBridge(harness);

  const firstAction = harness.window.FormBridge.runAction("save-draft");
  await expect(harness.window.FormBridge.runAction("submit")).resolves.toEqual({
    ignored: true,
    ok: false,
  });
  await expect(firstAction).resolves.toMatchObject({ ok: true });
  await expect(
    harness.window.FormBridge.runAction("submit")
  ).resolves.toMatchObject({ ok: true });

  const capabilityRequests = harness.messages.filter(
    ({ message }) => message.type === "capability-request"
  );
  expect(capabilityRequests).toEqual([
    {
      message: {
        action: "save-draft",
        bridgeId: harness.bridgeId,
        requestId: "capability-1",
        source: "form-bridge",
        type: "capability-request",
      },
      targetOrigin: harness.parentOrigin,
    },
    {
      message: {
        action: "submit",
        bridgeId: harness.bridgeId,
        requestId: "capability-2",
        source: "form-bridge",
        type: "capability-request",
      },
      targetOrigin: harness.parentOrigin,
    },
  ]);

  expect(
    harness.requests.map(({ headers, method, url }) => [
      method,
      url,
      headers.get("x-editor-capability"),
      headers.has("authorization"),
    ])
  ).toEqual([
    [
      "POST",
      "https://api.example.test/api/forms/public-id/draft",
      "fresh-save-draft-capability",
      false,
    ],
    [
      "GET",
      "https://api.example.test/api/operations/save-operation",
      "save-operation-capability",
      false,
    ],
    [
      "GET",
      "https://api.example.test/api/operations/save-operation",
      "save-operation-capability",
      false,
    ],
    [
      "POST",
      "https://api.example.test/api/forms/public-id/submit",
      "fresh-submit-capability",
      false,
    ],
    [
      "GET",
      "https://api.example.test/api/operations/submit-operation",
      "submit-operation-capability",
      false,
    ],
    [
      "GET",
      "https://api.example.test/api/operations/submit-operation",
      "submit-operation-capability",
      false,
    ],
  ]);
  expect(
    harness.requests.every(({ credentials }) => credentials === "omit")
  ).toBe(true);

  const operationMessages = harness.messages.filter(
    ({ message }) => message.type === "operation"
  );
  expect(operationMessages).toHaveLength(4);
  expect(
    operationMessages.map(({ message, targetOrigin }) => [
      message.action,
      message.status,
      message.bridgeId,
      targetOrigin,
    ])
  ).toEqual([
    ["save-draft", "pending", harness.bridgeId, harness.parentOrigin],
    ["save-draft", "completed", harness.bridgeId, harness.parentOrigin],
    ["submit", "pending", harness.bridgeId, harness.parentOrigin],
    ["submit", "completed", harness.bridgeId, harness.parentOrigin],
  ]);
});

test("rejects parent acknowledgements with the wrong source, origin, or bridge id", async () => {
  const invalidEvents = [
    (harness) => ({
      data: {
        bridgeId: harness.bridgeId,
        source: "folio-parent",
        type: "bridge-ack",
      },
      origin: harness.parentOrigin,
      source: {},
    }),
    (harness) => ({
      data: {
        bridgeId: harness.bridgeId,
        source: "folio-parent",
        type: "bridge-ack",
      },
      origin: "https://wrong.example.test",
      source: harness.parentWindow,
    }),
    (harness) => ({
      data: {
        bridgeId: "wrong-bridge",
        source: "folio-parent",
        type: "bridge-ack",
      },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    }),
  ];

  await Promise.all(
    invalidEvents.map(async (createEvent) => {
      const harness = createHarness({
        action: "template-edit",
      });
      harness.dispatch(createEvent(harness));
      await expect(
        harness.window.FormBridge.runAction("save-template")
      ).resolves.toMatchObject({ ok: false });
      expect(harness.requests).toHaveLength(0);
      expect(
        harness.messages.filter(({ message }) => message.type === "operation")
      ).toHaveLength(0);
    })
  );
});

test("fails safely when capability renewal times out or returns an error", async () => {
  const timeoutHarness = createHarness({ action: "template-edit" });
  acknowledgeBridge(timeoutHarness);
  const timedOutAction =
    timeoutHarness.window.FormBridge.runAction("save-template");

  expect(timeoutHarness.requests).toHaveLength(0);
  timeoutHarness.expireCapabilityRequests();
  await expect(timedOutAction).resolves.toMatchObject({
    error: "Timed out waiting for save-template capability",
    ok: false,
  });

  const errorHarness = createHarness({
    action: "template-edit",
    capabilityResponses: [{ error: "capability denied" }],
  });
  acknowledgeBridge(errorHarness);

  await expect(
    errorHarness.window.FormBridge.runAction("save-template")
  ).resolves.toMatchObject({
    error: "capability denied",
    ok: false,
  });
  expect(errorHarness.requests).toHaveLength(0);
});

test("ignores forged or malformed capability responses", async () => {
  const harness = createHarness({
    action: "template-edit",
    responses: [{ ok: true }],
  });
  acknowledgeBridge(harness);

  const action = harness.window.FormBridge.runAction("save-template");
  const request = harness.messages.find(
    ({ message }) => message.type === "capability-request"
  );
  const validResponse = {
    ...request.message,
    capability: "forged-capability",
    source: "folio-parent",
    type: "capability-response",
  };
  const invalidEvents = [
    {
      data: validResponse,
      origin: harness.parentOrigin,
      source: {},
    },
    {
      data: validResponse,
      origin: "https://wrong.example.test",
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, bridgeId: "wrong-bridge" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, requestId: "unknown-request" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, action: "submit" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, action: "unknown-action" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, source: "attacker" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, type: "unknown-response" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, capability: "" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, capability: {} },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: {
        ...harness.messages.find(
          ({ message }) => message.type === "capability-request"
        ).message,
        source: "folio-parent",
        type: "capability-response",
      },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
    {
      data: { ...validResponse, capability: "forged", error: "also forged" },
      origin: harness.parentOrigin,
      source: harness.parentWindow,
    },
  ];

  let settled = false;
  void action.then(() => {
    settled = true;
  });
  for (const event of invalidEvents) {
    harness.dispatch(event);
  }
  await Promise.resolve();

  expect(settled).toBe(false);
  expect(harness.requests).toHaveLength(0);
  harness.expireCapabilityRequests();
  await expect(action).resolves.toMatchObject({ ok: false });
});
