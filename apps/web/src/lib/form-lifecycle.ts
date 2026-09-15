export const SESSION_WARNING_WINDOW_MS = 5 * 60 * 1000;

export const shouldWarnBeforeSessionExpiry = (
  expiresAt: string | undefined,
  now = Date.now()
): boolean => {
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  const remaining = expiresAtMs - now;
  return remaining > 0 && remaining <= SESSION_WARNING_WINDOW_MS;
};

export const shouldBlockDirtyNavigation = (
  dirty: boolean,
  bypass: boolean
): boolean => dirty && !bypass;
export const isSaveFlowBusy = (
  operationBusy: boolean,
  exportAfterSave: string | null,
  saveBeforeExit: boolean
): boolean => operationBusy || exportAfterSave !== null || saveBeforeExit;

export const saveThenDownload = async (
  save: () => unknown | Promise<unknown>,
  download: () => unknown | Promise<unknown>
): Promise<void> => {
  await save();
  await download();
};

export const createDeferred = <T>() => {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  // oxlint-disable-next-line promise/avoid-new -- editor messages settle this deferred at a later terminal event.
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return {
    promise,
    reject: rejectDeferred,
    resolve: resolveDeferred,
  };
};
