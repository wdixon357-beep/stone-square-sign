import AppKit
import PDFKit
import SwiftUI
import WebKit
import UniformTypeIdentifiers

// The shared report service owns the form, draft, review and explicit-send workflow.
// No Sign session token or stored signature is passed to it.
@MainActor
final class ReportBrowserModel: NSObject, ObservableObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, NSWindowDelegate {
    static let reportURL = URL(string: "https://request.stonesquare22pha.org/report")!
    let webView: WKWebView
    @Published var error: String?
    private var previewWindows: [NSWindow] = []

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsMagnification = true
    }

    func loadIfNeeded() {
        if webView.url == nil && !webView.isLoading { reload() }
    }

    func reload() {
        error = nil
        webView.load(URLRequest(url: Self.reportURL))
    }

    // A genuine child web view preserves window.open(), including the later blob
    // navigation, while leaving the Brother's form and review controls untouched.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil else { return nil }
        let preview = WKWebView(frame: .zero, configuration: configuration)
        preview.uiDelegate = self
        preview.navigationDelegate = self
        preview.allowsMagnification = true
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 760),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Report preview"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = NSHostingView(rootView: ReportPreviewView(webView: preview))
        previewWindows.append(window)
        window.center()
        window.makeKeyAndOrderFront(nil)
        return preview
    }

    func webViewDidClose(_ webView: WKWebView) { webView.window?.close() }
    func windowWillClose(_ notification: Notification) {
        previewWindows.removeAll { $0 === notification.object as? NSWindow }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if url.scheme == "blob" || url.scheme == "about" ||
            (url.scheme == "https" && url.host == Self.reportURL.host) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if url.scheme == "https" || url.scheme == "mailto" { NSWorkspace.shared.open(url) }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = suggestedFilename
        panel.begin { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        self.error = "The PDF could not be saved. Please try Save the PDF again."
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            self.error = "The report page could not load. Check your connection and try again."
        }
    }
}

struct ReportGeneratorView: View {
    @ObservedObject var browser: ReportBrowserModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Report Generator").font(.title2.weight(.semibold))
                Spacer()
                Link("Open in browser", destination: ReportBrowserModel.reportURL)
            }.padding()
            if let error = browser.error {
                HStack { Text(error).foregroundStyle(.red); Button("Try again") { browser.reload() } }.padding()
            }
            ReportWebSurface(webView: browser.webView)
        }.onAppear { browser.loadIfNeeded() }
    }
}

struct ReportWebSurface: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

private struct ReportPreviewView: View {
    let webView: WKWebView
    @MainActor private func pdfData() async throws -> Data {
        guard let url = webView.url, url.scheme == "blob" else { throw URLError(.resourceUnavailable) }
        let result = try await webView.callAsyncJavaScript(
            "const r = await fetch(url); const a = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192)); return btoa(s);",
            arguments: ["url": url.absoluteString], in: nil, contentWorld: .page)
        guard let encoded = result as? String, let data = Data(base64Encoded: encoded), PDFDocument(data: data) != nil
        else { throw URLError(.cannotDecodeContentData) }
        return data
    }
    @MainActor private func showPDFError() {
        let alert = NSAlert()
        alert.messageText = "The PDF could not be opened."
        alert.informativeText = "Wait for the preview to finish loading, then try again."
        alert.runModal()
    }
    @MainActor private func savePDF() async {
        do {
            let data = try await pdfData()
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.pdf]
            panel.nameFieldStringValue = "Lodge Report.pdf"
            if panel.runModal() == .OK, let url = panel.url { try data.write(to: url, options: .atomic) }
        } catch { showPDFError() }
    }
    @MainActor private func printPDF() async {
        do {
            let data = try await pdfData()
            guard let pdf = PDFDocument(data: data),
                  let operation = pdf.printOperation(for: .shared, scalingMode: .pageScaleToFit, autoRotate: true)
            else { throw URLError(.cannotDecodeContentData) }
            operation.showsPrintPanel = true
            operation.showsProgressPanel = true
            operation.run()
        } catch { showPDFError() }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Return to the report form to review, sign and send.").foregroundStyle(.secondary)
                Spacer()
                Button("Save PDF") { Task { await savePDF() } }
                Button("Print") { Task { await printPDF() } }
                Button("Return to report") { webView.window?.close() }
            }.padding()
            ReportWebSurface(webView: webView)
        }
    }
}
