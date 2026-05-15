// ==UserScript==
// @name         BigQuant PDF Downloader
// @namespace    https://bigquant.com/
// @version      1.0.0
// @description  从 BigQuant 文档页提取 PDF 地址并按页面标题下载
// @match        https://bigquant.com/wiki/doc/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'bigquant-pdf-download-button';
  const TITLE_SUFFIX = ' - BigQuant量化交易';

  function sanitizeFileName(name) {
    return name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getDocumentTitle() {
    const heading = document.querySelector('h1');
    const rawTitle = heading?.textContent?.trim() || document.title.replace(TITLE_SUFFIX, '').trim();
    const safeTitle = sanitizeFileName(rawTitle || 'bigquant-document');
    return safeTitle.toLowerCase().endsWith('.pdf') ? safeTitle : `${safeTitle}.pdf`;
  }

  function toAbsolutePdfUrl(fileValue) {
    if (!fileValue) {
      return null;
    }

    const decodedValue = decodeURIComponent(fileValue).trim();

    if (/^https?:\/\//i.test(decodedValue)) {
      return decodedValue;
    }

    if (decodedValue.startsWith('/')) {
      return new URL(decodedValue, location.origin).href;
    }

    return new URL(decodedValue, location.href).href;
  }

  function extractPdfUrlFromViewerUrl(viewerUrl) {
    if (!viewerUrl) {
      return null;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(viewerUrl, location.origin);
    } catch {
      return null;
    }

    const fileValue = parsedUrl.searchParams.get('file');
    return toAbsolutePdfUrl(fileValue);
  }

  function findViewerUrlInText(text) {
    const match = text.match(/https?:\/\/bigquant\.com\/wiki\/pdfjs\/web\/viewer\.html\?file=[^\s"'<>]+/i);
    return match ? match[0] : null;
  }

  function findPdfUrl() {
    const iframe = Array.from(document.querySelectorAll('iframe')).find((element) =>
      element.src.includes('/wiki/pdfjs/web/viewer.html?file='),
    );
    const iframePdfUrl = extractPdfUrlFromViewerUrl(iframe?.src);
    if (iframePdfUrl) {
      return iframePdfUrl;
    }

    const htmlViewerUrl = findViewerUrlInText(document.documentElement.innerHTML);
    const htmlPdfUrl = extractPdfUrlFromViewerUrl(htmlViewerUrl);
    if (htmlPdfUrl) {
      return htmlPdfUrl;
    }

    const directPdfLink = Array.from(document.querySelectorAll('a[href]')).find((element) =>
      /\.pdf(?:$|[?#])/i.test(element.href),
    );
    if (directPdfLink) {
      return directPdfLink.href;
    }

    return null;
  }

  function triggerBrowserDownload(pdfUrl, fileName) {
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function downloadPdf() {
    const pdfUrl = findPdfUrl();
    if (!pdfUrl) {
      alert('没有找到 PDF 链接，请确认页面已经加载出预览器。');
      return;
    }

    const fileName = getDocumentTitle();

    try {
      const response = await fetch(pdfUrl, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      try {
        triggerBrowserDownload(blobUrl, fileName);
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      }
    } catch {
      triggerBrowserDownload(pdfUrl, fileName);
    }
  }

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) {
      return;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '下载 PDF';
    button.addEventListener('click', downloadPdf);
    Object.assign(button.style, {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: '99999',
      border: 'none',
      borderRadius: '999px',
      padding: '10px 16px',
      background: '#0f766e',
      color: '#ffffff',
      fontSize: '14px',
      fontWeight: '700',
      cursor: 'pointer',
      boxShadow: '0 10px 24px rgba(15, 118, 110, 0.28)',
    });
    document.body.appendChild(button);
  }

  function start() {
    injectButton();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('下载当前 BigQuant PDF', downloadPdf);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();