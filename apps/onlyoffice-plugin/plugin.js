// oxlint-disable func-style sort-keys no-implicit-globals no-unused-vars consistent-function-scoping complexity prefer-named-capture-group require-unicode-regexp avoid-new prefer-await-to-callbacks no-empty-function no-useless-return logical-assignment-operators no-useless-spread no-await-in-loop prefer-await-to-then
const ACTIONS = Object.freeze({
  DRAFT: "draft",
  FILL: "fill",
  PUBLISH: "publish",
  SAVE_DRAFT: "save-draft",
  SAVE_TEMPLATE: "save-template",
  SUBMIT: "submit",
  TEMPLATE_EDIT: "template-edit",
});
const BUTTON_IDS = Object.freeze({
  PUBLISH: "publish-form",
  SAVE_DRAFT: "save-draft",
  SAVE_TEMPLATE: "save-template",
  SUBMIT: "submit-form",
});

const API_ROUTES = Object.freeze({
  ADMIN_FORMS: "/api/admin/forms",
  FORMS: "/api/forms",
  OPERATIONS: "/api/operations",
});

const TOKEN_STORAGE_KEYS = [
  "onlyoffice.sessionToken",
  "onlyoffice.session-token",
  "onlyoffice-auth-token",
  "authToken",
  "auth-token",
  "accessToken",
  "access-token",
  "bearerToken",
  "bearer-token",
  "sessionToken",
  "session-token",
  "session_token",
  "better-auth.session_token",
  "better-auth.sessionToken",
];

const OPERATION_POLL_INTERVAL_MS = 1000;
const MAX_OPERATION_POLLS = 300;
const PREFILL_MAX_ATTEMPTS = 120;

let runtimeOptions = {};
let actionInFlight = false;
let initializationPending = false;
let initializationStarted = false;
let prefillApplied = false;
let prefillPromise;
let pluginInitialized = false;

/**
 * Runs inside ONLYOFFICE document context.
 *
 * IMPORTANT:
 * This function is passed into Asc.plugin.callCommand(), so it can access
 * Api.GetDocument() and Office API objects. Do not move dependencies into the
 * outer plugin scope: ONLYOFFICE serializes this function before execution.
 */
function extractFormDataCommand() {
  const doc = Api.GetDocument();
  const controls = doc.GetAllContentControls();
  const data = {};

  function getInlineTextInsideCommand(control) {
    return control
      .GetRange()
      .GetText({
        ParaSeparator: "\n",
        NewLineSeparator: "\n",
      })
      .trim();
  }

  function formatDateInsideCommand(date) {
    if (!date) {
      return null;
    }

    if (typeof date === "string") {
      return date.slice(0, 10);
    }

    try {
      if (typeof date.getFullYear === "function") {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");

        return `${year}-${month}-${day}`;
      }

      if (typeof date.toISOString === "function") {
        return date.toISOString().slice(0, 10);
      }
    } catch {
      return null;
    }

    return null;
  }

  for (const control of controls) {
    const tag = control.GetTag();

    if (!tag) {
      continue;
    }

    const classType = control.GetClassType();

    /**
     * Rich Text
     *
     * ONLYOFFICE represents this as blockLvlSdt.
     */
    if (classType === "blockLvlSdt") {
      data[tag] = control
        .GetContent()
        .GetText({
          ParaSeparator: "\n",
          NewLineSeparator: "\n",
        })
        .trim();

      continue;
    }

    /**
     * Everything below here is an inline content control.
     */
    if (classType !== "inlineLvlSdt") {
      continue;
    }

    /**
     * Checkbox
     *
     * Return a real boolean instead of "☒" / "☐".
     */
    if (control.IsCheckBox()) {
      data[tag] = Boolean(control.IsCheckBoxChecked());
      continue;
    }

    /**
     * Date picker
     *
     * Normalize to YYYY-MM-DD without changing the calendar date for local
     * Date objects returned by the Office API.
     */
    if (control.IsDatePicker()) {
      data[tag] = formatDateInsideCommand(control.GetDate());
      continue;
    }

    /**
     * Dropdown / Combo box
     *
     * Keep the option value, rather than the human-readable display text.
     */
    if (control.IsDropDownList() || control.IsComboBox()) {
      const displayText = getInlineTextInsideCommand(control);
      const list = control.GetDropdownList();
      const items = list.GetAllItems();

      // Fallback to visible text if no matching option exists.
      let value = displayText;

      for (const item of items) {
        if (item.GetText() === displayText) {
          value = item.GetValue();
          break;
        }
      }

      data[tag] = value;
      continue;
    }

    /**
     * Plain Text and other inline controls.
     */
    data[tag] = getInlineTextInsideCommand(control);
  }

  /**
   * callCommand() transports primitive/string data cleanly back to the
   * plugin iframe.
   */
  return JSON.stringify(data);
}

