// sync-sw.js - Service Worker de Sincronización de Datos
const SYNC_DB_NAME = 'temperature-sync-db';
const SYNC_DB_VERSION = 1;
const CONVERSIONS_STORE = 'conversions';
const PREFERENCES_STORE = 'preferences';
const SYNC_QUEUE_STORE = 'sync-queue';

// Inicializar IndexedDB
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Store para historial de conversiones
      if (!db.objectStoreNames.contains(CONVERSIONS_STORE)) {
        const conversionStore = db.createObjectStore(CONVERSIONS_STORE, { 
          keyPath: 'id', 
          autoIncrement: true 
        });
        conversionStore.createIndex('timestamp', 'timestamp', { unique: false });
        conversionStore.createIndex('synced', 'synced', { unique: false });
      }
      
      // Store para preferencias del usuario
      if (!db.objectStoreNames.contains(PREFERENCES_STORE)) {
        db.createObjectStore(PREFERENCES_STORE, { keyPath: 'key' });
      }
      
      // Store para cola de sincronización
      if (!db.objectStoreNames.contains(SYNC_QUEUE_STORE)) {
        db.createObjectStore(SYNC_QUEUE_STORE, { 
          keyPath: 'id', 
          autoIncrement: true 
        });
      }
    };
  });
}

// === INSTALACIÓN ===
self.addEventListener('install', (event) => {
  console.log('[Sync SW] Instalando Service Worker de Sincronización...');
  event.waitUntil(
    openDatabase().then(() => {
      console.log('[Sync SW] Base de datos inicializada');
      self.skipWaiting();
    })
  );
});

// === ACTIVACIÓN ===
self.addEventListener('activate', (event) => {
  console.log('[Sync SW] Activando Service Worker de Sincronización...');
  event.waitUntil(self.clients.claim());
});

// === SINCRONIZACIÓN EN SEGUNDO PLANO ===
self.addEventListener('sync', (event) => {
  console.log('[Sync SW] Evento de sincronización:', event.tag);
  
  if (event.tag === 'sync-conversions') {
    event.waitUntil(syncConversionsToServer());
  }
  
  if (event.tag === 'sync-preferences') {
    event.waitUntil(syncPreferencesToServer());
  }
});

// === MENSAJES DESDE LA APP ===
self.addEventListener('message', async (event) => {
  const { type, data } = event.data;
  
  switch (type) {
    case 'SAVE_CONVERSION':
      await saveConversion(data);
      event.ports[0].postMessage({ success: true });
      break;
      
    case 'SAVE_PREFERENCE':
      await savePreference(data);
      event.ports[0].postMessage({ success: true });
      break;
      
    case 'GET_CONVERSIONS':
      const conversions = await getConversions(data?.limit);
      event.ports[0].postMessage({ conversions });
      break;
      
    case 'GET_PREFERENCES':
      const preferences = await getPreferences();
      event.ports[0].postMessage({ preferences });
      break;
      
    case 'CLEAR_HISTORY':
      await clearHistory();
      event.ports[0].postMessage({ success: true });
      break;
      
    case 'FORCE_SYNC':
      await syncConversionsToServer();
      await syncPreferencesToServer();
      event.ports[0].postMessage({ success: true });
      break;
  }
});

// === FUNCIONES DE GUARDADO ===
async function saveConversion(conversionData) {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CONVERSIONS_STORE], 'readwrite');
    const store = transaction.objectStore(CONVERSIONS_STORE);
    
    const conversion = {
      value: conversionData.value,
      fromUnit: conversionData.fromUnit,
      toUnit: conversionData.toUnit,
      result: conversionData.result,
      timestamp: Date.now(),
      synced: false
    };
    
    await store.add(conversion);
    console.log('[Sync SW] Conversión guardada:', conversion);
    
    // Registrar sincronización si está disponible
    if ('sync' in self.registration) {
      await self.registration.sync.register('sync-conversions');
    }
    
    return true;
  } catch (error) {
    console.error('[Sync SW] Error guardando conversión:', error);
    return false;
  }
}

