import { sanitizeAudioSettings, sanitizeMetadata } from "./privacy.js?v=0.6.8-recovery.2";

const DATABASE_NAME = "noisecolor-local-history";
const DATABASE_VERSION = 2;
const STORE_NAME = "measurements";
export const HISTORY_RETENTION_LIMIT = 100;
export const HISTORY_PAGE_SIZE = 25;
const MAX_TEMPORAL_POINTS = 600;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Local history is not supported by this browser."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains("timestamp")) store.createIndex("timestamp", "timestamp");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local history."));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("History transaction was aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("History transaction failed."));
  });
}

function sampleEvenly(values, maximum = MAX_TEMPORAL_POINTS) {
  if (!Array.isArray(values) || values.length <= maximum) return values || [];
  return Array.from({ length: maximum }, (_, index) => values[Math.round((index * (values.length - 1)) / (maximum - 1))]);
}

export function sanitizeMicrophoneSettings(settings) {
  return sanitizeAudioSettings(settings);
}

export function compactMeasurement(result) {
  const {
    psd: _psd,
    spectrogram: _spectrogram,
    thirdOctave: _thirdOctave,
    inputRouteId: _inputRouteId,
    ...metadata
  } = result || {};
  return {
    ...sanitizeMetadata(metadata),
    temporalBeta: sampleEvenly(metadata.temporalBeta),
    colorTimeline: sampleEvenly(metadata.colorTimeline),
    microphoneSettings: sanitizeMicrophoneSettings(metadata.microphoneSettings),
    historyCompacted: true,
    historyDetailArraysStored: false,
  };
}

async function enforceRetention() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      let excess = Math.max(0, countRequest.result - HISTORY_RETENTION_LIMIT);
      if (!excess) return;
      const cursorRequest = store.index("timestamp").openCursor(null, "next");
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess -= 1;
        cursor.continue();
      };
    };
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function saveMeasurement(result) {
  const compacted = compactMeasurement(result);
  const timestamp = compacted.timestamp || new Date().toISOString();
  const record = {
    ...compacted,
    id: compacted.id || `result-${timestamp}-${compacted.sourceType || "unknown"}`,
    timestamp,
  };
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
  await enforceRetention();
  return record;
}

export function historyPaginationState(offset, recordCount, hasNext, pageSize = HISTORY_PAGE_SIZE) {
  const currentOffset = Math.max(0, Math.floor(offset) || 0);
  return {
    offset: currentOffset,
    pageNumber: Math.floor(currentOffset / pageSize) + 1,
    hasPrevious: currentOffset > 0,
    hasNext: Boolean(hasNext),
    nextOffset: hasNext ? currentOffset + pageSize : currentOffset,
    previousOffset: Math.max(0, currentOffset - pageSize),
    firstRecord: recordCount ? currentOffset + 1 : 0,
    lastRecord: currentOffset + recordCount,
  };
}

export async function listMeasurementPage({ limit = HISTORY_PAGE_SIZE, offset = 0 } = {}) {
  const maximum = Math.max(1, Math.min(HISTORY_PAGE_SIZE, Math.floor(limit) || HISTORY_PAGE_SIZE));
  const skip = Math.max(0, Math.floor(offset) || 0);
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const records = [];
      let seen = 0;
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).index("timestamp").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length > maximum) {
          const visible = records.slice(0, maximum);
          resolve({ records: visible, hasNext: records.length > maximum, pagination: historyPaginationState(skip, visible.length, records.length > maximum, maximum) });
          return;
        }
        if (seen >= skip) records.push(cursor.value);
        seen += 1;
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("History read failed."));
    });
  } finally {
    database.close();
  }
}

export async function listMeasurements(options = {}) {
  return (await listMeasurementPage(options)).records;
}

async function deleteOperation(operation) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    operation(transaction.objectStore(STORE_NAME));
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function deleteMeasurement(id) {
  await deleteOperation((store) => store.delete(id));
}

export async function clearMeasurements() {
  await deleteOperation((store) => store.clear());
}