/**
 * Runs inside ONLYOFFICE document context and applies server-provided
 * prefill values. Asc.scope is the supported bridge for passing data into a
 * callCommand function.
 */
function applyPrefillCommand() {
  const scope =
    typeof Asc !== "undefined" && Asc.scope
      ? Asc.scope
      : { formBridgePrefill: null };
  const payload = scope.formBridgePrefill || {};
  const values = payload.values || {};
  const policies = payload.policies || {};
  const doc = Api.GetDocument();
  const controls = doc.GetAllContentControls();
  const applied = [];
  const skipped = [];
  const failed = [];
  const hasOwn = Object.prototype.hasOwnProperty;

  function setControlText(control, text) {
    const classType =
      typeof control.GetClassType === "function" ? control.GetClassType() : "";

    if (
      classType === "inlineLvlSdt" &&
      typeof control.RemoveAllElements === "function" &&
      typeof control.AddText === "function"
    ) {
      control.RemoveAllElements();
      control.AddText(text);
      return true;
    }

    if (
      classType === "blockLvlSdt" &&
      typeof control.GetContent === "function"
    ) {
      const content = control.GetContent();
      if (content && typeof content.SetText === "function") {
        content.SetText(text);
        return true;
      }
    }

    if (typeof control.SetText === "function") {
      control.SetText(text);
      return true;
    }

    if (
      classType === "inlineLvlSdt" &&
      typeof control.GetRange === "function"
    ) {
      const range = control.GetRange();
      if (range && typeof range.SetText === "function") {
        range.SetText(text);
        return true;
      }
    }

    return false;
  }

  function setControlValue(control, value) {
    const classType =
      typeof control.GetClassType === "function" ? control.GetClassType() : "";
    if (classType !== "inlineLvlSdt" && classType !== "blockLvlSdt") {
      return false;
    }
    if (classType === "inlineLvlSdt" && typeof control.SetLock === "function") {
      control.SetLock("unlocked");
    }
    if (typeof control.IsCheckBox === "function" && control.IsCheckBox()) {
      const checked =
        value === true ||
        value === 1 ||
        value === "1" ||
        (typeof value === "string" && value.toLowerCase() === "true");

      if (typeof control.SetCheckBoxChecked === "function") {
        control.SetCheckBoxChecked(checked);
        return true;
      }

      return setControlText(control, checked ? "☒" : "☐");
    }

    if (typeof control.IsDatePicker === "function" && control.IsDatePicker()) {
      if (value === null || value === "") {
        return setControlText(control, "");
      }

      const dateText = String(value);
      const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);

      if (dateParts && typeof control.SetDate === "function") {
        control.SetDate(
          new Date(
            Number(dateParts[1]),
            Number(dateParts[2]) - 1,
            Number(dateParts[3])
          )
        );
        return true;
      }

      return setControlText(control, dateText);
    }

    const isDropdown =
      typeof control.IsDropDownList === "function" && control.IsDropDownList();
    const isComboBox =
      typeof control.IsComboBox === "function" && control.IsComboBox();

    if (isDropdown || isComboBox) {
      const valueText = value === null ? "" : String(value);
      if (typeof control.GetDropdownList === "function") {
        const list = control.GetDropdownList();
        if (list && typeof list.GetAllItems === "function") {
          const items = list.GetAllItems();
          for (const item of items) {
            if (!item || String(item.GetValue()) !== valueText) {
              continue;
            }
            if (typeof item.Select === "function") {
              item.Select();
              return true;
            }
          }
        }
      }
      return false;
    }

    return setControlText(control, value === null ? "" : String(value));
  }

  function setControlPolicy(control, policy) {
    if (typeof control.SetLock !== "function" || policy === undefined) {
      return;
    }

    let policyName = "";

    if (typeof policy === "string") {
      policyName = policy.toLowerCase();
    } else if (policy === true) {
      policyName = "locked";
    } else if (policy && typeof policy === "object") {
      if (policy.locked === true || policy.editable === false) {
        policyName = "locked";
      } else if (policy.editable === true || policy.locked === false) {
        policyName = "editable";
      } else if (typeof policy.mode === "string") {
        policyName = policy.mode.toLowerCase();
      }
    }

    if (
      policyName === "locked" ||
      policyName === "readonly" ||
      policyName === "read-only" ||
      policyName === "contentlocked" ||
      policyName === "sdtcontentlocked"
    ) {
      control.SetLock("sdtContentLocked");
    } else if (
      policyName === "editable" ||
      policyName === "unlocked" ||
      policyName === "write"
    ) {
      control.SetLock("unlocked");
    }
  }

  for (const control of controls) {
    const tag = control.GetTag();

    if (!tag || !hasOwn.call(values, tag)) {
      if (tag) {
        skipped.push(tag);
      }

      continue;
    }

    try {
      if (!setControlValue(control, values[tag])) {
        throw new Error("The content control does not support text updates");
      }

      setControlPolicy(control, policies[tag]);
      applied.push(tag);
    } catch {
      failed.push(tag);
    }
  }

  return JSON.stringify({
    applied,
    failed,
    skipped,
  });
}

