import AppKit
import SwiftUI
import WebKit

struct MeetingMinutesView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Meeting Minutes").font(.title2.weight(.semibold))
                Spacer()
                if let url = model.meetingMinutesURL {
                    Link("Open in browser", destination: url)
                }
            }
            .padding()

            if let url = model.meetingMinutesURL, let token = model.webSessionToken {
                MeetingMinutesWebSurface(url: url, token: token)
                    .id(token)
            } else {
                ContentUnavailableView(
                    "Meeting minutes are unavailable",
                    systemImage: "text.document",
                    description: Text("Sign in again to open the minutes workspace.")
                )
            }
        }
    }
}

private struct MeetingMinutesWebSurface: NSViewRepresentable {
    let url: URL
    let token: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let encodedToken = String(data: try! JSONEncoder().encode(token), encoding: .utf8)!
        configuration.userContentController.addUserScript(WKUserScript(
            source: "localStorage.setItem('stone-square-sign-token', \(encodedToken));",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = context.coordinator
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = true
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        if webView.url == nil && !webView.isLoading {
            webView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.scheme == "blob" || url.scheme == "about" || ["http", "https"].contains(url.scheme ?? "") {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                NSWorkspace.shared.open(url)
            }
        }
    }
}
