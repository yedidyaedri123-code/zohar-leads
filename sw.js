/* App-shell cache. CRM/API reads stay network-first and are not stored. */
var CACHE = 'zohar-shell-v8';
var SHELL = [
  '/',
  '/index.html',
  '/data.js',
  '/biometric.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(SHELL);
  }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) {
      return caches.delete(key);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

function isDataRequest(url) {
  var host = url.hostname;
  if (host === 'supabase.co' || host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) return true;
  if (url.origin === self.location.origin) {
    return url.pathname.indexOf('/rest/') === 0 || url.pathname.indexOf('/auth/') === 0 || url.pathname.indexOf('/api/') === 0;
  }
  return false;
}

function networkOnly(request) {
  return fetch(request);
}

function networkFirstShell(request) {
  return caches.open(CACHE).then(function (cache) {
    return fetch(request).then(function (response) {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    }).catch(function () {
      return cache.match(request).then(function (cached) {
        return cached || cache.match('/index.html') || cache.match('/');
      }).then(function (cached) {
        if (cached) return cached;
        return Promise.reject(new Error('offline'));
      });
    });
  });
}

function cacheFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (isDataRequest(url)) {
    event.respondWith(networkOnly(event.request));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (url.pathname === '/sw.js') return;
  if (url.pathname === '/data.js' || url.pathname === '/biometric.js' || event.request.mode === 'navigate') {
    event.respondWith(networkFirstShell(event.request));
    return;
  }
  event.respondWith(cacheFirst(event.request));
});