/**
 * Call an Office command and expose a Promise for the iframe-side flow.
 */
function callCommandResult(command) {
  return new Promise((resolve, reject) => {
    try {
      window.Asc.plugin.callCommand(command, false, false, resolve);
    } catch (error) {
      reject(error);
    }
  });
}
function executeMethodResult(method, args) {
  return new Promise((resolve, reject) => {
    try {
      window.Asc.plugin.executeMethod(method, args, resolve);
    } catch (error) {
      reject(error);
    }
  });
}
function restrictEditorToForms() {
  return executeMethodResult("SetEditingRestrictions", ["forms"]);
}
function freezeEditor() {
  return executeMethodResult("SetEditingRestrictions", ["view"]);
}

function parseCommandResult(result) {
  if (typeof result === "string") {
    return JSON.parse(result || "{}");
  }

  if (result && typeof result === "object") {
    return result;
  }

  return {};
}

/**
 * Extract the current document data.
 *
 * This callback API remains available for existing plugin consumers while
 * action handlers use extractFormDataPromise() below.
 */
function extractFormData(callback) {
  const done = typeof callback === "function" ? callback : () => {};

  try {
    window.Asc.plugin.callCommand(
      extractFormDataCommand,
      false,
      false,
      (result) => {
        try {
          done(null, parseCommandResult(result));
        } catch (error) {
          done(error);
        }
      }
    );
  } catch (error) {
    done(error);
  }
}

