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
  clipboard,
  responses = [],
  selection,
} = {}) => {
  const parentOrigin = "https://web.example.test";
  const bridgeId = "bridge-test-1";
  const messages = [];
  const messageListeners = [];
  const editorEvents = new Map();
  const elements = new Map();
  const requests = [];
  const timers = [];
  const queuedCapabilityResponses = [...capabilityResponses];
  const queuedResponses = [...responses];
  const selectionState = {
    currentControl: selection?.currentControl,
    properties: selection?.properties,
  };

  const createElement = (tagName = "div", id = "") => {
    const listeners = new Map();
    const element = {
      checked: false,
      children: [],
      dataset: {},
      disabled: false,
      hidden: false,
      id,
      style: {},
      tagName: tagName.toUpperCase(),
      textContent: "",
      value: "",
      addEventListener(type, listener) {
        const callbacks = listeners.get(type) || [];
        callbacks.push(listener);
        listeners.set(type, callbacks);
      },
      append(...children) {
        for (const child of children) {
          this.appendChild(child);
        }
      },
      appendChild(child) {
        if (!child) {
          return child;
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      dispatchEvent(event = {}) {
        const callbacks = listeners.get(event.type) || [];
        const dispatched = {
          ...event,
          currentTarget: this,
          target: event.target || this,
          preventDefault: event.preventDefault || (() => {}),
        };
        for (const callback of callbacks) {
          callback(dispatched);
        }
        return true;
      },
      remove() {
        if (!this.parentNode) {
          return;
        }
        this.parentNode.removeChild(this);
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) {
          this.children.splice(index, 1);
          child.parentNode = undefined;
        }
        return child;
      },
      replaceChildren(...children) {
        this.children = [];
        this.append(...children);
      },
      select() {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
    };
    if (id) {
      elements.set(id, element);
    }
    return element;
  };

  const panelIds = [
    "field-apply-pointer",
    "field-panel",
    "field-policy-form",
    "field-prefill-policy",
    "field-required",
    "field-save",
    "field-schema-list",
    "field-schema-next",
    "field-schema-query",
    "field-schema-search",
    "field-selection-tag",
    "field-selection-type",
    "field-panel-status",
    "form-bridge-status",
  ];
  for (const id of panelIds) {
    createElement("div", id);
  }
  elements.get("field-panel").hidden = true;
  const statusElement = elements.get("form-bridge-status");

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
    attachEditorEvent(name, callback) {
      const callbacks = editorEvents.get(name) || [];
      callbacks.push(callback);
      editorEvents.set(name, callbacks);
    },
    attachToolbarMenuClickEvent() {},
    callCommand(...args) {
      const command = args[0];
      const done = args.at(-1);
      if (typeof done !== "function") {
        return;
      }
      if (
        command?.name === "getCurrentContentControlCommand" &&
        selectionState.properties
      ) {
        done(command());
        return;
      }
      if (
        command?.name === "setCurrentContentControlTagCommand" &&
        selectionState.properties
      ) {
        const tag = window.Asc.scope?.formBridgeSelectionTag;
        selectionState.properties.Tag = tag;
        done(JSON.stringify({ ok: true, tag }));
        return;
      }
      done(JSON.stringify({ name: "Ada", value: "example" }));
    },
    executeMethod(method, ...args) {
      const done = args.at(-1);
      if (typeof done !== "function") {
        return;
      }
      if (selection !== undefined) {
        if (method === "GetCurrentContentControl") {
          done(selectionState.currentControl);
          return;
        }
        if (method === "GetCurrentContentControlPr") {
          done(selectionState.properties);
          return;
        }
      }
      done();
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
        targetId: "target-id",
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
    if (payload instanceof Response) {
      return payload;
    }
    if (
      payload &&
      typeof payload === "object" &&
      payload.httpStatus !== undefined
    ) {
      return new Response(JSON.stringify(payload.body ?? {}), {
        status: payload.httpStatus,
      });
    }
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
    body: createElement("body"),
    createElement,
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      if (selector.startsWith("#")) {
        return elements.get(selector.slice(1)) || null;
      }
      return statusElement;
    },
  };
  const officeControl = {
    GetClassType() {
      return "inlineLvlSdt";
    },
    GetFormType() {
      return selection?.formType || "";
    },
    GetInternalId() {
      return selectionState.currentControl;
    },
    GetTag() {
      return selectionState.properties?.Tag || "";
    },
  };
  const Api = {
    GetDocument() {
      return {
        GetAllContentControls() {
          return [];
        },
        GetCurrentContentControl() {
          return selection ? officeControl : null;
        },
        GetCurrentContentControlPr() {
          return selectionState.properties || {};
        },
      };
    },
  };
  const context = {
    Api,
    Headers,
    Response,
    document,
    fetch,
    navigator: clipboard ? { clipboard } : undefined,
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
    editorEvents,
    emitEditorEvent(name, value) {
      for (const callback of editorEvents.get(name) || []) {
        callback(value);
      }
    },
    element(id) {
      return elements.get(id);
    },
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
    setSelection(nextSelection) {
      selectionState.currentControl = nextSelection?.currentControl;
      selectionState.properties = nextSelection?.properties;
    },
    statusElement,
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
const flushPlugin = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Promise.resolve();
  }
};

const selectedControl = (
  tag = "title",
  controlType = "text",
  internalId = "control-1"
) => ({
  currentControl: internalId,
  properties: {
    InternalId: internalId,
    Tag: tag,
    Type: controlType,
  },
});

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

test("uses the public Form identifier for Admin template actions", async () => {
  const harness = createHarness({
    action: "template-edit",
    capabilityResponses: ["action-capability"],
    responses: [{ ok: true }],
  });
  acknowledgeBridge(harness);

  await expect(
    harness.window.FormBridge.runAction("save-template")
  ).resolves.toMatchObject({ ok: true });
  expect(harness.requests[0]?.url).toBe(
    "https://api.example.test/api/admin/forms/public-id/save"
  );
  expect(harness.requests[0]?.url).not.toContain("form-id");
});

test("configures the selected field with exact schema pointers and policy", async () => {
  let copiedPointer = null;
  const pointer = "/account/address/city";
  const harness = createHarness({
    action: "template-edit",
    capabilityResponses: [
      "field-capability-1",
      "field-capability-2",
      "field-capability-3",
      "field-capability-4",
    ],
    clipboard: {
      writeText(value) {
        copiedPointer = value;
        return Promise.resolve();
      },
    },
    responses: [
      { rules: [] },
      {
        items: [{ pointer, type: "string" }],
        nextCursor: "schema-cursor-1",
      },
      {
        items: [{ pointer: "/account/address/country", type: "string" }],
        nextCursor: null,
      },
      {
        rule: {
          prefillPointer: pointer,
          prefillPolicy: "lock-when-available",
          required: true,
          tag: pointer,
        },
      },
    ],
    selection: selectedControl("title", "text", "control-1"),
  });
  acknowledgeBridge(harness);
  await flushPlugin();

  expect(harness.element("field-panel").hidden).toBe(false);
  expect(harness.element("field-selection-tag").textContent).toBe("title");
  expect(harness.requests[0]).toMatchObject({
    credentials: "omit",
    method: "GET",
    url: "https://api.example.test/api/admin/forms/public-id/field-rules",
  });

  const query = harness.element("field-schema-query");
  query.value = "address";
  query.dispatchEvent({ target: query, type: "input" });
  harness.element("field-schema-search").dispatchEvent({ type: "click" });
  await flushPlugin();

  expect(harness.requests[1]).toMatchObject({
    credentials: "omit",
    method: "GET",
    url: "https://api.example.test/api/admin/forms/public-id/schema?q=address",
  });
  expect(harness.requests[1].headers.get("x-editor-capability")).toBe(
    "field-capability-2"
  );
  const list = harness.element("field-schema-list");
  expect(list.children).toHaveLength(1);
  const firstRow = list.children[0];
  const firstActions = firstRow.children[2];
  firstActions.children[0].dispatchEvent({ type: "click" });
  await flushPlugin();
  expect(copiedPointer).toBe(pointer);

  firstRow.children[0].dispatchEvent({ type: "click" });
  harness.element("field-schema-next").dispatchEvent({ type: "click" });
  await flushPlugin();
  expect(harness.requests[2]).toMatchObject({
    credentials: "omit",
    method: "GET",
    url: "https://api.example.test/api/admin/forms/public-id/schema?q=address&cursor=schema-cursor-1",
  });
  expect(list.children).toHaveLength(2);

  harness.element("field-apply-pointer").dispatchEvent({ type: "click" });
  await flushPlugin();
  const required = harness.element("field-required");
  required.checked = true;
  required.dispatchEvent({ target: required, type: "change" });
  const policy = harness.element("field-prefill-policy");
  policy.value = "lock-when-available";
  policy.dispatchEvent({ target: policy, type: "change" });
  harness.element("field-policy-form").dispatchEvent({ type: "submit" });
  await flushPlugin();

  expect(harness.requests[3]).toMatchObject({
    credentials: "omit",
    method: "PATCH",
    url: "https://api.example.test/api/admin/forms/public-id/field-rules",
  });
  expect(JSON.parse(harness.requests[3].body)).toEqual({
    documentKey: "document-key",
    previousTag: null,
    prefillPointer: pointer,
    prefillPolicy: "lock-when-available",
    required: true,
    tag: pointer,
  });
});

test("loads persisted field rules into the selected panel", async () => {
  const harness = createHarness({
    action: "template-edit",
    capabilityResponses: ["field-capability"],
    responses: [
      {
        rules: [
          {
            prefillPointer: "/account/address/city",
            prefillPolicy: "lock-when-available",
            required: true,
            tag: "title",
          },
        ],
      },
    ],
    selection: selectedControl("title", "text", "control-1"),
  });
  acknowledgeBridge(harness);
  await flushPlugin();

  expect(harness.element("field-required").checked).toBe(true);
  expect(harness.element("field-prefill-policy").value).toBe(
    "lock-when-available"
  );
  expect(harness.window.FormBridge.getPanelState()).toMatchObject({
    currentPointer: "/account/address/city",
    selection: { tag: "title" },
  });
});

test("emits a safe no-selection payload and keeps the panel mode-scoped", async () => {
  const templateHarness = createHarness({ action: "template-edit" });
  acknowledgeBridge(templateHarness);
  await flushPlugin();
  expect(templateHarness.element("field-panel").hidden).toBe(false);
  expect(
    templateHarness.messages.find(
      ({ message }) => message.type === "field-selection"
    )?.message
  ).toMatchObject({
    controlType: "unsupported",
    selected: false,
    tag: null,
    type: "field-selection",
  });

  const fillHarness = createHarness({ action: "fill" });
  expect(fillHarness.element("field-panel").hidden).toBe(true);
});

test("reports field-rule API failures without exposing a value payload", async () => {
  const harness = createHarness({
    action: "template-edit",
    capabilityResponses: ["field-capability"],
    responses: [{ body: { error: "unavailable" }, httpStatus: 503 }],
    selection: selectedControl("title", "text", "control-1"),
  });
  acknowledgeBridge(harness);
  await flushPlugin();

  expect(harness.element("field-panel-status").textContent).toBe(
    "ไม่สามารถโหลดนโยบายฟิลด์ได้"
  );
  expect(harness.requests[0]?.body).toBeUndefined();
  expect(
    harness.messages
      .filter(({ message }) => message.type === "field-selection")
      .every(({ message }) => !Object.hasOwn(message, "value"))
  ).toBe(true);
});

test("retries persisted field rules when bridge acknowledgement is delayed", async () => {
  const harness = createHarness({
    action: "template-edit",
    capabilityResponses: ["field-capability"],
    responses: [{ rules: [] }],
    selection: selectedControl("title", "text", "control-1"),
  });
  await flushPlugin();
  expect(harness.requests).toHaveLength(0);

  acknowledgeBridge(harness);
  await flushPlugin();
  expect(harness.requests).toHaveLength(1);
  expect(harness.requests[0]?.url).toContain("/field-rules");
});
test("maps real ONLYOFFICE form-type snapshots to supported controls", async () => {
  const cases = [
    ["textForm", "text"],
    ["comboBoxForm", "combo"],
    ["dropDownForm", "dropdown"],
    ["checkBoxForm", "checkbox"],
    ["pictureForm", "picture"],
    ["dateForm", "date"],
    ["radioForm", "unsupported"],
  ];

  for (const [formType, expectedType] of cases) {
    const harness = createHarness({
      action: "template-edit",
      capabilityResponses: ["field-capability"],
      responses: [{ rules: [] }],
      selection: {
        currentControl: "control-1",
        formType,
        properties: {
          Id: "control-1",
          InternalId: "control-1",
          Tag: "title",
        },
      },
    });
    acknowledgeBridge(harness);
    await flushPlugin();

    const selectionMessage = harness.messages
      .filter(({ message }) => message.type === "field-selection")
      .at(-1)?.message;
    expect(selectionMessage).toMatchObject({
      controlType: expectedType,
      selected: true,
      tag: "title",
      type: "field-selection",
    });
  }
});