async function savePreference(preferenceData) {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([PREFERENCES_STORE], 'readwrite');
    const store = transaction.objectStore(PREFERENCES_STORE);
    
    const preference = {
      key: preferenceData.key,
      value: preferenceData.value,
      timestamp: Date.now(),
      synced: false
    };
    
    await store.put(preference);
    console.log('[Sync SW] Preferencia guardada:', preference);
    
    if ('sync' in self.registration) {
      await self.registration.sync.register('sync-preferences');
    }
    
    return true;
  } catch (error) {
    console.error('[Sync SW] Error guardando preferencia:', error);
    return false;
  }
}

// === FUNCIONES DE LECTURA ===
async function getConversions(limit = 50) {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CONVERSIONS_STORE], 'readonly');
    const store = transaction.objectStore(CONVERSIONS_STORE);
    const index = store.index('timestamp');
    
    return new Promise((resolve, reject) => {
      const conversions = [];
      const request = index.openCursor(null, 'prev'); // Orden descendente
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && conversions.length < limit) {
          conversions.push(cursor.value);
          cursor.continue();
        } else {
          resolve(conversions);
        }
      };
      
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[Sync SW] Error obteniendo conversiones:', error);
    return [];
  }
}

async function getPreferences() {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([PREFERENCES_STORE], 'readonly');
    const store = transaction.objectStore(PREFERENCES_STORE);
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const prefs = {};
        request.result.forEach(item => {
          prefs[item.key] = item.value;
        });
        resolve(prefs);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[Sync SW] Error obteniendo preferencias:', error);
    return {};
  }
}

// === FUNCIONES DE SINCRONIZACIÓN ===
async function syncConversionsToServer() {
  console.log('[Sync SW] Iniciando sincronización de conversiones...');
  
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CONVERSIONS_STORE], 'readwrite');
    const store = transaction.objectStore(CONVERSIONS_STORE);
    const index = store.index('synced');
    
    // Obtener conversiones no sincronizadas
    const unsyncedConversions = await new Promise((resolve, reject) => {
      const request = index.getAll(false);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    if (unsyncedConversions.length === 0) {
      console.log('[Sync SW] No hay conversiones para sincronizar');
      return;
    }
    
    // AQUÍ IRÍA LA LLAMADA A TU API
    // Ejemplo: await fetch('/api/sync-conversions', { method: 'POST', body: JSON.stringify(unsyncedConversions) });
    
    // Por ahora solo marcamos como sincronizadas
    console.log(`[Sync SW] ${unsyncedConversions.length} conversiones listas para sincronizar`);
    
    // Marcar como sincronizadas
    for (const conversion of unsyncedConversions) {
      conversion.synced = true;
      await store.put(conversion);
    }
    
    console.log('[Sync SW] Conversiones sincronizadas exitosamente');
  } catch (error) {
    console.error('[Sync SW] Error sincronizando conversiones:', error);
  }
}

async function syncPreferencesToServer() {
  console.log('[Sync SW] Iniciando sincronización de preferencias...');
  
  try {
    const preferences = await getPreferences();
    
    // AQUÍ IRÍA LA LLAMADA A TU API
    // Ejemplo: await fetch('/api/sync-preferences', { method: 'POST', body: JSON.stringify(preferences) });
    
    console.log('[Sync SW] Preferencias listas para sincronizar:', preferences);
  } catch (error) {
    console.error('[Sync SW] Error sincronizando preferencias:', error);
  }
}

// === LIMPIEZA ===
async function clearHistory() {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CONVERSIONS_STORE], 'readwrite');
    const store = transaction.objectStore(CONVERSIONS_STORE);
    
    await store.clear();
    console.log('[Sync SW] Historial eliminado');
    return true;
  } catch (error) {
    console.error('[Sync SW] Error limpiando historial:', error);
    return false;
  }
}