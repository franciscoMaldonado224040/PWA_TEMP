// sw.js - Service Worker Unificado (Caché + Sincronización)
const CACHE_NAME = 'temperature-converter-v2';
const SYNC_DB_NAME = 'temperature-sync-db';
const SYNC_DB_VERSION = 1;
const CONVERSIONS_STORE = 'conversions';
const PREFERENCES_STORE = 'preferences';
const SYNC_QUEUE_STORE = 'sync-queue';

// Recursos para cachear
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/converter.js',
  '/converter.css',
  '/manifest.json'
];

// ==========================================
// FUNCIONES DE INDEXEDDB
// ==========================================
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

// ==========================================
// EVENTO: INSTALACIÓN
// ==========================================
self.addEventListener('install', event => {
  console.log('[SW] Instalando Service Worker...');
  event.waitUntil((async () => {
    try {
      // Cachear recursos estáticos
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(STATIC_ASSETS);
      console.log('[SW] Recursos cacheados');
      
      // Inicializar base de datos
      await openDatabase();
      console.log('[SW] Base de datos inicializada');
      
      self.skipWaiting();
    } catch (error) {
      console.error('[SW] Error en instalación:', error);
    }
  })());
});

// ==========================================
// EVENTO: ACTIVACIÓN
// ==========================================
self.addEventListener('activate', event => {
  console.log('[SW] Activando Service Worker...');
  event.waitUntil((async () => {
    // Limpiar cachés antiguos
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter(name => name !== CACHE_NAME)
        .map(name => {
          console.log('[SW] Eliminando caché antiguo:', name);
          return caches.delete(name);
        })
    );
    
    self.clients.claim();
    console.log('[SW] Service Worker activado');
  })());
});

// ==========================================
// EVENTO: FETCH (Caché)
// ==========================================
self.addEventListener('fetch', event => {
  // Ignorar solicitudes que no sean GET
  if (event.request.method !== 'GET') return;
  
  // Ignorar solicitudes a otros dominios
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Buscar en caché
    const cachedResponse = await cache.match(event.request);
    if (cachedResponse) {
      return cachedResponse;
    }

    // Si no está en caché, intentar red
    try {
      const fetchResponse = await fetch(event.request);
      
      // Cachear respuestas exitosas
      if (fetchResponse && fetchResponse.ok) {
        cache.put(event.request, fetchResponse.clone());
      }
      
      return fetchResponse;
    } catch (error) {
      console.error('[SW] Error de red:', error);
      
      // Página offline personalizada
      if (event.request.headers.get('accept').includes('text/html')) {
        return new Response(
          `<!DOCTYPE html>
          <html lang="es">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Sin conexión</title>
            <style>
              body {
                font-family: system-ui, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                text-align: center;
                padding: 20px;
              }
              .container {
                background: rgba(255,255,255,0.1);
                backdrop-filter: blur(10px);
                padding: 40px;
                border-radius: 20px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
              }
              h1 { font-size: 3em; margin: 0 0 20px 0; }
              button {
                background: white;
                color: #667eea;
                border: none;
                padding: 15px 30px;
                font-size: 1.1em;
                border-radius: 50px;
                cursor: pointer;
                margin-top: 20px;
                font-weight: bold;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>📡 Sin Conexión</h1>
              <p>No hay conexión a internet</p>
              <button onclick="window.location.reload()">Reintentar</button>
            </div>
          </body>
          </html>`,
          {
            status: 503,
            headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' })
          }
        );
      }
      
      return new Response('Offline', { status: 503 });
    }
  })());
});

// ==========================================
// EVENTO: SYNC (Sincronización en segundo plano)
// ==========================================
self.addEventListener('sync', event => {
  console.log('[SW] Evento de sincronización:', event.tag);
  
  if (event.tag === 'sync-conversions') {
    event.waitUntil(syncConversionsToServer());
  }
  
  if (event.tag === 'sync-preferences') {
    event.waitUntil(syncPreferencesToServer());
  }
});

// ==========================================
// EVENTO: MESSAGE (Comunicación con la app)
// ==========================================
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
      
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
      
    case 'CLEAR_CACHE':
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
      event.ports[0].postMessage({ success: true });
      break;
  }
});

// ==========================================
// FUNCIONES DE GUARDADO
// ==========================================
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
    console.log('[SW] Conversión guardada:', conversion);
    
    // Registrar sincronización si está disponible
    if ('sync' in self.registration) {
      await self.registration.sync.register('sync-conversions');
    }
    
    return true;
  } catch (error) {
    console.error('[SW] Error guardando conversión:', error);
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
    console.log('[SW] Preferencia guardada:', preference);
    
    if ('sync' in self.registration) {
      await self.registration.sync.register('sync-preferences');
    }
    
    return true;
  } catch (error) {
    console.error('[SW] Error guardando preferencia:', error);
    return false;
  }
}

// ==========================================
// FUNCIONES DE LECTURA
// ==========================================
async function getConversions(limit = 50) {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CONVERSIONS_STORE], 'readonly');
    const store = transaction.objectStore(CONVERSIONS_STORE);
    const index = store.index('timestamp');
    
    return new Promise((resolve, reject) => {
      const conversions = [];
      const request = index.openCursor(null, 'prev');
      
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
    console.error('[SW] Error obteniendo conversiones:', error);
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
    console.error('[SW] Error obteniendo preferencias:', error);
    return {};
  }
}

// ==========================================
// FUNCIONES DE SINCRONIZACIÓN
// ==========================================
async function syncConversionsToServer() {
  console.log('[SW] Iniciando sincronización de conversiones...');
  
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CONVERSIONS_STORE], 'readwrite');
    const store = transaction.objectStore(CONVERSIONS_STORE);
    const index = store.index('synced');
    
    const unsyncedConversions = await new Promise((resolve, reject) => {
      const request = index.getAll(false);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    if (unsyncedConversions.length === 0) {
      console.log('[SW] No hay conversiones para sincronizar');
      return;
    }
    
    // AQUÍ IRÍA LA LLAMADA A TU API
    // await fetch('/api/sync-conversions', { method: 'POST', body: JSON.stringify(unsyncedConversions) });
    
    console.log(`[SW] ${unsyncedConversions.length} conversiones listas para sincronizar`);
    
    // Marcar como sincronizadas
    for (const conversion of unsyncedConversions) {
      conversion.synced = true;
      await store.put(conversion);
    }
    
    console.log('[SW] Conversiones sincronizadas exitosamente');
  } catch (error) {
    console.error('[SW] Error sincronizando conversiones:', error);
  }
}

async function syncPreferencesToServer() {
  console.log('[SW] Iniciando sincronización de preferencias...');
  
  try {
    const preferences = await getPreferences();
    
    // AQUÍ IRÍA LA LLAMADA A TU API
    // await fetch('/api/sync-preferences', { method: 'POST', body: JSON.stringify(preferences) });
    
    console.log('[SW] Preferencias listas para sincronizar:', preferences);
  } catch (error) {
    console.error('[SW] Error sincronizando preferencias:', error);
  }
}

// ==========================================
// FUNCIÓN DE LIMPIEZA
// ==========================================
async function clearHistory() {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CONVERSIONS_STORE], 'readwrite');
    const store = transaction.objectStore(CONVERSIONS_STORE);
    
    await store.clear();
    console.log('[SW] Historial eliminado');
    return true;
  } catch (error) {
    console.error('[SW] Error limpiando historial:', error);
    return false;
  }
}