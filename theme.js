/* 暗色靠 html.dark 类，由用户点开关，不跟随系统 —— 与原实验室一致 */
(function () {
  'use strict';
  var KEY = 'lab-theme';
  try {
    if (JSON.parse(localStorage.getItem(KEY) || 'null') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('btnTheme');
    if (!b) return;
    function label() {
      b.textContent = document.documentElement.classList.contains('dark') ? '亮色' : '暗色';
    }
    label();
    b.addEventListener('click', function () {
      var dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch (e) {}
      label();
    });
  });
})();
