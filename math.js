/* 正文里的公式交给本地 KaTeX 渲染。
   生成器用 pymdownx.arithmatex 的 generic 模式，把 $...$ 变成 \(...\) 并包进
   <span class="arithmatex">，所以这里按那对定界符找；代码块和 <pre> 跳过。 */
(function () {
  'use strict';
  function go() {
    if (!window.renderMathInElement) return;
    renderMathInElement(document.body, {
      delimiters: [
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false }
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      throwOnError: false,
      output: "htmlAndMathml"
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go);
  } else {
    go();
  }
})();