function extractFormDataPromise() {
  return new Promise((resolve, reject) => {
    extractFormData((error, data) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(data);
    });
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return;
}

function copyPolicies(target, source) {
  if (Array.isArray(source)) {
    for (const field of source) {
      if (typeof field === "string" && field) {
        target[field] = "locked";
      }
    }

    return;
  }

  if (!isRecord(source)) {
    return;
  }

  for (const [field, policy] of Object.entries(source)) {
    target[field] = policy;
  }
}
function policiesForEditableFields(source) {
  if (Array.isArray(source)) {
    return Object.fromEntries(
      source
        .filter((field) => typeof field === "string" && field)
        .map((field) => [field, "editable"])
    );
  }

  if (!isRecord(source)) {
    return;
  }

  return Object.fromEntries(
    Object.entries(source).map(([field, editable]) => [
      field,
      editable === false ? "locked" : "editable",
    ])
  );
}

function normalizePrefill(options) {
  const rawPrefill = isRecord(options.prefill) ? options.prefill : undefined;
  const fieldValues = {};
  const policies = {};
  let valuesCandidate =
    (isRecord(options.prefillValues) && options.prefillValues) ||
    (isRecord(options.prefillData) && options.prefillData) ||
    undefined;

  if (rawPrefill) {
    if (isRecord(rawPrefill.values)) {
      valuesCandidate = rawPrefill.values;
    } else if (isRecord(rawPrefill.data)) {
      valuesCandidate = rawPrefill.data;
    } else if (isRecord(rawPrefill.fields)) {
      valuesCandidate = rawPrefill.fields;
    } else if (!valuesCandidate) {
      valuesCandidate = rawPrefill;
    }

    copyPolicies(policies, rawPrefill.policies);
    copyPolicies(policies, rawPrefill.fieldPolicies);
    copyPolicies(policies, rawPrefill.lockedFields);
    copyPolicies(policies, rawPrefill.locked);
    copyPolicies(
      policies,
      policiesForEditableFields(rawPrefill.editableFields)
    );
    copyPolicies(policies, policiesForEditableFields(rawPrefill.editable));
  }

  if (isRecord(valuesCandidate)) {
    const hasFieldDescriptors =
      (valuesCandidate === rawPrefill ||
        rawPrefill?.fields === valuesCandidate) &&
      !rawPrefill?.values &&
      !rawPrefill?.data;

    if (hasFieldDescriptors) {
      for (const [field, entry] of Object.entries(valuesCandidate)) {
        if (isRecord(entry) && Object.hasOwn(entry, "value")) {
          fieldValues[field] = entry.value;

          if (entry.policy !== undefined) {
            policies[field] = entry.policy;
          } else if (
            entry.locked !== undefined ||
            entry.editable !== undefined
          ) {
            policies[field] = entry;
          }
        } else {
          fieldValues[field] = entry;
        }
      }
    } else {
      Object.assign(fieldValues, valuesCandidate);
    }
  }

  copyPolicies(policies, options.policies);
  copyPolicies(policies, options.fieldPolicies);
  copyPolicies(policies, options.prefillPolicies);
  copyPolicies(policies, options.lockedFields);
  copyPolicies(policies, options.locked);

  copyPolicies(policies, policiesForEditableFields(options.editableFields));

  let defaultPolicy =
    options.prefillPolicy ?? rawPrefill?.policy ?? rawPrefill?.defaultPolicy;

  if (options.prefillLocked === true) {
    defaultPolicy = "locked";
  }

  if (typeof defaultPolicy === "string" || typeof defaultPolicy === "boolean") {
    for (const field of Object.keys(fieldValues)) {
      if (!Object.hasOwn(policies, field)) {
        policies[field] = defaultPolicy;
      }
    }
  } else if (isRecord(defaultPolicy)) {
    copyPolicies(policies, defaultPolicy.fields);
  }

  return {
    policies,
    values: fieldValues,
  };
}

function hasPrefillValues(prefill) {
  return Object.keys(prefill.values).length > 0;
}

function applyPrefill(prefill) {
  const scope = window.Asc.scope || (window.Asc.scope = {});
  scope.formBridgePrefill = prefill;

  return callCommandResult(applyPrefillCommand)
    .then((result) => parseCommandResult(result))
    .finally(() => {
      if (scope.formBridgePrefill === prefill) {
        delete scope.formBridgePrefill;
      }
    });
}
async function applyPrefillWhenReady(prefill) {
  for (let attempt = 0; attempt < PREFILL_MAX_ATTEMPTS; attempt += 1) {
    const result = await applyPrefill(prefill);
    if (result.applied?.length || result.failed?.length) {
      return result;
    }
    await wait(500);
  }
  return applyPrefill(prefill);
}
function ensurePrefill() {
  if (prefillApplied) {
    return Promise.resolve({ applied: [], failed: [], skipped: [] });
  }

  if (!prefillPromise) {
    prefillPromise = applyPrefillWhenReady(runtimeOptions.prefill).then(
      async (result) => {
        if (result.failed?.length) {
          throw new Error(
            `Could not prefill ${result.failed.length} field(s): ${result.failed.join(", ")}`
          );
        }
        prefillApplied = result.applied?.length > 0;
        await restrictEditorToForms();
        return result;
      }
    );
  }

  return prefillPromise;
}

function getStatusElement() {
  const existing = document.querySelector("#form-bridge-status");

  if (existing) {
    return existing;
  }

  if (!document.body) {
    return null;
  }

  const element = document.createElement("div");
  element.id = "form-bridge-status";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  document.body.append(element);

  return element;
}

function setStatus(message, state) {
  const element = getStatusElement();

  if (element) {
    element.textContent = message;
    element.dataset.state = state || "info";
  }
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error || "Unknown error");
}
function notifyParent(action, status, operationId, payload, error) {
  try {
    const target = window.top || window.parent;
    target?.postMessage(
      {
        action,
        error: error || undefined,
        operation: isRecord(payload?.operation) ? payload.operation : undefined,
        operationId: operationId || undefined,
        source: "form-bridge",
        status,
        type: "operation",
      },
      "*"
    );
  } catch {
    // The editor can run without a host frame.
  }
}

