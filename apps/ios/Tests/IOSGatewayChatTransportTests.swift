import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        self.lock()
        defer { self.unlock() }
        return body()
    }
}

private final class FakeGatewayWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let lock = NSLock()
    private let responsePayloads: [String: [String: Any]]
    private var _state: URLSessionTask.State = .suspended
    private var connectRequestId: String?
    private var receivePhase = 0
    private var pendingReceiveHandler:
        (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?
    private var methods: [String] = []
    private var paramsByMethod: [String: [[String: Any]]] = [:]

    init(responsePayloads: [String: [String: Any]]) {
        self.responsePayloads = responsePayloads
    }

    var state: URLSessionTask.State {
        self.lock.withLock { self._state }
    }

    func resume() {
        self.lock.withLock { self._state = .running }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
        let handler = self.lock.withLock { () -> (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)? in
            self._state = .canceling
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(.failure(URLError(.cancelled)))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data? = switch message {
        case let .data(data): data
        case let .string(text): text.data(using: .utf8)
        @unknown default: nil
        }
        guard let data,
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              frame["type"] as? String == "req",
              let id = frame["id"] as? String,
              let method = frame["method"] as? String
        else {
            return
        }

        if method == "connect" {
            self.lock.withLock {
                self.connectRequestId = id
                self.methods.append(method)
            }
            return
        }

        let payload = self.responsePayloads[method] ?? [:]
        let response: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": true,
            "payload": payload,
        ]
        let responseData = try JSONSerialization.data(withJSONObject: response)
        let handler = self.lock.withLock { () -> (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)? in
            self.methods.append(method)
            self.paramsByMethod[method, default: []].append(frame["params"] as? [String: Any] ?? [:])
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(.success(.data(responseData)))
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        let phase = self.lock.withLock { () -> Int in
            let current = self.receivePhase
            self.receivePhase += 1
            return current
        }
        if phase == 0 {
            return .data(Self.connectChallengeData(nonce: "nonce-1"))
        }
        for _ in 0..<50 {
            let id = self.lock.withLock { self.connectRequestId }
            if let id {
                return .data(Self.connectOkData(id: id))
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        return .data(Self.connectOkData(id: "connect"))
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        self.lock.withLock { self.pendingReceiveHandler = completionHandler }
    }

    func requestedMethods() -> [String] {
        self.lock.withLock { self.methods }
    }

    func requestedParams(for method: String) -> [[String: Any]] {
        self.lock.withLock { self.paramsByMethod[method] ?? [] }
    }

    private static func connectChallengeData(nonce: String) -> Data {
        let frame: [String: Any] = [
            "type": "event",
            "event": "connect.challenge",
            "payload": ["nonce": nonce],
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func connectOkData(id: String) -> Data {
        let payload: [String: Any] = [
            "type": "hello-ok",
            "protocol": 2,
            "server": [
                "version": "test",
                "connId": "test",
            ],
            "features": [
                "methods": ["models.list"],
                "events": [],
            ],
            "snapshot": [
                "presence": [],
                "health": [:],
                "stateVersion": [
                    "presence": 0,
                    "health": 0,
                ],
                "uptimeMs": 0,
            ],
            "policy": [
                "maxPayload": 1_000_000,
                "maxBufferedBytes": 1_000_000,
                "tickIntervalMs": 30_000,
            ],
            "auth": [:],
        ]
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": true,
            "payload": payload,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }
}

private final class FakeGatewayWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    private let lock = NSLock()
    private let responsePayloads: [String: [String: Any]]
    private var tasks: [FakeGatewayWebSocketTask] = []

    init(responsePayloads: [String: [String: Any]]) {
        self.responsePayloads = responsePayloads
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        _ = url
        return self.lock.withLock {
            let task = FakeGatewayWebSocketTask(responsePayloads: self.responsePayloads)
            self.tasks.append(task)
            return WebSocketTaskBox(task: task)
        }
    }

    func latestTask() -> FakeGatewayWebSocketTask? {
        self.lock.withLock { self.tasks.last }
    }
}

@Suite struct IOSGatewayChatTransportTests {
    private func object(from json: String) throws -> [String: Any] {
        let data = try #require(json.data(using: .utf8))
        let value = try JSONSerialization.jsonObject(with: data)
        return try #require(value as? [String: Any])
    }

    @Test func agentWaitTreatsSuccessAsCompletion() {
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus("success"))
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus(" ok "))
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus("completed"))
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus("succeeded"))
        #expect(!IOSGatewayChatTransport.isAgentWaitCompletionStatus("timeout"))
        #expect(!IOSGatewayChatTransport.isAgentWaitCompletionStatus("failed"))
    }

    @Test func agentWaitTimeoutAddsGatewayMargin() {
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 1) == 6)
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 1000) == 6)
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 30000) == 35)
    }

    @Test func agentWaitCompletionDecodesFallbackRunId() throws {
        let data = Data(#"{"status":"completed"}"#.utf8)
        let completion = try IOSGatewayChatTransport.decodeAgentWaitCompletion(data, fallbackRunId: "run-local")
        #expect(completion.runId == "run-local")
        #expect(completion.status == "completed")
        #expect(completion.completed)
    }

    @Test func listSessionsParamsIncludeGlobalSessionsButNotUnknown() throws {
        let params = try self.object(from: IOSGatewayChatTransport.makeListSessionsParamsJSON(limit: 12))
        #expect(params["includeGlobal"] as? Bool == true)
        #expect(params["includeUnknown"] as? Bool == false)
        #expect(params["limit"] as? Int == 12)
    }

    @Test func chatSendParamsOmitEmptyAttachmentsAndKeepSessionFields() throws {
        let params = try self.object(
            from: IOSGatewayChatTransport.makeChatSendParamsJSON(
                sessionKey: "agent:main",
                message: "hello",
                thinking: "low",
                idempotencyKey: "send-1",
                attachments: []))
        #expect(params["sessionKey"] as? String == "agent:main")
        #expect(params["message"] as? String == "hello")
        #expect(params["thinking"] as? String == "low")
        #expect(params["idempotencyKey"] as? String == "send-1")
        #expect(params["timeoutMs"] as? Int == IOSGatewayChatTransport.defaultChatSendTimeoutMs)
        #expect(params["attachments"] == nil)
    }

    @Test func requestsFailFastWhenGatewayNotConnected() async {
        let gateway = GatewayNodeSession()
        let transport = IOSGatewayChatTransport(gateway: gateway)

        do {
            _ = try await transport.listModels()
            Issue.record("Expected listModels to throw when gateway not connected")
        } catch {}

        do {
            _ = try await transport.requestHistory(sessionKey: "node-test")
            Issue.record("Expected requestHistory to throw when gateway not connected")
        } catch {}

        do {
            _ = try await transport.sendMessage(
                sessionKey: "node-test",
                message: "hello",
                thinking: "low",
                idempotencyKey: "idempotency",
                attachments: [])
            Issue.record("Expected sendMessage to throw when gateway not connected")
        } catch {}

        do {
            _ = try await transport.requestHealth(timeoutMs: 250)
            Issue.record("Expected requestHealth to throw when gateway not connected")
        } catch {}

        do {
            try await transport.resetSession(sessionKey: "node-test")
            Issue.record("Expected resetSession to throw when gateway not connected")
        } catch {}

        do {
            try await transport.setActiveSessionKey("node-test")
            Issue.record("Expected setActiveSessionKey to throw when gateway not connected")
        } catch {}
    }

    @Test func mapsSessionMessageEventToSessionMessage() {
        let payload = AnyCodable([
            "sessionKey": AnyCodable("agent:main:main"),
            "agentId": AnyCodable("main"),
            "messageId": AnyCodable("msg-1"),
            "messageSeq": AnyCodable(7),
            "message": AnyCodable([
                "role": AnyCodable("assistant"),
                "content": AnyCodable([
                    AnyCodable([
                        "type": AnyCodable("text"),
                        "text": AnyCodable("agent reply"),
                    ]),
                ]),
                "timestamp": AnyCodable(1234.5),
            ]),
        ])
        let frame = EventFrame(
            type: "event",
            event: "session.message",
            payload: payload,
            seq: 1,
            stateversion: nil)
        let mapped = IOSGatewayChatTransport.mapEventFrame(frame)

        switch mapped {
        case let .sessionMessage(message):
            #expect(message.sessionKey == "agent:main:main")
            #expect(message.agentId == "main")
            #expect(message.messageId == "msg-1")
            #expect(message.messageSeq == 7)
            #expect(message.message?.role == "assistant")
            #expect(message.message?.content.first?.text == "agent reply")
        default:
            Issue.record("expected .sessionMessage from session.message event, got \(String(describing: mapped))")
        }
    }

    @Test func mapsChatEventToChat() {
        let payload = AnyCodable([
            "runId": AnyCodable("run-1"),
            "sessionKey": AnyCodable("main"),
            "state": AnyCodable("final"),
        ])
        let frame = EventFrame(type: "event", event: "chat", payload: payload, seq: 1, stateversion: nil)
        let mapped = IOSGatewayChatTransport.mapEventFrame(frame)

        switch mapped {
        case let .chat(chat):
            #expect(chat.runId == "run-1")
            #expect(chat.sessionKey == "main")
            #expect(chat.state == "final")
        default:
            Issue.record("expected .chat from chat event, got \(String(describing: mapped))")
        }
    }

    @Test func mapsUnknownEventToNil() {
        let frame = EventFrame(
            type: "event",
            event: "unknown",
            payload: AnyCodable(["a": AnyCodable(1)]),
            seq: 1,
            stateversion: nil)
        let mapped = IOSGatewayChatTransport.mapEventFrame(frame)
        #expect(mapped == nil)
    }

    @Test func listModelsUsesGatewayModelsList() async throws {
        let session = FakeGatewayWebSocketSession(responsePayloads: [
            "models.list": [
                "models": [
                    [
                        "id": "gpt-5.5",
                        "name": "GPT-5.5",
                        "provider": "openai",
                        "contextWindow": 200_000,
                    ],
                    [
                        "id": "claude-opus-4-6",
                        "name": "Claude Opus 4.6",
                        "provider": "anthropic",
                        "available": false,
                    ],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: false, error: OpenClawNodeError(
                    code: .unavailable,
                    message: "unexpected node invoke"))
            })
        defer { Task { await gateway.disconnect() } }

        let transport = IOSGatewayChatTransport(gateway: gateway)
        let models = try await transport.listModels()

        #expect(models.map(\.selectionID) == ["openai/gpt-5.5", "anthropic/claude-opus-4-6"])
        #expect(models.first?.name == "GPT-5.5")
        #expect(models.first?.contextWindow == 200_000)
        #expect(models.last?.available == false)
        #expect(session.latestTask()?.requestedMethods().contains("models.list") == true)
        #expect(session.latestTask()?.requestedParams(for: "models.list").first?["view"] as? String == "configured")
    }
}
