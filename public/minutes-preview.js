// Render the same PDF on every device, including browsers without an inline PDF viewer.
import { getDocument, GlobalWorkerOptions } from '/pdfjs/build/pdf.mjs';
GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';

export class MinutesPreview {
  constructor(container) {
    this.container = container;
    this.generation = 0;
    this.resize = new ResizeObserver(() => this.rescale());
    this.resize.observe(container);
  }
  async clear() {
    this.generation += 1;
    this.observer?.disconnect();
    for (const page of this.pages || []) page.task?.cancel();
    this.pages = [];
    const loading = this.loading;
    this.loading = null;
    this.container.replaceChildren();
    await loading?.destroy();
  }
  async show(bytes) {
    const scroll = this.container.scrollTop;
    await this.clear();
    const generation = this.generation;
    const loading = getDocument({ data: bytes, isEvalSupported: false, standardFontDataUrl: '/pdfjs/standard_fonts/' });
    this.loading = loading;
    const pdf = await loading.promise;
    if (generation !== this.generation) return;
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const pdfPage = await pdf.getPage(index);
      if (generation !== this.generation) return;
      const figure = document.createElement('figure');
      const canvas = document.createElement('canvas');
      const caption = document.createElement('figcaption');
      const dimensions = pdfPage.getViewport({ scale: 1 });
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Document page ${index} of ${pdf.numPages}. Download the PDF for selectable text.`);
      canvas.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
      caption.textContent = `Page ${index} of ${pdf.numPages}`;
      figure.append(canvas, caption);
      this.container.append(figure);
      pages.push({ pdfPage, canvas, figure, visible: false, generation });
    }
    this.pages = pages;
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const page = this.pages.find(item => item.figure === entry.target);
        if (!page) continue;
        page.visible = entry.isIntersecting;
        if (page.visible) this.render(page);
      }
    }, { rootMargin: '600px' });
    pages.forEach(page => this.observer.observe(page.figure));
    this.container.scrollTop = scroll;
    // Render the first page immediately when visible; remaining pages load near the viewport.
    if (pages[0] && this.container.clientWidth) { pages[0].visible = true; await this.render(pages[0]); }
    return pdf.numPages;
  }
  rescale() {
    if (!this.container.clientWidth) return;
    for (const page of this.pages || []) if (page.visible) this.render(page);
  }
  async render(page) {
    const width = Math.floor(page.canvas.clientWidth);
    if (!width || page.width === width || page.generation !== this.generation) return;
    page.width = width;
    const previous = page.task;
    previous?.cancel();
    try { await previous?.promise; } catch { /* a resize supersedes the earlier render */ }
    if (page.width !== width || page.generation !== this.generation) return;
    const base = page.pdfPage.getViewport({ scale: 1 });
    const viewport = page.pdfPage.getViewport({ scale: width / base.width });
    const density = Math.min(window.devicePixelRatio || 1, 1.5);
    page.canvas.width = Math.ceil(viewport.width * density);
    page.canvas.height = Math.ceil(viewport.height * density);
    page.task = page.pdfPage.render({ canvasContext: page.canvas.getContext('2d'), viewport, transform: [density, 0, 0, density, 0, 0] });
    try { await page.task.promise; }
    catch (error) { if (error.name !== 'RenderingCancelledException') { page.width = null; this.container.dispatchEvent(new CustomEvent('previewerror', { detail: error.message })); } }
  }
}
