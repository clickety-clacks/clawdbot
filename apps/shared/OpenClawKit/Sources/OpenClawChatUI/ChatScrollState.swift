import Foundation

struct ChatScrollState: Codable, Equatable {
    var schemaVersion: Int
    var isPinnedToBottom: Bool
    var anchorMessageID: String?
    var updatedAtMs: Int64

    init(isPinnedToBottom: Bool, anchorMessageID: String?, updatedAtMs: Int64) {
        self.schemaVersion = 1
        self.isPinnedToBottom = isPinnedToBottom
        self.anchorMessageID = anchorMessageID
        self.updatedAtMs = updatedAtMs
    }
}

enum ChatScrollStateStore {
    private static let keyPrefix = "OpenClawChatUI.scrollState."

    static func load(sessionKey: String, defaults: UserDefaults = .standard) -> ChatScrollState? {
        guard let data = defaults.data(forKey: storageKey(sessionKey: sessionKey)) else { return nil }
        return try? JSONDecoder().decode(ChatScrollState.self, from: data)
    }

    static func save(_ state: ChatScrollState, sessionKey: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: storageKey(sessionKey: sessionKey))
    }

    static func clear(sessionKey: String, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: storageKey(sessionKey: sessionKey))
    }

    private static func storageKey(sessionKey: String) -> String {
        // Session keys are already stable identifiers; keeping them readable makes debugging easier.
        return "\(Self.keyPrefix)\(sessionKey)"
    }
}

