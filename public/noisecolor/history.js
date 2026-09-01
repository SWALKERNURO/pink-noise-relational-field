const DATABASE_NAME = "noisecolor-local-history";
const DATABASE_VERSION = 1;
const STORE_NAME = "measurements";

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Local history is not supported by this browser."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local history."));
  });
}

async function transact(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error("History operation failed."));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error("History transaction was aborted."));
      transaction.onerror = () => reject(transaction.error || new Error("History transaction failed."));
    });
  } finally {
    database.close();
  }
}

export async function saveMeasurement(result) {
  const record = {
    ...result,
    id: result.id || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: result.timestamp || new Date().toISOString(),
  };
  await transact("readwrite", (store) => store.put(record));
  return record;
}

export async function listMeasurements() {
  const records = await transact("readonly", (store) => store.getAll());
  return records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export async function deleteMeasurement(id) {
  await transact("readwrite", (store) => store.delete(id));
}

export async function clearMeasurements() {
  await transact("readwrite", (store) => store.clear());
}