function parseStoredToken(rawValue) {
  if (typeof rawValue !== "string") {
    return;
  }

  const value = rawValue.trim();

  if (!value) {
    return;
  }

  try {
    const parsed = JSON.parse(value);

    if (typeof parsed === "string" && parsed.trim()) {
      return parsed.trim();
    }

    if (isRecord(parsed)) {
      return firstString(
        parsed.token,
        parsed.sessionToken,
        parsed.accessToken,
        parsed.value
      );
    }
  } catch {
    return value;
  }

  return value;
}

function readBearerToken() {
  const runtimeToken = parseStoredToken(runtimeOptions.authToken);
  if (runtimeToken) {
    return runtimeToken;
  }

  let storage;

  try {
    storage = window.localStorage;
  } catch {
    throw new Error("The browser localStorage is unavailable");
  }

  if (!storage) {
    throw new Error("The browser localStorage is unavailable");
  }

  const configuredKey = runtimeOptions.tokenStorageKey;
  const keys = configuredKey
    ? [configuredKey, ...TOKEN_STORAGE_KEYS]
    : TOKEN_STORAGE_KEYS;

  for (const key of [...new Set(keys)]) {
    const token = parseStoredToken(storage.getItem(key));

    if (token) {
      return token;
    }
  }

  throw new Error("Sign in is required before using this form");
}

function apiUrl(path) {
  const base = runtimeOptions.apiBase;

  if (!base) {
    return path;
  }

  return `${base}${path}`;
}

async function requestJson(path, init) {
  const headers = new Headers(init?.headers || {});
  headers.set("Authorization", `Bearer ${readBearerToken()}`);

  if (init?.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
  });
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {
        message: text,
      };
    }
  }

  if (!response.ok) {
    const detail =
      (isRecord(payload) && (payload.error || payload.message)) ||
      `HTTP ${response.status}`;

    throw new Error(String(detail));
  }

  if (isRecord(payload) && payload.ok === false) {
    throw new Error(
      String(payload.error || payload.message || "Request failed")
    );
  }

  return payload;
}

