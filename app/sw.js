/* 只缓存 App 外壳，好让没网时也能打开、看本机副本、记账（联网后再同步）。
   数据本身不经过这里：GitHub API 的请求一律直连，不缓存。
   改了外壳文件就把 VERSION 加一。 */
var VERSION = "phenol-app-3";
var SHELL = ["/app/", "/app/app.css", "/app/app.js", "/sync.js", "/bills.js", "/app/manifest.webmanifest", "/app/icon-180.png", "/favicon.svg"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
/* 先走网络（拿到最新版），断网再用缓存 */
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  var path = u.pathname === "/app/index.html" ? "/app/" : u.pathname;
  if (SHELL.indexOf(path) < 0) return;
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok) { var cp = r.clone(); caches.open(VERSION).then(function (c) { c.put(path, cp); }); }
    return r;
  }).catch(function () {
    return caches.match(path).then(function (r) { return r || caches.match("/app/"); });
  }));
});