function normalizeRuntimeOptions() {
  let options = window.Asc.plugin.info?.options || {};

  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      options = {};
    }
  }
  return {
    action: firstString(options.action)?.toLowerCase(),
    apiBase: firstString(
      options.apiBase,
      options.apiBaseUrl,
      options.serverOrigin,
      options.serverUrl
    )?.replace(/\/+$/, ""),
    authToken: firstString(
      options.authToken,
      options.bearerToken,
      options.token
    ),
    documentKey: firstString(options.documentKey),
    formId: firstString(options.formId, options.publicId),
    operationId: firstString(options.operationId),
    prefill: normalizePrefill(options),
    publicId: firstString(options.publicId, options.formId),
    responseId: firstString(options.responseId),
    tokenStorageKey: firstString(options.tokenStorageKey),
  };
}

function actionLabel(action) {
  switch (action) {
    case ACTIONS.SAVE_TEMPLATE: {
      return "Save Template";
    }
    case ACTIONS.PUBLISH: {
      return "Publish";
    }
    case ACTIONS.SAVE_DRAFT: {
      return "Save Draft";
    }
    case ACTIONS.SUBMIT: {
      return "Submit";
    }
    default: {
      return "Form action";
    }
  }
}

function toolbarActionsForMode(mode) {
  switch (mode) {
    case ACTIONS.TEMPLATE_EDIT: {
      return [ACTIONS.SAVE_TEMPLATE, ACTIONS.PUBLISH];
    }
    case ACTIONS.FILL:
    case ACTIONS.DRAFT: {
      return [ACTIONS.SAVE_DRAFT, ACTIONS.SUBMIT];
    }
    case ACTIONS.SUBMIT: {
      return [ACTIONS.SUBMIT];
    }
    default: {
      return [];
    }
  }
}

function buttonIdForAction(action) {
  switch (action) {
    case ACTIONS.SAVE_TEMPLATE: {
      return BUTTON_IDS.SAVE_TEMPLATE;
    }
    case ACTIONS.PUBLISH: {
      return BUTTON_IDS.PUBLISH;
    }
    case ACTIONS.SAVE_DRAFT: {
      return BUTTON_IDS.SAVE_DRAFT;
    }
    case ACTIONS.SUBMIT: {
      return BUTTON_IDS.SUBMIT;
    }
    default: {
      return;
    }
  }
}

function addToolbarMenuItems(actions) {
  if (!actions.length) {
    return;
  }

  const items = actions.map((action) => ({
    enableToggle: false,
    hint: actionLabel(action),
    id: buttonIdForAction(action),
    lockInViewMode: false,
    separator: false,
    text: actionLabel(action),
    type: "button",
  }));

  try {
    window.Asc.plugin.executeMethod("AddToolbarMenuItem", [
      {
        guid: window.Asc.plugin.info.guid,
        tabs: [
          {
            id: "form_bridge",
            items,
            text: "Form",
          },
        ],
      },
    ]);
  } catch (error) {
    setStatus(`Could not add form toolbar: ${errorMessage(error)}`, "error");
  }
}

function attachToolbarHandlers(actions) {
  for (const action of actions) {
    const buttonId = buttonIdForAction(action);

    if (!buttonId) {
      continue;
    }

    try {
      window.Asc.plugin.attachToolbarMenuClickEvent(buttonId, () => {
        void runAction(action);
      });
    } catch (error) {
      setStatus(
        `Could not attach ${actionLabel(action)}: ${errorMessage(error)}`,
        "error"
      );
    }
  }
}

function requireOption(value, name) {
  if (!value) {
    throw new Error(`Missing editor option: ${name}`);
  }

  return value;
}

function actionRequest(action, data) {
  const documentKey = requireOption(runtimeOptions.documentKey, "documentKey");

  if (action === ACTIONS.SAVE_TEMPLATE || action === ACTIONS.PUBLISH) {
    const formId = encodeURIComponent(
      requireOption(runtimeOptions.formId, "formId")
    );

    return {
      body: {
        documentKey,
      },
      path: `${API_ROUTES.ADMIN_FORMS}/${formId}/${
        action === ACTIONS.SAVE_TEMPLATE ? "save" : "publish"
      }`,
    };
  }

  if (action === ACTIONS.SAVE_DRAFT || action === ACTIONS.SUBMIT) {
    const publicId = encodeURIComponent(
      requireOption(runtimeOptions.publicId, "publicId")
    );
    const body = {
      data,
      documentKey,
    };

    if (runtimeOptions.responseId) {
      body.responseId = runtimeOptions.responseId;
    }

    return {
      body,
      path: `${API_ROUTES.FORMS}/${publicId}/${
        action === ACTIONS.SAVE_DRAFT ? "draft" : "submit"
      }`,
    };
  }

  throw new Error(`Unsupported form action: ${action || "none"}`);
}

async function postAction(action, data) {
  const request = actionRequest(action, data);
  const result = await requestJson(request.path, {
    body: JSON.stringify(request.body),
    method: "POST",
  });

  return result;
}

function operationIdFromResponse(payload) {
  if (!isRecord(payload)) {
    return;
  }

  const operation = isRecord(payload.operation) ? payload.operation : {};
  const data = isRecord(payload.data) ? payload.data : {};

  return firstString(
    payload.operationId,
    operation.operationId,
    operation.id,
    data.operationId
  );
}

function operationStatus(payload) {
  const operation = isRecord(payload?.operation) ? payload.operation : {};
  const status = payload?.status ?? operation.status;

  if (typeof status !== "string") {
    return "";
  }

  return status
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
}

function operationFailureMessage(payload, operationId) {
  const operation = isRecord(payload?.operation) ? payload.operation : {};
  const detail = payload?.error ?? payload?.message ?? operation.error;

  return detail ? String(detail) : `Operation ${operationId} failed`;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function pollOperation(operationId, label = "operation") {
  const id = requireOption(operationId, "operationId");
  let previousStatus = "";

  for (let attempt = 0; attempt < MAX_OPERATION_POLLS; attempt += 1) {
    const payload = await requestJson(
      `${API_ROUTES.OPERATIONS}/${encodeURIComponent(id)}`,
      { method: "GET" }
    );
    const status = operationStatus(payload);

    if (!status) {
      throw new Error(`Operation ${id} returned no status`);
    }

    if (
      status !== previousStatus &&
      (status === "pending" || status === "queued" || status === "processing")
    ) {
      previousStatus = status;
      setStatus(`${label} is processing…`, "pending");
    }

    if (
      status === "completed" ||
      status === "complete" ||
      status === "succeeded" ||
      status === "success" ||
      status === "done"
    ) {
      return payload;
    }

    if (
      status === "failed" ||
      status === "failure" ||
      status === "error" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      throw new Error(operationFailureMessage(payload, id));
    }

    if (attempt < MAX_OPERATION_POLLS - 1) {
      await wait(OPERATION_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`Operation ${id} did not finish in time`);
}

async function runAction(action) {
  if (actionInFlight || initializationPending) {
    setStatus("A form action is already in progress", "pending");
    return { ignored: true, ok: false };
  }

  actionInFlight = true;
  let operationId;
  let completedPayload;
  let editorFrozen = false;

  try {
    const needsData =
      action === ACTIONS.SAVE_DRAFT || action === ACTIONS.SUBMIT;
    let data;

    if (needsData) {
      if (
        runtimeOptions.action === ACTIONS.FILL &&
        hasPrefillValues(runtimeOptions.prefill)
      ) {
        await ensurePrefill();
      } else if (runtimeOptions.action === ACTIONS.DRAFT) {
        await restrictEditorToForms();
      }
      await freezeEditor();
      editorFrozen = true;
      setStatus(`Reading fields for ${actionLabel(action)}…`, "pending");
      data = await extractFormDataPromise();
    }

    setStatus(`${actionLabel(action)} is pending…`, "pending");
    const response = await postAction(action, data);
    operationId = operationIdFromResponse(response);
    notifyParent(action, "pending", operationId, response);

    if (operationId) {
      completedPayload = await pollOperation(operationId, actionLabel(action));
    }

    setStatus(`${actionLabel(action)} completed`, "success");
    notifyParent(
      action,
      "completed",
      operationId,
      completedPayload || response
    );

    return {
      ok: true,
      operationId: operationId || null,
      response,
    };
  } catch (error) {
    const message = errorMessage(error);
    setStatus(`${actionLabel(action)} failed: ${message}`, "error");
    notifyParent(action, "failed", operationId, completedPayload, message);

    return {
      error: message,
      ok: false,
      operationId: operationId || null,
    };
  } finally {
    if (editorFrozen) {
      try {
        await restrictEditorToForms();
      } catch {
        setStatus("Could not restore form editing", "error");
      }
    }
    actionInFlight = false;
  }
}

/**
 * Compatibility entry point for existing callers of the original plugin.
 */
function submitForm() {
  return runAction(ACTIONS.SUBMIT);
}
function startInitializationTasks() {
  if (initializationStarted) {
    return;
  }
  initializationStarted = true;
  const tasks = [];
  if (
    runtimeOptions.action === ACTIONS.FILL &&
    hasPrefillValues(runtimeOptions.prefill)
  ) {
    window.setTimeout(() => {
      ensurePrefill()
        .then((result) => {
          setStatus(
            `Prefill applied (${result.applied?.length ?? 0} fields, ${
              result.skipped?.length ?? 0
            } skipped)`,
            "success"
          );
        })
        .catch((error) => {
          setStatus(`Prefill failed: ${errorMessage(error)}`, "error");
        });
    }, 5000);
  }
  if (
    (runtimeOptions.action === ACTIONS.FILL ||
      runtimeOptions.action === ACTIONS.DRAFT ||
      runtimeOptions.action === ACTIONS.SUBMIT) &&
    !hasPrefillValues(runtimeOptions.prefill)
  ) {
    window.setTimeout(() => {
      restrictEditorToForms().catch((error) => {
        setStatus(
          `Could not restrict document editing: ${errorMessage(error)}`,
          "error"
        );
      });
    }, 3000);
  }

  if (runtimeOptions.operationId) {
    tasks.push(
      pollOperation(runtimeOptions.operationId, "Existing operation")
        .then((result) => {
          setStatus("Existing operation completed", "success");
          return result;
        })
        .catch((error) => {
          setStatus(
            `Existing operation failed: ${errorMessage(error)}`,
            "error"
          );
          return null;
        })
    );
  }

  if (!tasks.length) {
    return;
  }

  initializationPending = true;
  Promise.all(tasks).finally(() => {
    initializationPending = false;
  });
}

function startInitializationWhenReady() {
  const plugin = window.Asc?.plugin;
  if (plugin && typeof plugin.attachEditorEvent === "function") {
    plugin.attachEditorEvent("onDocumentContentReady", () => {
      startInitializationTasks();
    });
  }

  window.setTimeout(startInitializationTasks, 3000);
}

function initializePlugin() {
  if (pluginInitialized) {
    return;
  }

  pluginInitialized = true;
  runtimeOptions = normalizeRuntimeOptions();

  const actions = toolbarActionsForMode(runtimeOptions.action);
  if (actions.length) {
    addToolbarMenuItems(actions);
    attachToolbarHandlers(actions);
  } else {
    setStatus("No supported form action was supplied", "error");
  }

  startInitializationWhenReady();
}

window.FormBridge = Object.assign(window.FormBridge || {}, {
  applyPrefill,
  extractFormData,
  getRuntimeOptions: () => runtimeOptions,
  pollOperation,
  runAction,
  submitForm,
});

/**
 * ONLYOFFICE plugin entry point.
 *
 * The host may install plugin options immediately before invoking init, so
 * wait for the info object without delaying registration of the init hook.
 */
window.Asc = window.Asc || {};
window.Asc.plugin = window.Asc.plugin || {};
window.Asc.plugin.init = function init() {
  const start = () => {
    const options = window.Asc.plugin.info?.options;
    if (
      !options ||
      (typeof options === "object" && Object.keys(options).length === 0)
    ) {
      window.setTimeout(start, 50);
      return;
    }
    initializePlugin();
  };
  start();
};
